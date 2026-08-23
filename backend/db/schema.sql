-- Cloud Architecture Platform backend schema (portfolio deployment)
-- Aurora MySQL Serverless v2, applied via RDS Data API at cluster bootstrap.

CREATE TABLE IF NOT EXISTS users (
  user_id            VARCHAR(64)  PRIMARY KEY,      -- Cognito sub
  email              VARCHAR(255) NOT NULL UNIQUE,
  email_verified     BOOLEAN      NOT NULL DEFAULT FALSE,
  auth_provider      VARCHAR(32)  NOT NULL DEFAULT 'email', -- email/google/github/apple/facebook/slack
  cognito_username   VARCHAR(255),
  federated_id       VARCHAR(255),
  account_status     VARCHAR(32)  NOT NULL DEFAULT 'active',
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_log_in_at     DATETIME,
  joined_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  display_name       VARCHAR(120),
  handle             VARCHAR(60)  UNIQUE,
  title              VARCHAR(160),
  bio                VARCHAR(500),
  location           VARCHAR(120),
  website            VARCHAR(255),
  avatar_url         VARCHAR(500),
  avatar_initials    VARCHAR(4),

  follower_count     INT NOT NULL DEFAULT 0,
  following_count    INT NOT NULL DEFAULT 0,
  diagram_count      INT NOT NULL DEFAULT 0,
  total_views        INT NOT NULL DEFAULT 0,

  dark_mode              BOOLEAN NOT NULL DEFAULT FALSE,
  email_notifications     BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_comment       BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_follow        BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_like          BOOLEAN NOT NULL DEFAULT TRUE,

  INDEX idx_users_handle (handle)
);

CREATE TABLE IF NOT EXISTS diagrams (
  diagram_id       VARCHAR(64)  PRIMARY KEY,
  user_id          VARCHAR(64)  NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  published_at     DATETIME,

  s3_key           VARCHAR(500),      -- user-content bucket key for exported PNG/JSON
  title            VARCHAR(200) NOT NULL DEFAULT 'Untitled Architecture',
  name             VARCHAR(200),
  description      VARCHAR(1000),
  feed_caption     VARCHAR(1000),
  category         VARCHAR(60),
  tags             JSON,
  status           VARCHAR(20)  NOT NULL DEFAULT 'draft',      -- draft/published/archived
  visibility       VARCHAR(20)  NOT NULL DEFAULT 'private',    -- public/private/followers
  is_shared_to_feed BOOLEAN     NOT NULL DEFAULT FALSE,
  shared_at        DATETIME,

  canvas_data      JSON,              -- full elements/connections/borders/labels/animSettings state
  thumbnail_url    VARCHAR(500),
  export_url       VARCHAR(500),

  view_count       INT NOT NULL DEFAULT 0,
  like_count       INT NOT NULL DEFAULT 0,
  comment_count    INT NOT NULL DEFAULT 0,
  save_count       INT NOT NULL DEFAULT 0,

  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  INDEX idx_diagrams_user (user_id),
  INDEX idx_diagrams_visibility_status (visibility, status)
);

CREATE TABLE IF NOT EXISTS comments (
  comment_id   VARCHAR(64)  PRIMARY KEY,
  diagram_id   VARCHAR(64)  NOT NULL,
  user_id      VARCHAR(64)  NOT NULL,
  body         VARCHAR(2000) NOT NULL,
  is_edited    BOOLEAN NOT NULL DEFAULT FALSE,
  like_count   INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (diagram_id) REFERENCES diagrams(diagram_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  INDEX idx_comments_diagram (diagram_id)
);

-- Idempotent add for deployments where the comments table already existed
-- before like_count was introduced — CREATE TABLE IF NOT EXISTS above is a
-- no-op on an existing table, so the column needs adding separately. MySQL
-- (unlike MariaDB) has no "IF NOT EXISTS" for ADD COLUMN, so bootstrap.sh
-- itself tolerates the "duplicate column" error this produces on a re-run.
ALTER TABLE comments ADD COLUMN like_count INT NOT NULL DEFAULT 0;

-- Threaded replies. NULL parent_comment_id = a top-level comment; otherwise
-- the comment_id this is a reply to. Deliberately NO self-referencing foreign
-- key: bootstrap.sh tolerates error codes 1060/1061/1050 on a re-run, but a
-- duplicate FK constraint raises 1826, which would fail the whole bootstrap.
-- Reply cleanup on parent deletion is handled in the comments-item Lambda.
-- Replies are kept one level deep (Instagram-style), not arbitrarily nested:
-- a reply to a reply attaches to the same top-level parent.
ALTER TABLE comments ADD COLUMN parent_comment_id VARCHAR(64) NULL;
ALTER TABLE comments ADD INDEX idx_comments_parent (parent_comment_id);

CREATE TABLE IF NOT EXISTS comment_likes (
  user_id     VARCHAR(64) NOT NULL,
  comment_id  VARCHAR(64) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, comment_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(comment_id) ON DELETE CASCADE,
  INDEX idx_comment_likes_comment (comment_id)
);

CREATE TABLE IF NOT EXISTS likes (
  user_id     VARCHAR(64) NOT NULL,
  diagram_id  VARCHAR(64) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, diagram_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (diagram_id) REFERENCES diagrams(diagram_id) ON DELETE CASCADE,
  INDEX idx_likes_diagram (diagram_id)
);

CREATE TABLE IF NOT EXISTS saves (
  user_id     VARCHAR(64) NOT NULL,
  diagram_id  VARCHAR(64) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, diagram_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (diagram_id) REFERENCES diagrams(diagram_id) ON DELETE CASCADE,
  INDEX idx_saves_diagram (diagram_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id   VARCHAR(64) NOT NULL,
  following_id  VARCHAR(64) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, following_id),
  FOREIGN KEY (follower_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (following_id) REFERENCES users(user_id) ON DELETE CASCADE,
  INDEX idx_follows_following (following_id)
);

-- Notifications -------------------------------------------------------------
-- One row per event delivered to a recipient. `actor_id` is whoever caused it.
-- A notification is never written when actor_id = recipient_id (you don't get
-- notified about your own activity) — that's enforced in the Lambdas.
--
-- diagram_id / comment_id are nullable and deliberately have NO foreign keys:
-- adding FK constraints here isn't safely re-runnable through bootstrap.sh
-- (a duplicate constraint raises 1826, which is not in the tolerated set).
-- Instead the notifications Lambda joins and simply omits rows whose target
-- has since been deleted, so a deleted diagram can't resurrect a dead link.
CREATE TABLE IF NOT EXISTS notifications (
  notification_id VARCHAR(64) PRIMARY KEY,
  recipient_id    VARCHAR(64) NOT NULL,
  actor_id        VARCHAR(64) NOT NULL,
  type            VARCHAR(32) NOT NULL,
  diagram_id      VARCHAR(64) NULL,
  comment_id      VARCHAR(64) NULL,
  preview         VARCHAR(200) NULL,
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (recipient_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES users(user_id) ON DELETE CASCADE,
  INDEX idx_notifications_recipient (recipient_id, is_read, created_at),
  INDEX idx_notifications_dedupe (recipient_id, actor_id, type, diagram_id, comment_id)
);

-- Profile privacy ------------------------------------------------------------
-- Public by default: an empty portfolio behind a wall helps nobody, and the
-- whole point of a profile here is to be sendable to a recruiter.
ALTER TABLE users ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT FALSE;

-- Follows become request-based for private accounts. Existing rows default to
-- 'accepted' so nobody currently following anyone is retroactively unfollowed.
--   accepted = a real follow
--   pending  = a request awaiting the private account's decision
-- Denied requests are DELETED rather than stored as 'denied': keeping them
-- would let the requester infer the refusal, and Instagram's behaviour (silent
-- removal, they may ask again) is the expected one.
ALTER TABLE follows ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'accepted';
ALTER TABLE follows ADD INDEX idx_follows_pending (following_id, status);

-- Portfolio features ---------------------------------------------------------
-- Pinned diagrams: up to three, shown first on a profile. A recruiter gives a
-- profile about thirty seconds, so the owner needs to choose what lands first
-- rather than relying on reverse-chronological order. The three-item cap is
-- enforced in the Lambda, not here — MySQL can't express it as a constraint.
ALTER TABLE diagrams ADD COLUMN is_pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE diagrams ADD COLUMN pinned_at DATETIME NULL;
ALTER TABLE diagrams ADD INDEX idx_diagrams_pinned (user_id, is_pinned);

-- Case study: structured Q&A stored as JSON, e.g.
--   [{"q":"What problem does this solve?","a":"..."}, ...]
-- Kept as JSON rather than five columns so the question set can change without
-- a migration, and so a diagram can carry only the questions its author chose
-- to answer.
ALTER TABLE diagrams ADD COLUMN case_study TEXT NULL;
