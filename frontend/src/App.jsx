import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Search, ZoomIn, ZoomOut, Type, Trash2, Move, ArrowRight, Undo, Layers, Square, MessageSquare, CornerDownRight, MapPin, Link2, Calendar, Eye, Edit2, X, Upload, Plus } from 'lucide-react';

// --- Robust JSON parser - handles markdown fences, leading/trailing text -------
function safeParseJSON(raw) {
  if(!raw) throw new Error('Empty response from API');
  // 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
  let cleaned = raw.replace(/^```(?:json|hcl|terraform)?\s*/i,'').replace(/\s*```\s*$/,'').trim();
  // 2. Try direct parse first
  try { return JSON.parse(cleaned); } catch(_) {}
  // 3. Extract first {...} block (handles leading/trailing prose)
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if(objMatch) { try { return JSON.parse(objMatch[0]); } catch(_) {} }
  // 4. Extract first [...] block
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if(arrMatch) { try { return JSON.parse(arrMatch[0]); } catch(_) {} }
  // 5. Last resort: remove any chars before first { or [
  const firstBrace = cleaned.search(/[{[]/);
  if(firstBrace > 0) {
    const trimmed = cleaned.slice(firstBrace);
    try { return JSON.parse(trimmed); } catch(_) {}
  }
  throw new Error('Could not parse AI response as JSON. Please try again.');
}

// --- Turn a raw API error message into something a human can actually read ------
function friendlyApiError(raw) {
  const msg = String(raw||'');
  // Try to find an "exceeded_limit" / usage-limit style payload embedded in the message
  const match = msg.match(/\{[\s\S]*\}/);
  if(match){
    try{
      const obj = JSON.parse(match[0]);
      if(obj && (obj.type==='exceeded_limit' || obj.resolved?.status==='exceeded' || obj.notice)) {
        const resetsAtRaw = obj.resetsAt || obj.resolved?.resets_at;
        let resetStr = '';
        if(resetsAtRaw){
          const d = typeof resetsAtRaw==='number' ? new Date(resetsAtRaw*1000) : new Date(resetsAtRaw);
          if(!isNaN(d.getTime())) resetStr = ` It should reset around ${d.toLocaleString()}.`;
        }
        return `You've hit the usage limit for AI testing in this preview.${resetStr} This only affects live-testing the AI features here in the artifact preview — it won't affect your real app once it's running on its own backend with its own API key.`;
      }
    }catch(_){}
  }
  return msg;
}

// --- Claude API caller with automatic retry ------------------------------------
// --- Premium Feature gate modal --------------------------------------------------
// Placeholder demo-video links (null for now) — swap these in once the
// actual recordings exist. Each entry can hold its own video URL so
// different features link to their own specific demo rather than one
// generic video.
const PREMIUM_DEMO_VIDEOS = {
  'Generate with AI': null,
  'Import from Terraform': null,
  'Import from Image / Doc': null,
  'Export IaC Code': null,
  'Architecture Comparison': null,
  'Architecture Validation': null,
};

function PremiumFeatureGate({ darkMode, featureName, onClose }) {
  const cardBg = darkMode ? '#1f2937' : '#ffffff';
  const textC = darkMode ? '#f1f5f9' : '#1e293b';
  const textMut = darkMode ? '#94a3b8' : '#64748b';
  const videoUrl = PREMIUM_DEMO_VIDEOS[featureName];

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:2000,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:cardBg,borderRadius:16,width:'100%',maxWidth:420,padding:'28px 26px',boxShadow:'0 24px 64px rgba(0,0,0,0.35)',textAlign:'center'}}>
        <div style={{fontSize:32,marginBottom:14}}>🔒</div>
        <div style={{fontSize:20,fontWeight:800,color:textC,marginBottom:10}}>Premium Feature</div>
        <div style={{fontSize:14,color:textMut,lineHeight:1.6,marginBottom:6}}>
          Watch a 2-minute demo to see {featureName} in action.
        </div>
        <div style={{fontSize:14,color:textMut,lineHeight:1.6,marginBottom:22}}>
          Public beta coming soon.
        </div>

        {videoUrl ? (
          <a href={videoUrl} target="_blank" rel="noopener noreferrer"
            style={{display:'block',padding:'12px',borderRadius:10,border:'none',background:'linear-gradient(135deg,#7c3aed,#2563eb)',color:'#fff',fontSize:14,fontWeight:700,textDecoration:'none',marginBottom:10}}>
            ▶ Watch the demo
          </a>
        ) : (
          <div style={{padding:'12px',borderRadius:10,background:darkMode?'#374151':'#f1f5f9',color:textMut,fontSize:13,fontWeight:600,marginBottom:10}}>
            Demo video coming soon
          </div>
        )}

        <button onClick={onClose}
          style={{width:'100%',padding:'10px',borderRadius:10,border:`1.5px solid ${darkMode?'#374151':'#e5e7eb'}`,background:'transparent',color:textMut,cursor:'pointer',fontSize:13,fontWeight:600}}>
          Close
        </button>
      </div>
    </div>
  );
}


// AI features should stay fully open here (Claude.ai artifact preview, for
// making demo recordings) but be gated behind a "Premium Feature" modal on
// the real deployed site. Rather than hardcoding a guess at Claude.ai's
// preview domain — which could change — this uses a more resilient signal:
// the artifact preview always runs embedded inside an iframe on claude.ai,
// while a real S3/CloudFront deployment is always visited as a top-level
// page. Falls back to gated (the safe direction) if anything's uncertain,
// so a misconfigured or unrecognized host never accidentally ships with AI
// features wide open.
function isPremiumGateActive() {
  try {
    if (typeof window === 'undefined') return true;
    const host = window.location.hostname;
    const isLocalDev = host === 'localhost' || host === '127.0.0.1';
    const isEmbeddedPreview = window.self !== window.top; // artifact preview runs in an iframe
    return !(isLocalDev || isEmbeddedPreview);
  } catch {
    return true; // cross-origin access to window.top can throw in some sandboxes — stay gated if so
  }
}

// --- Backend configuration -------------------------------------------------------
// Real values from `terraform output` after applying the backend module.
// Update these again if the backend is ever destroyed and recreated (new
// applies generate new IDs/domains for most of these).
const API_BASE_URL = 'https://furo7cozpg.execute-api.us-east-1.amazonaws.com';
const COGNITO_USER_POOL_ID = 'us-east-1_HcCdaVGbL';
const COGNITO_CLIENT_ID = '735332ra5uc16ua3h6c982veec';
const COGNITO_DOMAIN = 'cloudarch-auth-099814429392.auth.us-east-1.amazoncognito.com';

// --- Token storage -----------------------------------------------------------------
// Tries real browser storage (works on the deployed site); falls back to an
// in-memory object if storage throws — e.g. inside the Claude.ai artifact
// sandbox, where localStorage/sessionStorage aren't available. This means
// auth still works for demo/testing here, it just won't survive a refresh —
// which is fine, since real persistent sessions are only needed on the real
// deployed site anyway.
const _memoryTokenStore = {};
function tokenSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { _memoryTokenStore[key] = value; }
}
function tokenGet(key) {
  try { const v = window.localStorage.getItem(key); return v !== null ? v : (_memoryTokenStore[key] ?? null); }
  catch { return _memoryTokenStore[key] ?? null; }
}
function tokenClear() {
  try { ['accessToken','idToken','refreshToken'].forEach(k => window.localStorage.removeItem(k)); } catch {}
  Object.keys(_memoryTokenStore).forEach(k => delete _memoryTokenStore[k]);
}

// Decodes a JWT's payload without verifying the signature — fine for reading
// display info client-side, since the actual security boundary is the API
// Gateway JWT authorizer validating the token server-side on every request.
function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(atob(base64).split('').map(c =>
      '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
    return JSON.parse(json);
  } catch { return {}; }
}

// Thin wrapper around fetch for the CloudForger API — attaches the stored
// access token automatically when present, and throws a readable Error on
// any non-2xx response so callers can just try/catch.
async function apiRequest(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = tokenGet('accessToken');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function callClaudeWithRetry(payload, maxRetries=3) {
  let lastError;
  for(let attempt=1; attempt<=maxRetries; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({model:'claude-sonnet-4-6', max_tokens:16000, ...payload}),
      });
      if(!res.ok) {
        const err = await res.json().catch(()=>({}));
        throw new Error(friendlyApiError(err.error?.message||`API error ${res.status}`));
      }
      const data = await res.json();
      const text = data.content?.find(b=>b.type==='text')?.text||'';
      if(!text) throw new Error('Empty response from API');
      return text;
    } catch(e) {
      lastError = e;
      if(attempt < maxRetries) {
        // Exponential backoff: 800ms, 1600ms
        await new Promise(r=>setTimeout(r, 800 * attempt));
      }
    }
  }
  throw lastError;
}

// --- CloudForger Logo -----------------------------------------------------------
function CloudForgerLogo({ size = 28 }) {
  // Triangle height proportional to size
  const h = size;
  const w = size * 0.92;
  return (
    <svg width={w} height={h} viewBox="0 0 92 100" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id="af-grad" x1="0" y1="0" x2="92" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7B6EF6"/>
          <stop offset="100%" stopColor="#3B5BDB"/>
        </linearGradient>
      </defs>
      {/* Outer triangle (the "A" shape) */}
      <path d="M46 4 L88 84 Q88 96 76 96 L16 96 Q4 96 4 84 Z" fill="url(#af-grad)"/>
      {/* Inner cutout to hollow the A */}
      <path d="M46 26 L70 76 L22 76 Z" fill="white" opacity="0.18"/>
      {/* Network diagram icon centered inside the triangle */}
      {/* Top node */}
      <rect x="40" y="46" width="12" height="10" rx="2" fill="white" opacity="0.92"/>
      {/* Connector lines */}
      <line x1="46" y1="56" x2="46" y2="63" stroke="white" strokeWidth="2.2" opacity="0.85"/>
      <line x1="46" y1="63" x2="30" y2="63" stroke="white" strokeWidth="2.2" opacity="0.85"/>
      <line x1="46" y1="63" x2="62" y2="63" stroke="white" strokeWidth="2.2" opacity="0.85"/>
      {/* Left node */}
      <rect x="22" y="63" width="12" height="10" rx="2" fill="white" opacity="0.92"/>
      {/* Center node */}
      <rect x="40" y="63" width="12" height="10" rx="2" fill="white" opacity="0.92"/>
      {/* Right node */}
      <rect x="58" y="63" width="12" height="10" rx="2" fill="white" opacity="0.92"/>
    </svg>
  );
}

const TEMP_LOGO_PNG_LIGHT = "data:image/png;base64,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";
// Same logo with "Cloud" and "Platform" recolored white — the original navy
// was designed for a white background and is nearly illegible on dark ones.
const TEMP_LOGO_PNG_DARK = "data:image/png;base64,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";

function CloudForgerWordmark({ size = 28, dark = false }) {
  // TEMP: quick preview of the user-provided logo PNG in place of the SVG wordmark.
  // Uses a separate dark-mode variant with "Cloud"/"Platform" recolored white,
  // since the original navy is illegible on dark backgrounds. Note: `dark` here
  // means "render dark text" (i.e. for a light background) — callers pass
  // dark={!darkMode}, so dark=true is the light-background case.
  return (
    <img src={dark?TEMP_LOGO_PNG_LIGHT:TEMP_LOGO_PNG_DARK} alt="CloudForger" style={{ height: 42, width: 'auto', display: 'block' }}/>
  );
}

// --- Mobile detection ---------------------------------------------------------
function useIsMobile() {
  const [m, setM] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const h = () => setM(window.innerWidth < 768);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return m;
}

// --- Constants ----------------------------------------------------------------
const ICON_LIBRARY = [
  { id:'user',    name:'User',     icon:'👤', category:'People' },
  { id:'users',   name:'Users',    icon:'👥', category:'People' },
  { id:'key',     name:'Key',      icon:'🔑', category:'Security' },
  { id:'lock',    name:'Lock',     icon:'🔒', category:'Security' },
  { id:'globe',   name:'Globe',    icon:'🌍', category:'Network' },
  { id:'network', name:'Network',  icon:'🌐', category:'Network' },
  { id:'file',    name:'File',     icon:'📄', category:'Files' },
  { id:'folder',  name:'Folder',   icon:'📁', category:'Files' },
  { id:'server',  name:'Server',   icon:'🖥️', category:'Infra' },
  { id:'database',name:'Database', icon:'💾', category:'Infra' },
  { id:'check',   name:'Check',    icon:'✅', category:'Status' },
  { id:'warn',    name:'Warning',  icon:'⚠️', category:'Status' },
  { id:'gear',    name:'Settings', icon:'⚙️', category:'Tools' },
  { id:'shield',  name:'Shield',   icon:'🛡️', category:'Security' },
  { id:'cloud',   name:'Cloud',    icon:'☁️', category:'Infra' },
  { id:'laptop',  name:'Laptop',   icon:'💻', category:'Devices' },
  { id:'phone',   name:'Phone',    icon:'📱', category:'Devices' },
  { id:'email',   name:'Email',    icon:'📧', category:'Comm' },
  { id:'robot',   name:'Robot/AI', icon:'🤖', category:'AI' },
  { id:'brain',   name:'Brain/ML', icon:'🧠', category:'AI' },
  { id:'fire',    name:'Fire',     icon:'🔥', category:'Status' },
  { id:'api',     name:'API',      icon:'🔌', category:'Dev' },
];

const AWS_SERVICES = [
  { id:'ec2',         name:'EC2',          category:'Compute',    color:'#FF9900', icon:'🖥️', desc:'Virtual servers' },
  { id:'lambda',      name:'Lambda',       category:'Compute',    color:'#FF9900', icon:'λ',   desc:'Serverless functions' },
  { id:'eks',         name:'EKS',          category:'Compute',    color:'#FF9900', icon:'☸️',  desc:'Managed Kubernetes' },
  { id:'ecs',         name:'ECS',          category:'Compute',    color:'#FF9900', icon:'🐳',  desc:'Container service' },
  { id:'s3',          name:'S3',           category:'Storage',    color:'#569A31', icon:'🪣',  desc:'Object storage' },
  { id:'rds',         name:'RDS',          category:'Database',   color:'#527FFF', icon:'🗄️', desc:'Relational DB' },
  { id:'dynamodb',    name:'DynamoDB',     category:'Database',   color:'#527FFF', icon:'⚡',  desc:'NoSQL database' },
  { id:'aurora',      name:'Aurora',       category:'Database',   color:'#527FFF', icon:'⭐',  desc:'Aurora DB' },
  { id:'vpc',         name:'VPC',          category:'Networking', color:'#8C4FFF', icon:'🌐',  desc:'Virtual network' },
  { id:'cloudfront',  name:'CloudFront',   category:'Networking', color:'#8C4FFF', icon:'⚡',  desc:'CDN' },
  { id:'route53',     name:'Route 53',     category:'Networking', color:'#8C4FFF', icon:'🌍',  desc:'DNS service' },
  { id:'elb',         name:'ELB',          category:'Networking', color:'#8C4FFF', icon:'⚖️', desc:'Load balancer' },
  { id:'apigateway',  name:'API Gateway',  category:'Networking', color:'#8C4FFF', icon:'🚪',  desc:'API management' },
  { id:'iam',         name:'IAM',          category:'Security',   color:'#DD344C', icon:'🔐',  desc:'Identity & access' },
  { id:'waf',         name:'WAF',          category:'Security',   color:'#DD344C', icon:'🛡️', desc:'Web firewall' },
  { id:'codecommit',  name:'CodeCommit',   category:'Developer',  color:'#4B612C', icon:'📝',  desc:'Source control' },
  { id:'codebuild',   name:'CodeBuild',    category:'Developer',  color:'#4B612C', icon:'🔨',  desc:'Build service' },
  { id:'codedeploy',  name:'CodeDeploy',   category:'Developer',  color:'#4B612C', icon:'🚀',  desc:'Deployment' },
  { id:'codepipeline',name:'CodePipeline', category:'Developer',  color:'#4B612C', icon:'🔄',  desc:'CI/CD pipeline' },
  { id:'sqs',         name:'SQS',          category:'Messaging',  color:'#FF9900', icon:'📬',  desc:'Message queue' },
  { id:'sns',         name:'SNS',          category:'Messaging',  color:'#FF9900', icon:'🔔',  desc:'Pub/sub notifications' },
  { id:'cloudwatch',  name:'CloudWatch',   category:'Monitoring', color:'#FF9900', icon:'📊',  desc:'Monitoring & logs' },
];

const GCP_SERVICES = [
  { id:'gce',             name:'Compute Engine',     category:'Compute',    color:'#4285F4', icon:'🖥️', desc:'Virtual machines' },
  { id:'gcf',             name:'Cloud Functions',    category:'Compute',    color:'#4285F4', icon:'λ',   desc:'Serverless functions' },
  { id:'gke',             name:'GKE',                category:'Compute',    color:'#4285F4', icon:'☸️',  desc:'Managed Kubernetes' },
  { id:'cloudrun',        name:'Cloud Run',          category:'Compute',    color:'#4285F4', icon:'🐳',  desc:'Container platform' },
  { id:'gcs',             name:'Cloud Storage',      category:'Storage',    color:'#34A853', icon:'🪣',  desc:'Object storage' },
  { id:'cloudsql',        name:'Cloud SQL',          category:'Database',   color:'#FBBC04', icon:'🗄️', desc:'Managed SQL' },
  { id:'firestore',       name:'Firestore',          category:'Database',   color:'#FBBC04', icon:'🔥',  desc:'NoSQL document DB' },
  { id:'bigtable',        name:'Bigtable',           category:'Database',   color:'#FBBC04', icon:'⭐',  desc:'Wide-column NoSQL' },
  { id:'gcvpc',           name:'VPC Network',        category:'Networking', color:'#EA4335', icon:'🌐',  desc:'Virtual network' },
  { id:'gccdn',           name:'Cloud CDN',          category:'Networking', color:'#EA4335', icon:'⚡',  desc:'Content delivery' },
  { id:'gcldns',          name:'Cloud DNS',          category:'Networking', color:'#EA4335', icon:'🌍',  desc:'DNS service' },
  { id:'gclb',            name:'Cloud Load Bal.',    category:'Networking', color:'#EA4335', icon:'⚖️', desc:'Load balancing' },
  { id:'gcapigw',         name:'API Gateway',        category:'Networking', color:'#EA4335', icon:'🚪',  desc:'API management' },
  { id:'gciam',           name:'Cloud IAM',          category:'Security',   color:'#34A853', icon:'🔐',  desc:'Identity & access' },
  { id:'gcarmor',         name:'Cloud Armor',        category:'Security',   color:'#34A853', icon:'🛡️', desc:'DDoS & WAF' },
  { id:'cloudbuild',      name:'Cloud Build',        category:'Developer',  color:'#4285F4', icon:'🔨',  desc:'CI build service' },
  { id:'clouddeploy',     name:'Cloud Deploy',       category:'Developer',  color:'#4285F4', icon:'🚀',  desc:'CD service' },
  { id:'artifactreg',     name:'Artifact Registry',  category:'Developer',  color:'#4285F4', icon:'📦',  desc:'Container & pkg registry' },
  { id:'sourcerepo',      name:'Source Repositories',category:'Developer',  color:'#4285F4', icon:'📝',  desc:'Source control' },
  { id:'pubsub',          name:'Pub/Sub',            category:'Messaging',  color:'#FBBC04', icon:'📬',  desc:'Messaging service' },
  { id:'gctasks',         name:'Cloud Tasks',        category:'Messaging',  color:'#FBBC04', icon:'🔔',  desc:'Task queue' },
  { id:'gcmonitoring',    name:'Cloud Monitoring',   category:'Monitoring', color:'#34A853', icon:'📊',  desc:'Monitoring & alerting' },
];

const AZURE_SERVICES = [
  { id:'azvm',            name:'Virtual Machines',   category:'Compute',    color:'#0078D4', icon:'🖥️', desc:'IaaS virtual machines' },
  { id:'azfunc',          name:'Azure Functions',    category:'Compute',    color:'#0078D4', icon:'λ',   desc:'Serverless functions' },
  { id:'azaks',           name:'AKS',                category:'Compute',    color:'#0078D4', icon:'☸️',  desc:'Managed Kubernetes' },
  { id:'azcontainer',     name:'Container Apps',     category:'Compute',    color:'#0078D4', icon:'🐳',  desc:'Container platform' },
  { id:'azblob',          name:'Blob Storage',       category:'Storage',    color:'#00B294', icon:'🪣',  desc:'Object storage' },
  { id:'azsql',           name:'Azure SQL',          category:'Database',   color:'#F25022', icon:'🗄️', desc:'Managed SQL Server' },
  { id:'azcosmos',        name:'Cosmos DB',          category:'Database',   color:'#F25022', icon:'⭐',  desc:'Multi-model NoSQL' },
  { id:'azredis',         name:'Azure Cache Redis',  category:'Database',   color:'#F25022', icon:'⚡',  desc:'In-memory cache' },
  { id:'azvnet',          name:'Virtual Network',    category:'Networking', color:'#7FBA00', icon:'🌐',  desc:'Private network' },
  { id:'azfrontdoor',     name:'Front Door',         category:'Networking', color:'#7FBA00', icon:'⚡',  desc:'Global CDN & LB' },
  { id:'azdns',           name:'Azure DNS',          category:'Networking', color:'#7FBA00', icon:'🌍',  desc:'DNS hosting' },
  { id:'azlb',            name:'Load Balancer',      category:'Networking', color:'#7FBA00', icon:'⚖️', desc:'Load balancing' },
  { id:'azapimgmt',       name:'API Management',     category:'Networking', color:'#7FBA00', icon:'🚪',  desc:'API gateway' },
  { id:'azad',            name:'Azure AD',           category:'Security',   color:'#0078D4', icon:'🔐',  desc:'Identity & access' },
  { id:'azfirewall',      name:'Azure Firewall',     category:'Security',   color:'#0078D4', icon:'🛡️', desc:'Network firewall' },
  { id:'azdevops',        name:'Azure DevOps',       category:'Developer',  color:'#00B294', icon:'🔄',  desc:'Full DevOps suite' },
  { id:'azpipelines',     name:'Azure Pipelines',    category:'Developer',  color:'#00B294', icon:'🔨',  desc:'CI/CD pipelines' },
  { id:'azrepos',         name:'Azure Repos',        category:'Developer',  color:'#00B294', icon:'📝',  desc:'Git source control' },
  { id:'azacr',           name:'Container Registry', category:'Developer',  color:'#00B294', icon:'📦',  desc:'Container registry' },
  { id:'azservicebus',    name:'Service Bus',        category:'Messaging',  color:'#F25022', icon:'📬',  desc:'Enterprise messaging' },
  { id:'azeventgrid',     name:'Event Grid',         category:'Messaging',  color:'#F25022', icon:'🔔',  desc:'Event routing' },
  { id:'azmonitor',       name:'Azure Monitor',      category:'Monitoring', color:'#7FBA00', icon:'📊',  desc:'Monitoring & insights' },
];

const CLOUD_PROVIDERS = [
  { id:'aws',   name:'AWS',   color:'#FF9900', logo:'☁️',  services: AWS_SERVICES },
  { id:'gcp',   name:'GCP',   color:'#4285F4', logo:'🌤️', services: GCP_SERVICES },
  { id:'azure', name:'Azure', color:'#0078D4', logo:'⛅',  services: AZURE_SERVICES },
];

const ARCHITECTURE_TEMPLATES = [
  {
    id:'three-tier', name:'3-Tier Web App', icon:'🏗️', description:'Classic web application',
    elements:[
      {service:'route53',x:100,y:80},{service:'cloudfront',x:100,y:200},
      {service:'elb',x:100,y:320},{service:'ec2',x:40,y:440},
      {service:'ec2',x:160,y:440},{service:'rds',x:100,y:560}
    ],
    connections:[{from:0,to:1},{from:1,to:2},{from:2,to:3},{from:2,to:4},{from:3,to:5},{from:4,to:5}]
  },
  {
    id:'serverless', name:'Serverless API', icon:'⚡', description:'Serverless REST API',
    elements:[
      {service:'route53',x:100,y:80},{service:'apigateway',x:100,y:200},
      {service:'lambda',x:40,y:320},{service:'lambda',x:160,y:320},{service:'dynamodb',x:100,y:440}
    ],
    connections:[{from:0,to:1},{from:1,to:2},{from:1,to:3},{from:2,to:4},{from:3,to:4}]
  },
  {
    id:'cicd', name:'CI/CD Pipeline', icon:'🔄', description:'Complete CI/CD workflow',
    elements:[
      {service:'codecommit',x:100,y:80},{service:'codebuild',x:100,y:200},
      {service:'codedeploy',x:100,y:320},{service:'ec2',x:100,y:440}
    ],
    connections:[{from:0,to:1},{from:1,to:2},{from:2,to:3}]
  },
];

const COLOR_PALETTE = ['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f97316','#84cc16','#6b7280','#1e293b','#ffffff'];
const BUBBLE_SHAPES = [{id:'textbox',label:'Text Box'},{id:'speech',label:'Speech'},{id:'rounded',label:'Rounded'},{id:'rectangle',label:'Rectangle'},{id:'thought',label:'Thought'},{id:'cloud',label:'Cloud'},{id:'shout',label:'Shout'}];

const ELEMENT_SHAPES = [
  { id:'rounded',      label:'Rounded',      icon:'▢', borderRadius:'12%',       clip:null },
  { id:'sharp',        label:'Sharp',        icon:'[ ]', borderRadius:'0',          clip:null },
  { id:'pill',         label:'Pill',         icon:'⬭', borderRadius:'50%',        clip:null },
  { id:'circle',       label:'Circle',       icon:'○', borderRadius:'50%',        clip:null, forceSquare:true },
  { id:'diamond',      label:'Diamond',      icon:'◆', borderRadius:'0',          clip:'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' },
  { id:'hexagon',      label:'Hexagon',      icon:'⬡', borderRadius:'0',          clip:'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' },
  { id:'parallelogram',label:'Slanted',      icon:'▱', borderRadius:'0',          clip:'polygon(15% 0%, 100% 0%, 85% 100%, 0% 100%)' },
  { id:'triangle',     label:'Triangle',     icon:'△', borderRadius:'0',          clip:'polygon(50% 0%, 100% 100%, 0% 100%)' },
  { id:'octagon',      label:'Octagon',      icon:'⬡', borderRadius:'0',          clip:'polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)' },
  { id:'banner',       label:'Banner',       icon:'⛳', borderRadius:'0',          clip:'polygon(0% 0%, 85% 0%, 100% 50%, 85% 100%, 0% 100%)' },
];

// --- Phase 3 Visual Styles -----------------------------------------------------
const NODE_VISUAL_STYLES = [
  { id:'solid',  label:'Solid',  desc:'Flat filled colour (default)' },
  { id:'glass',  label:'Glass',  desc:'Frosted glass with blur & transparency' },
  { id:'neon',   label:'Neon',   desc:'Dark background with glowing neon border' },
  { id:'gradient',label:'Gradient',desc:'Radial gradient from colour to dark' },
];
const CONN_VISUAL_STYLES = [
  { id:'solid',    label:'Solid',    desc:'Single solid colour (default)' },
  { id:'gradient', label:'Gradient', desc:'Fades from source to destination colour' },
  { id:'particle', label:'Particles',desc:'Streaming particle trail along the line' },
];

// --- Animation constants -------------------------------------------------------
const ANIM_STYLES = [
  { id:'dataflow',     label:'Data Flow',      desc:'Glowing dots travel along connections',          icon:'->'  },
  { id:'pulse',        label:'Pulse',           desc:'Service nodes breathe with a soft glow',         icon:'◎'  },
  { id:'sequence',     label:'Sequence',        desc:'Components light up in request-flow order',      icon:'▶'  },
  { id:'packets',      label:'Data Packets',    desc:'Labelled packets (HTTP, SQL…) flow along arrows',icon:'📦' },
  { id:'status',       label:'Status',          desc:'Live health indicators pulse on each service',   icon:'🟢' },
  { id:'ripple',       label:'Wave Ripple',     desc:'Concentric rings expand outward from each node', icon:'🌊' },
  { id:'lightning',    label:'Lightning',       desc:'Electric arcs flash along connections',          icon:'⚡' },
  { id:'orbit',        label:'Orbit',           desc:'Satellite dots orbit each service node',         icon:'🔄' },
  { id:'mesh',         label:'Network Mesh',    desc:'Shockwave ripples cascade through connected nodes',icon:'🌐'},
  { id:'heatmap',      label:'Heatmap',         desc:'Traffic intensity shown by speed & brightness',  icon:'🔥' },
  { id:'heartbeat',    label:'Heartbeat',       desc:'ECG-style spike pulses along connections',       icon:'💓' },
  { id:'constellation',label:'Constellation',   desc:'Faint star-field lines link nearby nodes',       icon:'🌟' },
  { id:'ping',         label:'Ping / Latency',  desc:'Radar pings travel and acknowledge on arrival',  icon:'🎯' },
  { id:'streams',      label:'Flow Streams',    desc:'Liquid particle rivers flow along connections',  icon:'🏄' },
  { id:'colorshift',   label:'Colour Shift',    desc:'Diagram cycles through temperature moods',       icon:'🎨' },
];
const ANIM_SPEEDS = [
  { id:'slow',   label:'Slow',   ms:120 },
  { id:'normal', label:'Normal', ms:60  },
  { id:'fast',   label:'Fast',   ms:30  },
];
const GIF_FRAMES = { slow:40, normal:30, fast:20 };

// Data packet labels assigned based on connection index
const PACKET_LABELS = ['HTTP','SQL','JSON','gRPC','Event','TCP','TLS','Auth','Data','RPC'];
// Status colours: 0=healthy(green), 1=warning(amber), 2=error(red)
// Each element gets a stable "health" based on its index
const statusColor=(ei)=>{
  // Most services healthy, occasional warning, rare error - deterministic by index
  if(ei%7===5) return {color:'#ef4444',label:'Error'};
  if(ei%5===3) return {color:'#f59e0b',label:'Warn'};
  return {color:'#10b981',label:'OK'};
};

// --- Bubble paths -------------------------------------------------------------
function buildBubbleParts(shape, w, h) {
  const parts = [];
  if (shape==='speech') {
    const r=12;
    const tx1=w*0.18,tx2=w*0.38,tipX=w*0.07,tipY=h+28;
    parts.push({type:'path',d:`M${r},0 H${w-r} Q${w},0 ${w},${r} V${h-r} Q${w},${h} ${w-r},${h} H${tx2} L${tipX},${tipY} L${tx1},${h} H${r} Q0,${h} 0,${h-r} V${r} Q0,0 ${r},0 Z`});
  } else if (shape==='rounded') {
    const r=20;
    parts.push({type:'path',d:`M${r},0 H${w-r} Q${w},0 ${w},${r} V${h-r} Q${w},${h} ${w-r},${h} H${r} Q0,${h} 0,${h-r} V${r} Q0,0 ${r},0 Z`});
  } else if (shape==='rectangle'||shape==='textbox') {
    // Plain rectangle - no tail, just a clean box for text annotations
    const r=6;
    parts.push({type:'path',d:`M${r},0 H${w-r} Q${w},0 ${w},${r} V${h-r} Q${w},${h} ${w-r},${h} H${r} Q0,${h} 0,${h-r} V${r} Q0,0 ${r},0 Z`});
  } else if (shape==='thought') {
    parts.push({type:'ellipse',cx:w/2,cy:h/2,rx:w/2-2,ry:h/2-2});
    parts.push({type:'circle',cx:w*0.28,cy:h+13,r:8});
    parts.push({type:'circle',cx:w*0.17,cy:h+25,r:6});
    parts.push({type:'circle',cx:w*0.08,cy:h+35,r:4});
  } else if (shape==='cloud') {
    parts.push({type:'path',d:`M${w*.15},${h*.65} A${w*.18},${h*.32} 0 0,1 ${w*.22},${h*.30} A${w*.20},${h*.28} 0 0,1 ${w*.50},${h*.16} A${w*.18},${h*.28} 0 0,1 ${w*.78},${h*.26} A${w*.20},${h*.30} 0 0,1 ${w*.88},${h*.55} A${w*.15},${h*.25} 0 0,1 ${w*.72},${h*.82} A${w*.16},${h*.22} 0 0,1 ${w*.50},${h*.86} A${w*.18},${h*.24} 0 0,1 ${w*.28},${h*.80} A${w*.18},${h*.26} 0 0,1 ${w*.15},${h*.65} Z`});
    parts.push({type:'circle',cx:w*0.30,cy:h+13,r:8});
    parts.push({type:'circle',cx:w*0.18,cy:h+25,r:6});
    parts.push({type:'circle',cx:w*0.08,cy:h+35,r:4});
  } else if (shape==='shout') {
    const cx=w/2,cy=h/2,outerR=Math.min(w,h)*0.50,innerR=Math.min(w,h)*0.30;
    const pts=[];
    for(let i=0;i<20;i++){const angle=(Math.PI/10)*i-Math.PI/2;const r=i%2===0?outerR:innerR;pts.push(`${cx+r*Math.cos(angle)},${cy+r*Math.sin(angle)}`);}
    parts.push({type:'path',d:`M${pts.join('L')}Z`});
  } else {
    parts.push({type:'path',d:`M0,0 H${w} V${h} H0 Z`});
  }
  return parts;
}

// --- UI helpers ---------------------------------------------------------------
function ColorGrid({value,onChange,showNone}) {
  return (
    <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:4,marginBottom:6}}>
      {showNone&&<div onClick={()=>onChange('transparent')} style={{width:26,height:26,borderRadius:4,cursor:'pointer',border:'2px solid #d1d5db',background:'white',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:'#9ca3af',outline:value==='transparent'?'2px solid #fbbf24':'none'}}>∅</div>}
      {COLOR_PALETTE.map(c=><div key={c} onClick={()=>onChange(c)} style={{width:26,height:26,borderRadius:4,background:c,cursor:'pointer',border:c==='#ffffff'?'2px solid #d1d5db':'2px solid transparent',outline:value===c?'2px solid #fbbf24':'none',outlineOffset:1}}/>)}
    </div>
  );
}

function SliderRow({label,value,min,max,onChange}) {
  return (
    <div style={{marginBottom:10}}>
      <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'#6b7280',marginBottom:2}}>
        <span>{label}</span><span style={{fontWeight:700,color:'#374151'}}>{value}</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={e=>onChange(Number(e.target.value))} style={{width:'100%',accentColor:'#3b82f6',cursor:'pointer'}}/>
    </div>
  );
}

function SL({children}) { return <div style={{fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,marginTop:8}}>{children}</div>; }

function CtxMenu({pos,title,onClose,darkMode,children}) {
  const ref=useRef(null);
  useEffect(()=>{
    const h=e=>{if(ref.current&&!ref.current.contains(e.target))onClose();};
    const t=setTimeout(()=>document.addEventListener('mousedown',h),120);
    return()=>{clearTimeout(t);document.removeEventListener('mousedown',h);};
  },[onClose]);
  return (
    <div ref={ref} style={{position:'fixed',left:Math.min(pos.x,window.innerWidth-270),top:Math.min(pos.y,window.innerHeight-540),zIndex:9999,background:darkMode?'#1e2433':'#fff',border:`1.5px solid ${darkMode?'#374151':'#e5e7eb'}`,borderRadius:10,boxShadow:'0 8px 30px rgba(0,0,0,0.18)',width:252,padding:'12px 14px',fontFamily:'Inter,Arial,sans-serif',maxHeight:'90vh',overflowY:'auto'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <span style={{fontWeight:700,fontSize:13,color:darkMode?'#f1f5f9':'#1e293b'}}>{title}</span>
        <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:16,color:'#9ca3af',lineHeight:1}}>✕</button>
      </div>
      {children}
    </div>
  );
}

// Auto-calculates bubble height needed to fit text at given width
function calcBubbleHeight(text, w, fontSize=13, lineHeight=1.45, paddingV=24) {
  if(!text||!text.trim()) return 65;
  const charsPerLine=Math.floor((w-28)/(fontSize*0.55));
  const words=text.split(' ');
  let lines=1, lineLen=0;
  words.forEach(word=>{
    if(lineLen+word.length+1>charsPerLine&&lineLen>0){lines++;lineLen=word.length;}
    else{lineLen+=word.length+1;}
  });
  return Math.max(65, Math.ceil(lines*fontSize*lineHeight+paddingV));
}

function SpeechBubble({bubble,isSelected,isEditing,inDrawMode,onMouseDown,onTouchStart,onDoubleClick,onContextMenu,onTextChange,onBlur,onResizeDown}) {
  const{w,h,shape,fillColor,strokeColor,strokeWidth,text,textColor,textFontSize,textBold,textItalic,textUnderline,fontFamily}=bubble;
  const parts=buildBubbleParts(shape,w,h);
  const hasTail=shape==='speech'||shape==='thought'||shape==='cloud';
  const totalH=hasTail?h+50:h+6;
  const fill=fillColor==='transparent'?'transparent':(fillColor||'#fff');
  const sc=strokeColor||'#3b82f6';
  const sw=strokeWidth||2;
  const isRound=shape==='thought'||shape==='cloud';
  const isShout=shape==='shout';
  const txtSz=textFontSize||(text&&text.length>120?11:text&&text.length>60?12:13);
  const txtWeight=textBold?'700':'600';
  const txtStyle=textItalic?'italic':'normal';
  const txtDecor=textUnderline?'underline':'none';
  const ff=fontFamily||'Arial,sans-serif';
  return (
    <div onMouseDown={onMouseDown} onTouchStart={onTouchStart} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
      style={{position:'absolute',left:bubble.x,top:bubble.y,width:w+10,height:totalH,userSelect:'none',cursor:inDrawMode?'crosshair':'move',outline:inDrawMode?'2px dashed #3b82f6':'none',outlineOffset:2,borderRadius:6,touchAction:'none'}}>
      <svg width={w+10} height={totalH} style={{position:'absolute',top:0,left:0,overflow:'visible',pointerEvents:'none'}}>
        <defs><filter id={`sh-${bubble.id}`} x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="1" dy="2" stdDeviation="3" floodOpacity="0.12"/></filter></defs>
        <g filter={`url(#sh-${bubble.id})`}>
          {parts.map((p,i)=>{
            if(p.type==='path') return <path key={i} d={p.d} fill={fill} stroke={sc} strokeWidth={sw} strokeLinejoin="round"/>;
            if(p.type==='ellipse') return <ellipse key={i} cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} fill={fill} stroke={sc} strokeWidth={sw}/>;
            if(p.type==='circle') return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={fill} stroke={sc} strokeWidth={sw}/>;
            return null;
          })}
        </g>
        {isSelected&&<rect x={-3} y={-3} width={w+16} height={totalH+4} fill="none" stroke="#fbbf24" strokeWidth={2} strokeDasharray="5 3" rx={5}/>}
      </svg>
      {isEditing?(
        <textarea autoFocus value={text} onChange={e=>onTextChange(e.target.value)} onBlur={onBlur}
          onMouseDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} placeholder="Type here…"
          style={{position:'absolute',top:isRound?h*0.12:10,left:isShout?w*0.18:14,width:isShout?w*0.64:w-28,height:isRound?h*0.72:h-20,background:'transparent',border:'1px dashed rgba(0,0,0,0.2)',outline:'none',resize:'none',fontFamily:ff,fontWeight:txtWeight,fontStyle:txtStyle,textDecoration:txtDecor,fontSize:txtSz,color:textColor||'#1e293b',textAlign:'center',padding:4,cursor:'text',borderRadius:4,lineHeight:'1.4'}}/>
      ):text?(
        <div style={{position:'absolute',top:isRound?h*0.12:8,left:isShout?w*0.18:12,width:isShout?w*0.64:w-24,height:isRound?h*0.72:h-16,display:'flex',alignItems:'flex-start',justifyContent:'center',fontFamily:ff,fontWeight:txtWeight,fontStyle:txtStyle,textDecoration:txtDecor,fontSize:txtSz,color:textColor||'#1e293b',textAlign:'center',wordBreak:'break-word',overflowY:'auto',overflowX:'hidden',lineHeight:'1.45',pointerEvents:'none',padding:'2px 2px 4px'}}>{text}</div>
      ):(
        <div style={{position:'absolute',top:'35%',left:'50%',transform:'translate(-50%,-50%)',fontSize:10,color:'rgba(100,100,100,0.4)',pointerEvents:'none',whiteSpace:'nowrap'}}>dbl-click to type</div>
      )}
      {isSelected&&!isEditing&&(
        <div onMouseDown={e=>{e.stopPropagation();onResizeDown(e);}}
          onTouchStart={e=>{e.stopPropagation();e.preventDefault();onResizeDown(e);}}
          style={{position:'absolute',right:0,bottom:2,width:18,height:18,background:'#fbbf24',cursor:'se-resize',borderRadius:3,zIndex:20,touchAction:'none'}}/>
      )}
    </div>
  );
}

function RenameInput({value,onChange,onBlur,style}) {
  return <input autoFocus value={value} onChange={e=>onChange(e.target.value)} onBlur={onBlur}
    onMouseDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()}
    onKeyDown={e=>{if(e.key==='Enter'||e.key==='Escape')e.target.blur();}}
    style={{background:'rgba(255,255,255,0.9)',border:'1px solid #3b82f6',borderRadius:4,outline:'none',textAlign:'center',fontSize:11,fontWeight:700,padding:'1px 4px',width:'100%',...style}}/>;
}

function BorderLabel({label,isSelected,isEditing,onMouseDown,onResizeDown,onDoubleClick,onTextChange,onBlur}) {
  return (
    <div onMouseDown={onMouseDown} onDoubleClick={onDoubleClick}
      style={{position:'absolute',top:0,left:0,minWidth:label.manualWidth||60,width:label.manualWidth||'auto',minHeight:26,height:label.manualHeight||'auto',backgroundColor:label.color||'#3b82f6',color:'#fff',fontWeight:700,fontSize:12,fontFamily:'Arial,sans-serif',padding:'4px 10px',borderRadius:'4px 0 4px 0',cursor:isEditing?'text':'move',userSelect:'none',zIndex:10,boxSizing:'border-box',outline:isSelected?'2px solid #fbbf24':'none',whiteSpace:label.manualWidth?'normal':'pre',wordBreak:'break-word',display:'flex',alignItems:'flex-start'}}>
      {isEditing
        ?<textarea autoFocus value={label.text} onChange={e=>onTextChange(e.target.value)} onBlur={onBlur} onMouseDown={e=>e.stopPropagation()} onClick={e=>e.stopPropagation()} style={{background:'transparent',border:'none',outline:'none',color:'#fff',fontWeight:700,fontSize:12,fontFamily:'Arial,sans-serif',resize:'none',width:label.manualWidth?label.manualWidth-20:120,minWidth:60,minHeight:18,padding:0}} rows={1}/>
        :<span style={{lineHeight:'1.4'}}>{label.text||'Label'}</span>
      }
      {isSelected&&!isEditing&&<div onMouseDown={e=>{e.stopPropagation();onResizeDown(e);}} style={{position:'absolute',right:0,bottom:0,width:11,height:11,background:'#fbbf24',cursor:'se-resize',borderRadius:'2px 0 2px 0',zIndex:20}}/>}
    </div>
  );
}


// --- DiagramShareModal - reusable share sheet for any diagram -----------------
function DiagramShareModal({ diagram, darkMode, onClose }) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent=darkMode?'#67e8f9':'#2563eb';

  const [previewUrl,setPreviewUrl]=useState(null);
  // status: idle | uploading | ready | error
  const [uploadStatus,setUploadStatus]=useState('idle');
  const [publicUrl,setPublicUrl]=useState(null);
  const [uploadErr,setUploadErr]=useState(null);

  const buildImageFromDetail=()=>{
    const detail=DIAGRAM_DETAILS[diagram.id]||FEED_DIAGRAM_DETAILS[diagram.id];
    if(!detail||!detail.nodes||!detail.nodes.length) return null;
    const {nodes,edges}=detail;
    const pad=32;
    const minX=Math.min(...nodes.map(n=>n.x))-pad;
    const minY=Math.min(...nodes.map(n=>n.y))-pad;
    const maxX=Math.max(...nodes.map(n=>n.x+n.w))+pad;
    const maxY=Math.max(...nodes.map(n=>n.y+n.h))+pad;
    const W=maxX-minX, H=maxY-minY, scale=3;
    const cnv=document.createElement('canvas');
    cnv.width=W*scale; cnv.height=H*scale;
    const ctx=cnv.getContext('2d');
    ctx.scale(scale,scale);
    ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,W,H);
    ctx.fillStyle='rgba(37,99,235,0.07)';
    for(let x=0;x<W;x+=20) for(let y=0;y<H;y+=20){ctx.beginPath();ctx.arc(x,y,1.2,0,Math.PI*2);ctx.fill();}
    if(edges) edges.forEach(([a,b])=>{
      const from=nodes[a],to=nodes[b]; if(!from||!to) return;
      const x1=from.x+from.w/2-minX, y1=from.y+from.h-minY;
      const x2=to.x+to.w/2-minX, y2=to.y-minY, my=(y1+y2)/2;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.bezierCurveTo(x1,my,x2,my,x2,y2);
      ctx.strokeStyle='rgba(59,130,246,0.6)'; ctx.lineWidth=2;
      ctx.setLineDash([5,3]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle='rgba(59,130,246,0.7)';
      ctx.beginPath(); ctx.moveTo(x2,y2); ctx.lineTo(x2-6,y2-9); ctx.lineTo(x2+6,y2-9); ctx.closePath(); ctx.fill();
    });
    nodes.forEach(n=>{
      const x=n.x-minX, y=n.y-minY, r=10;
      ctx.shadowColor='rgba(0,0,0,0.15)'; ctx.shadowBlur=10; ctx.shadowOffsetY=4;
      ctx.beginPath();
      ctx.moveTo(x+r,y); ctx.lineTo(x+n.w-r,y); ctx.quadraticCurveTo(x+n.w,y,x+n.w,y+r);
      ctx.lineTo(x+n.w,y+n.h-r); ctx.quadraticCurveTo(x+n.w,y+n.h,x+n.w-r,y+n.h);
      ctx.lineTo(x+r,y+n.h); ctx.quadraticCurveTo(x,y+n.h,x,y+n.h-r);
      ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
      ctx.fillStyle=n.color; ctx.fill();
      ctx.shadowColor='transparent'; ctx.shadowBlur=0; ctx.shadowOffsetY=0;
      ctx.fillStyle='rgba(255,255,255,0.15)'; ctx.fillRect(x+5,y+4,n.w-10,n.h*0.3);
      ctx.strokeStyle='rgba(0,0,0,0.12)'; ctx.lineWidth=1.5; ctx.stroke();
      const iconSize=Math.round(n.h*0.4);
      ctx.font=iconSize+'px Arial'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillStyle='#ffffff'; ctx.fillText(n.icon,x+n.w/2,y+n.h*0.42);
      const lblSize=Math.max(9,Math.round(n.h*0.19));
      ctx.font='bold '+lblSize+'px Inter,Arial,sans-serif';
      ctx.fillStyle='#ffffff'; ctx.fillText(n.label,x+n.w/2,y+n.h*0.81);
    });
    ctx.fillStyle='rgba(37,99,235,0.08)'; ctx.fillRect(0,H-26,W,26);
    ctx.font='bold 10px Inter,Arial,sans-serif'; ctx.fillStyle='rgba(37,99,235,0.5)';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('Made with CloudForger - cloudforger.app',W/2,H-13);
    return cnv.toDataURL('image/png',1.0);
  };

  // Upload to Cloudinary (free unsigned upload - works from any browser, no backend needed)
  const uploadToCloudinary=async(dataUrl)=>{
    const base64=dataUrl.split(',')[1];
    const fd=new FormData();
    fd.append('file','data:image/png;base64,'+base64);
    fd.append('upload_preset','archforge_share'); // unsigned preset
    fd.append('cloud_name','archforge');
    const res=await fetch('https://api.cloudinary.com/v1_1/archforge/image/upload',{method:'POST',body:fd});
    if(!res.ok) throw new Error('Upload failed: '+res.status);
    const json=await res.json();
    return json.secure_url;
  };

  // Also try imgbb as fallback
  const uploadToImgbb=async(dataUrl)=>{
    const base64=dataUrl.split(',')[1];
    const fd=new FormData();
    fd.append('image',base64);
    // Free public API key from imgbb.com
    const res=await fetch('https://api.imgbb.com/1/upload?key=6d207e02198a847aa98d0a2a901485a2',{method:'POST',body:fd});
    if(!res.ok) throw new Error('imgbb failed');
    const json=await res.json();
    if(!json.success) throw new Error('imgbb error');
    return json.data.url;
  };

  useEffect(()=>{
    // Build preview + auto-start upload
    setTimeout(async()=>{
      const url=buildImageFromDetail();
      if(!url) return;
      setPreviewUrl(url);
      // Auto-upload so LinkedIn URL is ready when user clicks
      setUploadStatus('uploading');
      try{
        let pubUrl=null;
        // Try Cloudinary first, then imgbb
        try{ pubUrl=await uploadToCloudinary(url); }catch(_){
          try{ pubUrl=await uploadToImgbb(url); }catch(e2){ throw e2; }
        }
        setPublicUrl(pubUrl);
        setUploadStatus('ready');
      }catch(e){
        console.warn('Upload failed:',e);
        setUploadStatus('error');
        setUploadErr(e.message);
      }
    },0);
  },[]);

  const shareToLinkedIn=()=>{
    if(publicUrl){
      // LinkedIn fetches this URL and shows the image as a rich preview in the post
      const title=encodeURIComponent(diagram.title||'AWS Architecture Diagram');
      const summary=encodeURIComponent('Built with CloudForger - cloud architecture diagrams');
      const url=encodeURIComponent(publicUrl);
      window.open(
        'https://www.linkedin.com/sharing/share-offsite/?url='+url+'&title='+title+'&summary='+summary,
        '_blank','noopener,noreferrer,width=600,height=600'
      );
    } else {
      // Fallback: open LinkedIn post composer with text
      const caption=encodeURIComponent('Check out my AWS architecture diagram "'+( diagram.title||'Untitled')+'" built with CloudForger! #AWS #CloudArchitecture');
      window.open('https://www.linkedin.com/feed/?shareActive=true&text='+caption,'_blank','noopener,noreferrer');
    }
    onClose();
  };

  const shareToFacebook=()=>{
    if(publicUrl){
      window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(publicUrl),'_blank','noopener,noreferrer,width=600,height=600');
    } else {
      const caption=encodeURIComponent('Check out my AWS architecture diagram "'+( diagram.title||'Untitled')+'" built with CloudForger!');
      window.open('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent('https://cloudforger.app')+'&quote='+caption,'_blank','noopener,noreferrer');
    }
    onClose();
  };

  const downloadImage=()=>{
    const url=previewUrl||buildImageFromDetail(); if(!url) return;
    const a=document.createElement('a'); a.download=(diagram.title||'diagram')+'.png'; a.href=url;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const nativeShare=()=>{
    const url=previewUrl||buildImageFromDetail(); if(!url) return;
    fetch(url).then(r=>r.blob()).then(blob=>{
      const file=new File([blob],(diagram.title||'diagram')+'.png',{type:'image/png'});
      if(navigator.canShare&&navigator.canShare({files:[file]})){
        navigator.share({files:[file],title:diagram.title||'Diagram',text:'Check out my AWS architecture diagram built with CloudForger!'})
          .catch(()=>{});
      } else { downloadImage(); }
    });
  };

  const statusColor=uploadStatus==='ready'?'#10b981':uploadStatus==='error'?'#ef4444':'#f59e0b';
  const statusText=uploadStatus==='uploading'?'Uploading image for LinkedIn/Facebook embed...':uploadStatus==='ready'?'Image ready - LinkedIn/Facebook will show it as a post preview!':uploadStatus==='error'?'Could not upload image. LinkedIn will open without embedded image.':'';

  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.72)',zIndex:600,display:'flex',alignItems:'center',justifyContent:'center',padding:'16px'}}>
      <div style={{background:cardBg,borderRadius:20,width:'100%',maxWidth:500,maxHeight:'92vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.45)'}}>

        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 18px 0'}}>
          <span style={{fontSize:16,fontWeight:800,color:textC}}>Share Diagram</span>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:22,lineHeight:1}}>x</button>
        </div>

        {/* Diagram preview image */}
        <div style={{margin:'14px 18px 0',borderRadius:14,overflow:'hidden',border:'1px solid '+borderC,background:'#f0f4ff',position:'relative',minHeight:120}}>
          {previewUrl
            ?<img src={previewUrl} alt={diagram.title||'Diagram'} style={{width:'100%',display:'block'}}/>
            :<div style={{height:140,display:'flex',alignItems:'center',justifyContent:'center',color:textMut,fontSize:13}}>Building preview...</div>}
        </div>

        {/* Upload status bar */}
        {uploadStatus!=='idle'&&(
          <div style={{margin:'10px 18px 0',padding:'8px 12px',borderRadius:9,background:uploadStatus==='ready'?'#d1fae5':uploadStatus==='error'?'#fee2e2':'#fef3c7',border:'1px solid '+(uploadStatus==='ready'?'#6ee7b7':uploadStatus==='error'?'#fca5a5':'#fde68a'),display:'flex',alignItems:'center',gap:8}}>
            {uploadStatus==='uploading'&&<div style={{width:14,height:14,border:'2px solid #f59e0b',borderTop:'2px solid transparent',borderRadius:'50%',animation:'spin 0.8s linear infinite',flexShrink:0}}/>}
            <span style={{fontSize:12,fontWeight:600,color:uploadStatus==='ready'?'#065f46':uploadStatus==='error'?'#991b1b':'#92400e',lineHeight:1.4}}>{statusText}</span>
          </div>
        )}

        {/* Platform buttons */}
        <div style={{padding:'16px 18px 6px'}}>
          <div style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:12}}>Share to platform</div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>

            {/* LinkedIn - uses public URL for image embed */}
            <button onClick={shareToLinkedIn} disabled={uploadStatus==='uploading'}
              style={{padding:'14px 12px',borderRadius:13,border:'none',background:'#0A66C2',color:'#fff',cursor:uploadStatus==='uploading'?'wait':'pointer',opacity:uploadStatus==='uploading'?0.6:1,fontSize:14,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:8,position:'relative'}}>
              <span style={{fontSize:18,fontWeight:900,fontFamily:'Georgia,serif'}}>in</span>
              <div>
                <div>LinkedIn</div>
                <div style={{fontSize:10,fontWeight:400,opacity:0.85}}>{uploadStatus==='ready'?'Image embedded in post':uploadStatus==='uploading'?'Uploading...':'Open composer'}</div>
              </div>
            </button>

            {/* Facebook - uses public URL for image embed */}
            <button onClick={shareToFacebook} disabled={uploadStatus==='uploading'}
              style={{padding:'14px 12px',borderRadius:13,border:'none',background:'#1877F2',color:'#fff',cursor:uploadStatus==='uploading'?'wait':'pointer',opacity:uploadStatus==='uploading'?0.6:1,fontSize:14,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
              <span style={{fontSize:18,fontWeight:900,fontFamily:'Georgia,serif'}}>f</span>
              <div>
                <div>Facebook</div>
                <div style={{fontSize:10,fontWeight:400,opacity:0.85}}>{uploadStatus==='ready'?'Image embedded in post':uploadStatus==='uploading'?'Uploading...':'Open share'}</div>
              </div>
            </button>

            {/* Instagram - download + camera roll */}
            <button onClick={()=>{downloadImage();onClose();}}
              style={{padding:'14px 12px',borderRadius:13,border:'none',background:'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)',color:'#fff',cursor:'pointer',fontSize:14,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
              <span style={{fontSize:18}}>IG</span>
              <div>
                <div>Instagram</div>
                <div style={{fontSize:10,fontWeight:400,opacity:0.85}}>Download to camera roll</div>
              </div>
            </button>

            {/* TikTok - download + camera roll */}
            <button onClick={()=>{downloadImage();onClose();}}
              style={{padding:'14px 12px',borderRadius:13,border:'none',background:'#010101',color:'#fff',cursor:'pointer',fontSize:14,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
              <span style={{fontSize:18}}>TT</span>
              <div>
                <div>TikTok</div>
                <div style={{fontSize:10,fontWeight:400,opacity:0.85}}>Download to camera roll</div>
              </div>
            </button>
          </div>
        </div>

        {/* Download + native share row */}
        <div style={{padding:'0 18px 22px',display:'flex',gap:10}}>
          <button onClick={downloadImage} style={{flex:1,padding:'11px',borderRadius:11,border:'1.5px solid '+borderC,background:'transparent',color:textC,cursor:'pointer',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
            Download PNG
          </button>
          <button onClick={nativeShare} style={{flex:1,padding:'11px',borderRadius:11,border:'1.5px solid '+borderC,background:'transparent',color:textC,cursor:'pointer',fontSize:13,fontWeight:700}}>
            Share via...
          </button>
        </div>

        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>
    </div>
  );
}
// =============================================================================
// DIAGRAM LIBRARY - localStorage-first, S3-ready
// =============================================================================
// Storage schema (localStorage key: 'archforge_diagrams'):
//   [{id, title, provider, createdAt, updatedAt, thumbnail (dataURL),
//     elements, connections, borders, labels, icons, bubbles, texts, isPublic}]
// When S3 backend is ready: swap readLibrary/writeLibrary to API calls.
// =============================================================================

const LIBRARY_KEY='archforge_diagrams';

// --- API <-> local entry shape ------------------------------------------------
// The backend stores most of a diagram's content inside one canvas_data JSON
// column, plus a handful of flat fields (title, visibility, thumbnail_url...).
// Every other part of this app (Feed cards, the library picker, comparison,
// etc.) already expects one flat object with elements/connections/thumbnail/
// nodes/edges all at the top level — so these two functions are the only
// place that bridges between the two shapes, keeping every other component
// unchanged.
// Lightweight version for list/browsing results — GET /users/{id}/diagrams
// intentionally only returns summary fields (title, thumbnail, counts), not
// the full canvas_data, so this stays fast for browsing. Actually opening a
// diagram to edit fetches its full data separately — see loadFromLibrary.
function apiToLightEntry(d){
  return {
    id:d.diagram_id,
    title:d.title,
    thumbnail:d.thumbnail_url||null,
    isPublic:d.visibility==='public',
    category:d.category,
    tags:d.tags?(typeof d.tags==='string'?JSON.parse(d.tags):d.tags):[],
    viewCount:d.view_count||0,
    likeCount:d.like_count||0,
    commentCount:d.comment_count||0,
    saveCount:d.save_count||0,
    updatedAt:d.updated_at?new Date(d.updated_at).getTime():Date.now(),
    elements:[],connections:[],borders:[],nodes:[],edges:[], // populated only once the diagram is actually opened
    _isLight:true, // marks this as summary-only data, not yet the full diagram
  };
}
function apiToEntry(d){
  const cd=d.canvasData||{};
  return {
    id:d.diagram_id||d.diagramId,
    title:d.title,
    provider:cd.provider||'aws',
    elements:cd.elements||[],
    connections:cd.connections||[],
    borders:cd.borders||[],
    labels:cd.labels||[],
    icons:cd.icons||[],
    bubbles:cd.bubbles||[],
    texts:cd.texts||[],
    thumbnail:d.thumbnail_url||cd.thumbnail||null,
    colors:cd.colors||['#3b82f6','#f59e0b','#10b981'],
    nodes:cd.nodes||[],
    edges:cd.edges||[],
    isPublic:d.visibility==='public',
    animSettings:cd.animSettings,
    createdAt:d.created_at?new Date(d.created_at).getTime():Date.now(),
    updatedAt:d.updated_at?new Date(d.updated_at).getTime():Date.now(),
  };
}
function entryToApiPayload(entry){
  return {
    title:entry.title,
    visibility:entry.isPublic?'public':'private',
    canvasData:{
      provider:entry.provider,
      elements:entry.elements,
      connections:entry.connections,
      borders:entry.borders,
      labels:entry.labels,
      icons:entry.icons,
      bubbles:entry.bubbles,
      texts:entry.texts,
      thumbnail:entry.thumbnail, // embedded for now — moving this to the real S3 presigned-thumbnail flow is a good next increment, not required for save/load to work end-to-end
      colors:entry.colors,
      nodes:entry.nodes,
      edges:entry.edges,
      animSettings:entry.animSettings,
    },
  };
}

// Simple localStorage helpers - no module-level state.
// The App component owns the library in React state (useState).
// These functions only handle persistence - React state is the source of truth.
const _readStorage=()=>{
  try{
    const raw=localStorage.getItem(LIBRARY_KEY);
    if(raw){const p=JSON.parse(raw);if(Array.isArray(p)) return p;}
  }catch(e){}
  try{
    // window.storage is async so we can't use it here synchronously
    // It's used for initial load via useEffect in the App
  }catch(e){}
  return [];
};

const _writeStorage=(diagrams)=>{
  try{localStorage.setItem(LIBRARY_KEY,JSON.stringify(diagrams));}catch(e){}
  try{if(window.storage) window.storage.set(LIBRARY_KEY,JSON.stringify(diagrams)).catch(()=>{});}catch(e){}
};


// --- LibraryPanel -------------------------------------------------------------
// Full-featured panel for browsing, loading, and deleting saved diagrams.
function LibraryPanel({ darkMode, library=[], onClose, onLoad, onDelete, currentDiagramId }) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const surfaceBg=darkMode?'#111827':'#f8fafc';

  const [search,setSearch]=useState('');
  const [confirmDelete,setConfirmDelete]=useState(null);

  const filtered=library.filter(d=>!search||(d.title||'').toLowerCase().includes(search.toLowerCase()));

  const fmt=(ts)=>{
    if(!ts) return '';
    const diff=Date.now()-ts;
    if(diff<60000) return 'Just now';
    if(diff<3600000) return `${Math.floor(diff/60000)}m ago`;
    if(diff<86400000) return `${Math.floor(diff/3600000)}h ago`;
    if(diff<604800000) return `${Math.floor(diff/86400000)}d ago`;
    return new Date(ts).toLocaleDateString();
  };

  const handleDelete=(id)=>{
    onDelete(id);
    setConfirmDelete(null);
  };

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:900,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:cardBg,borderRadius:16,width:'100%',maxWidth:680,maxHeight:'90vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,0.3)'}}>

        {/* Header */}
        <div style={{padding:'18px 20px 14px',borderBottom:`1px solid ${borderC}`,flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
            <div>
              <div style={{fontSize:16,fontWeight:800,color:textC}}>🗂️ My Saved Diagrams</div>
              <div style={{fontSize:11,color:textMut,marginTop:2}}>{library.length} diagram{library.length!==1?'s':''} saved</div>
            </div>
            <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:20,lineHeight:1,padding:4}}>✕</button>
          </div>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Search by name..."
            style={{width:'100%',padding:'9px 12px',borderRadius:9,border:`1px solid ${borderC}`,background:surfaceBg,color:textC,fontSize:13,outline:'none',boxSizing:'border-box'}}/>
        </div>

        {/* Grid */}
        <div style={{flex:1,overflowY:'auto',padding:16}}>
          {filtered.length===0?(
            <div style={{textAlign:'center',padding:'48px 20px'}}>
              <div style={{fontSize:44,marginBottom:12}}>📭</div>
              <div style={{fontSize:15,fontWeight:700,color:textC,marginBottom:8}}>
                {search?'No diagrams match your search':'No saved diagrams yet'}
              </div>
              <div style={{fontSize:12,color:textMut,lineHeight:1.6}}>
                {search?'Try a different search term':'Hit the 💾 Save or 🚀 Post button to save your current diagram'}
              </div>
            </div>
          ):(
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(190px,1fr))',gap:12}}>
              {filtered.map(d=>{
                const isCurrent=d.id===currentDiagramId;
                return(
                  <div key={d.id}
                    style={{borderRadius:12,border:`2px solid ${isCurrent?'#6366f1':borderC}`,overflow:'hidden',background:isCurrent?(darkMode?'rgba(99,102,241,0.06)':'#eef2ff'):cardBg,transition:'all 0.15s',position:'relative'}}>

                    {/* Thumbnail - use real screenshot if available, else SVG diagram preview */}
                    <div style={{height:130,background:darkMode?'#0f172a':'#f8fafc',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden',position:'relative'}}>
                      {d.thumbnail?(
                        <img src={d.thumbnail} alt={d.title} style={{width:'100%',height:'100%',objectFit:'contain'}}/>
                      ):d.nodes?(
                        // Feed-style SVG diagram from nodes data
                        <div style={{width:'100%',height:'100%',padding:'8px',boxSizing:'border-box'}}>
                          <FullDiagramSVG diagram={d} darkMode={darkMode}/>
                        </div>
                      ):d.colors&&d.colors.length?(
                        // Color palette preview from element colors
                        <div style={{width:'100%',height:'100%',padding:'8px',boxSizing:'border-box'}}>
                          <DiagramThumb colors={d.colors.length>=3?d.colors:[...d.colors,'#3b82f6','#f59e0b','#10b981'].slice(0,3)}/>
                        </div>
                      ):(
                        <div style={{fontSize:32,opacity:0.2}}>🏗️</div>
                      )}
                      {isCurrent&&(
                        <div style={{position:'absolute',top:6,right:6,background:'#6366f1',color:'#fff',fontSize:9,fontWeight:800,padding:'2px 7px',borderRadius:10,letterSpacing:'0.04em'}}>CURRENT</div>
                      )}
                    </div>

                    {/* Info */}
                    <div style={{padding:'10px 12px'}}>
                      <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={d.title}>
                        {d.title||'Untitled'}
                      </div>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                        <span style={{fontSize:11,color:textMut}}>{d.elements?.length||0} services</span>
                        <span style={{fontSize:10,color:textMut}}>{fmt(d.updatedAt||d.createdAt)}</span>
                      </div>

                      {/* Actions */}
                      <div style={{display:'flex',gap:6}}>
                        <button onClick={()=>onLoad(d)} disabled={isCurrent}
                          style={{flex:1,padding:'7px',borderRadius:7,border:'none',
                            background:isCurrent?'#9ca3af':'#6366f1',
                            color:'#fff',cursor:isCurrent?'not-allowed':'pointer',
                            fontSize:11,fontWeight:700,transition:'all 0.15s'}}>
                          {isCurrent?'Active':'Load'}
                        </button>
                        <button onClick={()=>setConfirmDelete(d.id)}
                          style={{padding:'7px 10px',borderRadius:7,border:`1px solid ${borderC}`,background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:12,fontWeight:600}}>
                          🗑
                        </button>
                      </div>
                    </div>

                    {/* Delete confirmation overlay */}
                    {confirmDelete===d.id&&(
                      <div style={{position:'absolute',inset:0,background:'rgba(0,0,0,0.75)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10,padding:16,borderRadius:10}}>
                        <div style={{fontSize:12,fontWeight:700,color:'#fff',textAlign:'center'}}>Delete "{d.title}"?</div>
                        <div style={{display:'flex',gap:8}}>
                          <button onClick={()=>handleDelete(d.id)} style={{padding:'7px 16px',borderRadius:7,border:'none',background:'#ef4444',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>Delete</button>
                          <button onClick={()=>setConfirmDelete(null)} style={{padding:'7px 16px',borderRadius:7,border:'1px solid rgba(255,255,255,0.3)',background:'transparent',color:'#fff',cursor:'pointer',fontSize:12}}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- DiagramPickerModal -------------------------------------------------------
// Shows a grid of saved diagrams. User selects one (or more if allowMulti).
// Used by Compare to select Architecture B from saved diagrams.
function DiagramPickerModal({ darkMode, library=[], onSelect, onClose, excludeId=null, excludeTitle=null, title='Select a diagram', allowMulti=false }) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const surfaceBg=darkMode?'#111827':'#f8fafc';

  const [selected,setSelected]=useState(new Set());
  const [search,setSearch]=useState('');
  const hasFeedOptions=(library||[]).some(d=>d.source==='feed');
  const [tab,setTab]=useState('library');

  const isExcluded=d=>d.id===excludeId||(excludeTitle&&d.title===excludeTitle);
  const byTab=(library||[]).filter(d=>hasFeedOptions?(tab==='feed'?d.source==='feed':d.source!=='feed'):true);
  const filtered=byTab.filter(d=>
    !isExcluded(d)&&(!search||d.title.toLowerCase().includes(search.toLowerCase()))
  );

  const toggle=(id)=>{
    if(allowMulti){
      setSelected(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;});
    } else {
      setSelected(new Set([id]));
    }
  };

  const confirm=()=>{
    const picks=(library||[]).filter(d=>selected.has(d.id)&&!isExcluded(d));
    if(picks.length) onSelect(allowMulti?picks:picks[0]);
  };

  const fmt=(ts)=>{
    const dt=new Date(ts);
    const now=Date.now();
    const diff=now-ts;
    if(diff<60000) return 'Just now';
    if(diff<3600000) return `${Math.floor(diff/60000)}m ago`;
    if(diff<86400000) return `${Math.floor(diff/3600000)}h ago`;
    return dt.toLocaleDateString();
  };

  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:1000,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}
      onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:cardBg,borderRadius:16,width:'100%',maxWidth:640,maxHeight:'88vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,0.35)'}}>

        {/* Header */}
        <div style={{padding:'16px 20px',borderBottom:`1px solid ${borderC}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div>
            <div style={{fontSize:15,fontWeight:800,color:textC}}>{title}</div>
            <div style={{fontSize:11,color:textMut,marginTop:2}}>{filtered.length} diagram{filtered.length!==1?'s':''}</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:20,lineHeight:1}}>✕</button>
        </div>

        {hasFeedOptions&&(
          <div style={{display:'flex',gap:6,padding:'10px 20px 0',flexShrink:0}}>
            {[['library','📁 My Library'],['feed','🌐 From Feed']].map(([id,lbl])=>(
              <button key={id} onClick={()=>setTab(id)}
                style={{padding:'7px 14px',borderRadius:8,border:`1px solid ${tab===id?'#6366f1':borderC}`,background:tab===id?(darkMode?'rgba(99,102,241,0.12)':'#eef2ff'):'transparent',color:tab===id?'#6366f1':textMut,cursor:'pointer',fontSize:12,fontWeight:700}}>
                {lbl}
              </button>
            ))}
          </div>
        )}

        {/* Search */}
        <div style={{padding:'10px 20px',borderBottom:`1px solid ${borderC}`,flexShrink:0}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search diagrams…"
            style={{width:'100%',padding:'8px 12px',borderRadius:8,border:`1px solid ${borderC}`,background:surfaceBg,color:textC,fontSize:13,outline:'none',boxSizing:'border-box'}}/>
        </div>

        {/* Grid */}
        <div style={{flex:1,overflowY:'auto',padding:16}}>
          {filtered.length===0?(
            <div style={{textAlign:'center',padding:'40px 20px',color:textMut}}>
              <div style={{fontSize:36,marginBottom:12}}>📭</div>
              <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>{search?'No diagrams match your search':tab==='feed'?'No other Feed diagrams available':'No saved diagrams yet'}</div>
              <div style={{fontSize:12}}>{tab==='feed'?'Check back once more diagrams are posted to Feed':'Save a diagram using the 💾 Save button to see it here'}</div>
            </div>
          ):(
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))',gap:12}}>
              {filtered.map(d=>{
                const isSel=selected.has(d.id);
                return(
                  <div key={d.id} onClick={()=>toggle(d.id)}
                    style={{borderRadius:10,border:`2px solid ${isSel?'#6366f1':borderC}`,overflow:'hidden',cursor:'pointer',background:isSel?(darkMode?'rgba(99,102,241,0.08)':'#eef2ff'):'transparent',transition:'all 0.15s',position:'relative'}}>
                    {/* Thumbnail */}
                    <div style={{height:110,background:darkMode?'#0f172a':'#f8fafc',display:'flex',alignItems:'center',justifyContent:'center',overflow:'hidden'}}>
                      {d.thumbnail?(
                        <img src={d.thumbnail} alt={d.title} style={{width:'100%',height:'100%',objectFit:'contain'}}/>
                      ):d.nodes?(
                        <div style={{width:'100%',height:'100%',padding:'6px',boxSizing:'border-box'}}><FullDiagramSVG diagram={d} darkMode={darkMode}/></div>
                      ):d.colors&&d.colors.length>=3?(
                        <div style={{width:'100%',height:'100%',padding:'6px',boxSizing:'border-box'}}><DiagramThumb colors={d.colors}/></div>
                      ):(
                        <div style={{fontSize:28,opacity:0.25}}>🏗️</div>
                      )}
                    </div>
                    {/* Info */}
                    <div style={{padding:'8px 10px'}}>
                      <div style={{fontSize:12,fontWeight:700,color:textC,marginBottom:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.title||'Untitled'}</div>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                        <span style={{fontSize:10,color:textMut}}>{d.elements?.length||0} services</span>
                        <span style={{fontSize:10,color:textMut}}>{fmt(d.updatedAt||d.createdAt)}</span>
                      </div>
                      {d.provider&&<div style={{fontSize:9,color:textMut,marginTop:2,textTransform:'uppercase',letterSpacing:'0.05em'}}>{d.provider}</div>}
                    </div>
                    {/* Selected check */}
                    {isSel&&(
                      <div style={{position:'absolute',top:8,right:8,width:22,height:22,borderRadius:'50%',background:'#6366f1',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,fontWeight:800}}>✓</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:'12px 20px',borderTop:`1px solid ${borderC}`,display:'flex',gap:10,justifyContent:'flex-end',flexShrink:0}}>
          <button onClick={onClose} style={{padding:'9px 18px',borderRadius:9,border:`1.5px solid ${borderC}`,background:'transparent',color:textMut,cursor:'pointer',fontSize:13,fontWeight:600}}>
            Cancel
          </button>
          <button onClick={confirm} disabled={selected.size===0}
            style={{padding:'9px 20px',borderRadius:9,border:'none',background:selected.size>0?'#6366f1':'#9ca3af',color:'#fff',cursor:selected.size>0?'pointer':'not-allowed',fontSize:13,fontWeight:700}}>
            {allowMulti&&selected.size>1?`Compare ${selected.size} diagrams`:'Select'}{selected.size>0?` "${filtered.find(d=>selected.has([...selected][0]))?.title||''}"`:''} 
          </button>
        </div>
      </div>
    </div>
  );
}

// --- ArchitectureCompareModal -------------------------------------------------
function ArchitectureCompareModal({ darkMode, provider, library=[], elements, borders, labels, connections, bubbles, diagramTitle, currentDiagramId, onClose, callClaude, initialArchA=null, extraPickables=[] }) {
  // Use injected callClaude (from AwsDiagramBuilder scope where API proxy works)
  // Falls back to global callClaudeWithRetry if not provided
  const apiCall = callClaude || callClaudeWithRetry;
  // Architecture A can either be the live canvas (default) or an arbitrary
  // unsaved diagram passed in (e.g. a Feed post), so this modal can be opened
  // from contexts other than "the diagram I currently have open in the Designer".
  const archAData = initialArchA || { title:diagramTitle, provider, elements:elements||[], connections:connections||[], borders:borders||[], labels:labels||[] };
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const surfaceBg=darkMode?'#111827':'#f8fafc';

  const [archB,setArchB]=useState(null); // selected saved diagram
  const [showPicker,setShowPicker]=useState(false);
  const [status,setStatus]=useState('idle');
  const [errorMsg,setErrorMsg]=useState('');
  const [results,setResults]=useState(null);
  const [activeTab,setActiveTab]=useState('compare');
  const [whatifQuery,setWhatifQuery]=useState('');
  const [whatifResult,setWhatifResult]=useState(null);
  const [whatifStatus,setWhatifStatus]=useState('idle');
  const [whatifPage,setWhatifPage]=useState(0);
  const [showResultsScreen,setShowResultsScreen]=useState(false);
  const [showCompareResultsScreen,setShowCompareResultsScreen]=useState(false);
  const [whatifCache,setWhatifCache]=useState({}); // { [questionText]: resultObject }
  const handleClose=()=>{setWhatifCache({});onClose();};
  const whatifResultRef=useRef(null);
  const modalBodyRef=useRef(null);
  // vh units can behave unreliably inside the artifact iframe (its internal viewport isn't
  // guaranteed to match what's visually on screen), so measure real pixel height directly.
  const [viewportH,setViewportH]=useState(typeof window!=='undefined'?window.innerHeight:800);
  useEffect(()=>{
    const onResize=()=>setViewportH(window.innerHeight);
    onResize();
    window.addEventListener('resize',onResize);
    return()=>window.removeEventListener('resize',onResize);
  },[]);
  const modalHeightPx=Math.max(360,Math.min(viewportH-40,viewportH*0.9));
  const forceRepaint=()=>{
    const el=modalBodyRef.current;
    if(!el) return;
    // iOS Safari sometimes fails to repaint newly-added children inside a flex+overflow-auto
    // container until a reflow is forced. Nudging a transform + reading offsetHeight forces one.
    el.style.transform='translateZ(0)';
    void el.offsetHeight;
    el.style.transform='';
    requestAnimationFrame(()=>{ if(el) el.scrollTop=el.scrollTop; });
  };
  useEffect(()=>{
    forceRepaint();
    if(whatifStatus==='done'&&whatifResultRef.current){
      whatifResultRef.current.scrollIntoView({behavior:'smooth',block:'start'});
    }
  },[whatifStatus,whatifResult]);
  useEffect(()=>{
    forceRepaint();
  },[status,results]);
  const [hasMoreBelow,setHasMoreBelow]=useState(false);
  const checkOverflow=()=>{
    const el=modalBodyRef.current;
    if(!el) return;
    setHasMoreBelow(el.scrollHeight-el.scrollTop-el.clientHeight>24);
  };
  const handleBodyScroll=()=>checkOverflow();
  useEffect(()=>{
    const el=modalBodyRef.current;
    if(!el||typeof ResizeObserver==='undefined'){checkOverflow();return;}
    const ro=new ResizeObserver(()=>checkOverflow());
    ro.observe(el);
    // Also observe every direct child, since content height changes (e.g. impacts list growing)
    // don't always trigger a resize on the scroll container itself in every browser.
    Array.from(el.children).forEach(child=>ro.observe(child));
    checkOverflow();
    return()=>ro.disconnect();
  },[status,results,whatifStatus,whatifResult,activeTab]);

  const serialiseArch=(els,bords,lbls,conns,title)=>{
    const svcLines=(els||[]).map(el=>`  - ${el.customName||el.service?.name||el.service?.id||'Unknown'} (${el.service?.id||'?'})`).join('\n');
    const borderLines=(bords||[]).map(b=>{
      const lbl=(lbls||[]).find(l=>l.borderId===b.id);
      return `  - ${lbl?.text||b.label||'Border'}`;
    }).join('\n');
    const connLines=(conns||[]).map(c=>{
      const fromEl=(els||[]).find(e=>e.id===c.from);
      const toEl=(els||[]).find(e=>e.id===c.to);
      return `  - ${fromEl?.customName||fromEl?.service?.name||c.from} -> ${toEl?.customName||toEl?.service?.name||c.to}`;
    }).join('\n');
    return `Architecture: "${title||'Untitled'}"
Services (${(els||[]).length}):
${svcLines||'  (none)'}
Groups/Containers:
${borderLines||'  (none)'}
Connections:
${connLines||'  (none)'}`;
  };

  const buildCompareSystemPrompt=()=>{
    const provA=(archAData.provider||'aws').toLowerCase();
    const provB=(archB?.provider||'aws').toLowerCase();
    const sameProvider=provA===provB;
    const fwA=getFramework(provA);
    const fwB=getFramework(provB);
    const frameworkDimension=sameProvider
      ?{category:`${fwA.name} Score`,explanation:`overall ${fwA.name} alignment`}
      :{category:'Cloud Architecture Score (cross-provider)',explanation:`Architecture A scored against ${fwA.name}; Architecture B scored against ${fwB.name}. Since they use different native frameworks, both are normalised onto one common 0-100 scale covering the criteria every major cloud framework shares — security, reliability, performance, cost efficiency, and operational excellence — so the two numbers are fairly comparable despite coming from different provider ecosystems.`};
    const frameworkRule=sameProvider
      ?`- Both architectures use ${provA.toUpperCase()}, so score the final dimension directly against the ${fwA.name} (its real pillars: ${fwA.pillars.map(p=>p.label).join(', ')}).`
      :`- Architecture A is ${provA.toUpperCase()} (evaluated against ${fwA.name}: ${fwA.pillars.map(p=>p.label).join(', ')}); Architecture B is ${provB.toUpperCase()} (evaluated against ${fwB.name}: ${fwB.pillars.map(p=>p.label).join(', ')}). These are genuinely different rubrics from different providers, so do NOT just relabel one framework as the other. Internally evaluate each architecture against its own provider's real framework, then convert both to a normalised 0-100 "Cloud Architecture Score" using the shared underlying criteria (security, reliability, performance, cost efficiency, operational excellence) so the final numbers are a fair, apples-to-apples comparison rather than two incompatible scales sitting side by side.`;
    return `You are a senior multi-cloud solutions architect comparing two cloud architectures, which may be on the same or different providers (AWS, GCP, Azure).
Return ONLY valid JSON (no markdown, no code fences):
{"title_a":"Architecture A name","title_b":"Architecture B name","summary":"2-3 sentence executive summary of the key tradeoff","scores":[{"category":"Cost","score_a":8,"score_b":5,"max":10,"unit":"/10","label_a":"$","label_b":"$$","explanation":"why one costs more"},{"category":"High Availability","score_a":7,"score_b":10,"max":10,"unit":"/10","label_a":"","label_b":"","explanation":"why"},{"category":"Security","score_a":8,"score_b":9,"max":10,"unit":"/10","label_a":"","label_b":"","explanation":"why"},{"category":"Scalability","score_a":6,"score_b":10,"max":10,"unit":"/10","label_a":"","label_b":"","explanation":"why"},{"category":"Performance","score_a":7,"score_b":9,"max":10,"unit":"/10","label_a":"","label_b":"","explanation":"why"},{"category":"Operational Complexity","score_a":8,"score_b":5,"max":10,"unit":"/10","label_a":"","label_b":"","explanation":"higher score = simpler to operate. why one is simpler"},{"category":"RPO","score_a":5,"score_b":9,"max":10,"unit":"value","label_a":"~1 hour","label_b":"Near zero","explanation":"recovery point objective comparison"},{"category":"RTO","score_a":5,"score_b":9,"max":10,"unit":"value","label_a":"~30 minutes","label_b":"<5 minutes","explanation":"recovery time objective comparison"},{"category":"${frameworkDimension.category}","score_a":78,"score_b":95,"max":100,"unit":"/100","label_a":"","label_b":"","explanation":"${frameworkDimension.explanation}"}],"recommendations":[{"scenario":"Startup MVP","winner":"A","reason":"Lower cost and simpler ops"},{"scenario":"Enterprise production","winner":"B","reason":"Higher resilience and availability"},{"scenario":"Cost optimisation","winner":"A","reason":"Significantly lower monthly spend"},{"scenario":"Regulated industries (HIPAA/PCI)","winner":"B","reason":"Better security posture"},{"scenario":"High traffic SaaS","winner":"B","reason":"Better scalability"},{"scenario":"Learning / prototyping","winner":"A","reason":"Simpler to understand"}],"whatif_examples":["What if I add a CDN layer?","What if I replace the NAT Gateway with a NAT Instance?","What if I switch from EC2 to ECS Fargate?"]}

Rules:
- For Cost: higher score = cheaper architecture. label_a/label_b use $ symbols ($ cheap, $ moderate, $$ expensive, $$ very expensive)
- For RPO/RTO: unit is "value", put time strings in label_a/label_b, keep score_a/score_b for visual bar (higher=better/faster recovery)
- For Operational Complexity: higher score = SIMPLER to operate
${frameworkRule}
- Every score must have a specific explanation referencing actual services in the architectures, using each architecture's own provider's real service names (do not use AWS service names for a GCP or Azure architecture, or vice versa)
- Return ONLY the JSON object, nothing else`;
  };

  const runComparison=async()=>{
    if(!archB){setErrorMsg('Please select Architecture B first.');return;}
    setStatus('comparing');setErrorMsg('');setResults(null);
    const archADesc=serialiseArch(archAData.elements,archAData.borders,archAData.labels,archAData.connections,archAData.title);
    const archBDesc=serialiseArch(archB.elements,archB.borders,archB.labels,archB.connections,archB.title);
    const isValidCompareShape=(p)=>p&&typeof p.summary==='string'&&p.summary.trim()&&Array.isArray(p.scores)&&p.scores.length>=5;
    try{
      let parsed=null;
      for(let attempt=0;attempt<2&&!parsed;attempt++){
        const strictNote=attempt>0?'\n\nYour previous response was incomplete or missing the "scores" array. You MUST return all 9 dimensions in "scores" and a non-empty "summary".':'';
        const raw=await apiCall({
          max_tokens:4000,
          system:buildCompareSystemPrompt(),
          messages:[{role:'user',content:`Compare these two architectures:\n\nARCHITECTURE A:\n${archADesc}\n\nARCHITECTURE B:\n${archBDesc}\n\nReturn the comparison JSON.${strictNote}`}],
        });
        let candidate;
        try{candidate=safeParseJSON(raw);}catch(e){candidate=null;}
        if(isValidCompareShape(candidate)) parsed=candidate;
      }
      if(!parsed) throw new Error('The comparison came back incomplete. Please try again.');
      setResults(parsed);
      setStatus('done');
      setShowCompareResultsScreen(true);
    }catch(e){
      setStatus('error');
      setErrorMsg(e.message||'Comparison failed. Please try again.');
    }
  };

  const runWhatIf=async(directQuery)=>{
    const q=(typeof directQuery==='string'?directQuery:whatifQuery).trim();
    if(!q) return;
    setWhatifQuery(q);
    setWhatifPage(0);

    // Serve instantly from cache if we've already analysed this exact question
    if(whatifCache[q]){
      setWhatifResult(whatifCache[q]);
      setWhatifStatus('done');
      setShowResultsScreen(true);
      return;
    }

    setWhatifStatus('loading');
    setWhatifResult(null);
    const archADesc=serialiseArch(archAData.elements,archAData.borders,archAData.labels,archAData.connections,archAData.title);
    const archBDesc=archB?serialiseArch(archB.elements||[],archB.borders||[],archB.labels||[],archB.connections||[],archB.title||'Architecture B'):'';
    const buildUserMsg=(strict)=>`Architecture A (${archAData.title||'Current'}):\n${archADesc}\n\n${archBDesc?`Architecture B (${archB?.title||'B'}):\n${archBDesc}\n\n`:''}What-if: "${q}"\n\n${strict?'Your previous response was incomplete. You MUST return exactly 7 items in "impacts", one for each required dimension listed below, even if the direction is "neutral". ':''}Return JSON only.`;
    const system=`You are a senior AWS Solutions Architect. Analyse the what-if question and return ONLY this JSON (no markdown, no code fences):
{"change":"brief description of the change","impacts":[{"dimension":"Cost","direction":"decrease","explanation":"specific reason"},{"dimension":"Availability","direction":"neutral","explanation":"specific reason"},{"dimension":"Security","direction":"increase","explanation":"specific reason"},{"dimension":"Performance","direction":"increase","explanation":"specific reason"},{"dimension":"Scalability","direction":"neutral","explanation":"specific reason"},{"dimension":"Operational Complexity","direction":"increase","explanation":"specific reason"},{"dimension":"Latency","direction":"decrease","explanation":"specific reason"}],"recommendation":"one sentence verdict on whether to make this change"}
You MUST return exactly these 7 dimensions every time, in this order: Cost, Availability, Security, Performance, Scalability, Operational Complexity, Latency. Never omit one. If a dimension genuinely would not be affected, still include it with direction "neutral" and a one-sentence explanation of why it's unaffected — do not skip it. direction must be exactly one of: increase, decrease, neutral. The "change" field must never be empty. Each explanation must reference specific services from the architecture, not generic statements.`;
    const isValidShape=(p)=>p&&typeof p.change==='string'&&p.change.trim()&&Array.isArray(p.impacts)&&p.impacts.length>=6;
    try{
      let parsed=null;
      for(let attempt=0;attempt<2&&!parsed;attempt++){
        const raw=await apiCall({max_tokens:2800,system,messages:[{role:'user',content:buildUserMsg(attempt>0)}]});
        let candidate;
        try{candidate=safeParseJSON(raw);}catch(e){candidate=null;}
        if(isValidShape(candidate)) parsed=candidate;
      }
      if(!parsed) throw new Error('The AI returned an incomplete analysis. Please try again.');
      setWhatifResult(parsed);
      setWhatifStatus('done');
      setShowResultsScreen(true);
      setWhatifCache(prev=>({...prev,[q]:parsed}));
    }catch(e){
      console.error('What-if error:',e);
      setWhatifStatus('error');
      setWhatifResult({error:String(e?.message||e)||'Unknown error'});
    }
  };

  const dirColor=(d)=>d==='increase'?'#10b981':d==='decrease'?'#ef4444':'#6b7280';
  const dirIcon=(d)=>d==='increase'?'↑':d==='decrease'?'↓':'→';

  const ScoreBar=({score,max=10,color})=>(
    <div style={{height:6,borderRadius:3,background:darkMode?'#374151':'#e5e7eb',overflow:'hidden',minWidth:60}}>
      <div style={{height:'100%',borderRadius:3,background:color,width:`${Math.round((score/max)*100)}%`,transition:'width 0.6s ease'}}/>
    </div>
  );

  const scoreColor=(s,max)=>{
    const p=s/max;
    return p>=0.8?'#10b981':p>=0.6?'#f59e0b':'#ef4444';
  };

  const winnerOf=(row)=>row.unit==='value'?null:row.score_a>row.score_b?'A':row.score_b>row.score_a?'B':null;

  const fmt=(ts)=>{
    if(!ts) return '';
    const diff=Date.now()-ts;
    if(diff<3600000) return `${Math.floor(diff/60000)||1}m ago`;
    if(diff<86400000) return `${Math.floor(diff/3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  return(
    <div style={{position:'fixed',inset:0,background:darkMode?'#0f172a':'#f1f5f9',zIndex:900,overflowY:'auto',WebkitOverflowScrolling:'touch'}}>
      {/* Sticky header */}
      <div style={{position:'sticky',top:0,zIndex:20,background:'linear-gradient(135deg,#6366f1,#4f46e5)',padding:'18px 22px 14px',boxShadow:'0 4px 20px rgba(0,0,0,0.2)'}}>
        <div style={{maxWidth:760,margin:'0 auto'}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:results?12:0}}>
            <div>
              <div style={{fontSize:18,fontWeight:800,color:'#fff'}}>⚖️ Architecture Comparison</div>
              <div style={{fontSize:12,color:'rgba(255,255,255,0.75)',marginTop:2}}>Compare your diagrams side-by-side across 9 dimensions</div>
            </div>
            <button onClick={handleClose} style={{background:'rgba(255,255,255,0.15)',border:'none',borderRadius:8,color:'#fff',cursor:'pointer',fontSize:18,width:34,height:34,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>✕</button>
          </div>
          {results&&(
            <div style={{display:'flex',gap:4,background:'rgba(0,0,0,0.2)',borderRadius:10,padding:3}}>
              {[['compare','⚖️ Comparison'],['whatif','🔮 What If?']].map(([id,lbl])=>(
                <button key={id} onClick={()=>setActiveTab(id)}
                  style={{flex:1,padding:'7px',borderRadius:8,border:'none',background:activeTab===id?'rgba(255,255,255,0.95)':'transparent',color:activeTab===id?'#4f46e5':'rgba(255,255,255,0.85)',cursor:'pointer',fontSize:11,fontWeight:700,transition:'all 0.15s'}}>
                  {lbl}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Content - plain block flow; the outer container above handles all scrolling.
          No flex:1/minHeight:0/ResizeObserver scroll-chain here, deliberately. */}
      <div style={{maxWidth:760,margin:'0 auto',padding:'18px 22px 60px',display:'flex',flexDirection:'column',gap:16}}>

          {/* SETUP */}
          {status==='idle'&&(
            <>
              {/* Side-by-side arch cards */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,alignItems:'stretch'}}>
                {/* Architecture A */}
                <div style={{background:surfaceBg,borderRadius:10,padding:'12px 14px',border:`2px solid #6366f1`,display:'flex',flexDirection:'column',minHeight:130,minWidth:0}}>
                  <div style={{fontSize:9,fontWeight:700,color:'#6366f1',textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:6}}>Architecture A</div>
                  <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:6,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{archAData.title||'Current Canvas'}</div>
                  <div style={{display:'flex',flexDirection:'column',gap:2}}>
                    {[[archAData.elements.length,'service'],[archAData.connections.length,'connection'],[archAData.borders.length,'group']].map(([n,l])=>(
                      <span key={l} style={{fontSize:11,color:textMut}}><span style={{fontWeight:700,color:'#6366f1'}}>{n}</span> {l}{n!==1?'s':''}</span>
                    ))}
                  </div>
                  <div style={{flex:1}}/>
                  <div style={{fontSize:10,color:textMut,marginTop:8,fontStyle:'italic'}}>{initialArchA?'From Feed':'Currently open canvas'}</div>
                </div>

                {/* Architecture B - picker */}
                <div onClick={()=>setShowPicker(true)}
                  style={{background:archB?surfaceBg:'transparent',borderRadius:10,padding:'12px 14px',border:`2px ${archB?'solid #8b5cf6':'dashed #8b5cf680'}`,cursor:'pointer',transition:'all 0.2s',display:'flex',flexDirection:'column',minHeight:130,minWidth:0,justifyContent:archB?'flex-start':'center'}}
                  onMouseOver={e=>{if(!archB)e.currentTarget.style.background=darkMode?'rgba(139,92,246,0.06)':'#f5f3ff';}}
                  onMouseOut={e=>{if(!archB)e.currentTarget.style.background='transparent';}}>
                  {archB?(
                    <>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:6,marginBottom:6,minWidth:0}}>
                        <div style={{fontSize:9,fontWeight:700,color:'#8b5cf6',textTransform:'uppercase',letterSpacing:'0.07em',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>Architecture B</div>
                        <button onClick={e=>{e.stopPropagation();setArchB(null);}} style={{padding:'2px 7px',borderRadius:5,border:`1px solid ${borderC}`,background:'transparent',color:textMut,cursor:'pointer',fontSize:9,flexShrink:0}}>Change</button>
                      </div>
                      <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:6,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{archB.title||'Untitled'}</div>
                      <div style={{display:'flex',flexDirection:'column',gap:2}}>
                        {[[(archB.elements||[]).length,'service'],[(archB.connections||[]).length,'connection'],[(archB.borders||[]).length,'group']].map(([n,l])=>(
                          <span key={l} style={{fontSize:11,color:textMut}}><span style={{fontWeight:700,color:'#8b5cf6'}}>{n}</span> {l}{n!==1?'s':''}</span>
                        ))}
                      </div>
                      <div style={{flex:1}}/>
                      <div style={{fontSize:10,color:textMut,marginTop:8,fontStyle:'italic'}}>{archB?.source==='feed'?'From Feed':'Saved diagram'}</div>
                    </>
                  ):(
                    <div style={{textAlign:'center'}}>
                      <div style={{fontSize:28,marginBottom:8}}>📂</div>
                      <div style={{fontSize:12,fontWeight:700,color:'#8b5cf6',marginBottom:4}}>Select Architecture B</div>
                      <div style={{fontSize:11,color:textMut}}>Choose from your saved diagrams</div>
                    </div>
                  )}
                </div>
              </div>

              {errorMsg&&(
                <div style={{padding:'10px 14px',borderRadius:8,background:'#fee2e2',fontSize:12,color:'#991b1b'}}>{errorMsg}</div>
              )}

              <button onClick={runComparison} disabled={!archB||!archAData.elements.length}
                style={{padding:'14px',borderRadius:12,border:'none',background:archB&&archAData.elements.length?'linear-gradient(135deg,#6366f1,#4f46e5)':'#9ca3af',color:'#fff',cursor:archB&&archAData.elements.length?'pointer':'not-allowed',fontSize:14,fontWeight:800,boxShadow:archB&&archAData.elements.length?'0 4px 20px rgba(99,102,241,0.4)':'none',transition:'all 0.2s'}}>
                ⚖️ Compare Architectures · 2 credits
              </button>
              <div style={{fontSize:11,color:textMut,textAlign:'center'}}>
                Save diagrams using the 💾 Save button to build your library
              </div>
            </>
          )}

          {/* LOADING */}
          {status==='comparing'&&(
            <div style={{textAlign:'center',padding:'40px 0'}}>
              <div style={{width:40,height:40,border:'3.5px solid rgba(99,102,241,0.2)',borderTop:'3.5px solid #6366f1',borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 16px'}}/>
              <div style={{fontSize:15,fontWeight:700,color:textC,marginBottom:6}}>Comparing architectures…</div>
              <div style={{fontSize:12,color:textMut}}>Evaluating across 9 dimensions</div>
              <div style={{marginTop:16,height:5,borderRadius:3,background:darkMode?'#374151':'#e5e7eb',overflow:'hidden',maxWidth:280,margin:'16px auto 0'}}>
                <div style={{height:'100%',borderRadius:3,background:'linear-gradient(90deg,#6366f1,#8b5cf6)',width:'70%',transition:'width 0.5s ease'}}/>
              </div>
            </div>
          )}

          {status==='error'&&(
            <div style={{padding:'14px',borderRadius:10,background:'#fee2e2',border:'1px solid #fca5a5'}}>
              <div style={{fontSize:13,fontWeight:700,color:'#991b1b',marginBottom:6}}>Comparison failed</div>
              <div style={{fontSize:12,color:'#b91c1c',marginBottom:10}}>{errorMsg}</div>
              <button onClick={()=>{setStatus('idle');setErrorMsg('');}} style={{padding:'6px 14px',borderRadius:7,border:'1px solid #f87171',background:'transparent',color:'#dc2626',cursor:'pointer',fontSize:12,fontWeight:600}}>Try Again</button>
            </div>
          )}

          {/* RESULTS */}
          {status==='done'&&results&&(
            <>
              {activeTab==='compare'&&(
                <>
                  {/* Executive summary */}
                  <div style={{background:darkMode?'rgba(99,102,241,0.08)':'#eef2ff',borderRadius:10,padding:'14px 16px',border:`1px solid ${darkMode?'rgba(99,102,241,0.2)':'#c7d2fe'}`}}>
                    <div style={{fontSize:10,fontWeight:700,color:'#6366f1',textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Executive Summary</div>
                    <div style={{fontSize:13,color:textC,lineHeight:1.7}}>{results.summary}</div>
                  </div>

                  {/* Scoring table */}
                  <div style={{borderRadius:12,border:`1px solid ${borderC}`,overflow:'hidden'}}>
                    <div style={{display:'grid',gridTemplateColumns:'1.3fr 1fr 1fr',background:darkMode?'#111827':'#f1f5f9',padding:'10px 16px',gap:8}}>
                      <div style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em'}}>Category</div>
                      <div style={{fontSize:11,fontWeight:700,color:'#6366f1',textAlign:'center'}}>{results.title_a||archAData.title||'Architecture A'}</div>
                      <div style={{fontSize:11,fontWeight:700,color:'#8b5cf6',textAlign:'center'}}>{results.title_b||archB?.title||'Architecture B'}</div>
                    </div>
                    {(results.scores||[]).map((row,i)=>{
                      const isFinal=i===(results.scores||[]).length-1||/well-architected|architecture score|architecture framework/i.test(row.category||'');
                      const winner=winnerOf(row);
                      const isValue=row.unit==='value';
                      const displayVal=(label,score)=>isValue?label:(row.category==='Cost'?label:`${score}${row.unit||''}`);
                      return(
                        <div key={i} style={{borderTop:`1px solid ${borderC}`,background:isFinal?(darkMode?'rgba(99,102,241,0.14)':'#eef2ff'):(i%2===0?'transparent':(darkMode?'rgba(255,255,255,0.02)':'rgba(0,0,0,0.01)'))}}>
                          <div style={{display:'grid',gridTemplateColumns:'1.3fr 1fr 1fr',padding:'11px 16px',gap:8,alignItems:'center'}}>
                            <div style={{fontSize:isFinal?13:12,fontWeight:isFinal?800:600,color:isFinal?'#6366f1':textC}}>
                              {isFinal?'🏆 ':''}{row.category}
                            </div>
                            {[['A',row.score_a,row.label_a],['B',row.score_b,row.label_b]].map(([side,score,label])=>(
                              <div key={side} style={{display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                                <span style={{fontSize:isFinal?16:13,fontWeight:isFinal?800:700,color:isFinal?(darkMode?'#a5b4fc':'#4f46e5'):(isValue?textC:scoreColor(score,row.max||10))}}>
                                  {displayVal(label,score)}
                                </span>
                                {winner===side&&<span style={{fontSize:9,background:'#10b981',color:'#fff',borderRadius:3,padding:'1px 4px',fontWeight:700}}>BETTER</span>}
                              </div>
                            ))}
                          </div>
                          {row.explanation&&(
                            <div style={{padding:'0 16px 10px',fontSize:11,color:textMut,lineHeight:1.6,fontStyle:'italic'}}>{row.explanation}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Decision guide */}
                  {results.recommendations?.length>0&&(
                    <div>
                      <div style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:10}}>Decision Guide</div>
                      <div style={{display:'flex',flexDirection:'column',gap:6}}>
                        {results.recommendations.map((rec,i)=>(
                          <div key={i} style={{display:'flex',alignItems:'flex-start',gap:10,padding:'9px 12px',borderRadius:8,background:surfaceBg,border:`1px solid ${borderC}`}}>
                            <div style={{width:26,height:26,borderRadius:6,background:rec.winner==='A'?'#6366f1':'#8b5cf6',color:'#fff',fontSize:11,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>{rec.winner}</div>
                            <div>
                              <div style={{fontSize:12,fontWeight:700,color:textC}}>{rec.scenario}</div>
                              <div style={{fontSize:11,color:textMut,marginTop:2}}>{rec.reason}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <button onClick={()=>{setStatus('idle');setResults(null);setArchB(null);setActiveTab('compare');setWhatifResult(null);setWhatifCache({});}}
                    style={{padding:'10px',borderRadius:10,border:`1.5px solid ${borderC}`,background:'transparent',color:textMut,cursor:'pointer',fontSize:12,fontWeight:600}}>
                    ↺ New comparison
                  </button>
                </>
              )}

              {activeTab==='whatif'&&(
                <>
                  <div style={{fontSize:12,color:textMut,lineHeight:1.6}}>
                    Ask a "What if?" question about Architecture A to understand how a change would affect each dimension.
                  </div>
                  {results.whatif_examples?.length>0&&(
                    <div style={{display:'flex',flexDirection:'column',gap:5}}>
                      <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:2}}>Suggested questions</div>
                      {results.whatif_examples.map((ex,i)=>{
                        const isLoadingThis=whatifStatus==='loading'&&whatifQuery===ex;
                        return(
                          <button key={i} onClick={()=>runWhatIf(ex)} disabled={whatifStatus==='loading'}
                            style={{padding:'8px 12px',borderRadius:8,border:`1px solid ${isLoadingThis?'#6366f1':borderC}`,background:'transparent',color:isLoadingThis?'#6366f1':textC,cursor:whatifStatus==='loading'?'default':'pointer',fontSize:12,textAlign:'left',opacity:whatifStatus==='loading'&&!isLoadingThis?0.45:1,display:'flex',alignItems:'center',gap:8}}
                            onMouseOver={e=>{if(whatifStatus!=='loading'){e.currentTarget.style.borderColor='#6366f1';e.currentTarget.style.color='#6366f1';}}}
                            onMouseOut={e=>{if(whatifStatus!=='loading'){e.currentTarget.style.borderColor=borderC;e.currentTarget.style.color=textC;}}}>
                            {isLoadingThis
                              ?<span style={{width:12,height:12,flexShrink:0,border:'2px solid rgba(99,102,241,0.25)',borderTopColor:'#6366f1',borderRadius:'50%',display:'inline-block',animation:'spin 0.7s linear infinite'}}/>
                              :<span>🔮</span>}
                            <span>{ex}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div style={{display:'flex',gap:8}}>
                    <input value={whatifQuery} onChange={e=>setWhatifQuery(e.target.value)}
                      onKeyDown={e=>{if(e.key==='Enter'&&whatifQuery.trim())runWhatIf();}}
                      placeholder={`"What if I replace NAT Gateways with a NAT Instance?"`}
                      style={{flex:1,padding:'10px 12px',borderRadius:10,border:`1.5px solid ${whatifQuery.length>10?'#6366f1':borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:12,outline:'none',fontFamily:'inherit'}}/>
                    <button onClick={()=>runWhatIf()} disabled={(!whatifQuery.trim()&&whatifStatus!=='loading')||whatifStatus==='loading'}
                      style={{padding:'10px 16px',borderRadius:10,border:'none',background:whatifQuery.trim()?'#6366f1':'#9ca3af',color:'#fff',cursor:whatifQuery.trim()?'pointer':'not-allowed',fontSize:12,fontWeight:700,minWidth:80,display:'flex',alignItems:'center',justifyContent:'center',gap:7}}>
                      {whatifStatus==='loading'
                        ?(<><span style={{width:13,height:13,border:'2px solid rgba(255,255,255,0.35)',borderTopColor:'#fff',borderRadius:'50%',display:'inline-block',animation:'spin 0.7s linear infinite'}}/>Thinking…</>)
                        :'Analyse'}
                    </button>
                  </div>
                  {whatifStatus==='done'&&whatifResult&&!whatifResult.error&&(
                    <div ref={whatifResultRef} style={{display:'flex',flexDirection:'column',gap:12}}>
                      <div style={{background:'linear-gradient(135deg,#6366f1,#4f46e5)',borderRadius:16,padding:'16px 18px',color:'#fff'}}>
                        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8,flexWrap:'wrap',gap:8}}>
                          <div style={{fontSize:12,fontWeight:700,opacity:0.9}}>🔮 Impact Analysis</div>
                          <div style={{fontSize:10,fontWeight:700,background:'rgba(255,255,255,0.25)',borderRadius:10,padding:'3px 10px'}}>{(whatifResult.impacts||[]).length} dimensions</div>
                        </div>
                        <div style={{fontSize:14,fontWeight:600,lineHeight:1.5}}>"{whatifResult.change||whatifQuery}"</div>
                      </div>

                      {(whatifResult.impacts||[]).map((imp,i)=>(
                        <div key={i} style={{background:cardBg,borderRadius:12,border:`1px solid ${borderC}`,padding:14,display:'flex',alignItems:'flex-start',gap:12}}>
                          <span style={{fontSize:20,fontWeight:800,color:dirColor(imp.direction),width:24,flexShrink:0,textAlign:'center'}}>{dirIcon(imp.direction)}</span>
                          <div>
                            <span style={{fontSize:13,fontWeight:700,color:textC}}>{imp.dimension}</span>
                            <span style={{fontSize:11,fontWeight:600,color:dirColor(imp.direction),marginLeft:8}}>{imp.direction==='increase'?'Increases':imp.direction==='decrease'?'Decreases':'No change'}</span>
                            <div style={{fontSize:12,color:textMut,marginTop:5,lineHeight:1.6}}>{imp.explanation}</div>
                          </div>
                        </div>
                      ))}

                      {whatifResult.recommendation&&(
                        <div style={{background:darkMode?'rgba(99,102,241,0.1)':'#eef2ff',border:`1px solid ${darkMode?'rgba(99,102,241,0.3)':'#c7d2fe'}`,borderRadius:12,padding:14}}>
                          <div style={{fontSize:11,fontWeight:700,color:'#6366f1',marginBottom:5}}>Verdict</div>
                          <div style={{fontSize:12,color:textC,lineHeight:1.6}}>{whatifResult.recommendation}</div>
                        </div>
                      )}

                      <button onClick={()=>{setWhatifStatus('idle');setWhatifResult(null);setWhatifQuery('');}}
                        style={{padding:'10px',borderRadius:10,border:`1.5px solid ${borderC}`,background:'transparent',color:textMut,cursor:'pointer',fontSize:12,fontWeight:600}}>
                        Ask another question
                      </button>
                    </div>
                  )}
                  {whatifStatus==='error'&&(
                    <div style={{padding:'12px 14px',borderRadius:8,background:'#fee2e2',border:'1px solid #fca5a5'}}>
                      <div style={{fontSize:12,fontWeight:700,color:'#991b1b',marginBottom:4}}>Analysis failed</div>
                      <div style={{fontSize:11,color:'#b91c1c',lineHeight:1.5}}>{whatifResult?.error||'Unknown error. Please try again.'}</div>
                      <button onClick={()=>setWhatifStatus('idle')} style={{marginTop:8,padding:'4px 10px',borderRadius:6,border:'1px solid #f87171',background:'transparent',color:'#dc2626',cursor:'pointer',fontSize:11,fontWeight:600}}>Try Again</button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>

      {/* Diagram picker overlay */}
      {showPicker&&(
        <DiagramPickerModal
          darkMode={darkMode}
          library={[...library,...extraPickables]}
          excludeId={currentDiagramId}
          excludeTitle={archAData.title}
          title="Select Architecture B (saved or from Feed)"
          onSelect={(d)=>{setArchB(d);setShowPicker(false);}}
          onClose={()=>setShowPicker(false)}
        />
      )}
    </div>
  );
}
// --- ValidationPanel ----------------------------------------------------------
// Each provider's own real architecture framework — names, pillars, and weights
// as published by that provider, not a single generic AWS-shaped rubric relabeled.
const CLOUD_FRAMEWORKS = {
  aws: {
    name:'AWS Well-Architected Framework',
    shortName:'AWS Well-Architected',
    pillars:[
      { id:'security',            label:'Security',              weight:0.20, icon:'🔐', color:'#dc2626' },
      { id:'reliability',         label:'Reliability',           weight:0.20, icon:'🔄', color:'#2563eb' },
      { id:'performance',         label:'Performance Efficiency', weight:0.15, icon:'⚡', color:'#7c3aed' },
      { id:'cost',                label:'Cost Optimization',     weight:0.15, icon:'💰', color:'#059669' },
      { id:'operations',          label:'Operational Excellence', weight:0.15, icon:'📊', color:'#d97706' },
      { id:'sustainability',      label:'Sustainability',        weight:0.15, icon:'🌱', color:'#16a34a' },
    ],
  },
  gcp: {
    name:'Google Cloud Architecture Framework',
    shortName:'Google Cloud Architecture',
    pillars:[
      { id:'security',    label:'Security, Privacy & Compliance', weight:0.20, icon:'🔐', color:'#dc2626' },
      { id:'reliability', label:'Reliability',                    weight:0.20, icon:'🔄', color:'#2563eb' },
      { id:'performance', label:'Performance Optimization',       weight:0.20, icon:'⚡', color:'#7c3aed' },
      { id:'cost',        label:'Cost Optimization',              weight:0.20, icon:'💰', color:'#059669' },
      { id:'operations',  label:'Operational Excellence',         weight:0.20, icon:'📊', color:'#d97706' },
    ],
  },
  azure: {
    name:'Microsoft Azure Well-Architected Framework',
    shortName:'Azure Well-Architected',
    pillars:[
      { id:'reliability', label:'Reliability',            weight:0.20, icon:'🔄', color:'#2563eb' },
      { id:'security',    label:'Security',                weight:0.20, icon:'🔐', color:'#dc2626' },
      { id:'cost',        label:'Cost Optimization',      weight:0.20, icon:'💰', color:'#059669' },
      { id:'operations',  label:'Operational Excellence', weight:0.20, icon:'📊', color:'#d97706' },
      { id:'performance', label:'Performance Efficiency', weight:0.20, icon:'⚡', color:'#7c3aed' },
    ],
  },
};
const getFramework=(prov)=>CLOUD_FRAMEWORKS[(prov||'aws').toLowerCase()]||CLOUD_FRAMEWORKS.aws;
const getPillars=(prov)=>getFramework(prov).pillars;
// Kept for any legacy reference — defaults to the AWS pillar set.
const PILLARS = CLOUD_FRAMEWORKS.aws.pillars;

const SEVERITY = {
  critical: { label:'Critical', color:'#ef4444', bg:'#fee2e2', icon:'🔴' },
  warning:  { label:'Warning',  color:'#f59e0b', bg:'#fef3c7', icon:'🟡' },
  suggestion:{ label:'Suggestion', color:'#3b82f6', bg:'#dbeafe', icon:'🔵' },
};

const CERT_TAGS = {
  'SAA-C03': { label:'SAA-C03', color:'#f59e0b' },
  'SAP-C02': { label:'SAP-C02', color:'#8b5cf6' },
  'DVA-C02': { label:'DVA-C02', color:'#10b981' },
};

function ValidationPanel({ darkMode, provider, elements, borders, labels, connections, bubbles, diagramTitle,
  ignoredRecs, setIgnoredRecs, validationEnabled, setValidationEnabled,
  validationResults, setValidationResults, isMobile, onClose, setToast }) {

  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const panelBg=darkMode?'#111827':'#f8fafc';

  const [status,setStatus]=useState('idle'); // idle | validating | done | error
  const [errorMsg,setErrorMsg]=useState('');
  const [activeFilter,setActiveFilter]=useState('all'); // all | critical | warning | suggestion
  const [scoreHistory,setScoreHistory]=useState([]);
  const [ignoreReason,setIgnoreReason]=useState({}); // recId -> reason
  const [showIgnoreMenu,setShowIgnoreMenu]=useState(null); // recId

  const IGNORE_REASONS = ['Intentional by design','Out of scope for this diagram','Handled outside this diagram','Will fix later'];

  const buildDiagramContext = () => {
    const allSvcs=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];
    const elLines = elements.map(el=>{
      const name=el.customName||el.service.name;
      return `  - ${name} (${el.service.id}, category: ${el.service.category})`;
    }).join('\n');

    const borderLines = borders.map(b=>{
      const lbl=labels.find(l=>l.borderId===b.id);
      const name=lbl?.text||'Group';
      const inside=elements.filter(el=>el.x>=b.x&&el.x<=b.x+b.width&&el.y>=b.y&&el.y<=b.y+b.height)
        .map(el=>el.customName||el.service.name).join(', ');
      return `  - "${name}"${inside?` containing: ${inside}`:''}`;
    }).join('\n');

    const connLines = connections.slice(0,40).map(c=>{
      const from=elements.find(e=>e.id===c.from)||borders.find(b=>b.id===c.from);
      const to=elements.find(e=>e.id===c.to)||borders.find(b=>b.id===c.to);
      if(!from||!to) return null;
      const fn=from.customName||from.service?.name||labels.find(l=>l.borderId===from.id)?.text||'?';
      const tn=to.customName||to.service?.name||labels.find(l=>l.borderId===to.id)?.text||'?';
      return `  - ${fn} -> ${tn}`;
    }).filter(Boolean).join('\n');

    const hasMonitoring=elements.some(e=>['cloudwatch','gcmonitoring','azmonitor'].includes(e.service.id));
    const hasLb=elements.some(e=>['elb','gclb','azlb'].includes(e.service.id));
    const hasIam=elements.some(e=>['iam','gciam','azad'].includes(e.service.id));
    const hasWaf=elements.some(e=>['waf','gcarmor','azfirewall'].includes(e.service.id));
    const ec2Count=elements.filter(e=>e.service.id==='ec2').length;
    const hasRds=elements.some(e=>['rds','aurora','cloudsql','azsql'].includes(e.service.id));
    const hasS3=elements.some(e=>['s3','gcs','azblob'].includes(e.service.id));
    const hasCdn=elements.some(e=>['cloudfront','gccdn','azfrontdoor'].includes(e.service.id));
    const hasAutoScale=elements.some(e=>e.customName?.toLowerCase().includes('auto')||e.customName?.toLowerCase().includes('scale'));
    const subnetBorders=borders.filter(b=>{const l=labels.find(lbl=>lbl.borderId===b.id);return l?.text?.toLowerCase().includes('subnet');});
    const privateSubnets=subnetBorders.filter(b=>{const l=labels.find(lbl=>lbl.borderId===b.id);return l?.text?.toLowerCase().includes('private');});
    const hasNat=elements.some(e=>e.customName?.toLowerCase().includes('nat')||e.service.id==='vpc');

    return `Cloud provider: ${provider.toUpperCase()}
Diagram: "${diagramTitle||'Untitled'}"

Services on canvas:
${elLines||'  (none)'}

Groups/subnets/VPCs:
${borderLines||'  (none)'}

Connections/flow:
${connLines||'  (none)'}

Detected patterns:
  - Has load balancer: ${hasLb}
  - Has monitoring: ${hasMonitoring}
  - Has IAM/identity service: ${hasIam}
  - Has WAF/firewall: ${hasWaf}
  - Has CDN: ${hasCdn}
  - Has RDS/database: ${hasRds}
  - Has object storage: ${hasS3}
  - EC2 instance count: ${ec2Count}
  - Private subnet count: ${privateSubnets.length}
  - Has NAT gateway: ${hasNat}
  - Has auto-scaling indicators: ${hasAutoScale}`;
  };

  const buildSystemPrompt = () => {
    const fw=getFramework(provider);
    const pillars=fw.pillars;
    const pillarList=pillars.map((p,i)=>`${i+1}. ${p.label} (${Math.round(p.weight*100)}% weight)`).join('\n');
    const weightFormula=pillars.map(p=>`${p.label}x${p.weight}`).join(' + ');
    const scoresSchema=pillars.map(p=>`    "${p.id}": 7`).join(',\n');
    return `You are a senior ${provider.toUpperCase()} solutions architect and ${fw.name} expert. Analyse the architecture diagram described and return a JSON validation report.

Evaluate against the ${fw.name} — its ${pillars.length} pillars:
${pillarList}

Scoring rules:
- Score each pillar 1-10. Be honest and critical. A diagram missing obvious components should score 4-6.
- The overall score is the weighted average: ${weightFormula}
- Generate 4-8 specific, actionable recommendations
- Each recommendation must reference specific services or patterns visible in the diagram
- Ground every recommendation in ${provider.toUpperCase()}-specific services and terminology — do not use another provider's service names.
${provider==='aws'?'- Include certification exam relevance where applicable (SAA-C03, SAP-C02, DVA-C02)':''}

Return ONLY this exact JSON structure, no markdown, no explanation:
{
  "framework": "${fw.name}",
  "scores": {
${scoresSchema},
    "overall": 6.2
  },
  "summary": "One sentence summary of the architecture's strengths and main gaps.",
  "strengths": ["Strength 1", "Strength 2"],
  "recommendations": [
    {
      "id": "rec_001",
      "pillar": "${pillars[0].id}",
      "severity": "critical",
      "title": "Short title (max 8 words)",
      "description": "Specific, actionable description of the issue and how to fix it. Reference the actual services visible in this diagram. Include impact if not addressed.",
      "fix": "Concrete one-sentence fix instruction.",
      "certTags": ["SAA-C03"],
      "impact": "high"
    }
  ]
}`;
  };

  const validate = async (isRevalidation=false) => {
    if(!validationEnabled) return;
    setStatus('validating');
    setErrorMsg('');

    try {
      const raw = await callClaudeWithRetry({
        system: buildSystemPrompt(),
        messages: [{
          role: 'user',
          content: `Validate this cloud architecture and return the JSON report:\n\n${buildDiagramContext()}`,
        }],
      });

      const result = safeParseJSON(raw);
      if(!result.scores) throw new Error('Invalid response structure - missing scores. Please try again.');

      if(!isRevalidation) setIgnoredRecs(new Set());
      setValidationResults(result);
      setScoreHistory(h=>[...h.slice(-9),{
        ts:Date.now(),
        overall:result.scores.overall,
        label: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),
      }]);
      setStatus('done');

      const overall = result.scores.overall;
      const criticals = result.recommendations?.filter(r=>r.severity==='critical').length||0;
      setToast({
        msg: criticals>0
          ? `Score: ${overall.toFixed(1)}/10 · ${criticals} critical issue${criticals>1?'s':''} found`
          : `Score: ${overall.toFixed(1)}/10 · Architecture looks solid! ✅`,
        type: criticals>0?'info':'success'
      });
      setTimeout(()=>setToast(null),5000);

    } catch(e) {
      console.error('Validation error:',e);
      setStatus('error');
      setErrorMsg(e.message||'Validation failed. Please try again.');
    }
  };

  const ignoreRec = (id, reason) => {
    setIgnoredRecs(prev => new Set([...prev, id]));
    setIgnoreReason(prev => ({...prev, [id]: reason}));
    setShowIgnoreMenu(null);
  };

  const unignoreRec = (id) => {
    setIgnoredRecs(prev => { const n=new Set(prev); n.delete(id); return n; });
    setIgnoreReason(prev => { const n={...prev}; delete n[id]; return n; });
  };

  const generateShareCard = async () => {
    if(!validationResults) return;
    const cnv = document.createElement('canvas');
    cnv.width = 1200; cnv.height = 630;
    const ctx = cnv.getContext('2d');
    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0,0,1200,630);
    // Gradient accent
    const grad = ctx.createLinearGradient(0,0,1200,630);
    grad.addColorStop(0,'rgba(37,99,235,0.15)');
    grad.addColorStop(1,'rgba(124,58,237,0.15)');
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,1200,630);
    // Header
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 52px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('CloudForger Architecture Score', 600, 100);
    // Diagram title
    ctx.fillStyle = '#94a3b8';
    ctx.font = '28px Arial';
    ctx.fillText(`"${diagramTitle||'Untitled'}"`, 600, 150);
    // Overall score
    ctx.fillStyle = validationResults.scores.overall>=8?'#10b981':validationResults.scores.overall>=6?'#f59e0b':'#ef4444';
    ctx.font = 'bold 120px Arial';
    ctx.fillText(validationResults.scores.overall.toFixed(1), 600, 300);
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 32px Arial';
    ctx.fillText('/ 10  Overall Score', 600, 350);
    // Pillar scores
    const pillarsToShow = getPillars(provider);
    const startX = 120;
    const spacing = (1200-240) / (pillarsToShow.length-1);
    pillarsToShow.forEach((p,i) => {
      const x = startX + i*spacing;
      const score = validationResults.scores[p.id]||0;
      ctx.fillStyle = p.color;
      ctx.font = 'bold 36px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(`${score}/10`, x, 430);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '20px Arial';
      ctx.fillText(p.label, x, 460);
    });
    // Branding
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = 'bold 22px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('Built with CloudForger · cloudforger.app', 600, 580);

    const url = cnv.toDataURL('image/png');
    const a = document.createElement('a');
    a.download = `archforge-score-${(diagramTitle||'diagram').toLowerCase().replace(/\s+/g,'-')}.png`;
    a.href = url;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  const scores = validationResults?.scores;
  const recs = validationResults?.recommendations||[];
  const activeRecs = recs.filter(r => {
    if(activeFilter!=='all'&&r.severity!==activeFilter) return false;
    return true;
  });
  const critCount = recs.filter(r=>r.severity==='critical'&&!ignoredRecs.has(r.id)).length;
  const warnCount = recs.filter(r=>r.severity==='warning'&&!ignoredRecs.has(r.id)).length;
  const ignoredCount = ignoredRecs.size;

  // Panel: right side panel on desktop, bottom sheet on mobile
  const panelStyle = isMobile
    ? {position:'absolute',bottom:52,left:0,right:0,zIndex:200,background:cardBg,borderTop:`2px solid #10b981`,borderRadius:'16px 16px 0 0',boxShadow:'0 -8px 40px rgba(0,0,0,0.25)',maxHeight:'80vh',display:'flex',flexDirection:'column',overflow:'hidden'}
    : {position:'absolute',top:0,right:0,bottom:0,zIndex:200,width:380,background:panelBg,borderLeft:`1px solid ${borderC}`,boxShadow:'-4px 0 24px rgba(0,0,0,0.12)',display:'flex',flexDirection:'column',overflow:'hidden'};

  return (
    <div style={panelStyle}>
      {/* Panel header */}
      <div style={{background:'linear-gradient(135deg,#059669,#10b981)',padding:'14px 16px 12px',flexShrink:0}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
          <div>
            <div style={{fontSize:15,fontWeight:800,color:'#fff'}}>✓ Architecture Validation</div>
            <div style={{fontSize:11,color:'rgba(255,255,255,0.8)',marginTop:1}}>{getFramework(provider).name}</div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            {/* Enable/disable toggle */}
            <button onClick={()=>setValidationEnabled(v=>!v)} title={validationEnabled?'Disable recommendations':'Enable recommendations'}
              style={{background:'rgba(255,255,255,0.15)',border:'none',cursor:'pointer',color:'#fff',fontSize:10,fontWeight:700,padding:'4px 8px',borderRadius:6,opacity:0.9}}>
              {validationEnabled?'ON':'OFF'}
            </button>
            <button onClick={onClose} style={{background:'rgba(255,255,255,0.15)',border:'none',cursor:'pointer',color:'#fff',fontSize:18,lineHeight:1,borderRadius:6,padding:'3px 8px'}}>✕</button>
          </div>
        </div>
        {/* Score history sparkline */}
        {scoreHistory.length>1&&(
          <div style={{display:'flex',alignItems:'flex-end',gap:2,height:20,marginTop:4}}>
            {scoreHistory.map((h,i)=>(
              <div key={i} style={{flex:1,background:'rgba(255,255,255,0.4)',borderRadius:2,height:`${(h.overall/10)*100}%`,minHeight:2,transition:'height 0.3s'}} title={`${h.label}: ${h.overall.toFixed(1)}`}/>
            ))}
            <span style={{fontSize:9,color:'rgba(255,255,255,0.7)',marginLeft:4,alignSelf:'center',flexShrink:0}}>history</span>
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div style={{flex:1,overflowY:'auto',padding:'12px 14px'}}>

        {/* Idle state */}
        {status==='idle'&&!validationResults&&(
          <div style={{textAlign:'center',padding:'30px 12px'}}>
            <div style={{fontSize:40,marginBottom:10}}>🏗️</div>
            <div style={{fontSize:14,fontWeight:700,color:textC,marginBottom:6}}>Ready to validate</div>
            <div style={{fontSize:12,color:textMut,lineHeight:1.6,marginBottom:16}}>
              Claude will analyse your architecture against the {getFramework(provider).name} and score it across its {getPillars(provider).length} pillars with specific recommendations.
            </div>
            {!validationEnabled&&(
              <div style={{background:'#fef3c7',border:'1px solid #fde68a',borderRadius:8,padding:'8px 12px',marginBottom:12,fontSize:11,color:'#92400e'}}>
                Recommendations are disabled. Toggle ON in the header to enable.
              </div>
            )}
          </div>
        )}

        {/* Validating */}
        {status==='validating'&&(
          <div style={{textAlign:'center',padding:'40px 12px'}}>
            <div style={{width:40,height:40,border:'3px solid rgba(16,185,129,0.2)',borderTop:'3px solid #10b981',borderRadius:'50%',animation:'spin 0.9s linear infinite',margin:'0 auto 14px'}}/>
            <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:4}}>Analysing architecture…</div>
            <div style={{fontSize:11,color:textMut}}>Evaluating against {getFramework(provider).name}</div>
          </div>
        )}

        {/* Error */}
        {status==='error'&&(
          <div style={{background:'#fee2e2',border:'1px solid #fca5a5',borderRadius:9,padding:'12px 14px',marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:'#991b1b',marginBottom:4}}>Validation failed</div>
            <div style={{fontSize:11,color:'#b91c1c',lineHeight:1.5}}>{errorMsg}</div>
          </div>
        )}

        {/* Results */}
        {validationResults&&status!=='validating'&&(<>

          {/* Overall score card */}
          <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'14px',marginBottom:12,textAlign:'center'}}>
            <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:6}}>Overall Score</div>
            <div style={{fontSize:52,fontWeight:900,color:scores.overall>=8?'#10b981':scores.overall>=6?'#f59e0b':'#ef4444',lineHeight:1}}>
              {scores.overall.toFixed(1)}
            </div>
            <div style={{fontSize:13,color:textMut,marginBottom:10}}>/ 10</div>
            <div style={{fontSize:12,color:textC,fontStyle:'italic',lineHeight:1.5,marginBottom:8}}>{validationResults.summary}</div>
            {/* Strengths */}
            {validationResults.strengths?.length>0&&(
              <div style={{textAlign:'left',marginTop:8}}>
                {validationResults.strengths.map((s,i)=>(
                  <div key={i} style={{fontSize:11,color:'#10b981',marginBottom:3}}>✅ {s}</div>
                ))}
              </div>
            )}
          </div>

          {/* Pillar scores grid */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:5,marginBottom:12}}>
            {getPillars(provider).map(p=>{
              const score=scores[p.id]||0;
              const pct=score/10;
              return (
                <div key={p.id} style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:9,padding:'8px 4px',textAlign:'center'}}>
                  <div style={{fontSize:14,marginBottom:3}}>{p.icon}</div>
                  <div style={{position:'relative',height:40,background:darkMode?'#374151':'#f1f5f9',borderRadius:4,overflow:'hidden',marginBottom:4}}>
                    <div style={{position:'absolute',bottom:0,left:0,right:0,height:`${pct*100}%`,background:p.color,borderRadius:4,transition:'height 0.6s ease-out'}}/>
                    <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <span style={{fontSize:11,fontWeight:800,color:'#fff',textShadow:'0 1px 3px rgba(0,0,0,0.5)'}}>{score}</span>
                    </div>
                  </div>
                  <div style={{fontSize:8,fontWeight:700,color:textMut,lineHeight:1.2}}>{p.label}</div>
                </div>
              );
            })}
          </div>

          {/* Filter bar */}
          <div style={{display:'flex',gap:4,marginBottom:10,flexWrap:'wrap'}}>
            {[
              {id:'all',label:`All (${recs.length})`},
              {id:'critical',label:`🔴 ${recs.filter(r=>r.severity==='critical').length}`},
              {id:'warning',label:`🟡 ${recs.filter(r=>r.severity==='warning').length}`},
              {id:'suggestion',label:`🔵 ${recs.filter(r=>r.severity==='suggestion').length}`},
              ...(ignoredCount>0?[{id:'ignored',label:`⚫ ${ignoredCount}`}]:[]),
            ].map(f=>(
              <button key={f.id} onClick={()=>setActiveFilter(f.id)}
                style={{padding:'4px 9px',borderRadius:20,border:`1px solid ${activeFilter===f.id?'#10b981':borderC}`,background:activeFilter===f.id?'#10b981':'transparent',color:activeFilter===f.id?'#fff':textMut,cursor:'pointer',fontSize:10,fontWeight:700,whiteSpace:'nowrap'}}>
                {f.label}
              </button>
            ))}
          </div>

          {/* Recommendations list */}
          {(activeFilter==='ignored'?recs.filter(r=>ignoredRecs.has(r.id)):activeRecs).map(rec=>{
            const isIgnored = ignoredRecs.has(rec.id);
            const sev = SEVERITY[rec.severity]||SEVERITY.suggestion;
            const pillar = getPillars(provider).find(p=>p.id===rec.pillar);
            if(activeFilter!=='ignored'&&isIgnored) return null;
            return (
              <div key={rec.id} style={{background:cardBg,border:`1px solid ${isIgnored?borderC:sev.color+'44'}`,borderLeft:`3px solid ${isIgnored?borderC:sev.color}`,borderRadius:9,padding:'10px 12px',marginBottom:8,opacity:isIgnored?0.5:1,transition:'opacity 0.2s'}}>
                {/* Rec header */}
                <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:8,marginBottom:5}}>
                  <div style={{flex:1}}>
                    <div style={{display:'flex',alignItems:'center',gap:5,flexWrap:'wrap',marginBottom:3}}>
                      <span style={{fontSize:10,fontWeight:700,padding:'2px 6px',borderRadius:4,background:sev.bg,color:sev.color}}>{sev.icon} {sev.label}</span>
                      {pillar&&<span style={{fontSize:10,fontWeight:700,color:pillar.color}}>{pillar.icon} {pillar.label}</span>}
                      {rec.certTags?.map(tag=>(
                        <span key={tag} style={{fontSize:9,padding:'1px 5px',borderRadius:3,background:CERT_TAGS[tag]?.color+'22'||'#e5e7eb',color:CERT_TAGS[tag]?.color||textMut,fontWeight:700}}>{tag}</span>
                      ))}
                    </div>
                    <div style={{fontSize:12,fontWeight:700,color:textC,lineHeight:1.3}}>{rec.title}</div>
                  </div>
                  {/* Ignore / unignore button */}
                  <div style={{position:'relative',flexShrink:0}}>
                    {isIgnored?(
                      <button onClick={()=>unignoreRec(rec.id)} style={{fontSize:10,padding:'3px 7px',borderRadius:5,border:`1px solid ${borderC}`,background:'transparent',color:textMut,cursor:'pointer',whiteSpace:'nowrap'}}>Restore</button>
                    ):(
                      <button onClick={()=>setShowIgnoreMenu(showIgnoreMenu===rec.id?null:rec.id)}
                        style={{fontSize:10,padding:'3px 7px',borderRadius:5,border:`1px solid ${borderC}`,background:'transparent',color:textMut,cursor:'pointer',whiteSpace:'nowrap'}}>Ignore ▾</button>
                    )}
                    {showIgnoreMenu===rec.id&&(
                      <div style={{position:'absolute',right:0,top:26,background:cardBg,border:`1px solid ${borderC}`,borderRadius:8,boxShadow:'0 4px 16px rgba(0,0,0,0.15)',zIndex:300,minWidth:180,padding:4}}>
                        {IGNORE_REASONS.map(reason=>(
                          <button key={reason} onClick={()=>ignoreRec(rec.id,reason)}
                            style={{display:'block',width:'100%',textAlign:'left',padding:'6px 10px',border:'none',background:'transparent',color:textC,cursor:'pointer',fontSize:11,borderRadius:5}}
                            onMouseOver={e=>e.currentTarget.style.background=darkMode?'#374151':'#f1f5f9'}
                            onMouseOut={e=>e.currentTarget.style.background='transparent'}>
                            {reason}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{fontSize:11,color:textMut,lineHeight:1.6,marginBottom:6}}>{rec.description}</div>
                {rec.fix&&<div style={{fontSize:11,color:'#10b981',fontWeight:600,background:'rgba(16,185,129,0.08)',padding:'5px 8px',borderRadius:5}}>💡 {rec.fix}</div>}
                {isIgnored&&ignoreReason[rec.id]&&(
                  <div style={{fontSize:10,color:textMut,marginTop:4,fontStyle:'italic'}}>Ignored: {ignoreReason[rec.id]}</div>
                )}
              </div>
            );
          })}

          {activeRecs.filter(r=>!ignoredRecs.has(r.id)).length===0&&activeFilter!=='ignored'&&(
            <div style={{textAlign:'center',padding:'20px',color:textMut,fontSize:12}}>
              {activeFilter==='all'?'All recommendations have been addressed or ignored ✅':`No ${activeFilter} issues found`}
            </div>
          )}
        </>)}
      </div>

      {/* Footer actions */}
      <div style={{padding:'10px 14px 12px',borderTop:`1px solid ${borderC}`,flexShrink:0,display:'flex',gap:8,flexDirection:'column'}}>
        {validationResults?(
          <>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>validate(true)} disabled={status==='validating'||!validationEnabled}
                style={{flex:1,padding:'9px',borderRadius:9,border:'none',background:status==='validating'||!validationEnabled?'#6b7280':'linear-gradient(135deg,#059669,#10b981)',color:'#fff',cursor:status==='validating'||!validationEnabled?'not-allowed':'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                {status==='validating'?<><div style={{width:12,height:12,border:'2px solid rgba(255,255,255,0.3)',borderTop:'2px solid #fff',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>Validating…</>:'↺ Re-validate'}
              </button>
              <button onClick={generateShareCard}
                style={{padding:'9px 12px',borderRadius:9,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:12,fontWeight:700}}
                title="Download shareable score card">
                📤 Share
              </button>
            </div>
            {critCount>0&&<div style={{fontSize:10,color:'#ef4444',textAlign:'center',fontWeight:600}}>⚠️ {critCount} critical issue{critCount>1?'s':''} · {warnCount} warning{warnCount!==1?'s':''} · score may improve after fixes</div>}
          </>
        ):(
          <button onClick={()=>validate(false)} disabled={status==='validating'||!validationEnabled||(!elements.length&&!borders.length)}
            style={{width:'100%',padding:'11px',borderRadius:10,border:'none',background:status==='validating'||!validationEnabled?'#6b7280':'linear-gradient(135deg,#059669,#10b981)',color:'#fff',cursor:'pointer',fontSize:13,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',gap:7,boxShadow:'0 4px 16px rgba(16,185,129,0.35)'}}>
            {status==='validating'
              ?<><div style={{width:16,height:16,border:'2px solid rgba(255,255,255,0.3)',borderTop:'2px solid #fff',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>Analysing…</>
              :<>✓ Validate Architecture</>
            }
          </button>
        )}
        <div style={{fontSize:10,color:textMut,textAlign:'center'}}>Uses 2 credits · Re-validation 1 credit</div>
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>
    </div>
  );
}

// --- BannerEditorPanel --------------------------------------------------------

// --- Emoji / Icon Library -----------------------------------------------------
const EMOJI_LIBRARY = {
  'Cloud & AWS': ['☁️','🌩️','⚡','🔒','🛡️','🔑','🌐','📡','🖥️','💻','📱','🖨️','💾','💿','📶','🛰️','🌍','🔌','🔋','📺'],
  'Architecture': ['🏗️','🏛️','🏢','🔧','⚙️','🔩','🔨','🪛','🔬','🔭','📐','📏','🗃️','📦','📁','📂','🗄️','🗂️','🧩','🔗'],
  'Data & Flow': ['📊','📈','📉','📋','📌','📍','🔄','♻️','🔃','↩️','↪️','⬆️','⬇️','➡️','⬅️','🔀','🔁','💹','🗺️','📤'],
  'Status': ['✅','❌','⚠️','🔴','🟡','🟢','🔵','🟣','⭕','❗','❓','💡','🔔','🔕','📣','📢','🚨','🚧','🚫','⛔'],
  'Security': ['🔒','🔓','🛡️','🔑','🗝️','🪪','👁️','🕵️','🔐','🔏','🚪','🔍','🔎','💂','🪖','⚔️','🧱','⛓️','🚩','🎭'],
  'Performance': ['🚀','⚡','🏎️','💨','🔥','🌪️','💥','⚙️','🔧','🎯','🏆','🥇','📈','💪','🦾','⏱️','⏰','⌚','🕐','🏃'],
  'Fun & Misc': ['🎉','🎊','🎨','🌈','⭐','🌟','✨','💫','🎯','🃏','🎲','🎮','🕹️','👾','🤖','👻','💎','🌊','🦋','🔮'],
};

function EmojiPickerModal({onSelect,onClose,darkMode,cardBg,textC,textMut,borderC}){
  const [search,setSearch]=React.useState('');
  const [activeTab,setActiveTab]=React.useState(Object.keys(EMOJI_LIBRARY)[0]);
  const allEmojis=Object.values(EMOJI_LIBRARY).flat();
  const filtered=search?allEmojis.filter(e=>e.includes(search)):null;
  const customRef=React.useRef(null);
  return(
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:900,display:'flex',alignItems:'flex-end',justifyContent:'center',padding:0}}>
      <div style={{background:cardBg,borderRadius:'20px 20px 0 0',width:'100%',maxWidth:480,maxHeight:'85vh',display:'flex',flexDirection:'column',boxShadow:'0 -8px 40px rgba(0,0,0,0.3)'}}>
        <div style={{padding:'14px 16px 10px',borderBottom:'1px solid '+borderC,flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
            <span style={{fontSize:14,fontWeight:800,color:textC}}>Icon & Emoji Library</span>
            <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:22,lineHeight:1}}>✕</button>
          </div>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…"
            style={{width:'100%',padding:'7px 10px',borderRadius:8,border:'1px solid '+borderC,background:darkMode?'#1e293b':'#f8fafc',color:textC,fontSize:13,boxSizing:'border-box'}}/>
        </div>
        {!search&&(
          <div style={{display:'flex',overflowX:'auto',borderBottom:'1px solid '+borderC,flexShrink:0,scrollbarWidth:'none'}}>
            {Object.keys(EMOJI_LIBRARY).map(cat=>(
              <button key={cat} onClick={()=>setActiveTab(cat)}
                style={{padding:'7px 10px',border:'none',borderBottom:'2px solid '+(activeTab===cat?'#f59e0b':'transparent'),background:'transparent',color:activeTab===cat?'#f59e0b':textMut,cursor:'pointer',fontSize:10,fontWeight:700,whiteSpace:'nowrap',flexShrink:0}}>
                {cat}
              </button>
            ))}
          </div>
        )}
        <div style={{flex:1,overflowY:'auto',padding:12,display:'grid',gridTemplateColumns:'repeat(8,1fr)',gap:6}}>
          {(filtered||EMOJI_LIBRARY[activeTab]||[]).map((em,i)=>(
            <button key={i} onClick={()=>{onSelect(em);onClose();}}
              style={{height:42,borderRadius:9,border:'1px solid '+borderC,background:'transparent',cursor:'pointer',fontSize:22,display:'flex',alignItems:'center',justifyContent:'center'}}
              onMouseEnter={e=>e.currentTarget.style.background=darkMode?'#374151':'#f1f5f9'}
              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
              {em}
            </button>
          ))}
        </div>
        <div style={{padding:'10px 14px 20px',borderTop:'1px solid '+borderC,flexShrink:0,display:'flex',gap:8,alignItems:'center'}}>
          <span style={{fontSize:11,color:textMut,flexShrink:0}}>Custom:</span>
          <input ref={customRef} placeholder="Paste any emoji or char" style={{flex:1,padding:'7px 10px',borderRadius:7,border:'1px solid '+borderC,background:darkMode?'#1e293b':'#f8fafc',color:textC,fontSize:16}}/>
          <button onClick={()=>{const v=customRef.current?.value?.trim();if(v){onSelect(v);onClose();}}}
            style={{padding:'7px 14px',borderRadius:7,border:'none',background:'#f59e0b',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:800,flexShrink:0}}>
            Use
          </button>
        </div>
      </div>
    </div>
  );
}

const BANNER_FONTS = [
  'Arial','Georgia','Times New Roman','Courier New','Verdana','Trebuchet MS',
  'Impact','Comic Sans MS','Palatino','Garamond','Bookman','Tahoma',
  'Arial Black','Helvetica','Futura',
];
const BANNER_COLORS=['#1e293b','#ffffff','#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#06b6d4','#f97316','#84cc16','#6366f1','#14b8a6','#a855f7','#64748b'];

function BannerEditorPanel({darkMode,isMobile,banner,onUpdate,onDelete,onClose,cardBg,textC,textMut,borderC,accent}){
  const id=banner.id;
  const panelStyle=isMobile
    ?{position:'fixed',bottom:0,left:0,right:0,zIndex:500,background:cardBg,borderTop:'2px solid #f59e0b',borderRadius:'16px 16px 0 0',maxHeight:'78vh',display:'flex',flexDirection:'column',boxShadow:'0 -8px 32px rgba(245,158,11,0.2)'}
    :{position:'absolute',top:52,right:8,zIndex:400,width:270,background:cardBg,border:`1.5px solid #f59e0b`,borderRadius:13,boxShadow:'0 8px 32px rgba(245,158,11,0.18)',display:'flex',flexDirection:'column',maxHeight:'82vh'};

  return(
    <div style={panelStyle} onMouseDown={e=>e.stopPropagation()}>
      {/* Header */}
      <div style={{padding:'12px 14px 10px',flexShrink:0,borderBottom:`1px solid ${borderC}`,display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
        <span style={{fontSize:13,fontWeight:800,color:'#f59e0b'}}>T Text Banner</span>
        <div style={{display:'flex',gap:6,alignItems:'center'}}>
          {/* Done button - places/confirms the text on canvas */}
          <button onClick={onClose}
            style={{padding:'5px 14px',borderRadius:7,border:'none',background:'#f59e0b',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:800}}>
            ✓ Done
          </button>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:18,lineHeight:1}}>✕</button>
        </div>
      </div>

      {/* Hint */}
      <div style={{padding:'6px 14px',background:darkMode?'rgba(245,158,11,0.08)':'rgba(245,158,11,0.06)',borderBottom:`1px solid ${borderC}`,flexShrink:0}}>
        <div style={{fontSize:10,color:'#f59e0b',fontWeight:600}}>📍 Text placed on canvas - drag it to reposition</div>
      </div>

      <div style={{flex:1,overflowY:'auto',padding:'10px 14px 16px',display:'flex',flexDirection:'column',gap:10}}>

        {/* Live preview */}
        <div style={{background:darkMode?'#0f172a':'#f8fafc',borderRadius:9,padding:'12px',border:`1px solid ${borderC}`,textAlign:'center',overflow:'hidden',minHeight:52}}>
          <span style={{fontFamily:banner.fontFamily||'Arial',fontSize:Math.min(banner.fontSize||28,36),fontWeight:banner.fontWeight||'normal',fontStyle:banner.fontStyle||'normal',textDecoration:banner.textDecoration||'none',color:banner.color||'#1e293b',opacity:banner.opacity||1,whiteSpace:'pre',wordBreak:'break-word'}}>
            {banner.text||'Text Banner'}
          </span>
        </div>

        {/* Background fill */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Background</div>
          <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:4}}>
            <button onClick={()=>onUpdate(id,{bgColor:'transparent'})} style={{padding:'4px 8px',borderRadius:6,border:`1.5px solid ${!banner.bgColor||banner.bgColor==='transparent'?'#f59e0b':borderC}`,background:!banner.bgColor||banner.bgColor==='transparent'?'rgba(245,158,11,0.1)':'transparent',color:!banner.bgColor||banner.bgColor==='transparent'?'#f59e0b':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>None</button>
            <input type="color" value={banner.bgColor&&banner.bgColor!=='transparent'?banner.bgColor:'#ffffff'} onChange={e=>onUpdate(id,{bgColor:e.target.value})} style={{width:28,height:26,borderRadius:5,border:`1px solid ${borderC}`,cursor:'pointer',padding:0}}/>
            {banner.bgColor&&banner.bgColor!=='transparent'&&<>
              <span style={{fontSize:10,color:textMut}}>Opacity {Math.round((banner.bgOpacity||0.9)*100)}%</span>
            </>}
          </div>
          {banner.bgColor&&banner.bgColor!=='transparent'&&<input type="range" min={10} max={100} value={Math.round((banner.bgOpacity||0.9)*100)} onChange={e=>onUpdate(id,{bgOpacity:Number(e.target.value)/100})} style={{width:'100%',accentColor:'#f59e0b'}}/>}
        </div>

        {/* Border */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Border</div>
          <div style={{display:'flex',gap:6,alignItems:'center'}}>
            <button onClick={()=>onUpdate(id,{borderColor:'transparent'})} style={{padding:'4px 8px',borderRadius:6,border:`1.5px solid ${!banner.borderColor||banner.borderColor==='transparent'?'#f59e0b':borderC}`,background:!banner.borderColor||banner.borderColor==='transparent'?'rgba(245,158,11,0.1)':'transparent',color:!banner.borderColor||banner.borderColor==='transparent'?'#f59e0b':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>None</button>
            <input type="color" value={banner.borderColor&&banner.borderColor!=='transparent'?banner.borderColor:'#f59e0b'} onChange={e=>onUpdate(id,{borderColor:e.target.value})} style={{width:28,height:26,borderRadius:5,border:`1px solid ${borderC}`,cursor:'pointer',padding:0}}/>
            {banner.borderColor&&banner.borderColor!=='transparent'&&<input type="range" min={1} max={8} value={banner.borderWidth||2} onChange={e=>onUpdate(id,{borderWidth:Number(e.target.value)})} style={{flex:1,accentColor:'#f59e0b'}}/>}
          </div>
        </div>

        {/* Icon prefix */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Icon Prefix</div>
          <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap'}}>
            <button onClick={()=>onUpdate(id,{iconPrefix:''})}
              style={{padding:'5px 10px',borderRadius:7,border:`1.5px solid ${!banner.iconPrefix?'#f59e0b':borderC}`,background:!banner.iconPrefix?'rgba(245,158,11,0.12)':'transparent',color:!banner.iconPrefix?'#f59e0b':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>
              None
            </button>
            {banner.iconPrefix&&<div style={{fontSize:22,lineHeight:1,padding:'3px 7px',borderRadius:7,border:`1.5px solid #f59e0b`,background:'rgba(245,158,11,0.08)'}}>{banner.iconPrefix}</div>}
            <EmojiTriggerBtn onSelect={em=>onUpdate(id,{iconPrefix:em})} darkMode={darkMode} cardBg={cardBg} textC={textC} textMut={textMut} borderC={borderC} label="+ Pick Icon"/>
          </div>
        </div>

        {/* Text input */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:5}}>Text</div>
          <input value={banner.text} onChange={e=>onUpdate(id,{text:e.target.value})}
            style={{width:'100%',padding:'7px 10px',borderRadius:7,border:`1px solid ${borderC}`,background:darkMode?'#1e293b':'#f8fafc',color:textC,fontSize:13,boxSizing:'border-box',fontFamily:banner.fontFamily}}/>
        </div>

        {/* Font family */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:5}}>Font</div>
          <select value={banner.fontFamily||'Arial'} onChange={e=>onUpdate(id,{fontFamily:e.target.value})}
            style={{width:'100%',padding:'7px 10px',borderRadius:7,border:`1px solid ${borderC}`,background:darkMode?'#1e293b':'#f8fafc',color:textC,fontSize:12,cursor:'pointer'}}>
            {BANNER_FONTS.map(f=><option key={f} value={f} style={{fontFamily:f}}>{f}</option>)}
          </select>
        </div>

        {/* Font size */}
        <div>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:5}}>
            <span style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em'}}>Size</span>
            <span style={{fontSize:10,fontWeight:700,color:textC}}>{banner.fontSize||28}px</span>
          </div>
          <input type="range" min={8} max={120} value={banner.fontSize||28}
            onChange={e=>onUpdate(id,{fontSize:Number(e.target.value)})}
            style={{width:'100%',accentColor:'#f59e0b'}}/>
          {/* Quick size buttons */}
          <div style={{display:'flex',gap:4,marginTop:5}}>
            {[12,18,24,32,48,72].map(s=>(
              <button key={s} onClick={()=>onUpdate(id,{fontSize:s})}
                style={{flex:1,padding:'3px',borderRadius:5,border:`1px solid ${(banner.fontSize||28)===s?'#f59e0b':borderC}`,background:(banner.fontSize||28)===s?'rgba(245,158,11,0.1)':'transparent',cursor:'pointer',fontSize:9,fontWeight:700,color:(banner.fontSize||28)===s?'#f59e0b':textMut}}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Style toggles: Bold, Italic, Underline, Strikethrough */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Style</div>
          <div style={{display:'flex',gap:5}}>
            {[
              {label:'B',title:'Bold',prop:'fontWeight',on:'bold',off:'normal',style:{fontWeight:800}},
              {label:'I',title:'Italic',prop:'fontStyle',on:'italic',off:'normal',style:{fontStyle:'italic'}},
              {label:'U',title:'Underline',prop:'textDecoration',on:'underline',off:'none',style:{textDecoration:'underline'}},
              {label:'S',title:'Strikethrough',prop:'textDecoration',on:'line-through',off:'none',style:{textDecoration:'line-through'}},
            ].map(({label,title,prop,on,off,style:s})=>{
              const isOn=banner[prop]===on;
              return(
                <button key={label} title={title} onClick={()=>onUpdate(id,{[prop]:isOn?off:on})}
                  style={{flex:1,padding:'7px',borderRadius:7,border:`1.5px solid ${isOn?'#f59e0b':borderC}`,background:isOn?'rgba(245,158,11,0.12)':'transparent',cursor:'pointer',fontSize:13,color:isOn?'#f59e0b':textC,...s}}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Text align */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Align</div>
          <div style={{display:'flex',gap:5}}>
            {[{id:'left',icon:'⬅'},{id:'center',icon:'↔'},{id:'right',icon:'➡'}].map(a=>(
              <button key={a.id} onClick={()=>onUpdate(id,{align:a.id})}
                style={{flex:1,padding:'6px',borderRadius:7,border:`1.5px solid ${(banner.align||'center')===a.id?'#f59e0b':borderC}`,background:(banner.align||'center')===a.id?'rgba(245,158,11,0.12)':'transparent',cursor:'pointer',fontSize:14,color:(banner.align||'center')===a.id?'#f59e0b':textMut}}>
                {a.icon}
              </button>
            ))}
          </div>
        </div>

        {/* Color */}
        <div>
          <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Colour</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
            {BANNER_COLORS.map(c=>(
              <button key={c} onClick={()=>onUpdate(id,{color:c})} title={c}
                style={{width:24,height:24,borderRadius:6,background:c,border:(banner.color||'#1e293b')===c?'3px solid #f59e0b':c==='#ffffff'?'2px solid #d1d5db':'2px solid transparent',cursor:'pointer',flexShrink:0}}/>
            ))}
            {/* Custom colour picker */}
            <input type="color" value={banner.color||'#1e293b'} onChange={e=>onUpdate(id,{color:e.target.value})}
              style={{width:24,height:24,borderRadius:6,border:`1px solid ${borderC}`,cursor:'pointer',padding:0,flexShrink:0}}/>
          </div>
        </div>

        {/* Opacity */}
        <div>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
            <span style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em'}}>Opacity</span>
            <span style={{fontSize:10,fontWeight:700,color:textC}}>{Math.round((banner.opacity||1)*100)}%</span>
          </div>
          <input type="range" min={10} max={100} value={Math.round((banner.opacity||1)*100)}
            onChange={e=>onUpdate(id,{opacity:Number(e.target.value)/100})}
            style={{width:'100%',accentColor:'#f59e0b'}}/>
        </div>

        {/* Done + Delete row */}
        <div style={{display:'flex',gap:8,marginTop:4}}>
          <button onClick={onClose}
            style={{flex:2,padding:'10px',borderRadius:9,border:'none',background:'#f59e0b',color:'#fff',cursor:'pointer',fontSize:13,fontWeight:800}}>
            ✓ Done
          </button>
          <button onClick={()=>onDelete(id)}
            style={{flex:1,padding:'10px',borderRadius:9,border:`1px solid ${borderC}`,background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:11,fontWeight:600}}>
            🗑 Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// --- AnimationEditorPanel -----------------------------------------------------
const ANIM_COLOR_PRESETS=['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#ec4899','#06b6d4','#f97316','#ffffff','#a5b4fc'];
const DOT_SHAPES=[{id:'circle',icon:'●'},{id:'square',icon:'■'},{id:'diamond',icon:'◆'},{id:'triangle',icon:'▲'},{id:'star',icon:'★'}];
const COLORSHIFT_PRESETS=[{id:'full',label:'Full Spectrum'},{id:'warm',label:'Warm (Red->Amber)'},{id:'cool',label:'Cool (Blue->Teal)'},{id:'neon',label:'Neon (Purple->Pink)'},{id:'mono',label:'Monochrome'}];
const DIR_OPTS=[{id:'forward',label:'-> Forward'},{id:'reverse',label:'← Reverse'},{id:'bidirectional',label:'⇄ Both'}];

// Stable emoji trigger button - defined at module level to avoid remount
function EmojiTriggerBtn({onSelect,darkMode,cardBg,textC,textMut,borderC,label='+ Emoji'}){
  const [open,setOpen]=React.useState(false);
  return(<>
    <button onClick={()=>setOpen(true)}
      style={{padding:'5px 10px',borderRadius:7,border:`1.5px solid #f59e0b`,background:'rgba(245,158,11,0.08)',color:'#f59e0b',cursor:'pointer',fontSize:11,fontWeight:700,flexShrink:0}}>
      {label}
    </button>
    {open&&<EmojiPickerModal onSelect={onSelect} onClose={()=>setOpen(false)} darkMode={darkMode} cardBg={cardBg} textC={textC} textMut={textMut} borderC={borderC}/>}
  </>);
}

// Stable sub-components defined at module level so React doesn't remount on every render
function AELabel({children,textMut}){return <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:5,marginTop:10}}>{children}</div>;}
function AEColorRow({value,onChange,allowNull,borderC}){
  return(
    <div style={{display:'flex',flexWrap:'wrap',gap:5,marginBottom:4}}>
      {allowNull&&<button onClick={()=>onChange(null)} style={{width:22,height:22,borderRadius:5,border:!value?'2px solid #f59e0b':'1px solid '+borderC,background:'linear-gradient(135deg,#ccc,#999)',cursor:'pointer',fontSize:8,color:'#fff',fontWeight:700}} title="Use element colour">auto</button>}
      {ANIM_COLOR_PRESETS.map(c=><button key={c} onClick={()=>onChange(c)} style={{width:22,height:22,borderRadius:5,border:value===c?'2px solid #f59e0b':'1px solid transparent',background:c,cursor:'pointer'}}/>)}
      <input type="color" value={value||'#3b82f6'} onChange={e=>onChange(e.target.value)} style={{width:22,height:22,borderRadius:5,border:'1px solid '+borderC,cursor:'pointer',padding:0}}/>
    </div>
  );
}
function AESlider({label,value,min,max,step=1,onChange,textMut,textC}){
  return(
    <div style={{marginBottom:6}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
        <span style={{fontSize:10,color:textMut}}>{label}</span>
        <span style={{fontSize:10,fontWeight:700,color:textC}}>{value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e=>onChange(Number(e.target.value))}
        style={{width:'100%',accentColor:'#f59e0b'}}/>
    </div>
  );
}
function AEDirPicker({value,onChange,borderC,textMut}){
  return(
    <div style={{display:'flex',gap:4,marginBottom:6}}>
      {DIR_OPTS.map(d=>(
        <button key={d.id} onClick={()=>onChange(d.id)}
          style={{flex:1,padding:'5px 2px',borderRadius:7,border:`1.5px solid ${value===d.id?'#f59e0b':borderC}`,background:value===d.id?'rgba(245,158,11,0.12)':'transparent',color:value===d.id?'#f59e0b':textMut,cursor:'pointer',fontSize:10,fontWeight:700}}>
          {d.label}
        </button>
      ))}
    </div>
  );
}

function AnimationEditorPanel(props) {
  const{darkMode,isMobile,animStyle,cardBg,textC,textMut,borderC,accent,
    animColor,setAnimColor,animDirection,setAnimDirection,
    animDotShape,setAnimDotShape,animDotEmoji,setAnimDotEmoji,animDotSize,setAnimDotSize,
    animGlowRadius,setAnimGlowRadius,animRingCount,setAnimRingCount,
    animOrbitCount,setAnimOrbitCount,animOrbitDir,setAnimOrbitDir,
    animLightningColor,setAnimLightningColor,animLightningFreq,setAnimLightningFreq,
    animLightningDir,setAnimLightningDir,animLightningThickness,setAnimLightningThickness,
    animConstellationColor,setAnimConstellationColor,animConstellationDist,setAnimConstellationDist,
    animColorShiftStart,setAnimColorShiftStart,animColorShiftIntensity,setAnimColorShiftIntensity,
    animColorShiftPreset,setAnimColorShiftPreset,
    animPulseColor,setAnimPulseColor,animPulseRadius,setAnimPulseRadius,animPulseSync,setAnimPulseSync,
    animRippleColor,setAnimRippleColor,animRippleSpeed,setAnimRippleSpeed,
    animPacketLabels,setAnimPacketLabels,animPacketColor,setAnimPacketColor,
    animPacketTextColor,setAnimPacketTextColor,animPacketSize,setAnimPacketSize,
    connAnimOverrides,setConnAnimOverrides,nodeAnimOverrides,setNodeAnimOverrides,
    seqOrder,setSeqOrder,elements,connections,
    selectedAnimObj,setSelectedAnimObj,animEditorTab,setAnimEditorTab,onClose}=props;

  // Shorthand theme helpers passed to sub-components
  const th={textMut,textC,borderC,accent};

  const panelStyle=isMobile
    ?{position:'fixed',bottom:0,left:0,right:0,zIndex:700,background:cardBg,borderTop:'2px solid #f59e0b',borderRadius:'16px 16px 0 0',maxHeight:'88vh',display:'flex',flexDirection:'column',boxShadow:'0 -8px 40px rgba(245,158,11,0.2)'}
    :{position:'absolute',top:0,right:0,bottom:0,zIndex:400,width:320,background:cardBg,borderLeft:`1px solid ${borderC}`,display:'flex',flexDirection:'column',boxShadow:'-4px 0 24px rgba(0,0,0,0.15)'};

  const selConn=selectedAnimObj?.type==='conn'?connections.find(c=>c.id===selectedAnimObj.id):null;
  const selEl=selectedAnimObj?.type==='el'?elements.find(e=>e.id===selectedAnimObj.id):null;
  const updateConnOv=(id,upd)=>setConnAnimOverrides(p=>({...p,[id]:{...(p[id]||{}),...upd}}));
  const updateNodeOv=(id,upd)=>setNodeAnimOverrides(p=>({...p,[id]:{...(p[id]||{}),...upd}}));
  const clearOv=(id,type)=>{
    if(type==='conn')setConnAnimOverrides(p=>{const n={...p};delete n[id];return n;});
    else setNodeAnimOverrides(p=>{const n={...p};delete n[id];return n;});
  };

  const renderGlobal=()=>{
    if(animStyle==='dataflow'||animStyle==='streams'||animStyle==='ping'||animStyle==='heatmap') return(
      <>
        <AELabel {...th}>Global Colour (auto = connection colour)</AELabel>
        <AEColorRow value={animColor} onChange={setAnimColor} allowNull borderC={borderC}/>
        <AELabel {...th}>Flow Direction</AELabel>
        <AEDirPicker value={animDirection} onChange={setAnimDirection} borderC={borderC} textMut={textMut}/>
        {(animStyle==='dataflow'||animStyle==='streams')&&<>
          <AELabel {...th}>Dot Shape</AELabel>
          <div style={{display:'flex',gap:5,marginBottom:6}}>
            {DOT_SHAPES.map(s=>(
              <button key={s.id} onClick={()=>{setAnimDotShape(s.id);setAnimDotEmoji(null);}}
                style={{flex:1,padding:'6px 2px',borderRadius:7,border:`1.5px solid ${animDotShape===s.id&&!animDotEmoji?'#f59e0b':borderC}`,background:animDotShape===s.id&&!animDotEmoji?'rgba(245,158,11,0.12)':'transparent',cursor:'pointer',fontSize:16,color:animDotShape===s.id&&!animDotEmoji?'#f59e0b':textC}}>
                {s.icon}
              </button>
            ))}
          </div>
          <AELabel {...th}>Custom Emoji Dot</AELabel>
          <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:6}}>
            <button onClick={()=>setAnimDotEmoji(null)}
              style={{padding:'5px 10px',borderRadius:7,border:`1.5px solid ${!animDotEmoji?'#f59e0b':borderC}`,background:!animDotEmoji?'rgba(245,158,11,0.12)':'transparent',color:!animDotEmoji?'#f59e0b':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>
              ● Shape
            </button>
            {animDotEmoji&&<div style={{fontSize:24,lineHeight:1,padding:'4px 8px',borderRadius:7,border:`1.5px solid #f59e0b`,background:'rgba(245,158,11,0.08)'}}>{animDotEmoji}</div>}
            <EmojiTriggerBtn onSelect={setAnimDotEmoji} darkMode={darkMode} cardBg={cardBg} textC={textC} textMut={textMut} borderC={borderC} label="+ Pick Emoji"/>
          </div>
          <AESlider label="Dot Size" value={animDotSize} min={2} max={16} onChange={setAnimDotSize} {...th}/>
          <AESlider label="Glow Radius" value={animGlowRadius} min={4} max={30} onChange={setAnimGlowRadius} {...th}/>
        </>}
      </>
    );
    if(animStyle==='pulse') return(
      <>
        <AELabel {...th}>Glow Colour (auto = node colour)</AELabel>
        <AEColorRow value={animPulseColor} onChange={setAnimPulseColor} allowNull borderC={borderC}/>
        <AESlider label="Glow Radius" value={animPulseRadius} min={2} max={30} onChange={setAnimPulseRadius} {...th}/>
        <AELabel {...th}>Sync Mode</AELabel>
        <button onClick={()=>setAnimPulseSync(v=>!v)}
          style={{width:'100%',padding:'7px',borderRadius:8,border:`1.5px solid ${animPulseSync?'#f59e0b':borderC}`,background:animPulseSync?'rgba(245,158,11,0.1)':'transparent',color:animPulseSync?'#f59e0b':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>
          {animPulseSync?'🔁 All pulse together':'🌊 Staggered (default)'}
        </button>
      </>
    );
    if(animStyle==='ripple') return(
      <>
        <AELabel {...th}>Ring Colour (auto = node colour)</AELabel>
        <AEColorRow value={animRippleColor} onChange={setAnimRippleColor} allowNull borderC={borderC}/>
        <AESlider label="Number of Rings" value={animRingCount} min={1} max={6} onChange={setAnimRingCount} {...th}/>
        <AESlider label="Expansion Radius" value={animRippleSpeed} min={20} max={120} onChange={setAnimRippleSpeed} {...th}/>
      </>
    );
    if(animStyle==='orbit') return(
      <>
        <AESlider label="Satellites per Node" value={animOrbitCount} min={1} max={5} onChange={setAnimOrbitCount} {...th}/>
        <AELabel {...th}>Orbit Direction</AELabel>
        <div style={{display:'flex',gap:4}}>
          {[{id:'cw',label:'↻ Clockwise'},{id:'ccw',label:'↺ Counter-CW'}].map(d=>(
            <button key={d.id} onClick={()=>setAnimOrbitDir(d.id)}
              style={{flex:1,padding:'6px',borderRadius:7,border:`1.5px solid ${animOrbitDir===d.id?'#f59e0b':borderC}`,background:animOrbitDir===d.id?'rgba(245,158,11,0.12)':'transparent',color:animOrbitDir===d.id?'#f59e0b':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>
              {d.label}
            </button>
          ))}
        </div>
      </>
    );
    if(animStyle==='lightning') return(
      <>
        <AELabel {...th}>Lightning Colour</AELabel>
        <AEColorRow value={animLightningColor} onChange={setAnimLightningColor} borderC={borderC}/>
        <AELabel {...th}>Direction</AELabel>
        <AEDirPicker value={animLightningDir} onChange={setAnimLightningDir} borderC={borderC} textMut={textMut}/>
        <AESlider label="Flash Frequency" value={animLightningFreq} min={1} max={10} onChange={setAnimLightningFreq} {...th}/>
        <AESlider label="Arc Thickness" value={animLightningThickness} min={1} max={6} onChange={setAnimLightningThickness} {...th}/>
      </>
    );
    if(animStyle==='constellation') return(
      <>
        <AELabel {...th}>Line Colour</AELabel>
        <AEColorRow value={animConstellationColor} onChange={setAnimConstellationColor} borderC={borderC}/>
        <AESlider label="Max Connection Distance (px)" value={animConstellationDist} min={100} max={800} step={20} onChange={setAnimConstellationDist} {...th}/>
      </>
    );
    if(animStyle==='colorshift') return(
      <>
        <AELabel {...th}>Colour Palette</AELabel>
        <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:8}}>
          {COLORSHIFT_PRESETS.map(p=>(
            <button key={p.id} onClick={()=>setAnimColorShiftPreset(p.id)}
              style={{padding:'6px 10px',borderRadius:7,border:`1.5px solid ${animColorShiftPreset===p.id?'#f59e0b':borderC}`,background:animColorShiftPreset===p.id?'rgba(245,158,11,0.1)':'transparent',color:animColorShiftPreset===p.id?'#f59e0b':textC,cursor:'pointer',fontSize:11,fontWeight:700,textAlign:'left'}}>
              {p.label}
            </button>
          ))}
        </div>
        <AESlider label="Starting Hue" value={animColorShiftStart} min={0} max={359} onChange={setAnimColorShiftStart} {...th}/>
        <AESlider label="Intensity" value={Math.round(animColorShiftIntensity*100)} min={2} max={25} onChange={v=>setAnimColorShiftIntensity(v/100)} {...th}/>
      </>
    );
    if(animStyle==='packets') return(
      <>
        <AELabel {...th}>Packet Colour (auto = connection colour)</AELabel>
        <AEColorRow value={animPacketColor} onChange={setAnimPacketColor} allowNull borderC={borderC}/>
        <AELabel {...th}>Text Colour</AELabel>
        <AEColorRow value={animPacketTextColor} onChange={setAnimPacketTextColor} borderC={borderC}/>
        <AELabel {...th}>Direction</AELabel>
        <AEDirPicker value={animDirection} onChange={setAnimDirection} borderC={borderC} textMut={textMut}/>
        <AESlider label="Packet Size" value={Math.round(animPacketSize*10)} min={5} max={20} onChange={v=>setAnimPacketSize(v/10)} {...th}/>
        <AELabel {...th}>Custom Packet Labels</AELabel>
        {animPacketLabels.map((lbl,i)=>(
          <div key={i} style={{display:'flex',gap:4,marginBottom:4}}>
            <input value={lbl} onChange={e=>{const n=[...animPacketLabels];n[i]=e.target.value;setAnimPacketLabels(n);}}
              style={{flex:1,padding:'5px 8px',borderRadius:6,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:11,fontFamily:'monospace'}}/>
            <button onClick={()=>setAnimPacketLabels(p=>p.filter((_,j)=>j!==i))}
              style={{padding:'4px 8px',borderRadius:5,border:'none',background:'#ef4444',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>x</button>
          </div>
        ))}
        <button onClick={()=>setAnimPacketLabels(p=>[...p,'NEW'])}
          style={{width:'100%',padding:'5px',borderRadius:6,border:`1px dashed ${accent}`,background:'transparent',color:accent,cursor:'pointer',fontSize:11,fontWeight:600,marginTop:2}}>
          + Add Label
        </button>
      </>
    );
    if(animStyle==='status') return(
      <div style={{fontSize:12,color:textMut,lineHeight:1.6,padding:'8px 0'}}>
        Status is set per-node. Switch to the <strong style={{color:'#f59e0b'}}>Per Object</strong> tab, click a service node on the canvas, and set its individual health status.
      </div>
    );
    return <div style={{fontSize:12,color:textMut,padding:'12px 0'}}>Select an animation style in the ◎ Animations panel to see its settings here.</div>;
  };

  const renderPerObject=()=>{
    if(!selectedAnimObj) return(
      <div style={{textAlign:'center',padding:'24px 12px'}}>
        <div style={{fontSize:32,marginBottom:8}}>👆</div>
        <div style={{fontSize:12,color:textMut,lineHeight:1.6}}>
          Click any <strong style={{color:textC}}>connection arrow</strong> or <strong style={{color:textC}}>service node</strong> on the canvas to edit its individual animation properties.
        </div>
      </div>
    );
    if(selConn){
      const ov=connAnimOverrides[selConn.id]||{};
      const fromEl=elements.find(e=>e.id===selConn.from);
      const toEl=elements.find(e=>e.id===selConn.to);
      return(
        <>
          <div style={{fontSize:12,fontWeight:700,color:textC,marginBottom:8,padding:'4px 8px',background:darkMode?'#1e293b':'#f1f5f9',borderRadius:7}}>
            {fromEl?.customName||fromEl?.service?.name||'?'} {'->'} {toEl?.customName||toEl?.service?.name||'?'}
          </div>

          {/* Disable animation toggle - sits at the top, most prominent */}
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 12px',borderRadius:9,border:`1.5px solid ${ov.disabled?'#ef4444':borderC}`,background:ov.disabled?'rgba(239,68,68,0.06)':'transparent',marginBottom:8}}>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:ov.disabled?'#ef4444':textC}}>Disable Animation</div>
              <div style={{fontSize:10,color:textMut}}>This connection won't animate while others do</div>
            </div>
            <button onClick={()=>updateConnOv(selConn.id,{disabled:!ov.disabled})}
              style={{width:40,height:22,borderRadius:11,border:'none',background:ov.disabled?'#ef4444':borderC,cursor:'pointer',position:'relative',flexShrink:0,transition:'background 0.2s'}}>
              <span style={{position:'absolute',top:3,left:ov.disabled?20:3,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.2s',display:'block'}}/>
            </button>
          </div>

          {/* Other controls - greyed out when disabled */}
          <div style={{opacity:ov.disabled?0.35:1,pointerEvents:ov.disabled?'none':'all',transition:'opacity 0.2s'}}>
            <AELabel {...th}>Override Colour</AELabel>
            <AEColorRow value={ov.color||null} onChange={c=>updateConnOv(selConn.id,{color:c})} allowNull borderC={borderC}/>
            <AELabel {...th}>Override Direction</AELabel>
            <AEDirPicker value={ov.direction||animDirection} onChange={d=>updateConnOv(selConn.id,{direction:d})} borderC={borderC} textMut={textMut}/>
            {(animStyle==='dataflow'||animStyle==='streams')&&<>
              <AELabel {...th}>Override Dot Emoji</AELabel>
              <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:6}}>
                <button onClick={()=>updateConnOv(selConn.id,{dotEmoji:null})}
                  style={{padding:'5px 10px',borderRadius:7,border:`1.5px solid ${!ov.dotEmoji?'#f59e0b':borderC}`,background:!ov.dotEmoji?'rgba(245,158,11,0.12)':'transparent',color:!ov.dotEmoji?'#f59e0b':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>
                  Global
                </button>
                {ov.dotEmoji&&<div style={{fontSize:22,lineHeight:1,padding:'3px 7px',borderRadius:7,border:`1.5px solid #f59e0b`,background:'rgba(245,158,11,0.08)'}}>{ov.dotEmoji}</div>}
                <EmojiTriggerBtn onSelect={em=>updateConnOv(selConn.id,{dotEmoji:em})} darkMode={darkMode} cardBg={cardBg} textC={textC} textMut={textMut} borderC={borderC} label="+ Pick"/>
              </div>
            </>}
            {animStyle==='packets'&&<>
              <AELabel {...th}>Override Packet Label</AELabel>
              <input value={ov.label||''} onChange={e=>updateConnOv(selConn.id,{label:e.target.value})}
                placeholder="e.g. POST /api"
                style={{width:'100%',padding:'7px 10px',borderRadius:7,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:12,boxSizing:'border-box',marginBottom:6,fontFamily:'monospace'}}/>
            </>}
          </div>

          <button onClick={()=>clearOv(selConn.id,'conn')}
            style={{width:'100%',marginTop:8,padding:'7px',borderRadius:7,border:'1px solid #ef4444',background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:11,fontWeight:600}}>
            Reset to Global Settings
          </button>
        </>
      );
    }
    if(selEl){
      const ov=nodeAnimOverrides[selEl.id]||{};
      return(
        <>
          <div style={{fontSize:12,fontWeight:700,color:textC,marginBottom:8,padding:'4px 8px',background:darkMode?'#1e293b':'#f1f5f9',borderRadius:7}}>
            {selEl.customName||selEl.service?.name}
          </div>
          {animStyle==='status'&&<>
            <AELabel {...th}>Health Status</AELabel>
            <div style={{display:'flex',gap:6,marginBottom:8}}>
              {[{s:'ok',c:'#10b981',l:'✅ OK'},{s:'warn',c:'#f59e0b',l:'⚠️ Warn'},{s:'error',c:'#ef4444',l:'🔴 Error'}].map(({s,c,l})=>(
                <button key={s} onClick={()=>updateNodeOv(selEl.id,{status:s,statusColor:c})}
                  style={{flex:1,padding:'7px 4px',borderRadius:7,border:`1.5px solid ${(ov.status||'ok')===s?c:borderC}`,background:(ov.status||'ok')===s?c+'18':'transparent',color:(ov.status||'ok')===s?c:textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>
                  {l}
                </button>
              ))}
            </div>
            <AELabel {...th}>Custom Status Label</AELabel>
            <input value={ov.statusLabel||''} onChange={e=>updateNodeOv(selEl.id,{statusLabel:e.target.value})}
              placeholder="e.g. Degraded"
              style={{width:'100%',padding:'7px 10px',borderRadius:7,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:12,boxSizing:'border-box',marginBottom:6}}/>
          </>}
          {animStyle==='pulse'&&<>
            <AELabel {...th}>Override Pulse Colour</AELabel>
            <AEColorRow value={ov.pulseColor||null} onChange={c=>updateNodeOv(selEl.id,{pulseColor:c})} allowNull borderC={borderC}/>
          </>}
          {animStyle!=='status'&&animStyle!=='pulse'&&(
            <div style={{fontSize:12,color:textMut,lineHeight:1.6,padding:'8px 0'}}>
              Per-object editing for <strong>{animStyle}</strong> - switch to this animation to see per-node options.
            </div>
          )}
          <button onClick={()=>clearOv(selEl.id,'el')}
            style={{width:'100%',marginTop:8,padding:'7px',borderRadius:7,border:'1px solid #ef4444',background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:11,fontWeight:600}}>
            Reset to Global Settings
          </button>
        </>
      );
    }
    return null;
  };

  return (
    <div style={panelStyle}>
      <div style={{padding:'14px 16px 10px',flexShrink:0,borderBottom:`1px solid ${borderC}`}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
          <span style={{fontSize:14,fontWeight:800,color:'#f59e0b'}}>✦ Animation Editor</span>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:20,lineHeight:1}}>✕</button>
        </div>
        <div style={{display:'flex',gap:0,borderRadius:8,overflow:'hidden',border:`1px solid ${borderC}`}}>
          {[['global','🌐 Global'],['perObject','🎯 Per Object']].map(([id,lbl])=>(
            <button key={id} onClick={()=>setAnimEditorTab(id)}
              style={{flex:1,padding:'7px',border:'none',background:animEditorTab===id?'#f59e0b':'transparent',color:animEditorTab===id?'#fff':textMut,cursor:'pointer',fontSize:11,fontWeight:700}}>
              {lbl}
            </button>
          ))}
        </div>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'10px 16px 24px'}}>
        {animEditorTab==='global'&&renderGlobal()}
        {animEditorTab==='perObject'&&renderPerObject()}
      </div>
    </div>
  );
}

// --- DiagramImportModal -------------------------------------------------------
// Imports diagrams from: images (PNG/JPG/PDF screenshot), documents (PDF/text),
// or code (CloudFormation/CDK - extends existing Terraform feature)
function DiagramImportModal({ darkMode, provider, onClose, onGenerate }) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent='#7c3aed';

  const [importTab,setImportTab]=useState('image'); // image | document | code
  const [status,setStatus]=useState('idle'); // idle | reading | extracting | generating | done | error
  const [errorMsg,setErrorMsg]=useState('');
  const [fileName,setFileName]=useState('');
  const [preview,setPreview]=useState(null); // {type, summary}
  const [annotations,setAnnotations]=useState(true);
  const [docText,setDocText]=useState('');       // for .txt/.md and pasted text
  const [docPdfData,setDocPdfData]=useState(null); // for PDF files (base64)
  const [docInputMode,setDocInputMode]=useState('none'); // 'none'|'text'|'pdf'|'paste'
  const [imageData,setImageData]=useState(null); // base64 image
  const [imageMediaType,setImageMediaType]=useState('image/png');
  const [dragOver,setDragOver]=useState(false);
  const fileRef=useRef(null);

  const statusLabel={
    idle:'',reading:'Reading file…',
    extracting:'Extracting architecture…',
    generating:'Generating diagram…',
    done:'Done!',error:'Error',
  }[status];

  const progressPct={idle:0,reading:15,extracting:45,generating:80,done:100,error:0}[status];

  // ── File readers ────────────────────────────────────────────────────────────
  const readAsBase64=(file)=>new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=e=>res(e.target.result.split(',')[1]); // strip data:...;base64,
    r.onerror=()=>rej(new Error('Could not read '+file.name));
    r.readAsDataURL(file);
  });

  const readAsText=(file)=>new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=e=>res(e.target.result||'');
    r.onerror=()=>rej(new Error('Could not read '+file.name));
    r.readAsText(file);
  });

  // ── File selection handlers ──────────────────────────────────────────────
  const handleImageFile=async(file)=>{
    if(!file) return;
    setErrorMsg('');setStatus('reading');setFileName(file.name);
    try{
      const type=file.type||'image/png';
      const validTypes=['image/png','image/jpeg','image/jpg','image/gif','image/webp'];
      const useType=validTypes.includes(type)?type:'image/png';
      setImageMediaType(useType);
      const b64=await readAsBase64(file);
      setImageData(b64);
      setPreview({type:'image',summary:`${file.name} · ${(file.size/1024).toFixed(0)}KB · Ready to extract`});
      setStatus('idle');
    }catch(e){setErrorMsg(e.message);setStatus('error');}
  };

  const handleDocumentFile=async(file)=>{
    if(!file) return;
    setErrorMsg('');setStatus('reading');setFileName(file.name);
    const isPdf=file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf');
    try{
      if(isPdf){
        // Send PDF as base64 to Claude's native document API
        const b64=await readAsBase64(file);
        setDocPdfData(b64);
        setDocText('');
        setDocInputMode('pdf');
        setPreview({type:'document',summary:`${file.name} · PDF · Ready to extract`});
      } else {
        // Plain text, markdown, etc - read as text
        const text=await readAsText(file);
        if(!text.trim()){
          setErrorMsg('File appears empty. Try copying and pasting the text instead.');
          setStatus('error');return;
        }
        const wordCount=text.split(/\s+/).length;
        setDocText(text);
        setDocPdfData(null);
        setDocInputMode('text');
        setPreview({type:'document',summary:`${file.name} · ~${wordCount.toLocaleString()} words · Ready to extract`});
      }
      setStatus('idle');
    }catch(e){
      setErrorMsg('Could not read file. Try copying and pasting the text instead.');
      setStatus('error');
    }
  };

  const handleDrop=(e,tab)=>{
    e.preventDefault();setDragOver(false);
    const file=e.dataTransfer.files[0];
    if(!file) return;
    if(tab==='image') handleImageFile(file);
    else handleDocumentFile(file);
  };

  // ── System prompts ──────────────────────────────────────────────────────
  const imageSystemPrompt=()=>`You are an expert cloud architect who reads architecture diagrams and converts them into structured JSON.

You will receive an image of a cloud architecture diagram. Your job is to:
1. Identify every cloud service or component shown
2. Determine the connections between them (arrows, lines)
3. Identify any grouping borders (VPCs, subnets, regions, availability zones)
4. Extract labels, names, and any text annotations

Map what you see to these AWS service IDs where possible:
users, ec2, ecs, eks, lambda, rds, aurora, dynamodb, s3, elasticache, elb, apigateway, cloudfront, route53, waf, iam, secretsmanager, sqs, sns, kinesis, eventbridge, cloudwatch, xray, cognito, acm, kms, glue, redshift, athena, codepipeline, codebuild, codecommit, codedeploy, iot, batch, sagemaker, bedrock

LAYOUT: Place elements in a clean vertical or horizontal layout.
- Vertical (web/API diagrams): elements 260px apart vertically, centred around x=640
- Horizontal (data pipelines): elements 300px apart horizontally, centred around y=400
- All elements: width:130, height:110
- Bubbles: place at x>=1200 in a clean column, w:240, h:auto

Return ONLY valid JSON - no markdown, no explanation:
{"title":"...","elements":[{"id":"...","serviceId":"...","label":"...","x":0,"y":0,"width":130,"height":110}],"connections":[{"from":"...","to":"...","type":"arrow","bent":false}],"borders":[{"id":"...","label":"...","x":0,"y":0,"width":0,"height":0,"color":"#3b82f6"}],"bubbles":[${annotations?'{"id":"...","text":"...","shape":"textbox","x":1200,"y":0,"w":240,"h":80,"fillColor":"#f0f9ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"element_id"}':''}]}`;

  const documentSystemPrompt=()=>`You are an expert cloud architect who reads technical documents and extracts the architecture they describe.

Read the document and identify:
1. Every cloud service or component mentioned
2. How they connect or interact
3. Any groupings (VPCs, regions, tiers, layers)
4. The overall architecture pattern

Map to these AWS service IDs:
users, ec2, ecs, eks, lambda, rds, aurora, dynamodb, s3, elasticache, elb, apigateway, cloudfront, route53, waf, iam, secretsmanager, sqs, sns, kinesis, eventbridge, cloudwatch, xray, cognito, acm, kms, glue, redshift, athena, codepipeline, codebuild, iot, batch, sagemaker, bedrock

Generate a clean, well-spaced diagram:
- Vertical layout for web/API architectures
- Horizontal layout for data pipelines
- Elements: width:130, height:110, minimum 260px apart
- Bubbles at x>=1200, explaining each service's role from the document

Return ONLY valid JSON:
{"title":"...","elements":[{"id":"...","serviceId":"...","label":"...","x":0,"y":0,"width":130,"height":110}],"connections":[...],"borders":[...],"bubbles":[${annotations?'{"id":"...","text":"quote or summary from document","shape":"textbox","x":1200,"y":0,"w":240,"h":80,"fillColor":"#f0f9ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"element_id"}':''}]}`;

  // ── Main generate function ───────────────────────────────────────────────
  const generate=async()=>{
    setErrorMsg('');
    const allSvcs=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];

    try{
      let raw='';

      if(importTab==='image'){
        if(!imageData){setErrorMsg('Please upload an image first.');return;}
        setStatus('extracting');
        raw=await callClaudeWithRetry({
          max_tokens:8000,
          system:imageSystemPrompt(),
          messages:[{role:'user',content:[
            {type:'image',source:{type:'base64',media_type:imageMediaType,data:imageData}},
            {type:'text',text:`Extract the architecture from this diagram image.${annotations?' Include bubble annotations explaining each component.':' No annotations needed.'}`},
          ]}],
        });
      } else if(importTab==='document'){
        const hasPdf=!!docPdfData;
        const hasText=docText.trim().length>20;
        if(!hasPdf&&!hasText){
          setErrorMsg('Please upload a document or paste some text first.');return;
        }
        setStatus('extracting');

        if(hasPdf){
          // Send PDF natively to Claude's document API
          raw=await callClaudeWithRetry({
            max_tokens:8000,
            system:documentSystemPrompt(),
            messages:[{role:'user',content:[
              {type:'document',source:{type:'base64',media_type:'application/pdf',data:docPdfData}},
              {type:'text',text:`Extract the cloud architecture from this document and return diagram JSON.${annotations?' Include bubble annotations explaining each service.':' No annotations.'}`},
            ]}],
          });
        } else {
          // Plain text or pasted content
          const textToSend=docText.length>20000
            ?docText.slice(0,20000)+'\n\n[Document truncated - first 20,000 characters sent]'
            :docText;
          raw=await callClaudeWithRetry({
            max_tokens:8000,
            system:documentSystemPrompt(),
            messages:[{role:'user',content:`Extract the cloud architecture from this document and return diagram JSON.${annotations?' Include bubble annotations.':''}\n\nDocument:\n${textToSend}`}],
          });
        }
      }

      setStatus('generating');
      let diagram;
      try{diagram=safeParseJSON(raw);}
      catch(e){throw new Error('Could not parse the extracted architecture. Please try again.');}

      const ts=Date.now();
      const elements=(diagram.elements||[]).map((el,i)=>{
        const svc=allSvcs.find(s=>s.id===el.serviceId)||allSvcs.find(s=>s.id==='ec2');
        return{id:el.id||`imp_el_${ts}_${i}`,service:svc,
          x:Math.round((el.x||100+i*160)/10)*10,
          y:Math.round((el.y||100)/10)*10,
          width:el.width||130,height:el.height||110,
          customName:el.label!==svc?.name?el.label:null};
      });

      const idMap={};
      elements.forEach((el,i)=>{if(diagram.elements[i]?.id)idMap[diagram.elements[i].id]=el.id;});

      const connections=(diagram.connections||[]).map((c,i)=>({
        id:`imp_c_${ts}_${i}`,
        from:idMap[c.from]||c.from,to:idMap[c.to]||c.to,
        type:c.type||'arrow',bent:!!c.bent,
        color:'#3b82f6',strokeWidth:3,arrowSize:14,midLabel:c.midLabel||null,
      })).filter(c=>c.from&&c.to&&c.from!==c.to);

      const borders=(diagram.borders||[]).map((b,i)=>({
        id:b.id||`imp_b_${ts}_${i}`,
        x:Math.round((b.x||50)/10)*10,y:Math.round((b.y||50)/10)*10,
        width:b.width||400,height:b.height||300,
        color:b.color||'#3b82f6',strokeWidth:2,strokeStyle:'solid',borderRadius:8,label:b.label||'',
      }));

      const borderLabels=borders.filter(b=>b.label).map((b,i)=>({
        id:`imp_lbl_${ts}_${i}`,borderId:b.id,text:b.label,color:b.color,
      }));

      const validShapes=['speech','rounded','rectangle','textbox','thought','cloud','shout'];
      const bubbles=(diagram.bubbles||[]).map((b,i)=>{
        const bW=Math.max(200,b.w||240);
        const bText=b.text||'';
        return{
          id:b.id||`imp_bbl_${ts}_${i}`,
          x:Math.round((b.x||200)/10)*10,y:Math.round((b.y||200)/10)*10,
          w:bW,h:calcBubbleHeight(bText,bW),
          shape:validShapes.includes(b.shape)?b.shape:'textbox',
          fillColor:b.fillColor||'#f0f9ff',strokeColor:b.strokeColor||'#3b82f6',
          strokeWidth:1.5,text:bText,textColor:b.textColor||'#1e293b',
        };
      }).filter(b=>b.text&&b.text.trim());

      const bubbleConns=(diagram.bubbles||[]).filter(b=>b.connectTo&&b.text?.trim()).map((b,i)=>{
        const bubId=b.id||`imp_bbl_${ts}_${i}`;
        const tgtId=idMap[b.connectTo]||b.connectTo;
        if(!elements.find(e=>e.id===tgtId)||!bubbles.find(bb=>bb.id===bubId)) return null;
        return{id:`imp_bc_${ts}_${i}`,from:bubId,to:tgtId,type:'line',bent:false,color:'#f59e0b',strokeWidth:1.5,arrowSize:10};
      }).filter(Boolean);

      setStatus('done');
      setTimeout(()=>{
        onGenerate(elements,[...connections,...bubbleConns],borders,
          diagram.title||fileName.replace(/\.[^.]+$/,'')||'Imported Architecture',
          borderLabels,bubbles);
      },500);

    }catch(e){
      console.error('Import error:',e);
      setStatus('error');
      setErrorMsg(e.message||'Import failed. Please try again.');
    }
  };

  const canGenerate=(importTab==='image'&&!!imageData)||(importTab==='document'&&(!!docPdfData||docText.trim().length>20));

  // ── Render ──────────────────────────────────────────────────────────────
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:900,display:'flex',alignItems:'center',justifyContent:'center',padding:16}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{background:cardBg,borderRadius:16,width:'100%',maxWidth:520,maxHeight:'90vh',display:'flex',flexDirection:'column',overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,0.3)'}}>

        {/* Header */}
        <div style={{background:'linear-gradient(135deg,#0f766e,#0e7490)',padding:'18px 22px 14px',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
            <div>
              <div style={{fontSize:18,fontWeight:800,color:'#fff'}}>📥 Import Diagram</div>
              <div style={{fontSize:12,color:'rgba(255,255,255,0.75)',marginTop:2}}>From an image, document, or description</div>
            </div>
            <button onClick={onClose} style={{background:'rgba(255,255,255,0.15)',border:'none',borderRadius:8,color:'#fff',cursor:'pointer',fontSize:18,width:34,height:34,display:'flex',alignItems:'center',justifyContent:'center'}}>✕</button>
          </div>
          {/* Tab selector */}
          <div style={{display:'flex',gap:4,background:'rgba(0,0,0,0.2)',borderRadius:10,padding:3}}>
            {[['image','📷 From Image'],['document','📄 From Document']].map(([id,lbl])=>(
              <button key={id} onClick={()=>{setImportTab(id);setStatus('idle');setErrorMsg('');setPreview(null);setDocText('');setDocPdfData(null);setImageData(null);setFileName('');}}
                style={{flex:1,padding:'7px',borderRadius:8,border:'none',
                  background:importTab===id?'rgba(255,255,255,0.95)':'transparent',
                  color:importTab===id?'#0f766e':'rgba(255,255,255,0.85)',
                  cursor:'pointer',fontSize:11,fontWeight:700,transition:'all 0.15s'}}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{flex:1,overflowY:'auto',padding:'20px 22px 24px',display:'flex',flexDirection:'column',gap:14}}>

          {/* IMAGE TAB */}
          {importTab==='image'&&(
            <>
              <div style={{fontSize:12,color:textMut,lineHeight:1.6}}>
                Upload a screenshot or photo of any architecture diagram - AWS console, Lucidchart, draw.io, whiteboard, or any other tool. Claude will extract the services and recreate it as an editable CloudForger diagram.
              </div>

              {/* Drop zone */}
              <div
                onClick={()=>fileRef.current?.click()}
                onDragOver={e=>{e.preventDefault();setDragOver(true);}}
                onDragLeave={()=>setDragOver(false)}
                onDrop={e=>handleDrop(e,'image')}
                style={{border:`2px dashed ${dragOver?accent:borderC}`,borderRadius:12,padding:'32px 20px',textAlign:'center',cursor:'pointer',background:dragOver?accent+'08':'transparent',transition:'all 0.2s'}}>
                {imageData?(
                  <div>
                    <div style={{fontSize:32,marginBottom:8}}>✅</div>
                    <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:4}}>{fileName}</div>
                    <div style={{fontSize:11,color:textMut}}>{preview?.summary}</div>
                    <div style={{fontSize:11,color:accent,marginTop:8,fontWeight:600}}>Click to change image</div>
                  </div>
                ):(
                  <div>
                    <div style={{fontSize:40,marginBottom:10}}>📷</div>
                    <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:6}}>Drop image here or click to upload</div>
                    <div style={{fontSize:11,color:textMut}}>PNG, JPG, JPEG, WEBP · Max 5MB</div>
                    <div style={{fontSize:11,color:textMut,marginTop:4}}>Works with: screenshots, photos of whiteboards, exported diagrams</div>
                  </div>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}}
                onChange={e=>handleImageFile(e.target.files[0])}/>
            </>
          )}

          {/* DOCUMENT TAB */}
          {importTab==='document'&&(
            <>
              <div style={{fontSize:12,color:textMut,lineHeight:1.6}}>
                Upload a PDF, text file, or paste content from an architecture whitepaper, technical spec, ADR, or blog post. Claude will read it and generate a diagram of the architecture it describes.
              </div>

              {/* Drop zone */}
              <div
                onClick={()=>fileRef.current?.click()}
                onDragOver={e=>{e.preventDefault();setDragOver(true);}}
                onDragLeave={()=>setDragOver(false)}
                onDrop={e=>handleDrop(e,'document')}
                style={{border:`2px dashed ${dragOver?accent:borderC}`,borderRadius:12,padding:'20px',textAlign:'center',cursor:'pointer',background:dragOver?accent+'08':'transparent',transition:'all 0.2s'}}>
                {preview?.type==='document'?(
                  <div>
                    <div style={{fontSize:28,marginBottom:8}}>{docPdfData?'📋':'📄'}</div>
                    <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:4}}>{fileName}</div>
                    <div style={{fontSize:11,color:textMut}}>{preview.summary}</div>
                    {docPdfData&&<div style={{fontSize:11,color:'#10b981',marginTop:6,fontWeight:600}}>✓ PDF will be sent natively to Claude</div>}
                    <div style={{fontSize:11,color:accent,marginTop:6,fontWeight:600}}>Click to change file</div>
                  </div>
                ):(
                  <div>
                    <div style={{fontSize:32,marginBottom:8}}>📄</div>
                    <div style={{fontSize:12,fontWeight:700,color:textC,marginBottom:4}}>Drop file here or click to upload</div>
                    <div style={{fontSize:11,color:textMut}}>PDF, TXT, MD · Text-based PDFs only</div>
                  </div>
                )}
              </div>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.doc,.docx,text/plain,application/pdf" style={{display:'none'}}
                onChange={e=>handleDocumentFile(e.target.files[0])}/>

              {/* Paste fallback */}
              <div>
                <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:6}}>
                  Or paste text directly
                </label>
                <textarea value={docText} onChange={e=>{setDocText(e.target.value);if(e.target.value.length>50)setPreview({type:'document',summary:`Pasted text · ~${e.target.value.split(/\s+/).length} words`});}}
                  placeholder="Paste whitepaper content, architecture description, or technical spec…"
                  rows={5}
                  style={{width:'100%',padding:'10px 12px',borderRadius:10,border:`1.5px solid ${docText.length>50?accent:borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:12,resize:'vertical',outline:'none',fontFamily:'inherit',lineHeight:1.6,boxSizing:'border-box'}}/>
              </div>
            </>
          )}

          {/* Annotations toggle */}
          {(imageData||docPdfData||(docText.trim().length>20))&&status!=='generating'&&status!=='extracting'&&(
            <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',borderRadius:10,background:darkMode?'#0f172a':'#f8fafc',border:`1px solid ${borderC}`}}>
              <input type="checkbox" id="imp-ann" checked={annotations} onChange={e=>setAnnotations(e.target.checked)} style={{width:16,height:16,cursor:'pointer'}}/>
              <label htmlFor="imp-ann" style={{fontSize:12,color:textC,cursor:'pointer',fontWeight:600}}>
                Include annotations explaining each service
              </label>
            </div>
          )}

          {/* Progress */}
          {(status==='extracting'||status==='generating'||status==='reading')&&(
            <div style={{textAlign:'center',padding:'12px 0'}}>
              <div style={{width:32,height:32,border:'3px solid rgba(14,116,144,0.2)',borderTop:'3px solid #0e7490',borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 10px'}}/>
              <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:8}}>{statusLabel}</div>
              <div style={{height:5,borderRadius:3,background:darkMode?'#374151':'#e5e7eb',overflow:'hidden'}}>
                <div style={{height:'100%',borderRadius:3,background:'linear-gradient(90deg,#0f766e,#0e7490)',width:`${progressPct}%`,transition:'width 0.5s ease'}}/>
              </div>
            </div>
          )}

          {/* Error */}
          {status==='error'&&errorMsg&&(
            <div style={{padding:'12px 14px',borderRadius:10,background:'#fee2e2',border:'1px solid #fca5a5'}}>
              <div style={{fontSize:12,fontWeight:700,color:'#991b1b',marginBottom:4}}>Import failed</div>
              <div style={{fontSize:11,color:'#b91c1c',lineHeight:1.5}}>{errorMsg}</div>
              <button onClick={()=>{setStatus('idle');setErrorMsg('');}} style={{marginTop:8,padding:'4px 10px',borderRadius:6,border:'1px solid #f87171',background:'transparent',color:'#dc2626',cursor:'pointer',fontSize:11,fontWeight:600}}>Try Again</button>
            </div>
          )}

          {/* Success */}
          {status==='done'&&(
            <div style={{textAlign:'center',padding:'10px',color:'#10b981',fontSize:14,fontWeight:700}}>
              ✅ Diagram imported successfully!
            </div>
          )}

          {/* Import button */}
          {status!=='extracting'&&status!=='generating'&&status!=='reading'&&status!=='done'&&(
            <button onClick={generate} disabled={!canGenerate}
              style={{padding:'14px',borderRadius:12,border:'none',
                background:canGenerate?'linear-gradient(135deg,#0f766e,#0e7490)':'#9ca3af',
                color:'#fff',cursor:canGenerate?'pointer':'not-allowed',
                fontSize:14,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',gap:8,
                boxShadow:canGenerate?'0 4px 20px rgba(14,116,144,0.4)':'none',transition:'all 0.2s'}}>
              📥 Import & Generate Diagram · 2 credits
            </button>
          )}

          <div style={{fontSize:10,color:textMut,textAlign:'center',lineHeight:1.5}}>
            {importTab==='image'?'Works best with clear screenshots. Handwritten whiteboards may need cleanup after import.':'PDFs are sent natively to Claude - no text extraction needed. For scanned PDFs (images of pages), copy and paste the text instead.'}
          </div>
        </div>

        <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
      </div>
    </div>
  );
}

// --- TerraformImportModal ----------------------------------------------------
function TerraformImportModal({ darkMode, provider, onClose, onGenerate }) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const codeBg=darkMode?'#0f172a':'#f1f5f9';

  const [inputMode,setInputMode]=useState('paste'); // paste | file
  const [hclText,setHclText]=useState('');
  const [fileNames,setFileNames]=useState([]);
  const [filesReady,setFilesReady]=useState(false);
  const [status,setStatus]=useState('idle'); // idle | analysing | done | error
  const [errorMsg,setErrorMsg]=useState('');
  const [preview,setPreview]=useState(null); // {resourceCount, providers, title}
  const [annotations,setAnnotations]=useState(true);
  const [activeProvider,setActiveProvider]=useState(provider||'aws');
  const fileRef=useRef(null);

  // Detect provider from HCL text
  const detectProvider=(text)=>{
    if(text.includes('google_')||text.includes('provider "google"')) return 'gcp';
    if(text.includes('azurerm_')||text.includes('provider "azurerm"')) return 'azure';
    return 'aws';
  };

  // Count resources for preview
  const analyseHcl=(text)=>{
    const resourceMatches=text.match(/^resource\s+"[^"]+"\s+"[^"]+"/gm)||[];
    const providerMatches=text.match(/provider\s+"([^"]+)"/g)||[];
    const titleMatch=text.match(/Project\s*=\s*"([^"]+)"/i)||text.match(/Name\s*=\s*"([^"]+)"/i);
    return {
      resourceCount:resourceMatches.length,
      providers:[...new Set(providerMatches.map(p=>p.replace(/provider\s+"/,'').replace('"','')))],
      title:titleMatch?titleMatch[1].replace(/-/g,' ').replace(/\b\w/g,l=>l.toUpperCase()):'Terraform Architecture',
    };
  };

  // iOS Safari compatible file reader using FileReader API
  const readFileText=(file)=>new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=(e)=>resolve(e.target.result||'');
    reader.onerror=()=>reject(new Error('Could not read '+file.name));
    reader.readAsText(file);
  });

  const handleFileUpload=async(files)=>{
    setErrorMsg('');
    // Accept .tf, .tfvars, .txt - iOS sometimes renames or strips extensions
    let fileArr=Array.from(files).filter(f=>
      f.name.endsWith('.tf')||f.name.endsWith('.tfvars')||
      f.name.endsWith('.txt')||f.type==='text/plain'||f.type===''
    );
    // Fallback: accept anything if filter rejected all
    if(!fileArr.length) fileArr=Array.from(files);
    if(!fileArr.length){setErrorMsg('No files selected');return;}
    setFileNames(fileArr.map(f=>f.name));
    try{
      const texts=await Promise.all(fileArr.map(f=>readFileText(f)));
      const combined=texts.filter(Boolean).join('\n\n');
      if(!combined.trim()){setErrorMsg('Files appear to be empty. Try the Paste Code option.');return;}
      setHclText(combined);
      setFilesReady(true);
      setPreview(analyseHcl(combined));
      setActiveProvider(detectProvider(combined));
    }catch(e){
      setErrorMsg('Could not read the file. Please use the Paste Code option instead.');
    }
  };

  const handlePasteChange=(text)=>{
    setHclText(text);
    if(text.length>100){
      const info=analyseHcl(text);
      setPreview(info);
      setActiveProvider(detectProvider(text));
    } else {
      setPreview(null);
    }
  };

  const buildSystemPrompt=()=>`You are a senior cloud architect who specialises in reverse engineering Terraform HCL into visual architecture diagrams. Your job is to read Terraform code and produce a structured JSON diagram that faithfully represents the infrastructure.

Rules for reading Terraform:
- Each "resource" block becomes a diagram element. Use the resource TYPE to determine the service (e.g. aws_instance -> ec2, aws_lb -> elb, google_compute_instance -> gce, azurerm_virtual_machine -> azvm).
- Resource references (vpc_id = aws_vpc.main.id, subnet_id, security_groups, etc.) define connections between elements.
- aws_vpc, google_compute_network, azurerm_virtual_network -> border groups (VPCs)
- aws_subnet, google_compute_subnetwork, azurerm_subnet -> border groups nested inside VPCs
- Use the Name tag or resource label as the element's display label.
- ALWAYS generate bubbles with textbox annotations for the most important resources. ANNOTATION TEXT RULES (CRITICAL):
  * Keep each annotation to MAX 25 words. Be concise. No sentences longer than 15 words.
  * Good example: "Public-facing ALB. Accepts HTTPS (443) and HTTP (80) from CloudFront. Forwards to web servers. Spans both AZs."
  * Bad example (too long, will overflow): "The Application Load Balancer sits in the public subnets and accepts incoming HTTPS traffic on port 443 from the internet and redirects HTTP traffic..."
  * Only annotate the 6-8 MOST IMPORTANT resources. Skip route tables, EIPs, route table associations.
- LAYOUT RULES (CRITICAL - must follow exactly):
  * Canvas is 2400px wide x 2000px tall. Use this full space.
  * Start elements at x=400 (leave 400px on left for annotation bubbles).
  * Space elements at least 250px apart horizontally and 200px apart vertically.
  * Element width: 140px, height: 120px.
  * Annotation bubbles: place to the LEFT of their element at x = element.x - 320, same y as element.
  * Bubble size: w=280, h=100. These sizes are MANDATORY - do not use smaller values.
  * VPC border: start at x=80, y=250, width=2000, height=1600.
  * Subnet borders: width=900, height=350 minimum.
- Map resource types to these service IDs:
  AWS: aws_instance->ec2, aws_lambda_function->lambda, aws_s3_bucket->s3, aws_db_instance->rds, aws_dynamodb_table->dynamodb, aws_vpc->vpc, aws_lb/aws_alb->elb, aws_cloudfront_distribution->cloudfront, aws_route53_record->route53, aws_api_gateway_rest_api->apigateway, aws_iam_role->iam, aws_security_group->waf, aws_ecr_repository->ecs, aws_ecs_service->ecs, aws_eks_cluster->eks, aws_elasticache_cluster->rds, aws_sqs_queue->sqs, aws_sns_topic->sns, aws_cloudwatch_metric_alarm->cloudwatch, aws_codepipeline->codepipeline, aws_codebuild_project->codebuild, aws_codecommit_repository->codecommit, aws_internet_gateway->vpc, aws_nat_gateway->vpc, aws_cloudwatch_log_group->cloudwatch
  GCP: google_compute_instance->gce, google_cloudfunctions_function->gcf, google_storage_bucket->gcs, google_sql_database_instance->cloudsql, google_container_cluster->gke, google_compute_network->gcvpc, google_compute_subnetwork->gcvpc, google_pubsub_topic->pubsub
  Azure: azurerm_virtual_machine/azurerm_linux_virtual_machine->azvm, azurerm_function_app->azfunc, azurerm_storage_account->azblob, azurerm_sql_server->azsql, azurerm_cosmosdb_account->azcosmos, azurerm_kubernetes_cluster->azaks, azurerm_virtual_network->azvnet, azurerm_subnet->azvnet, azurerm_application_gateway->azlb, azurerm_service_bus_namespace->azservicebus

Return ONLY valid JSON in this exact schema, no markdown:
{
  "title": "Infrastructure Name",
  "elements": [
    {"id":"el_alb","serviceId":"elb","label":"Web ALB","x":800,"y":400,"width":140,"height":120}
  ],
  "connections": [
    {"from":"el_alb","to":"el_ec2_a","type":"arrow","bent":false}
  ],
  "borders": [
    {"id":"border_vpc","label":"Main VPC (10.0.0.0/16)","x":80,"y":250,"width":2000,"height":1600,"color":"#8b5cf6"},
    {"id":"border_public","label":"Public Subnets","x":120,"y":300,"width":1900,"height":400,"color":"#3b82f6"}
  ],
  "bubbles": [
    {"id":"bubble_alb","text":"Public ALB. Accepts HTTPS 443 from internet. Forwards to web servers. Spans both AZs.","shape":"textbox","x":480,"y":400,"w":280,"h":100,"fillColor":"#fffbeb","strokeColor":"#f59e0b","textColor":"#1e293b","connectTo":"el_alb"}
  ]
}`;

  const generate=async()=>{
    if(!hclText.trim()){setErrorMsg('Please paste Terraform code or upload a .tf file');return;}
    setStatus('analysing');setErrorMsg('');

    // Truncate only if extremely large (24k covers virtually all real-world single-file TF)
    const hclToSend=hclText.length>24000
      ?hclText.slice(0,24000)+'\n\n# ... (truncated - first 24,000 characters sent)'
      :hclText;

    try{
      const raw=await callClaudeWithRetry({
        max_tokens:16000,
        system:buildSystemPrompt(),
        messages:[{
          role:'user',
          content:`Convert this Terraform HCL into a diagram JSON. ${annotations?'Include textbox annotations for every resource explaining what it does and noting important config details.':'Omit annotations - diagram only.'}\n\nTerraform code:\n\`\`\`hcl\n${hclToSend}\n\`\`\``,
        }],
      });

      let diagram;
      try{diagram=safeParseJSON(raw);}
      catch(e){throw new Error('Could not parse response. Please try again.');}

      const allSvcs=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];
      const providerSvcs=activeProvider==='gcp'?GCP_SERVICES:activeProvider==='azure'?AZURE_SERVICES:AWS_SERVICES;
      const ts=Date.now();

      const elements=(diagram.elements||[]).map((el,i)=>{
        const svc=providerSvcs.find(s=>s.id===el.serviceId)
          ||allSvcs.find(s=>s.id===el.serviceId)
          ||providerSvcs.find(s=>s.category==='Compute')||providerSvcs[0];
        return{
          id:el.id||`tf_el_${ts}_${i}`,
          service:svc,
          x:Math.round((el.x||100+i*170)/10)*10,
          y:Math.round((el.y||100)/10)*10,
          width:el.width||130,
          height:el.height||110,
          customName:el.label!==svc.name?el.label:null,
        };
      });

      const idMap={};
      elements.forEach((el,i)=>{if(diagram.elements[i]?.id)idMap[diagram.elements[i].id]=el.id;});

      const connections=(diagram.connections||[]).map((c,i)=>({
        id:`tf_c_${ts}_${i}`,
        from:idMap[c.from]||c.from,
        to:idMap[c.to]||c.to,
        type:c.type||'arrow',bent:c.bent||false,
        color:'#3b82f6',strokeWidth:3,arrowSize:14,
      })).filter(c=>elements.find(e=>e.id===c.from)&&elements.find(e=>e.id===c.to));

      const borders=(diagram.borders||[]).map((b,i)=>({
        id:b.id||`tf_b_${ts}_${i}`,
        x:Math.round((b.x||50)/10)*10,y:Math.round((b.y||50)/10)*10,
        width:b.width||600,height:b.height||400,
        color:b.color||'#8b5cf6',strokeWidth:2,strokeStyle:'solid',
      }));

      const borderIdMap={};
      borders.forEach((b,i)=>{if(diagram.borders[i]?.id)borderIdMap[diagram.borders[i].id]=b.id;});

      const labels=borders.map((b,i)=>{
        const raw=diagram.borders[i];
        if(!raw?.label)return null;
        return{id:`tf_lbl_${ts}_${i}`,borderId:b.id,text:raw.label,color:b.color,x:b.x,y:b.y};
      }).filter(Boolean);

      const validBubbleShapes=['speech','rounded','rectangle','textbox','thought','cloud','shout'];
      const bubbles=(annotations?(diagram.bubbles||[]):[]).map((bu,i)=>{
        const w=Math.max(240,bu.w||260);
        const rawText=bu.text||'';
        const text=rawText.length>300?rawText.slice(0,297)+'…':rawText;
        const h=calcBubbleHeight(text,w); // dynamic - fits all text
        return {
          id:bu.id||`tf_bbl_${ts}_${i}`,
          x:Math.round((bu.x||300+i*320)/10)*10,
          y:Math.round((bu.y||200)/10)*10,
          w, h,
          shape:validBubbleShapes.includes(bu.shape)?bu.shape:'textbox',
          fillColor:bu.fillColor||'#fffbeb',
          strokeColor:bu.strokeColor||'#f59e0b',
          strokeWidth:1.5,
          text,
          textColor:bu.textColor||'#1e293b',
        };
      });

      // Wire bubble connectTo references
      const bubbleConns=(diagram.bubbles||[]).map((bu,i)=>{
        if(!bu.connectTo||!annotations)return null;
        const targetId=idMap[bu.connectTo]||bu.connectTo;
        const bubbleId=bubbles[i]?.id;
        if(!bubbleId||!elements.find(e=>e.id===targetId))return null;
        return{id:`tf_bc_${ts}_${i}`,from:bubbleId,to:targetId,type:'arrow',bent:false,color:'#f59e0b',strokeWidth:1.5,arrowSize:10};
      }).filter(Boolean);

      setStatus('done');
      setTimeout(()=>{
        onGenerate(elements,[...connections,...bubbleConns],borders,diagram.title||'Terraform Architecture',labels,bubbles);
      },400);

    }catch(e){
      console.error('TF import error:',e);
      setStatus('error');
      setErrorMsg(e.message||'Import failed. Please try again.');
    }
  };

  const resourceCount=preview?.resourceCount||0;

  return(
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:cardBg,borderRadius:20,width:'100%',maxWidth:640,maxHeight:'92vh',display:'flex',flexDirection:'column',boxShadow:'0 24px 64px rgba(0,0,0,0.5)'}}>

        {/* Header */}
        <div style={{background:'linear-gradient(135deg,#0f766e,#0e7490)',borderRadius:'20px 20px 0 0',padding:'18px 22px 16px',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:10}}>
            <div>
              <div style={{fontSize:18,fontWeight:800,color:'#fff',marginBottom:2}}>📂 Import from Terraform</div>
              <div style={{fontSize:12,color:'rgba(255,255,255,0.8)'}}>Reverse engineer .tf files into beautiful editable diagrams</div>
            </div>
            <button onClick={onClose} style={{background:'rgba(255,255,255,0.15)',border:'none',cursor:'pointer',color:'#fff',fontSize:18,borderRadius:8,padding:'3px 9px'}}>✕</button>
          </div>
          {/* Provider pills */}
          <div style={{display:'flex',gap:6}}>
            {CLOUD_PROVIDERS.map(p=>(
              <button key={p.id} onClick={()=>setActiveProvider(p.id)}
                style={{padding:'4px 12px',borderRadius:20,border:`1.5px solid ${activeProvider===p.id?'#fff':'rgba(255,255,255,0.3)'}`,background:activeProvider===p.id?'rgba(255,255,255,0.2)':'transparent',color:'#fff',cursor:'pointer',fontSize:11,fontWeight:700,display:'flex',alignItems:'center',gap:4}}>
                {p.logo} {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{flex:1,overflowY:'auto',padding:'16px 22px'}}>

          {/* Input mode tabs */}
          <div style={{display:'flex',gap:0,borderRadius:9,overflow:'hidden',border:`1px solid ${borderC}`,marginBottom:14}}>
            {[['paste','✏️ Paste Code'],['file','📁 Upload Files']].map(([id,lbl])=>(
              <button key={id} onClick={()=>setInputMode(id)}
                style={{flex:1,padding:'8px',border:'none',background:inputMode===id?'#0e7490':'transparent',color:inputMode===id?'#fff':textMut,cursor:'pointer',fontSize:12,fontWeight:700}}>
                {lbl}
              </button>
            ))}
          </div>

          {/* Paste mode */}
          {inputMode==='paste'&&(
            <div>
              <div style={{fontSize:11,color:textMut,marginBottom:6}}>Paste your Terraform HCL below. Multiple resource blocks are supported.</div>
              <textarea
                value={hclText}
                onChange={e=>handlePasteChange(e.target.value)}
                placeholder={`resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n  ...\n}\n\nresource "aws_instance" "web" {\n  ami = var.ami_id\n  ...\n}`}
                style={{width:'100%',height:220,padding:'10px 12px',borderRadius:9,border:`1.5px solid ${hclText?'#0e7490':borderC}`,background:codeBg,color:textC,fontSize:11,fontFamily:"'JetBrains Mono','Fira Code','Consolas',monospace",resize:'vertical',boxSizing:'border-box',outline:'none',lineHeight:1.6}}
              />
            </div>
          )}

          {/* File upload mode */}
          {inputMode==='file'&&(
            <div>
              <input ref={fileRef} type="file" multiple accept=".tf,.tfvars" style={{display:'none'}}
                onChange={e=>handleFileUpload(e.target.files)}/>
              <div onClick={()=>fileRef.current?.click()}
                style={{border:`2px dashed ${fileNames.length?'#0e7490':borderC}`,borderRadius:12,padding:'32px 16px',textAlign:'center',cursor:'pointer',background:fileNames.length?(darkMode?'rgba(14,116,144,0.08)':'rgba(14,116,144,0.04)'):codeBg,transition:'all 0.2s'}}
                onDragOver={e=>{e.preventDefault();}}
                onDrop={e=>{e.preventDefault();handleFileUpload(e.dataTransfer.files);}}>
                {fileNames.length?(
                  <div>
                    <div style={{fontSize:28,marginBottom:8}}>✅</div>
                    <div style={{fontSize:13,fontWeight:700,color:'#0e7490',marginBottom:4}}>{fileNames.length} file{fileNames.length>1?'s':''} loaded</div>
                    <div style={{fontSize:11,color:textMut,lineHeight:1.6}}>{fileNames.join(' · ')}</div>
                    <button onClick={e=>{e.stopPropagation();setFileNames([]);setHclText('');setPreview(null);setFilesReady(false);}}
                      style={{marginTop:10,padding:'4px 12px',borderRadius:6,border:'1px solid #ef4444',background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:11,fontWeight:600}}>
                      Clear
                    </button>
                  </div>
                ):(
                  <div>
                    <div style={{fontSize:36,marginBottom:8}}>📁</div>
                    <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:4}}>Drop .tf files here or click to browse</div>
                    <div style={{fontSize:11,color:textMut}}>Supports single files, multiple files, and .tfvars</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Preview stats */}
          {preview&&hclText&&(
            <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
              <span style={{fontSize:11,padding:'3px 10px',borderRadius:20,background:darkMode?'#1e293b':'#e0f2fe',color:'#0e7490',fontWeight:700}}>
                📦 {preview.resourceCount} resource{preview.resourceCount!==1?'s':''}
              </span>
              {preview.providers.length>0&&<span style={{fontSize:11,padding:'3px 10px',borderRadius:20,background:darkMode?'#1e293b':'#e0f2fe',color:'#0e7490',fontWeight:700}}>
                ☁️ {preview.providers.join(', ')}
              </span>}
              {preview.title&&preview.title!=='Terraform Architecture'&&<span style={{fontSize:11,padding:'3px 10px',borderRadius:20,background:darkMode?'#1e293b':'#f1f5f9',color:textMut,fontWeight:600}}>
                "{preview.title}"
              </span>}
              {hclText.length>24000&&<span style={{fontSize:11,padding:'3px 10px',borderRadius:20,background:'#fef3c7',color:'#92400e',fontWeight:600}}>
                ⚠️ Large file - first 12k chars will be used
              </span>}
            </div>
          )}

          {/* Annotations toggle */}
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:14,padding:'10px 14px',borderRadius:10,border:`1px solid ${borderC}`,background:darkMode?'rgba(255,255,255,0.03)':'rgba(0,0,0,0.02)'}}>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:textC}}>Include annotations</div>
              <div style={{fontSize:11,color:textMut}}>Text boxes explaining each resource + config insights from the code</div>
            </div>
            <button onClick={()=>setAnnotations(v=>!v)}
              style={{width:40,height:22,borderRadius:11,border:'none',background:annotations?'#0e7490':borderC,cursor:'pointer',position:'relative',flexShrink:0,transition:'background 0.2s'}}>
              <span style={{position:'absolute',top:3,left:annotations?20:3,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.2s',display:'block'}}/>
            </button>
          </div>

          {/* Error */}
          {status==='error'&&(
            <div style={{marginTop:12,padding:'10px 14px',borderRadius:9,background:'#fee2e2',border:'1px solid #fca5a5'}}>
              <div style={{fontSize:12,fontWeight:700,color:'#991b1b',marginBottom:3}}>Import failed</div>
              <div style={{fontSize:11,color:'#b91c1c',lineHeight:1.5}}>{errorMsg}</div>
            </div>
          )}

          {/* Done state */}
          {status==='done'&&(
            <div style={{marginTop:12,padding:'12px 14px',borderRadius:9,background:'#d1fae5',border:'1px solid #6ee7b7',textAlign:'center'}}>
              <div style={{fontSize:20,marginBottom:4}}>✅</div>
              <div style={{fontSize:13,fontWeight:700,color:'#065f46'}}>Diagram generated - loading canvas…</div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:'12px 22px 20px',borderTop:`1px solid ${borderC}`,flexShrink:0}}>
          <button onClick={generate} disabled={status==='analysing'||status==='done'||(inputMode==='paste'&&!hclText.trim())||(inputMode==='file'&&!filesReady)}
            style={{width:'100%',padding:'13px',borderRadius:12,border:'none',
              background:status==='analysing'||status==='done'||(inputMode==='paste'&&!hclText.trim())||(inputMode==='file'&&!filesReady)?'#9ca3af':'linear-gradient(135deg,#0f766e,#0e7490)',
              color:'#fff',cursor:status==='analysing'||status==='done'||(inputMode==='paste'&&!hclText.trim())||(inputMode==='file'&&!filesReady)?'not-allowed':'pointer',
              fontSize:14,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',gap:10,
              boxShadow:(inputMode==='paste'&&!hclText.trim())||(inputMode==='file'&&!filesReady)||status==='analysing'?'none':'0 4px 20px rgba(14,116,144,0.4)'}}>
            {status==='analysing'
              ?<><div style={{width:18,height:18,border:'2.5px solid rgba(255,255,255,0.3)',borderTop:'2.5px solid #fff',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>Analysing Terraform…</>
              :status==='done'
              ?<>✅ Diagram ready!</>
              :<>📂 Generate Diagram {annotations?'+ Annotations':''}</>
            }
          </button>
          <div style={{marginTop:8,fontSize:11,color:textMut,textAlign:'center'}}>
            Uses 4 credits · Supports AWS, GCP, and Azure · All standard resource types
          </div>
        </div>
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>
    </div>
  );
}


// --- UpgradeModal -------------------------------------------------------------
const PLANS = [
  {
    id: 'free',
    name: 'Free',
    icon: '🌱',
    monthlyPrice: 0,
    yearlyPrice: 0,
    color: '#64748b',
    gradient: 'linear-gradient(135deg,#64748b,#475569)',
    description: 'Get started with the basics',
    credits: '0 AI credits/month',
    features: [
      { text: '3 diagrams', included: true },
      { text: 'Export PNG & JPEG', included: true },
      { text: 'Share to feed', included: true },
      { text: 'Basic animations', included: true },
      { text: 'AI diagram generation', included: false },
      { text: 'Terraform / CloudFormation / CDK export', included: false },
      { text: 'Architecture validation', included: false },
      { text: 'Watermark / logo', included: false },
      { text: 'Unlimited diagrams', included: false },
    ],
    cta: 'Current plan',
    ctaDisabled: true,
  },
  {
    id: 'pro',
    name: 'Pro',
    icon: '⚡',
    monthlyPrice: 12,
    yearlyPrice: 99,
    color: '#6366f1',
    gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
    description: 'For cloud architects who ship',
    credits: '20 AI credits/month',
    badge: 'Most Popular',
    features: [
      { text: 'Unlimited diagrams', included: true },
      { text: 'Export PNG & JPEG', included: true },
      { text: 'Share to feed', included: true },
      { text: 'All animations', included: true },
      { text: 'AI diagram generation', included: true },
      { text: 'Terraform / CloudFormation / CDK export', included: true },
      { text: 'Architecture validation', included: true },
      { text: 'Watermark / logo', included: true },
      { text: '20 AI credits/month', included: true },
    ],
    cta: 'Upgrade to Pro',
    ctaDisabled: false,
  },
];

const TOPUPS = [
  { id: 'starter', name: 'Starter', credits: 10, price: 2.99, perCredit: 0.30 },
  { id: 'standard', name: 'Standard', credits: 25, price: 5.99, perCredit: 0.24, badge: 'Popular' },
  { id: 'power', name: 'Power', credits: 60, price: 11.99, perCredit: 0.20, badge: 'Best value' },
];

function UpgradeModal({ darkMode, userPlan='free', onClose, onUpgrade }) {
  const cardBg = darkMode ? '#1f2937' : '#ffffff';
  const bg = darkMode ? '#111827' : '#f8fafc';
  const textC = darkMode ? '#f1f5f9' : '#1e293b';
  const textMut = darkMode ? '#94a3b8' : '#64748b';
  const borderC = darkMode ? '#374151' : '#e5e7eb';

  const [billing, setBilling] = React.useState('monthly'); // monthly | yearly
  const [tab, setTab] = React.useState('plans'); // plans | topup
  const yearlySaving = 20; // percent

  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: cardBg, borderRadius: 24, width: '100%', maxWidth: 720, maxHeight: '94vh', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(0,0,0,0.5)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ background: 'linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#0891b2 100%)', padding: '24px 24px 20px', flexShrink: 0, position: 'relative' }}>
          <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,0.15)', border: 'none', cursor: 'pointer', color: '#fff', fontSize: 18, width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.75)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>CloudForger Plans</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: '#fff', marginBottom: 6, lineHeight: 1.1 }}>Build better diagrams,<br/>deploy with confidence</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)' }}>Start free. Upgrade when you're ready.</div>

          {/* Tab selector */}
          <div style={{ display: 'flex', gap: 4, marginTop: 18, background: 'rgba(0,0,0,0.2)', borderRadius: 10, padding: 3, width: 'fit-content' }}>
            {[['plans', '📋 Plans'], ['topup', '⚡ Buy Credits']].map(([id, lbl]) => (
              <button key={id} onClick={() => setTab(id)}
                style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: tab === id ? '#fff' : 'transparent', color: tab === id ? '#6366f1' : 'rgba(255,255,255,0.8)', cursor: 'pointer', fontSize: 12, fontWeight: 700, transition: 'all 0.15s' }}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 20px 24px' }}>

          {tab === 'plans' && (<>
            {/* Billing toggle */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 22 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: billing === 'monthly' ? textC : textMut }}>Monthly</span>
              <button onClick={() => setBilling(b => b === 'monthly' ? 'yearly' : 'monthly')}
                style={{ width: 44, height: 24, borderRadius: 12, border: 'none', background: billing === 'yearly' ? '#6366f1' : borderC, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 3, left: billing === 'yearly' ? 22 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', display: 'block', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }} />
              </button>
              <span style={{ fontSize: 12, fontWeight: 600, color: billing === 'yearly' ? textC : textMut }}>
                Yearly
                <span style={{ marginLeft: 6, padding: '2px 7px', borderRadius: 20, background: '#d1fae5', color: '#065f46', fontSize: 10, fontWeight: 800 }}>Save {yearlySaving}%</span>
              </span>
            </div>

            {/* Plan cards */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {PLANS.map(plan => {
                const price = billing === 'yearly' ? plan.yearlyPrice : plan.monthlyPrice;
                const isCurrent = userPlan === plan.id;
                const isHighlighted = plan.id === 'pro';
                return (
                  <div key={plan.id} style={{
                    borderRadius: 16, border: `2px solid ${isHighlighted ? '#6366f1' : borderC}`,
                    background: isHighlighted ? (darkMode ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.04)') : cardBg,
                    overflow: 'hidden',
                    boxShadow: isHighlighted ? '0 0 0 1px rgba(99,102,241,0.3), 0 4px 20px rgba(99,102,241,0.12)' : 'none',
                  }}>
                    <div style={{ padding: '16px 18px' }}>
                      {/* Row 1: icon + name/desc */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                        <div style={{ width: 40, height: 40, borderRadius: 10, background: plan.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>
                          {plan.icon}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 16, fontWeight: 800, color: textC }}>{plan.name}</div>
                          <div style={{ fontSize: 11, color: textMut }}>{plan.description}</div>
                        </div>
                      </div>
                      {/* Row 2: price + badges on same line, no overlap */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                        <div style={{ flexShrink: 0 }}>
                          {plan.monthlyPrice === 0 ? (
                            <span style={{ fontSize: 26, fontWeight: 900, color: textC, lineHeight: 1 }}>Free</span>
                          ) : (
                            <>
                              <span style={{ fontSize: 28, fontWeight: 900, color: textC, lineHeight: 1 }}>${price}</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: textMut }}>/{billing === 'yearly' ? 'yr' : 'mo'}</span>
                              {billing === 'yearly' && (
                                <div style={{ fontSize: 11, color: '#6366f1', fontWeight: 700 }}>(${(price/12).toFixed(2)}/mo billed yearly)</div>
                              )}
                            </>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {plan.badge && <span style={{ padding: '3px 10px', borderRadius: 20, background: plan.gradient, color: '#fff', fontSize: 10, fontWeight: 800 }}>{plan.badge}</span>}
                          {isCurrent && <span style={{ padding: '3px 10px', borderRadius: 20, background: '#d1fae5', color: '#065f46', fontSize: 10, fontWeight: 800 }}>Current plan</span>}
                        </div>
                      </div>

                      {/* Features */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 14 }}>
                        {plan.features.map((f, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: f.included ? textC : textMut, opacity: f.included ? 1 : 0.5 }}>
                            <span style={{ fontSize: 12, flexShrink: 0 }}>{f.included ? '✅' : '⬜'}</span>
                            {f.text}
                          </div>
                        ))}
                      </div>

                      {/* CTA */}
                      {!isCurrent && (
                        <button onClick={() => onUpgrade && onUpgrade(plan.id, billing)}
                          style={{
                            width: '100%', padding: '11px', borderRadius: 10, border: 'none',
                            background: plan.ctaDisabled ? borderC : plan.gradient,
                            color: plan.ctaDisabled ? textMut : '#fff',
                            cursor: plan.ctaDisabled ? 'default' : 'pointer',
                            fontSize: 13, fontWeight: 800,
                            boxShadow: !plan.ctaDisabled ? '0 4px 14px rgba(99,102,241,0.35)' : 'none',
                          }}>
                          {plan.cta} {!plan.ctaDisabled && '->'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ textAlign: 'center', marginTop: 16, fontSize: 11, color: textMut }}>
              Cancel anytime · No contracts · Secure payment via Stripe
            </div>
          </>)}

          {tab === 'topup' && (<>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 800, color: textC, marginBottom: 4 }}>Top up AI credits</div>
              <div style={{ fontSize: 12, color: textMut, lineHeight: 1.5 }}>Credits never expire within 90 days. Monthly plan credits always used first.</div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {TOPUPS.map(pack => (
                <div key={pack.id} style={{ borderRadius: 14, border: `1.5px solid ${pack.badge ? '#6366f1' : borderC}`, padding: '16px 18px', background: pack.badge ? (darkMode ? 'rgba(99,102,241,0.08)' : 'rgba(99,102,241,0.04)') : cardBg, position: 'relative' }}>
                  {pack.badge && (
                    <span style={{ position: 'absolute', top: 12, right: 12, padding: '2px 9px', borderRadius: 20, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', fontSize: 10, fontWeight: 800 }}>{pack.badge}</span>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>⚡</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: textC }}>{pack.name} · {pack.credits} credits</div>
                      <div style={{ fontSize: 11, color: textMut }}>${pack.perCredit.toFixed(2)} per credit · 90-day expiry</div>
                    </div>
                    <button onClick={() => onUpgrade && onUpgrade('topup_' + pack.id, 'once')}
                      style={{ padding: '9px 18px', borderRadius: 9, border: 'none', background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 800, flexShrink: 0, boxShadow: '0 3px 12px rgba(99,102,241,0.3)' }}>
                      ${pack.price}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Credit usage table */}
            <div style={{ borderRadius: 12, border: `1px solid ${borderC}`, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: `1px solid ${borderC}`, background: darkMode ? '#0f172a' : '#f8fafc' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: textMut, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Credit costs per action</div>
              </div>
              {[['AI diagram generation', 2], ['Terraform / HCL export', 2], ['CloudFormation export', 2], ['CDK TypeScript export', 3], ['CDK Python export', 3], ['Architecture validation', 2], ['Import from Terraform', 4]].map(([action, cost]) => (
                <div key={action} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: `1px solid ${borderC}44` }}>
                  <span style={{ fontSize: 12, color: textC }}>{action}</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: '#6366f1' }}>{cost} credits</span>
                </div>
              ))}
            </div>
          </>)}
        </div>
      </div>
    </div>
  );
}

// --- IaCExportModal -----------------------------------------------------------
// --- IaC Export Modal (Terraform / CloudFormation / CDK TS / CDK Python) ------
const IAC_FORMATS = [
  { id:'terraform',  label:'Terraform',       icon:'</>', ext:'.tf',   lang:'hcl',        credits:2, awsOnly:false },
  { id:'terraform_modules', label:'TF Modules', icon:'📁', ext:'.zip', lang:'hcl',        credits:5, awsOnly:false },
  { id:'cfn',        label:'CloudFormation',  icon:'☁️',  ext:'.yaml', lang:'yaml',       credits:2, awsOnly:true  },
  { id:'cdk_ts',     label:'CDK TypeScript',  icon:'TS',  ext:'.ts',   lang:'typescript', credits:3, awsOnly:true  },
  { id:'cdk_py',     label:'CDK Python',      icon:'🐍',  ext:'.py',   lang:'python',     credits:3, awsOnly:true  },
];

// Module grouping: maps service categories to Terraform module names
const MODULE_MAP = {
  'Compute':    'compute',
  'Storage':    'storage',
  'Database':   'database',
  'Networking': 'networking',
  'Security':   'security',
  'Developer':  'compute',
  'Messaging':  'messaging',
  'Monitoring': 'monitoring',
  'AI/ML':      'compute',
  'Analytics':  'analytics',
  'CDN':        'cdn',
  'DNS':        'cdn',
};
const CATEGORY_TO_MODULE=cat=>MODULE_MAP[cat]||'misc';

// Deduce module dependencies from connections
const buildModuleGraph=(elements,connections)=>{
  const elModule={}; // elementId -> moduleName
  elements.forEach(el=>{elModule[el.id]=CATEGORY_TO_MODULE(el.service?.category||'misc');});
  const deps={}; // moduleName -> Set of moduleNames it depends on
  connections.forEach(c=>{
    const fromMod=elModule[c.from], toMod=elModule[c.to];
    if(fromMod&&toMod&&fromMod!==toMod){
      if(!deps[fromMod])deps[fromMod]=new Set();
      deps[fromMod].add(toMod);
    }
  });
  return{elModule,deps};
};

function IaCExportModal({ darkMode, provider, elements, borders, labels, connections, diagramTitle, onClose }) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const codeBg=darkMode?'#0f172a':'#f1f5f9';

  const [format,setFormat]=useState('terraform');
  const [status,setStatus]=useState('idle');
  const [code,setCode]=useState('');
  const [files,setFiles]=useState(null); // {filename: content} for multi-file
  const [activeFile,setActiveFile]=useState(null);
  const [errorMsg,setErrorMsg]=useState('');
  const [copied,setCopied]=useState(false);
  const [activeProvider,setActiveProvider]=useState(provider||'aws');

  const fmt=IAC_FORMATS.find(f=>f.id===format)||IAC_FORMATS[0];
  const isAwsOnly=fmt.awsOnly&&activeProvider!=='aws';
  const isMultiFile=format==='terraform_modules';

  const switchFormat=(id)=>{setFormat(id);setCode('');setFiles(null);setActiveFile(null);setStatus('idle');setErrorMsg('');setProgress(0);setProgressLabel('');};
  const switchProvider=(id)=>{setActiveProvider(id);setCode('');setFiles(null);setActiveFile(null);setStatus('idle');setErrorMsg('');setProgress(0);setProgressLabel('');};

  const buildDiagramContext=()=>{
    const elLines=elements.map(el=>{
      const name=el.customName||el.service.name;
      return `  - ${name} (service: ${el.service.id}, category: ${el.service.category})`;
    }).join('\n');
    const borderLines=borders.map(b=>{
      const lbl=labels.find(l=>l.borderId===b.id);
      const name=lbl?.text||'Group';
      const inside=elements.filter(el=>el.x>=b.x&&el.x<=b.x+b.width&&el.y>=b.y&&el.y<=b.y+b.height)
        .map(el=>el.customName||el.service.name).join(', ');
      return `  - "${name}"${inside?` containing: ${inside}`:''}`;
    }).join('\n');
    const connLines=connections.slice(0,30).map(c=>{
      const from=elements.find(e=>e.id===c.from)||borders.find(b=>b.id===c.from);
      const to=elements.find(e=>e.id===c.to)||borders.find(b=>b.id===c.to);
      if(!from||!to)return null;
      const fn=from.customName||from.service?.name||labels.find(l=>l.borderId===from.id)?.text||'?';
      const tn=to.customName||to.service?.name||labels.find(l=>l.borderId===to.id)?.text||'?';
      return `  - ${fn} -> ${tn}`;
    }).filter(Boolean).join('\n');
    return `Diagram: "${diagramTitle||'AWS Architecture'}" · Provider: ${activeProvider.toUpperCase()}\n\nServices:\n${elLines||'  (none)'}\n\nGroups:\n${borderLines||'  (none)'}\n\nConnections:\n${connLines||'  (none)'}`;
  };

  // Build module grouping context for multi-file prompt
  const buildModuleContext=()=>{
    const{elModule,deps}=buildModuleGraph(elements,connections);
    const moduleGroups={};
    elements.forEach(el=>{
      const mod=elModule[el.id];
      if(!moduleGroups[mod])moduleGroups[mod]=[];
      moduleGroups[mod].push(el.customName||el.service.name);
    });
    const modLines=Object.entries(moduleGroups).map(([mod,els])=>`  ${mod}: ${els.join(', ')}`).join('\n');
    const depLines=Object.entries(deps).map(([mod,depSet])=>`  ${mod} depends on: ${[...depSet].join(', ')}`).join('\n');
    return{moduleGroups,modLines,depLines};
  };

  const buildSystemPrompt=()=>{
    if(format==='terraform_modules'){
      const{modLines,depLines}=buildModuleContext();
      const prov=activeProvider==='aws'?'hashicorp/aws ~> 5.0':activeProvider==='gcp'?'hashicorp/google ~> 5.0':'hashicorp/azurerm ~> 3.0';
      return `You are a senior cloud infrastructure engineer who writes production Terraform following HashiCorp best practices.

Generate a COMPLETE multi-file Terraform project structured as modules. Return ONLY a valid JSON object where keys are file paths and values are file contents. No markdown, no explanation, just the JSON object.

MODULE STRUCTURE REQUIRED:
${modLines}

MODULE DEPENDENCIES:
${depLines||'  (none detected - modules are independent)'}

FILE STRUCTURE TO GENERATE:
- versions.tf - terraform{} block with required_providers and version constraints
- providers.tf - provider configuration
- variables.tf - ALL root-level input variables
- locals.tf - local values and common_tags map
- main.tf - ONLY module calls, no resources directly
- outputs.tf - root-level outputs referencing module outputs
- terraform.tfvars - example variable values
- modules/<name>/main.tf - resources for that module
- modules/<name>/variables.tf - input variables for that module
- modules/<name>/outputs.tf - outputs from that module (IDs, ARNs, endpoints)

RULES:
- Every resource must live inside a module, NOT in root main.tf
- Root main.tf contains ONLY module{} blocks
- Cross-module references use module.<name>.<output> syntax
- Each module must export outputs that other modules need
- Variables flow: root variables.tf -> passed into module calls in main.tf -> received in modules/<name>/variables.tf
- Use ${prov}
- No inline comments inside resource blocks
- Include ALL resources for every service listed

Return format - a JSON object like:
{"versions.tf":"content","providers.tf":"content","variables.tf":"content","locals.tf":"content","main.tf":"content","outputs.tf":"content","terraform.tfvars":"content","modules/networking/main.tf":"content","modules/networking/variables.tf":"content","modules/networking/outputs.tf":"content"}`;
    }

    if(format==='terraform') return `You are a senior cloud infrastructure engineer. Generate production-quality Terraform HCL.
- Output ONLY valid HCL. No markdown fences.
- CRITICAL: Generate a resource block for EVERY SINGLE component listed in the diagram. Do not skip any resources.
- CONCISENESS: No inline comments inside resource blocks. Minimal arguments - required ones plus key security properties only.
- Include: terraform{} block, provider, variables (region, env, CIDR, instance types), ALL resources, outputs, locals with tags.
- Use ${activeProvider==='aws'?'hashicorp/aws ~> 5.0':activeProvider==='gcp'?'hashicorp/google ~> 5.0':'hashicorp/azurerm ~> 3.0'}.
- Wire dependencies correctly. Group with # === SECTION === comments only. Secure defaults.`;

    if(format==='cfn') return `You are a senior AWS CloudFormation expert. Generate a complete production-quality CloudFormation YAML template.
- Output ONLY valid YAML. No markdown fences. Start with AWSTemplateFormatVersion and Description.
- CRITICAL: Include a Resource entry for EVERY SINGLE component listed in the diagram. Do not omit any resources.
- CONCISENESS RULES (essential to fit all resources): No inline comments. Minimal Properties - only the required ones plus key security/config properties. No DependsOn unless strictly required to avoid circular refs. No lengthy Metadata blocks.
- Include: Parameters section (Environment, VpcCidr, InstanceType, DBPassword), ALL Resources with correct types, Outputs for VPC ID, ALB DNS, DB endpoint.
- Use correct types: AWS::EC2::VPC, AWS::EC2::Subnet, AWS::EC2::InternetGateway, AWS::EC2::VPCGatewayAttachment, AWS::EC2::NatGateway, AWS::EC2::EIP, AWS::EC2::RouteTable, AWS::EC2::Route, AWS::EC2::SubnetRouteTableAssociation, AWS::ElasticLoadBalancingV2::LoadBalancer, AWS::ElasticLoadBalancingV2::Listener, AWS::ElasticLoadBalancingV2::TargetGroup, AWS::AutoScaling::AutoScalingGroup, AWS::AutoScaling::LaunchTemplate, AWS::RDS::DBCluster, AWS::RDS::DBInstance, AWS::RDS::DBSubnetGroup, AWS::CloudFront::Distribution, AWS::Route53::RecordSet, AWS::S3::Bucket, AWS::IAM::Role, AWS::IAM::InstanceProfile, AWS::Logs::LogGroup, AWS::CloudWatch::Alarm, AWS::EC2::SecurityGroup.
- Use !Ref and !GetAtt for cross-references. DeletionPolicy: Retain on RDS and S3 only.`;

    if(format==='cdk_ts') return `You are a senior AWS CDK TypeScript expert. Generate a complete production-quality CDK stack.
- Output ONLY valid TypeScript. No markdown fences.
- CRITICAL: Create a CDK construct for EVERY SINGLE component listed in the diagram. Do not omit any.
- CONCISENESS: No JSDoc comments. Minimal props - required ones plus key security settings only. No blank lines between constructs.
- Structure: all necessary imports from aws-cdk-lib sub-modules, export class MyStack extends cdk.Stack.
- Use L2 constructs: ec2.Vpc, elbv2.ApplicationLoadBalancer, rds.DatabaseCluster, lambda.Function, s3.Bucket, cloudfront.Distribution, route53.ARecord, iam.Role, autoscaling.AutoScalingGroup, ecs.Cluster, eks.Cluster, cloudwatch.LogGroup, sqs.Queue, sns.Topic, dynamodb.Table.
- Wire via construct references. End with app entry point.`;

    if(format==='cdk_py') return `You are a senior AWS CDK Python expert. Generate a complete production-quality CDK stack.
- Output ONLY valid Python. No markdown fences.
- CRITICAL: Create a CDK construct for EVERY SINGLE component listed in the diagram. Do not omit any.
- CONCISENESS: No docstrings or block comments. Minimal kwargs - required ones plus key security settings only. No blank lines between constructs.
- Structure: all necessary imports from aws_cdk modules, class MyStack(Stack) with __init__.
- Use L2 constructs: ec2.Vpc, elbv2.ApplicationLoadBalancer, rds.DatabaseCluster, lambda_.Function, s3.Bucket, cloudfront.Distribution, route53.ARecord, iam.Role, autoscaling.AutoScalingGroup, ecs.Cluster, eks.Cluster, logs.LogGroup, sqs.Queue, sns.Topic, dynamodb.Table.
- Wire via construct references. End with app.synth().`;

    return '';
  };

  const userMessage=()=>{
    const ctx=buildDiagramContext();
    if(format==='terraform_modules') return `Generate a complete multi-file Terraform module project for this architecture:\n\n${ctx}\n\nReturn ONLY the JSON object with file paths as keys and HCL content as values. No markdown, no explanation.`;
    if(format==='terraform') return `Generate Terraform HCL for this architecture:\n\n${ctx}\n\nOutput only the complete main.tf content.`;
    if(format==='cfn') return `Generate a CloudFormation YAML template for this architecture:\n\n${ctx}\n\nOutput only the complete template.yaml content.`;
    if(format==='cdk_ts') return `Generate CDK TypeScript code for this architecture:\n\n${ctx}\n\nOutput only the complete stack.ts content.`;
    if(format==='cdk_py') return `Generate CDK Python code for this architecture:\n\n${ctx}\n\nOutput only the complete stack.py content.`;
    return '';
  };

  const [progress,setProgress]=useState(0); // 0-100
  const [progressLabel,setProgressLabel]=useState('');

  const generate=async()=>{
    if(isAwsOnly)return;
    setStatus('generating');setErrorMsg('');setCode('');setFiles(null);setActiveFile(null);
    setProgress(0);setProgressLabel('');
    try{
      if(isMultiFile){
        await generateModules();
      } else {
        // Single-file formats - simulate progress via timer
        setProgressLabel('Analysing architecture…');
        const timer=setInterval(()=>setProgress(p=>Math.min(p+3,88)),400);
        try{
          let raw=await callClaudeWithRetry({
            max_tokens:16000,
            system:buildSystemPrompt(),
            messages:[{role:'user',content:userMessage()}],
          });
          clearInterval(timer);
          setProgress(100);
          raw=raw.replace(/^```[\w]*\s*/i,'').replace(/\s*```\s*$/,'').trim();
          if(!raw)throw new Error('Empty response. Please try again.');
          setCode(raw);setStatus('done');
        }catch(e){clearInterval(timer);throw e;}
      }
    }catch(e){
      setStatus('error');setErrorMsg(e.message||'Generation failed. Please try again.');
      setProgress(0);
    }
  };

  const generateModules=async()=>{
    const{moduleGroups,modLines,depLines}=buildModuleContext();
    const moduleNames=Object.keys(moduleGroups);
    const allFiles={};
    const prov=activeProvider==='aws'?'hashicorp/aws ~> 5.0':activeProvider==='gcp'?'hashicorp/google ~> 5.0':'hashicorp/azurerm ~> 3.0';
    const ctx=buildDiagramContext();
    const safeName=(diagramTitle||'stack').toLowerCase().replace(/[^a-z0-9]+/g,'-');
    const totalSteps=moduleNames.length+2; // modules + root files + outputs
    let step=0;

    const tick=(label)=>{
      step++;
      setProgress(Math.round((step/totalSteps)*100));
      setProgressLabel(label);
    };

    // Step 1: Generate each module individually
    for(const mod of moduleNames){
      tick(`Building module: ${mod}/…`);
      const els=moduleGroups[mod];
      const raw=await callClaudeWithRetry({
        max_tokens:8000,
        system:`You are a senior Terraform engineer. Generate ONLY the Terraform HCL for the "${mod}" module.
Return a JSON object with exactly 3 keys: "main.tf", "variables.tf", "outputs.tf".
- main.tf: all resources for this module (${els.join(', ')})
- variables.tf: all input variables needed (vpc_id, subnet_ids, environment, etc.)
- outputs.tf: all useful output values (IDs, ARNs, endpoints, security group IDs)
- Use ${prov}
- No comments, minimal arguments, only required + key security properties
- Wire cross-module deps via variables, not data sources
- Return ONLY the JSON object, no markdown, no explanation.`,
        messages:[{role:'user',content:`Architecture context:\n${ctx}\n\nModule dependency info:\n${depLines||'none'}\n\nGenerate the "${mod}" module containing: ${els.join(', ')}.\n\nReturn JSON with keys "main.tf", "variables.tf", "outputs.tf".`}],
      });
      const parsed=safeParseModuleJSON(raw);
      if(parsed){
        allFiles[`modules/${mod}/main.tf`]=parsed['main.tf']||'# No resources generated';
        allFiles[`modules/${mod}/variables.tf`]=parsed['variables.tf']||'';
        allFiles[`modules/${mod}/outputs.tf`]=parsed['outputs.tf']||'';
      } else {
        // Fallback: use raw as main.tf
        allFiles[`modules/${mod}/main.tf`]=raw.replace(/^```[\w]*\s*/i,'').replace(/\s*```$/,'').trim();
        allFiles[`modules/${mod}/variables.tf`]='# Variables - review and complete\nvariable "environment" { type = string }';
        allFiles[`modules/${mod}/outputs.tf`]='# Outputs - review and complete';
      }
    }

    // Step 2: Generate root files (versions, providers, variables, locals, main, outputs, tfvars)
    tick('Building root files…');
    const moduleCallsDesc=moduleNames.map(m=>{
      const outs=allFiles[`modules/${m}/outputs.tf`]||'';
      const vars=allFiles[`modules/${m}/variables.tf`]||'';
      return `Module "${m}": contains ${moduleGroups[m].join(', ')}`;
    }).join('\n');

    const rootRaw=await callClaudeWithRetry({
      max_tokens:8000,
      system:`You are a senior Terraform engineer. Generate the ROOT-LEVEL files for a Terraform project that uses child modules.
Return a JSON object with these exact keys: "versions.tf", "providers.tf", "variables.tf", "locals.tf", "main.tf", "outputs.tf", "terraform.tfvars".
- versions.tf: terraform{} block with required_providers and required_version
- providers.tf: provider "${activeProvider==='aws'?'aws':activeProvider==='gcp'?'google':'azurerm'}" block with region/project variable
- variables.tf: ALL root input variables (environment, region/project, CIDRs, instance types, etc.)
- locals.tf: locals block with common_tags map
- main.tf: ONLY module{} blocks, one per child module listed. Pass outputs between modules using module.<name>.<output>. NO resources directly in main.tf.
- outputs.tf: key outputs referencing module outputs (VPC ID, ALB DNS, DB endpoint, etc.)
- terraform.tfvars: example values for all variables
- Use ${prov}
Return ONLY the JSON object, no markdown.`,
      messages:[{role:'user',content:`Architecture: ${ctx}\n\nModules that exist:\n${moduleCallsDesc}\n\nModule dependency graph:\n${depLines||'none'}\n\nGenerate all 7 root files. main.tf must use module{} calls that wire modules together using module.<name>.<output> references.`}],
    });
    const rootParsed=safeParseModuleJSON(rootRaw);
    const rootKeys=['versions.tf','providers.tf','variables.tf','locals.tf','main.tf','outputs.tf','terraform.tfvars'];
    if(rootParsed){
      rootKeys.forEach(k=>{if(rootParsed[k])allFiles[k]=rootParsed[k];});
    } else {
      allFiles['main.tf']=rootRaw.replace(/^```[\w]*\s*/i,'').replace(/\s*```$/,'').trim();
      allFiles['variables.tf']='# Root variables - review and complete\nvariable "environment" { default = "prod" }\nvariable "aws_region" { default = "us-east-1" }';
    }

    setProgress(100);
    setProgressLabel('Done!');
    setFiles(allFiles);
    setActiveFile('main.tf');
    setStatus('done');
  };

  // Robust JSON parser that handles markdown fences, trailing commas, truncation
  const safeParseModuleJSON=(raw)=>{
    if(!raw)return null;
    // Remove markdown fences
    let s=raw.replace(/^```[\w]*\s*/i,'').replace(/\s*```\s*$/,'').trim();
    // Try direct parse first
    try{return JSON.parse(s);}catch(_){}
    // Extract outermost {...}
    const start=s.indexOf('{'), end=s.lastIndexOf('}');
    if(start===-1||end===-1)return null;
    s=s.slice(start,end+1);
    try{return JSON.parse(s);}catch(_){}
    // Try to fix common issues: trailing commas, unterminated strings
    try{
      // Remove trailing commas before } or ]
      s=s.replace(/,\s*([}\]])/g,'$1');
      return JSON.parse(s);
    }catch(_){}
    // If still failing, JSON is truncated - return null to use fallback
    return null;
  };

  // Download single file
  const download=()=>{
    if(!code)return;
    const blob=new Blob([code],{type:'text/plain'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const safeName=(diagramTitle||'stack').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const fileNames={terraform:`${safeName}.tf`,cfn:`${safeName}-template.yaml`,cdk_ts:`${safeName}-stack.ts`,cdk_py:`${safeName}_stack.py`};
    a.download=fileNames[format]||`${safeName}${fmt.ext}`;
    a.href=url;document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Download ZIP for multi-file
  const downloadZip=async()=>{
    if(!files)return;
    const safeName=(diagramTitle||'stack').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    // Use JSZip if available, otherwise build a simple concatenated download
    try{
      // Dynamic import JSZip from CDN
      const script=document.createElement('script');
      script.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      await new Promise((res,rej)=>{script.onload=res;script.onerror=rej;document.head.appendChild(script);});
      const zip=new window.JSZip();
      const folder=zip.folder(safeName);
      Object.entries(files).forEach(([path,content])=>{
        // Create sub-folders as needed
        const parts=path.split('/');
        if(parts.length===1){
          folder.file(path,content);
        } else {
          let current=folder;
          for(let i=0;i<parts.length-1;i++){
            current=current.folder(parts[i]);
          }
          current.file(parts[parts.length-1],content);
        }
      });
      const blob=await zip.generateAsync({type:'blob'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.download=`${safeName}-terraform.zip`;
      a.href=url;document.body.appendChild(a);a.click();document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }catch(e){
      // Fallback: download as concatenated text
      const content=Object.entries(files).map(([path,c])=>`# ===== ${path} =====\n${c}`).join('\n\n');
      const blob=new Blob([content],{type:'text/plain'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.download=`${safeName}-terraform.tf`;
      a.href=url;document.body.appendChild(a);a.click();document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const copyCode=async()=>{
    const text=isMultiFile?(files&&activeFile?files[activeFile]:''):code;
    if(!text)return;
    try{await navigator.clipboard.writeText(text);}catch(_){
      const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;opacity:0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
    }
    setCopied(true);setTimeout(()=>setCopied(false),2500);
  };

  const lineCount=(isMultiFile&&files&&activeFile?files[activeFile]:code||'').split('\n').length;

  // File tree helpers
  const fileTree=files?Object.keys(files).reduce((tree,path)=>{
    const parts=path.split('/');
    if(parts.length===1){tree.root=tree.root||[];tree.root.push(path);}
    else{const dir=parts.slice(0,-1).join('/');tree[dir]=tree[dir]||[];tree[dir].push(path);}
    return tree;
  },{}):{};

  const ROOT_FILE_ORDER=['versions.tf','providers.tf','variables.tf','locals.tf','main.tf','outputs.tf','terraform.tfvars'];
  const sortedFiles=files?[
    ...ROOT_FILE_ORDER.filter(f=>files[f]),
    ...Object.keys(files).filter(f=>f.includes('/')).sort(),
  ]:[];

  const idleInfo={
    terraform:{emoji:'🏗️',title:'Generate Terraform HCL',desc:'Single main.tf with provider, variables, resources, outputs, and tags.',checks:['terraform {} + provider blocks','Variables for region, env, CIDRs','Resource blocks with cross-references','Output blocks for key values','locals{} with common tags']},
    terraform_modules:{emoji:'📁',title:'Generate Terraform Modules',desc:'Production-ready multi-file project with proper module structure.',checks:['versions.tf + providers.tf + locals.tf','variables.tf + terraform.tfvars','main.tf with module{} calls only','modules/<name>/ for each service group','Cross-module output references']},
    cfn:{emoji:'☁️',title:'Generate CloudFormation',desc:'Complete template.yaml ready to deploy via AWS Console or CLI.',checks:['AWSTemplateFormatVersion + Description','Parameters for env, CIDRs, instance types','Resources with !Ref / !GetAtt references','Outputs for ARNs and endpoints','DeletionPolicy on stateful resources']},
    cdk_ts:{emoji:'📦',title:'Generate CDK TypeScript',desc:'Complete stack.ts using aws-cdk-lib L2 constructs.',checks:['Imports from aws-cdk-lib sub-modules','MyStack class extends cdk.Stack','L2 constructs with type-safe props','Construct references (no hardcoded IDs)','app.synth() entry point']},
    cdk_py:{emoji:'🐍',title:'Generate CDK Python',desc:'Complete stack.py using aws_cdk L2 constructs.',checks:['Imports from aws_cdk modules','class MyStack(Stack) with __init__','L2 constructs with Pythonic API','Removal policies and security defaults','app.synth() entry point']},
  }[format];

  const applyCmd={terraform:'terraform apply',terraform_modules:'terraform init && terraform apply',cfn:'aws cloudformation deploy',cdk_ts:'cdk deploy',cdk_py:'cdk deploy'}[format];

  // Preview the module structure before generating
  const modulePreview=isMultiFile&&status==='idle'&&elements.length>0?()=>{
    const{moduleGroups}=buildModuleContext();
    return Object.entries(moduleGroups);
  }:null;

  return(
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}}
      style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:cardBg,borderRadius:20,width:'100%',maxWidth:760,maxHeight:'94vh',display:'flex',flexDirection:'column',boxShadow:'0 24px 64px rgba(0,0,0,0.5)'}}>

        {/* Header */}
        <div style={{background:'linear-gradient(135deg,#0f766e,#0891b2)',borderRadius:'20px 20px 0 0',padding:'16px 20px 14px',flexShrink:0}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12}}>
            <div>
              <div style={{fontSize:17,fontWeight:800,color:'#fff',marginBottom:2}}>{'</>'} Export Infrastructure Code</div>
              <div style={{fontSize:11,color:'rgba(255,255,255,0.8)'}}>Generate IaC from your diagram · {elements.length} services · {connections.length} connections</div>
            </div>
            <button onClick={onClose} style={{background:'rgba(255,255,255,0.15)',border:'none',cursor:'pointer',color:'#fff',fontSize:18,borderRadius:8,padding:'3px 9px'}}>✕</button>
          </div>

          {/* Format tabs */}
          <div style={{display:'flex',gap:4,marginBottom:10,flexWrap:'wrap'}}>
            {IAC_FORMATS.map(f=>(
              <button key={f.id} onClick={()=>switchFormat(f.id)}
                style={{flex:1,minWidth:60,padding:'6px 4px',borderRadius:8,border:`1.5px solid ${format===f.id?'#fff':'rgba(255,255,255,0.25)'}`,background:format===f.id?'rgba(255,255,255,0.22)':'transparent',color:'#fff',cursor:'pointer',fontSize:10,fontWeight:700,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
                <span style={{fontSize:13}}>{f.icon}</span>
                <span>{f.label}</span>
                <span style={{fontSize:9,opacity:0.8}}>{f.credits} cr</span>
              </button>
            ))}
          </div>

          {/* Provider selector for Terraform */}
          {(format==='terraform'||format==='terraform_modules')&&(
            <div style={{display:'flex',gap:5}}>
              {CLOUD_PROVIDERS.map(p=>(
                <button key={p.id} onClick={()=>switchProvider(p.id)}
                  style={{padding:'4px 10px',borderRadius:20,border:`1.5px solid ${activeProvider===p.id?'#fff':'rgba(255,255,255,0.3)'}`,background:activeProvider===p.id?'rgba(255,255,255,0.18)':'transparent',color:'#fff',cursor:'pointer',fontSize:10,fontWeight:700,display:'flex',alignItems:'center',gap:4}}>
                  {p.logo} {p.name}
                </button>
              ))}
            </div>
          )}
          {format!=='terraform'&&format!=='terraform_modules'&&(
            <div style={{fontSize:11,color:'rgba(255,255,255,0.7)',padding:'4px 8px',background:'rgba(255,255,255,0.08)',borderRadius:6,display:'inline-block'}}>
              ☁️ AWS only · For GCP/Azure use Terraform tab
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column'}}>

          {isAwsOnly&&(
            <div style={{padding:'20px',textAlign:'center'}}>
              <div style={{fontSize:32,marginBottom:10}}>☁️</div>
              <div style={{fontSize:14,fontWeight:700,color:textC,marginBottom:6}}>{fmt.label} is AWS-only</div>
              <div style={{fontSize:12,color:textMut,lineHeight:1.6,marginBottom:16}}>Switch to the <strong>Terraform</strong> tab to export GCP or Azure infrastructure code.</div>
              <button onClick={()=>switchFormat('terraform')} style={{padding:'9px 20px',borderRadius:9,border:'none',background:'linear-gradient(135deg,#0f766e,#0891b2)',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>Switch to Terraform {'->'}</button>
            </div>
          )}

          {!isAwsOnly&&status==='idle'&&(
            <div style={{overflowY:'auto',flex:1,padding:'14px 20px'}}>
              <div style={{textAlign:'center',marginBottom:20}}>
                <div style={{fontSize:40,marginBottom:8}}>{idleInfo?.emoji}</div>
                <div style={{fontSize:15,fontWeight:700,color:textC,marginBottom:4}}>{idleInfo?.title}</div>
                <div style={{fontSize:12,color:textMut,lineHeight:1.6,maxWidth:400,margin:'0 auto'}}>{idleInfo?.desc}</div>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:4,background:darkMode?'#0f172a':'#f8fafc',borderRadius:10,padding:'12px 14px',border:`1px solid ${borderC}`,maxWidth:400,margin:'0 auto 16px',fontSize:11,color:textMut}}>
                {idleInfo?.checks.map((c,i)=><div key={i}>✅ {c}</div>)}
                <div>⚠️ Review credentials &amp; environment values before deploying</div>
              </div>
              {/* Module preview for terraform_modules */}
              {isMultiFile&&modulePreview&&(
                <div style={{maxWidth:440,margin:'0 auto'}}>
                  <div style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:8}}>Detected Modules</div>
                  <div style={{background:darkMode?'#0f172a':'#f8fafc',borderRadius:10,border:`1px solid ${borderC}`,padding:'10px 14px',fontFamily:'monospace',fontSize:11,lineHeight:1.7,color:textC}}>
                    <div style={{color:'#10b981',marginBottom:4}}>📁 {(diagramTitle||'my-architecture').toLowerCase().replace(/[^a-z0-9]+/g,'-')}/</div>
                    {['versions.tf','providers.tf','variables.tf','locals.tf','main.tf','outputs.tf','terraform.tfvars'].map(f=>(
                      <div key={f} style={{paddingLeft:16,color:textMut}}>├-- <span style={{color:'#60a5fa'}}>{f}</span></div>
                    ))}
                    <div style={{paddingLeft:16,color:textMut,marginTop:4}}>└-- 📁 modules/</div>
                    {modulePreview().map(([mod,els])=>(
                      <div key={mod} style={{paddingLeft:32}}>
                        <div style={{color:textMut}}>├-- 📁 <span style={{color:'#f59e0b'}}>{mod}/</span></div>
                        {['main.tf','variables.tf','outputs.tf'].map(f=>(
                          <div key={f} style={{paddingLeft:16,color:textMut}}>│   ├-- <span style={{color:'#a78bfa'}}>{f}</span></div>
                        ))}
                        <div style={{paddingLeft:16,fontSize:10,color:textMut,fontStyle:'italic'}}>│       ({els.slice(0,3).join(', ')}{els.length>3?`, +${els.length-3} more`:''})</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!isAwsOnly&&status==='generating'&&(
            <div style={{textAlign:'center',padding:'40px 24px',flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
              <div style={{width:48,height:48,border:'4px solid rgba(8,145,178,0.2)',borderTop:'4px solid #0891b2',borderRadius:'50%',animation:'spin 0.9s linear infinite',marginBottom:20}}/>
              <div style={{fontSize:15,fontWeight:700,color:textC,marginBottom:6}}>
                {isMultiFile?'Building module structure…':'Generating code…'}
              </div>
              <div style={{fontSize:12,color:textMut,marginBottom:24,minHeight:18}}>
                {progressLabel||'Claude is analysing your architecture'}
              </div>
              {/* Progress bar */}
              <div style={{width:'100%',maxWidth:320}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{fontSize:10,color:textMut,fontWeight:600}}>
                    {isMultiFile?`${progressLabel?'Step in progress':'Starting…'}`:'Generating…'}
                  </span>
                  <span style={{fontSize:11,fontWeight:800,color:'#0891b2'}}>{progress}%</span>
                </div>
                <div style={{height:6,background:darkMode?'#374151':'#e5e7eb',borderRadius:3,overflow:'hidden'}}>
                  <div style={{height:'100%',width:`${progress}%`,background:'linear-gradient(90deg,#0f766e,#0891b2)',borderRadius:3,transition:'width 0.4s ease'}}/>
                </div>
                {isMultiFile&&progress>0&&progress<100&&(
                  <div style={{fontSize:10,color:textMut,marginTop:8,textAlign:'center'}}>
                    Each module is generated separately for accuracy
                  </div>
                )}
              </div>
            </div>
          )}

          {!isAwsOnly&&status==='error'&&(
            <div style={{padding:'14px 20px',flex:1}}>
              <div style={{padding:'14px',borderRadius:10,background:'#fee2e2',border:'1px solid #fca5a5'}}>
                <div style={{fontSize:13,fontWeight:700,color:'#991b1b',marginBottom:4}}>Generation failed</div>
                <div style={{fontSize:11,color:'#b91c1c',lineHeight:1.5,marginBottom:8}}>{errorMsg}</div>
                <button onClick={()=>setStatus('idle')} style={{padding:'5px 12px',borderRadius:6,border:'1px solid #f87171',background:'transparent',color:'#dc2626',cursor:'pointer',fontSize:11,fontWeight:600}}>Try Again</button>
              </div>
            </div>
          )}

          {/* Multi-file code view */}
          {!isAwsOnly&&status==='done'&&isMultiFile&&files&&(
            <div style={{flex:1,display:'flex',overflow:'hidden',minHeight:0}}>
              {/* File tree sidebar */}
              <div style={{width:200,flexShrink:0,borderRight:`1px solid ${borderC}`,overflowY:'auto',background:darkMode?'#0f172a':'#f8fafc',padding:'8px 0'}}>
                <div style={{fontSize:9,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',padding:'0 12px 6px'}}>Files</div>
                {/* Root files first */}
                {ROOT_FILE_ORDER.filter(f=>files[f]).map(f=>(
                  <button key={f} onClick={()=>setActiveFile(f)}
                    style={{width:'100%',padding:'5px 12px',border:'none',background:activeFile===f?(darkMode?'rgba(8,145,178,0.2)':'#dbeafe'):'transparent',color:activeFile===f?'#0891b2':textC,cursor:'pointer',fontSize:11,fontWeight:activeFile===f?700:400,textAlign:'left',display:'block'}}>
                    📄 {f}
                  </button>
                ))}
                {/* Module directories */}
                {[...new Set(Object.keys(files).filter(f=>f.includes('/')).map(f=>f.split('/').slice(0,-1).join('/')))].sort().map(dir=>(
                  <div key={dir}>
                    <div style={{padding:'8px 12px 3px',fontSize:10,fontWeight:700,color:'#f59e0b'}}>📁 {dir}/</div>
                    {Object.keys(files).filter(f=>f.startsWith(dir+'/')).map(f=>(
                      <button key={f} onClick={()=>setActiveFile(f)}
                        style={{width:'100%',padding:'4px 12px 4px 22px',border:'none',background:activeFile===f?(darkMode?'rgba(8,145,178,0.2)':'#dbeafe'):'transparent',color:activeFile===f?'#0891b2':textC,cursor:'pointer',fontSize:11,fontWeight:activeFile===f?700:400,textAlign:'left',display:'block'}}>
                        📄 {f.split('/').pop()}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              {/* Code panel */}
              <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minWidth:0}}>
                <div style={{padding:'8px 14px',borderBottom:`1px solid ${borderC}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0,background:darkMode?'#0f172a':'#f8fafc'}}>
                  <span style={{fontSize:12,fontWeight:700,color:textC,fontFamily:'monospace'}}>{activeFile}</span>
                  <span style={{fontSize:10,color:textMut}}>{activeFile&&files[activeFile]?files[activeFile].split('\n').length:0} lines</span>
                </div>
                <pre style={{flex:1,overflowY:'auto',overflowX:'auto',margin:0,padding:'12px 16px',fontSize:11,lineHeight:1.7,color:darkMode?'#e2e8f0':'#1e293b',background:codeBg,fontFamily:"'JetBrains Mono','Fira Code','Consolas',monospace",whiteSpace:'pre'}}>
                  {activeFile&&files[activeFile]||''}
                </pre>
              </div>
            </div>
          )}

          {/* Single-file code view */}
          {!isAwsOnly&&status==='done'&&!isMultiFile&&code&&(
            <div style={{flex:1,overflowY:'auto',padding:'14px 20px'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
                <span style={{fontSize:11,color:textMut,fontWeight:600}}>{lineCount} lines · {fmt.ext}</span>
                <span style={{fontSize:11,color:'#10b981',fontWeight:700}}>✅ Generated</span>
              </div>
              <div style={{position:'relative'}}>
                <pre style={{background:codeBg,border:`1px solid ${borderC}`,borderRadius:10,padding:'14px 16px',fontSize:11,lineHeight:1.7,color:darkMode?'#e2e8f0':'#1e293b',overflowX:'auto',fontFamily:"'JetBrains Mono','Fira Code','Consolas',monospace",margin:0,whiteSpace:'pre',maxHeight:360,overflowY:'auto'}}>
                  {code}
                </pre>
                <div style={{position:'absolute',bottom:0,left:0,right:0,height:28,background:`linear-gradient(transparent,${codeBg})`,borderRadius:'0 0 10px 10px',pointerEvents:'none'}}/>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:'12px 20px 18px',borderTop:`1px solid ${borderC}`,flexShrink:0}}>
          {!isAwsOnly&&status!=='done'&&(
            <button onClick={generate} disabled={status==='generating'||!elements.length||isAwsOnly}
              style={{width:'100%',padding:'13px',borderRadius:12,border:'none',
                background:status==='generating'||!elements.length?'#9ca3af':'linear-gradient(135deg,#0f766e,#0891b2)',
                color:'#fff',cursor:status==='generating'||!elements.length?'not-allowed':'pointer',
                fontSize:14,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',gap:10,
                boxShadow:status!=='generating'&&elements.length?'0 4px 20px rgba(8,145,178,0.4)':'none'}}>
              {status==='generating'
                ?<><div style={{width:18,height:18,border:'2.5px solid rgba(255,255,255,0.3)',borderTop:'2.5px solid #fff',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>
                  {isMultiFile?'Building modules…':'Generating…'}</>
                :<>{fmt.icon} Generate {fmt.label}</>
              }
            </button>
          )}
          {!isAwsOnly&&status==='done'&&(
            <div style={{display:'flex',gap:8}}>
              <button onClick={copyCode}
                style={{flex:1,padding:'11px',borderRadius:10,border:`1.5px solid ${copied?'#10b981':borderC}`,background:copied?'#d1fae5':'transparent',color:copied?'#065f46':textC,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6,transition:'all 0.2s'}}>
                {copied?'✅ Copied!':isMultiFile?'📋 Copy File':'📋 Copy'}
              </button>
              <button onClick={isMultiFile?downloadZip:download}
                style={{flex:2,padding:'11px',borderRadius:10,border:'none',background:'linear-gradient(135deg,#0f766e,#0891b2)',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6,boxShadow:'0 3px 12px rgba(8,145,178,0.35)'}}>
                {isMultiFile?'⬇ Download ZIP':'⬇ Download'} {isMultiFile?'':''+fmt.ext}
              </button>
              <button onClick={()=>{setStatus('idle');setCode('');setFiles(null);setActiveFile(null);}}
                style={{padding:'11px 13px',borderRadius:10,border:`1.5px solid ${borderC}`,background:'transparent',color:textMut,cursor:'pointer',fontSize:13,fontWeight:600}}>↺</button>
            </div>
          )}
          {!isAwsOnly&&(
            <div style={{marginTop:8,fontSize:10,color:textMut,textAlign:'center'}}>
              {fmt.credits} credits · Review all values before running <code style={{background:darkMode?'#374151':'#e5e7eb',padding:'1px 4px',borderRadius:3}}>{applyCmd}</code>
            </div>
          )}
        </div>
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>
    </div>
  );
}

// --- AiGenerateModal ----------------------------------------------------------
const CREDIT_COSTS = { simple:1, standard:2, detailed:3 };
const EXAMPLE_PROMPTS = [
  'A VPC with 2 public and 2 private subnets, an internet gateway, NAT gateway, and 2 EC2 instances in each subnet',
  'Three-tier web app with an ALB, 3 EC2 web servers, RDS Aurora database, and ElastiCache in front of the DB',
  'Serverless API with API Gateway, Lambda functions, DynamoDB table, S3 bucket, and CloudWatch monitoring',
  'EKS cluster with a load balancer, 3 node groups, ECR registry, RDS database, and VPC networking',
  'CI/CD pipeline using CodeCommit, CodeBuild, CodePipeline, CodeDeploy deploying to ECS with ECR',
  'GCP microservices: Cloud Run services, Cloud SQL, Pub/Sub, Cloud Load Balancing, and Cloud Armor',
  'Azure web app: App Service, Azure SQL, Blob Storage, Azure CDN, and Azure AD for auth',
  'A VPC with an EC2 web server, RDS database, S3 bucket, and CloudFront - add a text box next to each component explaining what it does',
];

function AiGenerateModal({ darkMode, provider, onClose, onGenerate,
  currentElements=[], currentConnections=[], currentBorders=[], currentBubbles=[], currentLabels=[], currentTitle='', onPreModify }) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent='#7c3aed';

  const [modalTab,setModalTab]=useState(currentElements.length>0?'modify':'generate'); // generate | modify
  const [prompt,setPrompt]=useState('');
  const [modifyPrompt,setModifyPrompt]=useState('');
  const [complexity,setComplexity]=useState('standard');
  const [activeProvider,setActiveProvider]=useState(provider||'aws');
  const [status,setStatus]=useState('idle'); // idle | generating | done | error
  const [modifyStatus,setModifyStatus]=useState('idle');
  const [errorMsg,setErrorMsg]=useState('');
  const [modifyErrorMsg,setModifyErrorMsg]=useState('');
  const [credits,setCredits]=useState(20);
  const [showExample,setShowExample]=useState(false);
  const [genPhase,setGenPhase]=useState('');
  const [modifyPhase,setModifyPhase]=useState('');
  const [lastModifyPrompt,setLastModifyPrompt]=useState('');
  const textRef=useRef(null);
  const modifyRef=useRef(null);

  const hasExistingDiagram=currentElements.length>0;

  useEffect(()=>{
    if(modalTab==='generate') setTimeout(()=>textRef.current?.focus(),120);
    else setTimeout(()=>modifyRef.current?.focus(),120);
  },[modalTab]);

  const cost=CREDIT_COSTS[complexity]||2;
  const canGenerate=prompt.trim().length>10&&credits>=cost&&status!=='generating';
  const canModify=modifyPrompt.trim().length>5&&credits>=2&&modifyStatus!=='generating'&&hasExistingDiagram;

  // Serialise current diagram for modification context
  const serialiseDiagram=()=>{
    const allSvcs=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];
    const els=currentElements.map(el=>({
      id:el.id,
      serviceId:el.service?.id||'ec2',
      label:el.customName||el.service?.name||'',
      x:el.x, y:el.y, width:el.width||130, height:el.height||110,
    }));
    const conns=currentConnections.map(c=>({
      from:c.from, to:c.to, type:c.type||'arrow', bent:!!c.bent,
      midLabel:c.midLabel||undefined,
    }));
    const bords=currentBorders.map(b=>{
      const lbl=currentLabels.find(l=>l.borderId===b.id);
      return{id:b.id, label:lbl?.text||b.label||'', x:b.x, y:b.y, width:b.width, height:b.height, color:b.color||'#3b82f6'};
    });
    const bbls=currentBubbles.map(b=>({
      id:b.id, text:b.text||'', shape:b.shape||'textbox',
      x:b.x, y:b.y, w:b.w||220, h:b.h||70,
      fillColor:b.fillColor, strokeColor:b.strokeColor, textColor:b.textColor,
    }));
    return{title:currentTitle||'Current Architecture',elements:els,connections:conns,borders:bords,bubbles:bbls};
  };

  const buildModifySystemPrompt=(modType)=>{
    const allSvcIds={
      aws:AWS_SERVICES.map(s=>s.id).join(', '),
      gcp:GCP_SERVICES.map(s=>s.id).join(', '),
      azure:AZURE_SERVICES.map(s=>s.id).join(', '),
    };
    const svcIds=allSvcIds[activeProvider]||allSvcIds.aws;

    const opGuide={
      additive:`OPERATION: ADDITIVE - add new services, connections, borders, or annotations.
  - Keep ALL existing elements, connections, borders, and bubbles exactly as-is
  - Generate new unique IDs for new elements using prefix "mod_" + short descriptor
  - Detect the existing grid from current positions (reverse-engineer the padding system)
  - Place new elements respecting the established grid spacing (30px sibling gaps, nesting padding)
  - If the new element does not fit without violating spacing rules:
    EXPAND the parent container - do NOT squeeze or overlap. Cascade expansion upward.
  - Connect new elements to relevant existing ones
  - Add bubble annotation for each new significant service at x>=1300 (vertical) or y>=700 (horizontal)
  - All siblings at the same level must remain the same size after addition`,
      subtractive:`OPERATION: SUBTRACTIVE - remove specified services, connections, or groups.
  - Identify the element(s) matching the instruction to remove
  - Delete those elements from the elements array
  - Delete ALL connections where from or to references a removed element ID
  - Delete ALL bubbles where connectTo references a removed element ID
  - Resize or remove borders if removing an element leaves a border empty
  - Keep everything else exactly as-is`,
      replacement:`OPERATION: REPLACEMENT - swap one service type for another.
  - Find the element(s) matching the service to replace
  - Keep the EXACT same id, x, y, width, height as the original
  - Update ONLY: serviceId (to the new service), label (to the new service name or as instructed)
  - Keep ALL existing connections referencing this element's ID - they still apply
  - Update the bubble text for this element if one exists, to describe the new service
  - Keep all other elements exactly as-is`,
      structural:`OPERATION: STRUCTURAL REORGANISATION - change the layout, grouping, or overall architecture.
  - Recalculate element positions to match the new layout described
  - Keep all element IDs the same - only change x, y positions and border dimensions
  - Vertical layout: y=60 users, y=240 DNS, y=420 CDN, y=600 LB, y=800 compute, y=1020 data
  - Horizontal layout: x=60 sources, x=340 ingest, x=620 process, x=900 store, x=1160 analytics
  - 260px minimum between all element centres
  - Recalculate all border positions to contain their elements with 70px padding`,
      general:`OPERATION: GENERAL MODIFICATION - follow the instruction carefully.
  - If adding: preserve all existing, add new with unique IDs
  - If removing: delete element + its connections + its bubbles
  - If replacing: keep same ID and position, update serviceId and label only
  - If reorganising: keep IDs, update positions only`,
    }[modType]||'Follow the modification instruction precisely.';

    return `You are an expert AWS cloud architect modifying an existing architecture diagram.
Return the COMPLETE modified diagram JSON - all elements, all connections, all borders, all bubbles.

${opGuide}

UNIVERSAL RULES (apply to all operations):
- Available service IDs - ONLY use these exact strings for serviceId: ${svcIds}
- ALB/NLB must always have at least 2 compute targets (EC2, ECS, Lambda exception)
- Element sizes: ALWAYS width:130, height:110. All siblings at same level same size.
- Nesting padding: VPC=40px, NACL=30px, Subnet=24px, SecurityGroup=16px inward all sides
- Container sizing: derived BOTTOM-UP from element sizes + padding, never top-down
- Sibling gaps: exactly 30px between ALL sibling borders horizontally AND vertically
- Mathematical centering: every element centred within its parent using exact arithmetic
- Absolute minimums: 20px between any two borders, 130px between any two elements, NO overlaps
- Grid alignment: same-row elements share y coordinate, same-column elements share x coordinate
- Security hierarchy: VPC(solid #3b82f6)->NACL(dotted)->Subnet(solid)->SecurityGroup(dashed #ef4444)
- Label placement: all border labels top-left corner, 8px inset from edges
- Connection routing: use bent:true to avoid diagonal cuts through unrelated containers
- Bubbles: column at x>=1300 (vertical) or row at y>=700 (horizontal), never overlapping
- Modification cascading: if adding an element doesn't fit, EXPAND the parent container
  upward through the hierarchy - never squeeze or overlap existing elements
- Valid JSON only - no markdown, no code fences, no explanation

OUTPUT (return complete diagram):
{"title":"...","elements":[...],"connections":[...],"borders":[...],"bubbles":[...]}`;
  };

  const modify=async()=>{
    if(!canModify) return;
    if(onPreModify) onPreModify();
    setModifyStatus('generating');
    setModifyErrorMsg('');
    setModifyPhase('analysing');

    const currentDiagram=serialiseDiagram();
    const modType=classifyModification(modifyPrompt);

    try{
      setModifyPhase('modifying');
      const raw=await callClaudeWithRetry({
        max_tokens:14000,
        system:buildModifySystemPrompt(modType),
        messages:[{role:'user',content:`Current diagram:\n${JSON.stringify(currentDiagram,null,2)}\n\nModification (${modType}): "${modifyPrompt.trim()}"\n\nReturn the complete modified diagram JSON.`}],
      });

      let diagram;
      try{diagram=safeParseJSON(raw);}
      catch(e){throw new Error('Could not parse modification response. Please try again.');}

      const allSvcs=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];
      const providerSvcs=activeProvider==='gcp'?GCP_SERVICES:activeProvider==='azure'?AZURE_SERVICES:AWS_SERVICES;
      const ts=Date.now();

      const elements=(diagram.elements||[]).map((el,i)=>{
        const svc=providerSvcs.find(s=>s.id===el.serviceId)||allSvcs.find(s=>s.id===el.serviceId)||providerSvcs[0];
        return{id:el.id||`mod_el_${ts}_${i}`,service:svc,x:Math.round((el.x||100)/10)*10,y:Math.round((el.y||100)/10)*10,width:el.width||130,height:el.height||110,customName:el.label!==svc?.name?el.label:null};
      });

      const idMap={};
      elements.forEach((el,i)=>{if(diagram.elements[i]?.id)idMap[diagram.elements[i].id]=el.id;});
      currentElements.forEach(el=>{idMap[el.id]=el.id;});

      // Preserve original connection styles for existing connections
      const existingConnMap={};
      currentConnections.forEach(c=>{existingConnMap[`${c.from}->${c.to}`]=c;});

      const connections=(diagram.connections||[]).map((c,i)=>{
        const fromId=idMap[c.from]||c.from;
        const toId=idMap[c.to]||c.to;
        const existing=existingConnMap[`${fromId}->${toId}`];
        return{
          id:existing?.id||`mod_c_${ts}_${i}`,
          from:fromId, to:toId,
          type:c.type||existing?.type||'arrow',
          bent:c.bent!==undefined?!!c.bent:!!(existing?.bent),
          color:existing?.color||'#3b82f6',
          strokeWidth:existing?.strokeWidth||3,
          arrowSize:existing?.arrowSize||14,
          midLabel:c.midLabel||existing?.midLabel||null,
          animated:existing?.animated||false,
          dashStyle:existing?.dashStyle||null,
          animation:existing?.animation||null,
        };
      }).filter(c=>c.from&&c.to&&c.from!==c.to);

      // Preserve original border styles for existing borders
      const existingBorderMap={};
      currentBorders.forEach(b=>{existingBorderMap[b.id]=b;});

      const rawBorders=(diagram.borders||[]).map((b,i)=>{
        const existing=existingBorderMap[b.id];
        return{
          id:b.id||`mod_b_${ts}_${i}`,
          x:Math.round((b.x||50)/10)*10, y:Math.round((b.y||50)/10)*10,
          width:b.width||400, height:b.height||300,
          color:b.color||existing?.color||'#3b82f6',
          strokeWidth:existing?.strokeWidth||2,
          strokeStyle:existing?.strokeStyle||'solid',
          fillColor:existing?.fillColor||'transparent',
          fillOpacity:existing?.fillOpacity||0.05,
          borderRadius:existing?.borderRadius||8,
          label:b.label||'',
          animation:existing?.animation||null,
        };
      });

      const borders=computeAutoGroupBorders(elements,rawBorders,ts,classifyModification(modifyPrompt));

      const borderLabels=borders.filter(b=>b.label).map((b,i)=>{
        const existLbl=currentLabels.find(l=>l.borderId===b.id);
        return{id:existLbl?.id||`mod_lbl_${ts}_${i}`,borderId:b.id,text:b.label,color:b.color,manualWidth:existLbl?.manualWidth||null,manualHeight:existLbl?.manualHeight||null};
      });

      const validBubbleShapes=['speech','rounded','rectangle','textbox','thought','cloud','shout'];
      const existingBubbleMap={};
      currentBubbles.forEach(b=>{existingBubbleMap[b.id]=b;});

      const bubbles=(diagram.bubbles||[]).map((b,i)=>{
        const existing=existingBubbleMap[b.id];
        const bW=Math.max(160,b.w||240);
        const bText=b.text||existing?.text||'';
        return{
          id:b.id||`mod_bbl_${ts}_${i}`,
          x:Math.round((b.x||200)/10)*10, y:Math.round((b.y||200)/10)*10,
          w:bW, h:calcBubbleHeight(bText,bW),
          shape:validBubbleShapes.includes(b.shape)?b.shape:'textbox',
          fillColor:b.fillColor||existing?.fillColor||'#f0f9ff',
          strokeColor:b.strokeColor||existing?.strokeColor||'#3b82f6',
          strokeWidth:existing?.strokeWidth||1.5,
          text:bText,
          textColor:b.textColor||existing?.textColor||'#1e293b',
          fontFamily:existing?.fontFamily||'Arial',
        };
      });

      setCredits(c=>c-2);
      setModifyStatus('done');
      setModifyPhase('');
      setLastModifyPrompt(modifyPrompt.trim());
      setModifyPrompt('');

      setTimeout(()=>{
        onGenerate(elements,connections,borders,diagram.title||currentTitle||'Modified Architecture',borderLabels,bubbles);
      },600);

    }catch(e){
      console.error('Modify error:',e);
      setModifyStatus('error');
      setModifyPhase('');
      setModifyErrorMsg(e.message||'Modification failed. Please try again.');
    }
  };

  const classifyModification=(text)=>{
    const t=text.toLowerCase();
    if(/remove|delete|drop|eliminate|get rid of|take out/.test(t)) return 'subtractive';
    if(/replace|swap|change.*to|convert|switch|upgrade|downgrade|migrate/.test(t)) return 'replacement';
    if(/reorgani|restructure|layout|rearrange|reorder|move everything|horizontal|vertical/.test(t)) return 'structural';
    if(/add|include|insert|attach|put|introduce|create/.test(t)) return 'additive';
    return 'general';
  };

  // -- Build the system prompt that tells Claude exactly what JSON to return (GENERATION)
  const buildSystemPrompt=()=>{
    const allSvcIds={
      aws:AWS_SERVICES.map(s=>s.id).join(', '),
      gcp:GCP_SERVICES.map(s=>s.id).join(', '),
      azure:AZURE_SERVICES.map(s=>s.id).join(', '),
    };
    const detailLevel=`CRITICAL RULE - ONLY GENERATE WHAT THE USER EXPLICITLY ASKS FOR.
Do not add any service, component, border, or connection that is not mentioned in the user's prompt.
If the user asks for "a VPC with 2 subnets" - generate exactly that. No NAT gateways, no NACLs, no security groups, no CloudWatch unless asked.
If the user asks for "a serverless API" - generate exactly that. No WAF, no IAM roles, no ACM unless asked.
The user controls the scope. You only add what they request.
Complexity level selected: ${complexity}. Use this only as a guide for HOW MUCH DETAIL to show for things they DID ask for - not as permission to add unrequested services.`;

    const providerName=activeProvider.toUpperCase();
    const svcIds=allSvcIds[activeProvider]||allSvcIds.aws;

    // -- Few-shot examples (canonical AWS architectures) ----------------------
    const fewShotExamples=activeProvider==='aws'?`
====================================================
REFERENCE EXAMPLE 1 - Three-Tier Web App (ECS/EC2)
TRIGGERS: "web app", "website", "SaaS", "e-commerce", "ECS", "Fargate", "containers", "3-tier"
PATTERN: internet entry -> CDN -> load balancer -> compute (multi-AZ) -> database
SPACING NOTE: Elements are 260px apart vertically. Compute nodes 280px apart horizontally.
Borders have 70px padding. Bubbles form a clean column on the far right (x:1300+).
====================================================
{
  "title": "ECS Fargate Web App",
  "elements": [
    {"id":"users",  "serviceId":"users",      "label":"Users",              "x":640,"y":60,   "width":130,"height":110},
    {"id":"r53",    "serviceId":"route53",     "label":"Route 53",           "x":640,"y":240,  "width":130,"height":110},
    {"id":"cf",     "serviceId":"cloudfront",  "label":"CloudFront",         "x":640,"y":420,  "width":130,"height":110},
    {"id":"alb",    "serviceId":"elb",         "label":"App Load Balancer",  "x":640,"y":600,  "width":130,"height":110},
    {"id":"ecs1",   "serviceId":"ecs",         "label":"ECS Fargate AZ-1",   "x":400,"y":800,  "width":130,"height":110},
    {"id":"ecs2",   "serviceId":"ecs",         "label":"ECS Fargate AZ-2",   "x":880,"y":800,  "width":130,"height":110},
    {"id":"aurora", "serviceId":"aurora",      "label":"Aurora MySQL",       "x":520,"y":1020, "width":130,"height":110},
    {"id":"cache",  "serviceId":"elasticache", "label":"ElastiCache Redis",  "x":760,"y":1020, "width":130,"height":110},
    {"id":"s3",     "serviceId":"s3",          "label":"Static Assets",      "x":920,"y":420,  "width":130,"height":110},
    {"id":"cw",     "serviceId":"cloudwatch",  "label":"CloudWatch",         "x":1080,"y":600, "width":130,"height":110}
  ],
  "connections":[
    {"from":"users","to":"r53",   "type":"arrow","bent":false},
    {"from":"r53",  "to":"cf",    "type":"arrow","bent":false},
    {"from":"cf",   "to":"alb",   "type":"arrow","bent":false},
    {"from":"cf",   "to":"s3",    "type":"arrow","bent":true},
    {"from":"alb",  "to":"ecs1",  "type":"arrow","bent":false},
    {"from":"alb",  "to":"ecs2",  "type":"arrow","bent":false},
    {"from":"ecs1", "to":"aurora","type":"arrow","bent":false},
    {"from":"ecs2", "to":"aurora","type":"arrow","bent":false},
    {"from":"ecs1", "to":"cache", "type":"arrow","bent":true},
    {"from":"cw",   "to":"alb",   "type":"line", "bent":true}
  ],
  "borders":[
    {"id":"vpc",  "label":"VPC",            "x":290,"y":540, "width":890,"height":570,"color":"#3b82f6"},
    {"id":"pub",  "label":"Public Subnet",  "x":330,"y":570, "width":810,"height":190,"color":"#10b981"},
    {"id":"priv", "label":"Private Subnet", "x":330,"y":760, "width":810,"height":360,"color":"#f59e0b"}
  ],
  "bubbles":[
    {"id":"b_r53",  "text":"Global DNS routing with health checks and failover",           "shape":"textbox","x":1300,"y":200, "w":240,"h":70, "fillColor":"#f0f9ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"r53"},
    {"id":"b_cf",   "text":"CDN caches static assets globally, reduces latency",          "shape":"textbox","x":1300,"y":300, "w":240,"h":70, "fillColor":"#f0f9ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"cf"},
    {"id":"b_alb",  "text":"Distributes traffic across ECS tasks in two AZs",            "shape":"textbox","x":1300,"y":400, "w":240,"h":70, "fillColor":"#f0f9ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"alb"},
    {"id":"b_ecs",  "text":"Fargate tasks run containers - no EC2 to manage",            "shape":"textbox","x":1300,"y":500, "w":240,"h":70, "fillColor":"#fff7ed","strokeColor":"#f59e0b","textColor":"#1e293b","connectTo":"ecs1"},
    {"id":"b_aur",  "text":"Multi-AZ Aurora for high availability and auto-failover",    "shape":"textbox","x":1300,"y":600, "w":240,"h":70, "fillColor":"#fff7ed","strokeColor":"#f59e0b","textColor":"#1e293b","connectTo":"aurora"},
    {"id":"b_cach", "text":"Redis caches session data and query results",                 "shape":"textbox","x":1300,"y":700, "w":240,"h":70, "fillColor":"#fff7ed","strokeColor":"#f59e0b","textColor":"#1e293b","connectTo":"cache"}
  ]
}

====================================================
REFERENCE EXAMPLE 2 - Serverless API
TRIGGERS: "serverless", "Lambda", "no servers", "functions", "API", "REST API"
PATTERN: internet -> API Gateway -> Lambda functions -> managed data services
SPACING NOTE: Lambda functions spaced 280px apart. Bubbles in clean right column at x:1260.
NO midLabels on connections - they clutter the diagram.
====================================================
{
  "title": "Serverless REST API",
  "elements": [
    {"id":"client", "serviceId":"users",      "label":"Client Apps",    "x":620,"y":60,  "width":130,"height":110},
    {"id":"r53",    "serviceId":"route53",    "label":"Route 53",       "x":620,"y":240, "width":130,"height":110},
    {"id":"apigw",  "serviceId":"apigateway", "label":"API Gateway",    "x":620,"y":420, "width":130,"height":110},
    {"id":"cognito","serviceId":"cognito",    "label":"Cognito",        "x":940,"y":420, "width":130,"height":110},
    {"id":"lam1",   "serviceId":"lambda",     "label":"Read Lambda",    "x":340,"y":620, "width":130,"height":110},
    {"id":"lam2",   "serviceId":"lambda",     "label":"Write Lambda",   "x":620,"y":620, "width":130,"height":110},
    {"id":"lam3",   "serviceId":"lambda",     "label":"Async Lambda",   "x":900,"y":620, "width":130,"height":110},
    {"id":"ddb",    "serviceId":"dynamodb",   "label":"DynamoDB",       "x":340,"y":840, "width":130,"height":110},
    {"id":"s3",     "serviceId":"s3",         "label":"S3 Storage",     "x":620,"y":840, "width":130,"height":110},
    {"id":"sqs",    "serviceId":"sqs",        "label":"SQS Queue",      "x":900,"y":840, "width":130,"height":110},
    {"id":"cw",     "serviceId":"cloudwatch", "label":"CloudWatch",     "x":1080,"y":240,"width":130,"height":110}
  ],
  "connections":[
    {"from":"client","to":"r53",    "type":"arrow","bent":false},
    {"from":"r53",   "to":"apigw",  "type":"arrow","bent":false},
    {"from":"apigw", "to":"cognito","type":"arrow","bent":true},
    {"from":"apigw", "to":"lam1",   "type":"arrow","bent":false},
    {"from":"apigw", "to":"lam2",   "type":"arrow","bent":false},
    {"from":"apigw", "to":"lam3",   "type":"arrow","bent":false},
    {"from":"lam1",  "to":"ddb",    "type":"arrow","bent":false},
    {"from":"lam2",  "to":"ddb",    "type":"arrow","bent":false},
    {"from":"lam2",  "to":"s3",     "type":"arrow","bent":true},
    {"from":"lam3",  "to":"sqs",    "type":"arrow","bent":false},
    {"from":"cw",    "to":"apigw",  "type":"line", "bent":true}
  ],
  "borders":[
    {"id":"fns",  "label":"Lambda Functions","x":240,"y":565,"width":770,"height":200,"color":"#f59e0b"},
    {"id":"data", "label":"Data Layer",      "x":240,"y":785,"width":770,"height":210,"color":"#8b5cf6"}
  ],
  "bubbles":[
    {"id":"b_gw",  "text":"Single entry point - routes requests to the right Lambda",     "shape":"textbox","x":1260,"y":200, "w":240,"h":70, "fillColor":"#f0f9ff","strokeColor":"#7c3aed","textColor":"#1e293b","connectTo":"apigw"},
    {"id":"b_cog", "text":"Manages user sign-up, sign-in and JWT token validation",       "shape":"textbox","x":1260,"y":300, "w":240,"h":70, "fillColor":"#f0f9ff","strokeColor":"#7c3aed","textColor":"#1e293b","connectTo":"cognito"},
    {"id":"b_lam", "text":"Each Lambda handles one responsibility - scales independently","shape":"textbox","x":1260,"y":400, "w":240,"h":70, "fillColor":"#fff7ed","strokeColor":"#f59e0b","textColor":"#1e293b","connectTo":"lam1"},
    {"id":"b_ddb", "text":"DynamoDB scales to any load with single-digit ms latency",     "shape":"textbox","x":1260,"y":500, "w":240,"h":70, "fillColor":"#f5f3ff","strokeColor":"#8b5cf6","textColor":"#1e293b","connectTo":"ddb"},
    {"id":"b_sqs", "text":"Decouples async work - retry logic built in",                  "shape":"textbox","x":1260,"y":600, "w":240,"h":70, "fillColor":"#f5f3ff","strokeColor":"#8b5cf6","textColor":"#1e293b","connectTo":"sqs"}
  ]
}

====================================================
REFERENCE EXAMPLE 3 - Real-Time Data Pipeline
TRIGGERS: "data pipeline", "ETL", "analytics", "streaming", "data processing", "real-time", "data lake"
PATTERN: sources (left) -> ingest -> process -> store -> analytics (right), horizontal layout
SPACING NOTE: Stages 280px apart horizontally. Items in same stage 200px apart vertically.
Bubbles in clean column BELOW the diagram at y:700+.
====================================================
{
  "title": "Real-Time Data Pipeline",
  "elements": [
    {"id":"app",     "serviceId":"ec2",        "label":"App Servers",    "x":60,  "y":180,"width":130,"height":110},
    {"id":"iot",     "serviceId":"iot",        "label":"IoT Devices",    "x":60,  "y":400,"width":130,"height":110},
    {"id":"kinesis", "serviceId":"kinesis",    "label":"Kinesis Streams","x":340, "y":290,"width":130,"height":110},
    {"id":"lam",     "serviceId":"lambda",     "label":"Stream Processor","x":620, "y":180,"width":130,"height":110},
    {"id":"firehose","serviceId":"kinesis",    "label":"Firehose",       "x":620, "y":400,"width":130,"height":110},
    {"id":"s3raw",   "serviceId":"s3",         "label":"Raw Data Lake",  "x":900, "y":180,"width":130,"height":110},
    {"id":"s3proc",  "serviceId":"s3",         "label":"Processed Data", "x":900, "y":400,"width":130,"height":110},
    {"id":"glue",    "serviceId":"glue",       "label":"Glue ETL",       "x":1160,"y":290,"width":130,"height":110},
    {"id":"redshift","serviceId":"redshift",   "label":"Redshift DW",    "x":1160,"y":480,"width":130,"height":110},
    {"id":"athena",  "serviceId":"athena",     "label":"Athena Queries", "x":1160,"y":100,"width":130,"height":110}
  ],
  "connections":[
    {"from":"app",     "to":"kinesis", "type":"arrow","bent":false},
    {"from":"iot",     "to":"kinesis", "type":"arrow","bent":false},
    {"from":"kinesis", "to":"lam",     "type":"arrow","bent":false},
    {"from":"kinesis", "to":"firehose","type":"arrow","bent":false},
    {"from":"lam",     "to":"s3raw",   "type":"arrow","bent":false},
    {"from":"firehose","to":"s3proc",  "type":"arrow","bent":false},
    {"from":"s3raw",   "to":"glue",    "type":"arrow","bent":false},
    {"from":"s3proc",  "to":"glue",    "type":"arrow","bent":false},
    {"from":"glue",    "to":"redshift","type":"arrow","bent":false},
    {"from":"s3raw",   "to":"athena",  "type":"arrow","bent":true}
  ],
  "borders":[
    {"id":"ingest",   "label":"Ingestion",  "x":0,   "y":110,"width":550,"height":480,"color":"#3b82f6"},
    {"id":"storage",  "label":"Storage",    "x":800, "y":110,"width":220,"height":480,"color":"#10b981"},
    {"id":"analytics","label":"Analytics",  "x":1070,"y":50, "width":300,"height":610,"color":"#8b5cf6"}
  ],
  "bubbles":[
    {"id":"b_kin", "text":"Kinesis ingests millions of events/sec from all sources",    "shape":"textbox","x":60,  "y":660,"w":240,"h":65,"fillColor":"#eff6ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"kinesis"},
    {"id":"b_lam", "text":"Lambda processes and enriches records in real time",         "shape":"textbox","x":340, "y":660,"w":240,"h":65,"fillColor":"#fff7ed","strokeColor":"#f59e0b","textColor":"#1e293b","connectTo":"lam"},
    {"id":"b_s3",  "text":"S3 stores raw and processed data as the source of truth",   "shape":"textbox","x":620, "y":660,"w":240,"h":65,"fillColor":"#f0fdf4","strokeColor":"#10b981","textColor":"#1e293b","connectTo":"s3raw"},
    {"id":"b_rs",  "text":"Redshift enables fast analytical queries across all data",  "shape":"textbox","x":900, "y":660,"w":240,"h":65,"fillColor":"#f5f3ff","strokeColor":"#8b5cf6","textColor":"#1e293b","connectTo":"redshift"}
  ]
}

====================================================
REFERENCE EXAMPLE 4 - VPC Nested Subnets and Security Groups
TRIGGERS: "vpc", "subnet", "public subnet", "private subnet", "security group", "nacl",
  "network acl", "ec2 in subnet", "multi-az vpc", "vpc with ec2"
PATTERN: VPC -> NACL -> Subnet rows -> Security Groups -> EC2 elements
CRITICAL: This is the ONLY correct way to nest VPC/NACL/Subnet/SG/Element.
  Every coordinate is mathematically derived bottom-up. Study and reproduce exactly.
====================================================

COORDINATE DERIVATION (bottom-up - always calculate this way):
  Element:        130w x 110h  (fixed)
  Security Group: 130+(16x2)=162w, 110+(16x2)+20=162h  [16px padding all sides, 20px for label]
  Subnet:         162+(24x2)=210w, 162+(24x2)+20=250h  [24px padding all sides, 20px for label]
  2x2 grid:       (210x2)+30=450w, (250x2)+30=530h     [30px sibling gaps]
  NACL:           450+(30x2)=510w, 530+(30x2)+20=610h  [30px padding, 20px for label]
  VPC:            510+(40x2)=590w, 610+(40x2)+20=710h  [40px padding, 20px for label]

  Placement: VPC at x=105,y=60 (centred on 800px canvas)
  All other positions derived by adding padding to parent position.

{
  "title": "VPC Multi-AZ Public and Private Subnets",
  "elements": [
    {"id":"igw",      "serviceId":"internetgateway","label":"Internet Gateway","x":335,"y":820,"width":130,"height":110},
    {"id":"ec2_puba", "serviceId":"ec2","label":"EC2 Public A",  "x":215,"y":310,"width":130,"height":110},
    {"id":"ec2_pubb", "serviceId":"ec2","label":"EC2 Public B",  "x":455,"y":310,"width":130,"height":110},
    {"id":"ec2_pria", "serviceId":"ec2","label":"EC2 Private A", "x":215,"y":590,"width":130,"height":110},
    {"id":"ec2_prib", "serviceId":"ec2","label":"EC2 Private B", "x":455,"y":590,"width":130,"height":110}
  ],
  "connections":[
    {"from":"igw","to":"ec2_puba","type":"arrow","bent":false},
    {"from":"igw","to":"ec2_pubb","type":"arrow","bent":false},
    {"from":"ec2_puba","to":"ec2_pria","type":"arrow","bent":false},
    {"from":"ec2_pubb","to":"ec2_prib","type":"arrow","bent":false}
  ],
  "borders":[
    {"id":"vpc",    "label":"VPC 10.0.0.0/16",       "x":105,"y":60, "width":590,"height":710,"color":"#3b82f6","strokeWidth":2,"strokeStyle":"solid"},
    {"id":"nacl",   "label":"NACL",                  "x":145,"y":120,"width":510,"height":610,"color":"#1e293b","strokeWidth":2,"strokeStyle":"dashed"},
    {"id":"pub_a",  "label":"Public Subnet A AZ-1",  "x":175,"y":180,"width":210,"height":250,"color":"#10b981","strokeWidth":2,"strokeStyle":"solid"},
    {"id":"pub_b",  "label":"Public Subnet B AZ-2",  "x":415,"y":180,"width":210,"height":250,"color":"#10b981","strokeWidth":2,"strokeStyle":"solid"},
    {"id":"priv_a", "label":"Private Subnet A AZ-1", "x":175,"y":460,"width":210,"height":250,"color":"#f59e0b","strokeWidth":2,"strokeStyle":"solid"},
    {"id":"priv_b", "label":"Private Subnet B AZ-2", "x":415,"y":460,"width":210,"height":250,"color":"#f59e0b","strokeWidth":2,"strokeStyle":"solid"},
    {"id":"sg_puba","label":"SG Public A",           "x":199,"y":220,"width":162,"height":162,"color":"#ef4444","strokeWidth":1,"strokeStyle":"dashed"},
    {"id":"sg_pubb","label":"SG Public B",           "x":439,"y":220,"width":162,"height":162,"color":"#ef4444","strokeWidth":1,"strokeStyle":"dashed"},
    {"id":"sg_pria","label":"SG Private A",          "x":199,"y":500,"width":162,"height":162,"color":"#ef4444","strokeWidth":1,"strokeStyle":"dashed"},
    {"id":"sg_prib","label":"SG Private B",          "x":439,"y":500,"width":162,"height":162,"color":"#ef4444","strokeWidth":1,"strokeStyle":"dashed"}
  ],
  "bubbles":[
    {"id":"b_vpc", "text":"VPC isolates all resources in a private network with full routing control",          "shape":"textbox","x":760,"y":80, "w":240,"h":65,"fillColor":"#eff6ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"vpc"},
    {"id":"b_nacl","text":"NACL is stateless subnet-level firewall - first line of defence",                   "shape":"textbox","x":760,"y":165,"w":240,"h":65,"fillColor":"#f1f5f9","strokeColor":"#1e293b","textColor":"#1e293b","connectTo":"nacl"},
    {"id":"b_pub", "text":"Public subnets route to Internet Gateway for inbound and outbound internet",         "shape":"textbox","x":760,"y":250,"w":240,"h":65,"fillColor":"#f0fdf4","strokeColor":"#10b981","textColor":"#1e293b","connectTo":"pub_a"},
    {"id":"b_priv","text":"Private subnets have no IGW route - outbound only via NAT Gateway",                "shape":"textbox","x":760,"y":335,"w":240,"h":65,"fillColor":"#fff7ed","strokeColor":"#f59e0b","textColor":"#1e293b","connectTo":"priv_a"},
    {"id":"b_sg",  "text":"Security Groups are stateful instance-level firewalls - allow rules only",          "shape":"textbox","x":760,"y":420,"w":240,"h":65,"fillColor":"#fef2f2","strokeColor":"#ef4444","textColor":"#1e293b","connectTo":"sg_puba"},
    {"id":"b_igw", "text":"Internet Gateway is horizontally scaled and HA by default - no bottleneck",         "shape":"textbox","x":760,"y":505,"w":240,"h":65,"fillColor":"#eff6ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"igw"}
  ]
}

NESTING PROOF - verify these relationships hold in the example above:
  VPC contains NACL:    vpc.x(105)+40=145=nacl.x, vpc.y(60)+40+20=120=nacl.y [VPC 40px pad + 20px label]
  NACL contains subnets: nacl.x(145)+30=175=pub_a.x, nacl.y(120)+30+20=170... [NACL 30px pad + 20px label -> y=180 - rounding applied]
  Subnet gap:           pub_b.x(415) - (pub_a.x(175)+pub_a.width(210)) = 415-385 = 30px [exact 30px gap]
  Row gap:              priv_a.y(460) - (pub_a.y(180)+pub_a.height(250)) = 460-430 = 30px [exact 30px gap]
  SG inside pub_a:      sg_puba.x(199) = pub_a.x(175)+24 [24px subnet padding]
  EC2 in SG:            ec2_puba.x(215) = sg_puba.x(199)+16 [16px SG padding]
  EC2 centred in SG:    (sg_puba.width(162)-ec2.width(130))/2=16 -> ec2_puba.x=199+16=215 [exact centre]

`:'';


    const serviceMapping=activeProvider==='aws'?`
====================================================
SERVICE SELECTION - reason about context, don't just pattern-match keywords
====================================================

COMPUTE - infer from workload characteristics, not just keywords:
  • Event-driven / short-lived / spiky traffic / "serverless" / "functions"
      -> lambda. Good for: APIs, triggers, async processing, webhooks.
  • Long-running processes / stateful / "always on" / "servers" / "VMs"
      -> ec2 (consider Auto Scaling Group for production workloads).
  • Container workloads / "Docker" / "microservices" / teams that prefer containers
      -> ecs (Fargate mode for serverless containers). Use eks ONLY when
         "Kubernetes" or "k8s" is explicitly mentioned.
  • Scheduled / batch / data processing jobs
      -> lambda (short jobs <15min) or batch (long-running jobs, HPC).
  • Mixed: real-time API + background processing
      -> lambda for the API layer, sqs triggering lambda for the background work.

DATABASE - the data model and access pattern matter far more than compute choice:
  • Relational data / SQL / joins / transactions / "Postgres" / "MySQL" / "financial"
    / "orders" / "inventory" / "ACID" / "normalised schema"
      -> aurora (preferred over rds for most new workloads - better performance,
         serverless scaling option, easier failover).
      -> rds if the user explicitly names a specific engine (e.g. "Postgres RDS").
  • Flexible schema / "NoSQL" / "document store" / "key-value" / high-scale reads
    / "sessions" / "user profiles" / "shopping cart" / "leaderboard"
      -> dynamodb.
  • MULTI-REGION ACTIVE-ACTIVE / "global tables" / "active-active DR"
      -> dynamodb with Global Tables. NOT aurora. Aurora Global DB is active-passive
         (one writable primary). DynamoDB Global Tables is genuinely active-active
         (every region writes simultaneously). See contextual rule 8 for full details.
  • Database type NOT specified AND compute is lambda
      -> default to dynamodb. Reason: Lambda is stateless and short-lived; RDS
         requires persistent connections that Lambda cannot maintain at scale.
         If the user later says the data is relational, switch to aurora + rdsProxy.
  • Database type NOT specified AND compute is ec2 or ecs
      -> default to aurora. Reason: traditional servers handle persistent
         connections fine, and Aurora is superior to RDS for new workloads.
  • Lambda + relational data explicitly required
      -> aurora (Serverless v2 preferred) + rdsProxy between Lambda and Aurora.
         rdsProxy solves the connection pooling problem - this IS a valid pattern.
  • Caching layer needed / "Redis" / "Memcached" / "session store" / "fast reads"
      -> elasticache. ADD this alongside the primary database, not instead of it.
  • Full-text search / "Elasticsearch" / "search functionality"
      -> opensearch.
  • Analytical queries / "data warehouse" / "BI" / "reporting" / "OLAP"
      -> redshift (with s3 as the data lake feeding it).
  • Time-series / "IoT metrics" / "sensor data" / "monitoring data"
      -> timestream.

NETWORKING - build the entry path based on what the architecture actually serves:
  • Public-facing web or API: always start with users -> route53 -> cloudfront -> ...
      Route53 provides DNS. CloudFront provides edge caching AND DDoS protection
      at the CDN layer. WAF adds application-layer filtering (add for "production",
      "security-conscious", or "financial" architectures).
  • Traditional compute (ec2/ecs): cloudfront -> elb -> ec2/ecs
      ALB (elb) is the right ingress for compute clusters. Do NOT use API Gateway
      as a load balancer for EC2 - that's not its purpose.
  • Serverless API: cloudfront or direct -> apigateway -> lambda
      API Gateway IS the load balancer for Lambda. Do NOT add elb between
      API Gateway and Lambda - redundant and wrong.
  • Static frontend / "React app" / "Vue" / "SPA" / "static site"
      -> s3 (hosting) + cloudfront (CDN + HTTPS). Always both together.
         Never s3 alone for a production frontend.
  • Internal-only service / "private API" / "no public internet"
      -> skip route53 and cloudfront. Start with a VPC border and internal elb.

MESSAGING - choose based on the communication pattern, not just keywords:
  • One producer -> one consumer, ordered processing, retry logic
      -> sqs. Good for: job queues, background tasks, decoupling services.
  • One event -> many consumers, broadcast, fan-out
      -> sns. Good for: notifications, triggering multiple downstream actions.
  • High-throughput streaming / "Kafka-like" / "event log" / real-time analytics
      -> kinesis. Good for: clickstreams, IoT data, log aggregation.
  • Event routing / "if X happens do Y" / scheduled rules / cross-service orchestration
      -> eventbridge. Good for: SaaS integrations, scheduled triggers, complex routing.
  • Transactional email / marketing email / "send email"
      -> ses.
  • Tip: sqs + lambda is the most common async pattern - SQS triggers Lambda
    automatically. sns + sqs is the fan-out pattern (SNS fans to multiple SQS queues).

SECURITY & IDENTITY - add these when the context implies them, not just when named:
  • Any user-facing application with login / "users" / "accounts" / "auth"
      -> cognito. Provides user pools (auth) and identity pools (AWS access).
  • Any application accessing AWS services from compute
      -> iam (IAM roles, not users). Always present implicitly; add as element
         only when IAM is architecturally significant (e.g. cross-account access).
  • Credentials / API keys / database passwords anywhere in the architecture
      -> secretsmanager. Add whenever Lambda or EC2 needs to connect to a database.
  • HTTPS / custom domain / "TLS"
      -> acm. Add alongside cloudfront or elb when custom domains are implied.
  • Sensitive data / "encryption at rest" / "KMS" / "HIPAA" / "financial"
      -> kms. Add when data sensitivity is implied by the use case.

MONITORING - only add when explicitly requested:
  • NEVER add cloudwatch, xray, or any monitoring service unless the user specifically asked for it.
  • "tracing" / "distributed tracing" / "X-Ray" explicitly mentioned -> xray alongside lambda or ecs.
  • "monitoring" / "cloudwatch" / "alarms" explicitly mentioned -> cloudwatch.

IMPORTANT CONTEXTUAL JUDGEMENTS - only apply when the user explicitly asks:
  1. Lambda + no DB type specified -> dynamodb by default (connection pooling issue with RDS).
     If user says relational data needed -> aurora + rdsProxy is valid.
  2. "Production" / "high availability" / "multi-AZ" explicitly mentioned -> show multi-AZ.
     Do NOT add WAF, ElastiCache, or extra services just because "production" is mentioned.
  3. "Microservices" explicitly mentioned -> one box per named service.
  4. "Frontend" + "backend" explicitly mentioned -> s3+cloudfront for frontend.
  5. "CI/CD" explicitly mentioned -> codecommit + codebuild + codepipeline + codedeploy.
  6. "active-active" explicitly mentioned -> dynamodb Global Tables (NOT aurora).
  7. When the description is ambiguous, pick the more modern/managed service but do NOT
     add services the user did not ask for. Ask yourself: "did the user mention this?" 
     If no -> do not include it.
  8. Multi-region active-active vs active-passive - this distinction is critical:

     ACTIVE-ACTIVE ("active-active" / "multi-site" / "zero RPO" / "zero RTO" /
     "all regions writable" / "no failover" / "disaster recovery" without specifying
     failover) -> MUST use dynamodb with Global Tables.
     REASON: DynamoDB Global Tables allows simultaneous writes in EVERY region at the
     same time with automatic conflict resolution (last-writer-wins). No region is
     primary. If us-east-1 disappears entirely, us-west-2 was already accepting writes
     the whole time - no promotion, no failover, no data loss. True active-active.

     NEVER use aurora for active-active multi-region. Aurora Global Database has exactly
     ONE writable primary region. All other regions are READ-ONLY replicas. Promoting a
     secondary to writable requires a deliberate failover action. This is active-PASSIVE,
     regardless of how many regions exist. Aurora Global DB is appropriate only for:
     "active-passive" / "warm standby" / "pilot light" / "DR with failover accepted".

     SUMMARY: active-active -> dynamodb Global Tables. active-passive -> aurora Global DB.`:``;

    // -- Layout rules ---------------------------------------------------------
    const layoutRules=`
====================================================
LAYOUT SYSTEM - hierarchical grid consistency
====================================================

PRIME DIRECTIVE: Every container at every nesting depth must follow the same
spatial discipline. The whitespace itself communicates the structure. A diagram
where you can draw invisible grid lines through every element is correct.
Clarity over completeness - fewer well-spaced elements always beats many crowded ones.

====================================================
RULE 1 - ELEMENT SIZES (fixed, never vary)
====================================================
  * Service elements: width:130, height:110 - ALWAYS, no exceptions
  * Bubble annotations: w:240, h:auto (system calculates height from text), shape:"textbox"
  * All siblings at the same nesting level must be the SAME size
  * When siblings differ in content, grow ALL siblings to match the largest -
    never shrink to the smallest

====================================================
RULE 2 - NESTING PADDING SYSTEM (hierarchical, decreasing)
====================================================
The AWS networking hierarchy is:
  VPC -> NACL -> Subnet (Public/Private) -> Security Group -> Service Element

Fixed inward padding per nesting depth (space from container edge to children):
  VPC:            40px on all four sides
  NACL:           30px on all four sides
  Subnet:         24px on all four sides (plus 20px top for the label)
  Security Group: 16px on all four sides
  
This padding is the MINIMUM. Never less. The container must be sized
to accommodate its children PLUS this padding on every side.

Label height: add 20px to the top padding wherever a border has a label
(the label text sits inside the top padding space).

====================================================
RULE 3 - CONTENT-DERIVED CONTAINER SIZING (bottom-up)
====================================================
Calculate container sizes BOTTOM-UP from element sizes. Never top-down.

Example for a 2x2 grid of subnets inside a VPC:
  1. Service element: 130x110
  2. Security Group:  130+(16x2)=162 wide, 110+(16x2)+20=162 tall
  3. Subnet:          162+(24x2)=210 wide, 162+(24x2)+20=230 tall
  4. Grid of 2x2 subnets with 30px gap between them:
     Grid width:  (210x2)+(30x1)=450
     Grid height: (230x2)+(30x1)=490
  5. NACL:            450+(30x2)=510 wide, 490+(30x2)+20=590 tall
  6. VPC:             510+(40x2)=590 wide, 590+(40x2)+20=690 tall

The border x,y position is calculated so its children are centred within it.
Child centre x = border.x + border.width/2
Content starts at border.x + padding_left

====================================================
RULE 4 - SIBLING SYMMETRY (uniform gaps, uniform sizes)
====================================================
All siblings at the same nesting level must obey:
  * Identical size (width AND height equal across all siblings)
  * Identical gap between every pair of siblings - horizontally AND vertically
  * The gap between sibling borders is 30px (never more, never less)
  * Siblings form a true grid: top edges align in the same row,
    left edges align in the same column
  * The entire sibling group is centred within their parent container

Grid positions for N siblings (gap=30, each sibling same size WxH):
  1 item:  centred in parent
  2 items: side by side, gap=30 between them, group centred
  2 rows:  top row and bottom row each centred, rows 30px apart
  4 items: 2x2 grid, 30px horizontal gap, 30px vertical gap

====================================================
RULE 5 - MATHEMATICAL CENTERING
====================================================
Every element must be mathematically centred within its parent container.
"Near the edge" or "roughly centred" is not acceptable.

For a single element in a container:
  element.x = container.x + (container.width - element.width) / 2
  element.y = container.y + (container.height - element.height) / 2

For a group of elements in a container:
  group_total_width = (n_cols x element.width) + ((n_cols-1) x gap)
  group_total_height = (n_rows x element.height) + ((n_rows-1) x gap)
  group_start_x = container.x + (container.width - group_total_width) / 2
  group_start_y = container.y + (container.height - group_total_height) / 2 + label_offset

====================================================
RULE 6 - ABSOLUTE MINIMUM GAPS (hard floors, never violated)
====================================================
These gaps are absolute minimums - the preferred value is 30px but never below these:
  * Between ANY two sibling borders: 20px minimum (prefer 30px)
  * Between a border and its parent's inner edge: 20px minimum (prefer padding values in Rule 2)
  * Between ANY two service elements: 130px minimum (prefer 260px between centres)
  * Between a border and any element NOT inside it: 30px minimum
  * NO overlaps of any kind - borders, elements, labels, or bubbles

====================================================
RULE 7 - GRID ALIGNMENT (invisible grid lines must work)
====================================================
Elements at the same level must share coordinate axes:
  * Same row -> identical y (top edge) coordinate
  * Same column -> identical x (left edge) coordinate
  * If you drew horizontal lines through top edges and vertical lines through
    left edges, they would form a perfect grid

Vertical layout layers (y = top of element, not centre):
  Layer 1  y:60    users/internet
  Layer 2  y:240   DNS/security
  Layer 3  y:420   CDN/edge
  Layer 4  y:600   load balancing
  Layer 5  y:800   compute (280px apart horizontally)
  Layer 6  y:1020  primary data
  Layer 7  y:1220  secondary storage

Horizontal x positions for compute layer (element centres):
  2 items: x=400, x=880 (centres 480px apart)
  3 items: x=300, x=620, x=940 (centres 320px apart)
  4 items: x=220, x=500, x=780, x=1060 (centres 280px apart)

====================================================
RULE 8 - SECURITY/NETWORK CONTAINER HIERARCHY
====================================================
Security and network containers have strict nesting rules:
  VPC (outermost, blue #3b82f6, solid)
    NACL (dashed border, black #1e293b, dotted strokeStyle - wraps all subnets)
      Public Subnet (green #10b981, solid - internet-facing)
        Security Group (red #ef4444, dashed strokeStyle - wraps compute)
          EC2 / ECS / etc.
      Private Subnet (amber #f59e0b, solid - no direct internet)
        Security Group (red #ef4444, dashed strokeStyle)
          RDS / Aurora / etc.

NACL border:
  * Sits inside the VPC with 40px clearance from VPC edges
  * Uses dotted/dashed strokeStyle to distinguish from solid subnets
  * Wraps ALL subnets with 30px padding around the entire subnet grid

Security Groups:
  * Always dashed strokeStyle
  * Sit inside their subnet with 24px clearance from subnet edges
  * Wrap their service element with 16px padding on all sides
  * Never touch the subnet border edges

Subnets:
  * Sit inside the NACL with 30px clearance from NACL edges
  * Sibling subnets (Public 1 + Public 2, Private 1 + Private 2) are same size
  * 30px gap between all sibling subnets
  * Public subnets: row 1. Private subnets: row 2. 30px vertical gap between rows.

====================================================
RULE 9 - CONSISTENT LABEL PLACEMENT
====================================================
  * ALL border labels: top-left corner, 8px inset from left edge, 8px inset from top edge
  * Label text sits within the border's top padding space
  * Label font size and weight consistent across all borders at same nesting level
  * NEVER place labels at bottom, right, or centre - always top-left

====================================================
RULE 10 - CLEAN CONNECTION ROUTING
====================================================
  * NO midLabels by default - connections are clean arrows
  * Only add midLabel when the protocol is architecturally critical (max 3 total)
  * For nested diagrams: connections exit from element edge, NOT from border edge
  * bent:false for cross-layer vertical connections (top to bottom)
  * bent:true for same-layer horizontal connections and monitoring lines
  * Connections must NOT pass diagonally through unrelated containers
    - if a line would cross through an unrelated border, use bent:true to route around it
  * Max 3 outbound connections from any single non-hub element

====================================================
RULE 11 - ALB/NLB MINIMUM TARGETS
====================================================
  * Every ALB or NLB MUST connect to at least 2 compute targets in different AZs
  * Never a single EC2 or ECS task behind a load balancer
  * Exception: Lambda (scales automatically, single element is fine)

====================================================
RULE 12 - BUBBLE ANNOTATIONS
====================================================
  * Bubbles NEVER overlap any service element, border, or other bubble
  * Vertical diagrams: clean column at x>=1300, y starting at 160, 110px between each
  * Horizontal diagrams: clean row at y>=700, evenly spaced horizontally
  * Colour by layer: DNS/internet #f0f9ff/#3b82f6, compute #fff7ed/#f59e0b,
    data #f5f3ff/#8b5cf6, security #fef2f2/#ef4444, monitoring #f0fdf4/#10b981

====================================================
RULE 13 - MODIFICATION CASCADING (when AI modifies a diagram)
====================================================
When adding an element to an existing container:
  1. Detect the existing grid (reverse-engineer padding from current positions)
  2. Place the new element respecting the established grid spacing
  3. If the new element does not fit without violating spacing rules:
     EXPAND the parent container to accommodate it - do NOT squeeze the element
  4. When a parent expands, cascade upward: expand grandparent to maintain ITS padding
  5. Shift other elements down/right to restore symmetry after expansion
  6. NEVER place a new element by just finding empty canvas space -
     it must fit within the established spatial system

HORIZONTAL LAYOUT specifics:
  Stages: x=60, 340, 620, 900, 1160 (280px between stage centres)
  Items per stage: spread 220px apart vertically, group centred at y=290

CANVAS BOUNDS: Keep all elements within x:60-1450, y:60-1350
`;


    return `You are an expert ${providerName} cloud architect creating clean, professional architecture diagrams.

MOST IMPORTANT RULE: Generate ONLY what the user explicitly asks for.
Do not add services, borders, connections, or components that the user did not mention.
If the user asks for "a VPC with 2 public subnets and 2 private subnets" - generate exactly that.
No NAT gateways unless asked. No NACLs unless asked. No security groups unless asked.
No CloudWatch unless asked. No WAF unless asked. No IAM unless asked.
Read the prompt literally. The user controls scope entirely.

${detailLevel}

Provider: ${providerName}
Available service IDs - use ONLY these exact strings for serviceId: ${svcIds}

${layoutRules}
${serviceMapping}

STUDY THESE REFERENCE EXAMPLES CAREFULLY - match their spacing, bubble placement, and clean layout:
${fewShotExamples||'(No examples for this provider - apply the layout and service rules above carefully.)'}

ANNOTATION BUBBLES - always include unless user says not to:
  • Every significant service gets a bubble explaining WHY it exists here
  • Bubbles go in a clean column to the RIGHT of all elements (x>=1280) for vertical diagrams
  • Bubbles go in a clean row BELOW all elements (y>=700) for horizontal diagrams
  • Bubbles NEVER overlap service elements - position them in clear empty space
  • w:240 for all bubbles. Height is auto-calculated from text - write as much as needed to explain clearly.

OUTPUT - raw JSON only, no markdown, no explanation:
{
  "title": "Short descriptive title (max 6 words)",
  "elements": [{"id":"uid","serviceId":"exact_id","label":"Name","x":640,"y":800,"width":130,"height":110}],
  "connections": [{"from":"a","to":"b","type":"arrow","bent":false}],
  "borders": [{"id":"vpc","label":"VPC","x":290,"y":540,"width":890,"height":570,"color":"#3b82f6"}],
  "bubbles": [{"id":"b1","text":"Short explanation","shape":"textbox","x":1300,"y":160,"w":240,"h":65,"fillColor":"#f0f9ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"element_id"}]
}

FINAL CHECKS before outputting:
[ ] Every serviceId exists in the available IDs list
[ ] Minimum 260px between ALL element centres - no element within 130px of another
[ ] All bubbles at x>=1280 (vertical) or y>=700 (horizontal) - never overlapping elements
[ ] Borders have 70px padding around their contents
[ ] Width:130 height:110 on every element. Bubble w:240 (height auto-sized to fit text).
[ ] No midLabels unless absolutely essential (max 3 total)
[ ] Valid JSON only`;
  };

  // -- AWS Architectural Rules ---------------------------------------------------
  // Compiled from AWS CDK source, Well-Architected Framework, AWS Prescriptive Guidance
  // Rules are injected into prompts dynamically based on detected keywords
  const AWS_ARCH_RULES={
    DR_001:{trigger:['active-active','multi-site','zero rpo','zero rto','all regions writable','no failover','simultaneously writ','both regions writ','multi-region writes'],rule:`ACTIVE-ACTIVE MULTI-REGION: Use DynamoDB Global Tables - every replica accepts reads AND writes simultaneously. Conflict resolution is automatic (last-writer-wins). Zero failover, zero RTO, zero RPO.\nNEVER use Aurora Global Database for active-active. Aurora Global DB has ONE writable primary. All other regions are READ-ONLY replicas. Promoting a secondary IS a failover action - active-PASSIVE.\nSUMMARY: active-active -> dynamodb Global Tables. active-passive -> aurora Global DB.`},
    DR_002:{trigger:['active-passive','warm standby','pilot light','failover','rpo.*minutes','rto.*minutes'],rule:`ACTIVE-PASSIVE DR: Aurora Global Database is appropriate - one writable primary, secondaries promote in ~1 minute. Pair with Route53 health checks and failover routing policy for automatic DNS cutover.`},
    DR_003:{trigger:['route53','latency routing','geolocation','failover routing','health check'],rule:`ROUTE53 ROUTING: Latency-based for active-active. Failover for active-passive DR. Geolocation for data residency. Always add health checks for DR scenarios - triggers DNS failover within 60 seconds.`},
    DB_001:{trigger:['lambda','serverless','function','faas'],rule:`LAMBDA + DATABASE: Lambda is stateless; RDS/Aurora expects persistent connections. At scale Lambda exhausts RDS connection limits (db.t3.medium = ~170 connections). DEFAULT: use DynamoDB (HTTP, no connections). IF RELATIONAL: use Aurora Serverless v2 + RDS Proxy. RDS Proxy pools connections - valid production pattern. NEVER: provisioned RDS directly with Lambda without RDS Proxy.`},
    DB_002:{trigger:['relational','sql','mysql','postgres','postgresql','joins','transactions','acid','foreign key','financial','orders','inventory'],rule:`RELATIONAL DATA: Aurora over plain RDS - 5x faster MySQL, 3x faster PostgreSQL, auto-storage scaling, 15 read replicas, <30s failover. Aurora Serverless v2 for variable workloads. Use plain RDS only when migrating existing instances.`},
    DB_003:{trigger:['nosql','document store','key-value','flexible schema','sessions','cart','leaderboard','gaming','user profile','high throughput'],rule:`NOSQL/HIGH-THROUGHPUT: DynamoDB. HTTP-based (no connection limits), single-digit ms latency, on-demand scaling, built-in TTL, Streams for event processing, Global Tables for multi-region. Design around access patterns, not entity relationships.`},
    DB_004:{trigger:['cache','redis','memcached','session store','in-memory','fast reads','rate limiting','session state','session cache'],rule:`CACHING - choose based on WHAT is being cached, not just what database is present:

ElastiCache IS correct and appropriate when caching:
  • Session state / user sessions (exists independently of DynamoDB data)
  • Rate limiting counters (Redis atomic INCR/DECR)
  • Computed or aggregated results expensive to recompute
  • Data from multiple sources (DynamoDB + RDS + external APIs combined)
  • Pub/sub messaging between services
  In multi-region: one ElastiCache cluster PER REGION - never label "ElastiCache Global"
  ElastiCache clusters are single-region. No global version exists.

DAX is correct when:
  • The ONLY data being cached is DynamoDB item reads / query results
  • You want a drop-in replacement (same DynamoDB API, change endpoint only)
  • Write-through caching of DynamoDB items specifically
  DAX is NOT a session store and NOT a general cache.
  Do NOT use DAX for: strongly consistent reads, write-heavy workloads,
  or labelling as "Global" - no global DAX exists, one cluster per region.

ElastiCache + DynamoDB in the same diagram = VALID and CORRECT when:
  ElastiCache handles session state / computed results (non-DynamoDB data)
  DynamoDB handles the primary application data
  This is a common and correct production pattern.

DAX + DynamoDB = VALID when you specifically want to cache DynamoDB reads.`},
    DB_012:{trigger:['dax','dynamodb accelerator','dynamodb cache','cache dynamodb','accelerate dynamodb','microsecond dynamodb'],rule:`DAX (DYNAMODB ACCELERATOR) - caches DynamoDB reads specifically:
Drop-in replacement: same DynamoDB SDK API, change endpoint URL only.
Write-through: writes to DAX -> DAX writes to DynamoDB -> cache consistent.
Read-through: cache miss -> fetches from DynamoDB -> caches -> returns.
Eventually consistent reads only (not for strongly consistent requirements).
One DAX cluster per region - no global DAX. Multi-AZ for production HA.
NOT a general cache: DAX only caches DynamoDB data.
  For session state or non-DynamoDB data: use ElastiCache alongside DAX.
DAX cache hits consume zero DynamoDB RCUs - cost saving on read-heavy tables.`},
    DB_005:{trigger:['data warehouse','olap','business intelligence','bi','reporting','analytical queries','petabyte','historical data'],rule:`DATA WAREHOUSE: Redshift. RDS/Aurora is OLTP (fast small reads/writes). Redshift is OLAP (complex queries over billions of rows). Serverless for intermittent. Provisioned for continuous heavy use. Load via COPY from S3 (fastest). For ad-hoc SQL on S3: Athena (pay per query scanned).`},
    DB_006:{trigger:['search','elasticsearch','full text search','opensearch','log analytics','fuzzy search','faceted search'],rule:`SEARCH: OpenSearch Service. Not RDS (no text indexing, table scans) or DynamoDB (no text matching). Feed from DynamoDB Streams -> Lambda -> OpenSearch. Production: minimum 2 data nodes across 2 AZs.`},
    DB_007:{trigger:['time series','iot metrics','sensor data','monitoring metrics','telemetry'],rule:`TIME-SERIES: Timestream. Purpose-built - auto tiers recent data in memory, historical on magnetic. 1,000x faster and 1/10th cost of RDS for time-series. Built-in interpolation, smoothing, approximation functions.`},
    COMPUTE_001:{trigger:['lambda','serverless','function','event-driven','faas'],rule:`LAMBDA LIMITS: Max timeout 15 min (use Step Functions for longer). Max memory 10,240MB. Concurrent executions 1,000/region default. Cold starts: mitigate with Provisioned Concurrency. SnapStart reduces cold starts 90% for Java/Python/.NET. Lambda in VPC adds ~10s cold start penalty - only use VPC when accessing VPC resources.`},
    COMPUTE_002:{trigger:['containers','docker','ecs','fargate','container','microservices'],rule:`ECS LAUNCH TYPE: Fargate (default for new workloads) - AWS manages EC2 instances, no patching. EC2 launch type - you manage instances, lower cost at scale, supports GPU/Windows. Use EKS ONLY when user explicitly mentions Kubernetes, k8s, Helm, or existing k8s workloads.`},
    COMPUTE_003:{trigger:['ec2','virtual machine','vm','servers','instances','auto scaling','lift and shift'],rule:`EC2 PRODUCTION: Always Auto Scaling Group (not standalone EC2). Minimum 2 instances across 2 AZs. Use Launch Templates (Launch Configurations deprecated). EC2 in private subnets, ALB in public subnet. Target tracking scaling for simplicity. Use IMDSv2 for security.`},
    NET_001:{trigger:['api gateway','lambda','serverless api','rest api','http api'],rule:`API GATEWAY + LAMBDA: HTTP API (70% cheaper, JWT auth, simple proxy) vs REST API (throttling, caching, API keys, WAF, request transformation). NEVER add both API Gateway AND ALB in front of same Lambda - redundant. ALB->Lambda valid only when routing to both Lambda AND EC2/ECS from same ALB.`},
    NET_002:{trigger:['alb','application load balancer','load balance','distribute traffic','nlb'],rule:`LOAD BALANCER: ALB for HTTP/HTTPS Layer 7 (path/host routing, WebSockets, WAF). NLB for TCP/UDP Layer 4 (ultra-low latency, static IP per AZ, preserves client IP, PrivateLink). Classic Load Balancer: deprecated - do not use for new architectures.`},
    NET_013:{trigger:['alb','application load balancer','load balancer','load balance','elb','distribute traffic','nlb','network load balancer'],rule:`ALB/NLB MINIMUM TARGET REQUIREMENT:
Every load balancer in the diagram MUST have at least 2 compute targets attached to it.
A single EC2 instance or single ECS task behind an ALB defeats the purpose of a load balancer.
With one target: no load balancing occurs, no high availability, single point of failure.

ALWAYS show a minimum of 2 targets per ALB/NLB:
  • EC2: minimum 2 instances (e.g. "EC2 AZ-1a" and "EC2 AZ-1b")
  • ECS Fargate: minimum 2 tasks (e.g. "ECS Fargate AZ-1" and "ECS Fargate AZ-2")
  • EKS: minimum 2 pods or node groups
  • Lambda: ALB -> Lambda is valid (Lambda scales automatically, no minimum target count)

Place targets in DIFFERENT Availability Zones. This is the entire point of using an ALB:
  - Traffic distributed across targets (load balancing)
  - If one AZ fails, the other continues serving traffic (high availability)
  - ALB health checks remove unhealthy targets automatically

In multi-region diagrams: each region has its OWN ALB with its OWN 2+ targets.
  Do NOT show one ALB spanning multiple regions - ALBs are regional.

NAMING convention for targets: append AZ to label to make it clear.
  "ECS Fargate us-east-1a" and "ECS Fargate us-east-1b"
  "EC2 Web Server AZ-1" and "EC2 Web Server AZ-2"`},
    NET_003:{trigger:['cloudfront','cdn','edge','global distribution','s3 static','static site','spa','react','angular','vue'],rule:`CLOUDFRONT + S3: Always together for production. Never expose S3 directly - no HTTPS, no custom domain HTTPS. OAC (Origin Access Control): CloudFront signs requests, S3 bucket stays private. Cache: long TTL for JS/CSS/images, short TTL for HTML. Free DDoS protection via Shield Standard.`},
    NET_004:{trigger:['vpc','subnet','public subnet','private subnet','nat gateway','internet gateway'],rule:`VPC SUBNETS: Public subnet (has IGW route) = ALB, NAT Gateway, bastion. Private subnet (no direct internet) = EC2, ECS, Lambda, RDS, ElastiCache. One NAT Gateway per AZ for HA (cross-AZ NAT costs money). Use VPC Endpoints for S3/DynamoDB/AWS services to avoid NAT charges. Minimum 2 AZs for production.`},
    NET_005:{trigger:['waf','firewall','ddos','sql injection','xss','rate limiting','bot protection'],rule:`WAF PLACEMENT: Attach to CloudFront (global, edge-level) or ALB (regional). Not directly to EC2. Use AWSManagedRulesCommonRuleSet (OWASP Top 10) as baseline. Rate-based rules block IPs exceeding thresholds. Shield Advanced for critical DDoS protection (~$3k/month).`},
    NET_006:{trigger:['route53','dns','domain','routing policy'],rule:`ROUTE53: Use Alias records (not CNAME) for ALB, CloudFront, S3, API Gateway - free queries, support apex domain. Routing: Simple (single resource), Failover (active-passive DR), Weighted (A/B testing), Latency (active-active multi-region), Geolocation (data residency).`},
    MSG_001:{trigger:['queue','background job','async task','worker','decouple','sqs','message queue','job queue'],rule:`SQS: Point-to-point async. Standard (unlimited throughput, at-least-once, best-effort order) vs FIFO (300 TPS, exactly-once, strict order). Always configure DLQ for production. Visibility timeout = 6x Lambda timeout. Lambda SQS trigger: auto-scales concurrency with queue depth.`},
    MSG_002:{trigger:['sns','notification','pub/sub','fan-out','broadcast','one to many'],rule:`SNS: One-to-many pub/sub. Fan-out pattern: publish once to SNS -> multiple SQS queues (each subscriber independent). Message filtering by attributes - only relevant messages delivered per subscription. SNS + SQS most common pattern: SNS broadcasts, SQS buffers per consumer.`},
    MSG_003:{trigger:['kinesis','streaming','real-time','clickstream','kafka','event stream','high throughput events'],rule:`KINESIS: Real-time streaming with replay (up to 7 days). Data Streams: manual shard management, 1MB record limit. Firehose: managed delivery to S3/Redshift/OpenSearch, no shard management. SQS for task queues (no replay, 256KB limit). MSK only when migrating from Kafka or needing Kafka ecosystem tools.`},
    MSG_004:{trigger:['eventbridge','event bus','event-driven','scheduled','cron','saas integration'],rule:`EVENTBRIDGE: Event routing/scheduling/SaaS integration. Scheduler replaces CloudWatch Events (200+ targets directly, no Lambda needed). Event Bus: content-based routing, cross-account/region, archives for replay. Pipes: point-to-point with filtering and enrichment. Preferred over SNS for cross-account, SaaS, scheduling, content-based routing.`},
    SEC_001:{trigger:['auth','authentication','login','sign in','sign up','users','cognito','jwt','oauth','sso'],rule:`COGNITO: Never build custom auth. User Pools = user directory (sign-up/in, social login, MFA, SAML). Identity Pools = temporary AWS credentials for direct AWS access from client. API Gateway + Cognito = automatic JWT validation without Lambda authorizer. Advanced Security adds anomaly detection, compromised credential checking.`},
    SEC_002:{trigger:['secrets','api key','password','credentials','connection string','environment variable','private key'],rule:`SECRETS: Never hardcode. Never plain-text env vars. Secrets Manager ($0.40/secret/month): auto-rotation for RDS/Redshift, cross-account, use for passwords needing rotation. SSM Parameter Store (free tier): configuration values, non-rotating secrets. Lambda Secrets Manager extension caches secrets (faster, cheaper). Aurora integrates natively - auto-rotates master password.`},
    SEC_003:{trigger:['iam','role','permission','policy','least privilege','cross-account'],rule:`IAM: Roles over Users - services use roles (never access keys on AWS services). Least privilege: start restrictive, add as needed. Resource-based policies for cross-account (S3, KMS, SQS). IAM Access Analyzer detects overly permissive policies. Avoid wildcard (*) in Resource field. Use Conditions to restrict by IP, VPC, MFA, tags.`},
    SEC_004:{trigger:['kms','encryption','encrypt at rest','compliance','hipaa','pci','cmk'],rule:`KMS: AWS Managed Keys (free, limited control) vs Customer Managed Keys ($1/key/month - full control, mandatory for HIPAA/PCI). Envelope encryption: KMS encrypts a data key, data key encrypts data (reduces KMS API costs). CloudTrail logs all KMS calls for compliance audit.`},
    OBS_001:{trigger:['monitoring','cloudwatch','metrics','alarms','logs','dashboard','alerting','observability'],rule:`CLOUDWATCH: Set retention on ALL log groups (default = never expire = costly). Composite alarms reduce alert noise. Container Insights for ECS/EKS. Lambda Insights via Layer. Key metrics: Lambda errors/throttles/duration, ALB 4xx/5xx, RDS connections/CPU, SQS queue depth. Metric Filters extract custom metrics from logs.`},
    OBS_002:{trigger:['xray','tracing','distributed tracing','latency analysis','service map','performance bottleneck'],rule:`X-RAY: Traces requests across Lambda -> API Gateway -> downstream services. Service Map shows latency/errors per service. Native with Lambda (Active Tracing), API Gateway, ECS. Sampling: 5% default - increase for debugging, reduce for cost. Use when multiple downstream service calls need correlation.`},
    STORAGE_001:{trigger:['s3','object storage','files','uploads','images','data lake','backup'],rule:`S3 STORAGE CLASSES: Standard ($0.023/GB, frequent access). Standard-IA ($0.0125/GB + retrieval fee, monthly access). Glacier Instant ($0.004/GB, quarterly). Glacier Flexible ($0.0036/GB, archives). Intelligent-Tiering (unpredictable patterns + $0.0025/1k objects monitoring). Use Lifecycle Policies to auto-transition. Pre-signed URLs for secure client uploads/downloads.`},
    STORAGE_002:{trigger:['efs','file system','nfs','shared storage','multiple ec2','concurrent access'],rule:`EFS: Shared NFS across multiple EC2/Lambda. EBS is single-instance only. Auto-scales storage. Multi-AZ replication. Lambda: mount EFS for ML models or dependencies >250MB. Performance: General Purpose (web, low latency) vs Max I/O (parallel big data). Throughput: Elastic (auto-scales, best for unpredictable). EBS gp3: 3,000 IOPS baseline, cheaper than gp2.`},
    CICD_001:{trigger:['ci/cd','cicd','pipeline','continuous deployment','continuous integration','codepipeline','codebuild','codedeploy'],rule:`AWS CICD: GitHub (preferred source, AWS recommends over CodeCommit which is deprecated for new customers) -> CodeBuild (buildspec.yml, pay per minute) -> CodePipeline (orchestrate stages, human approvals) -> CodeDeploy (Rolling/Blue-Green/Canary). Blue/Green ECS: new task set -> traffic shift -> terminate old. ECR for container image storage.`},
    SERVERLESS_001:{trigger:['step functions','workflow','state machine','orchestration','long running','multi-step','saga'],rule:`STEP FUNCTIONS vs LAMBDA CHAINING: Never chain Lambdas directly (inconsistent state on failure, no visibility, doubled cost). Standard (up to 1yr, exactly-once, audit history, $0.025/1k transitions) for business workflows. Express (5 min, at-least-once, high throughput, $1/million) for IoT/streaming. Direct SDK integrations avoid Lambda glue code for simple service calls.`},
    SERVERLESS_002:{trigger:['appsync','graphql','real-time subscription','websocket','mobile backend'],rule:`APPSYNC vs API GATEWAY: AppSync for GraphQL + real-time subscriptions + mobile offline sync. API Gateway REST for REST endpoints, API keys, usage plans, OpenAPI spec, WAF. API Gateway HTTP (70% cheaper than REST) for simple Lambda proxy, JWT auth, no advanced features needed. API Gateway WebSocket for custom real-time without GraphQL.`},
    COST_001:{trigger:['cost','cheap','affordable','save money','spot','reserved','savings plan','budget'],rule:`COST HIERARCHY: 1) Right-size first (CloudWatch metrics). 2) Compute Savings Plans (66% savings, any EC2/Fargate/Lambda). 3) Reserved Instances for RDS/ElastiCache/Redshift. 4) Spot (90% savings, use for batch/CI-CD/stateless). 5) Graviton/ARM (20-40% better price-perf). 6) S3 Intelligent-Tiering. 7) VPC Endpoints instead of NAT Gateway for AWS service traffic.`},
  };

  const getRelevantRules=(userPrompt,pattern,services=[])=>{
    const text=(userPrompt+' '+pattern+' '+services.join(' ')).toLowerCase();
    const matched=new Set();
    Object.entries(AWS_ARCH_RULES).forEach(([id,rule])=>{
      const isMatch=rule.trigger.some(kw=>kw.includes('.*')?new RegExp(kw).test(text):text.includes(kw));
      if(isMatch) matched.add(id);
    });
    return[...matched].map(id=>AWS_ARCH_RULES[id]);
  };

  const buildRulesSection=(userPrompt,pattern,services=[])=>{
    const rules=getRelevantRules(userPrompt,pattern,services);
    if(!rules.length) return '';
    return `\n====================================================\nARCHITECTURAL RULES - apply these precisely:\n====================================================\n${rules.map(r=>`[${Object.keys(AWS_ARCH_RULES).find(k=>AWS_ARCH_RULES[k]===r)}] ${r.rule}`).join('\n\n')}`;
  };

  // -- Improvement 1: Pattern Classification ------------------------------------
  // Classify architecture type from prompt keywords BEFORE calling Claude
  // This selects the right examples and layout mode, no API call needed
  const classifyPattern=(text)=>{
    const t=text.toLowerCase();
    // Order matters - more specific patterns first
    if(/ci.?cd|codepipeline|codebuild|codedeploy|codecommit|pipeline|deploy|github.action|gitlab.ci/.test(t)) return 'CICD';
    if(/machine.learn|ml.pipeline|sagemaker|model.train|inference|bedrock|ai.pipeline/.test(t)) return 'ML_PIPELINE';
    if(/iot|sensor|device|telemetry|mqtt|greengrass/.test(t)) return 'IOT';
    if(/data.pipeline|etl|data.lake|data.warehouse|analytics.pipeline|streaming|kinesis|glue|redshift|athena|real.time.data/.test(t)) return 'DATA_PIPELINE';
    if(/microservice|service.mesh|service.discovery|multiple.service|each.service/.test(t)) return 'MICROSERVICES';
    if(/serverless|lambda|no.server|function.as|faas/.test(t)) return 'SERVERLESS';
    if(/security|waf|guard.?duty|config|cloud.?trail|shield|compliance|hipaa|pci/.test(t)) return 'SECURITY';
    if(/static.site|jamstack|spa|react.app|vue.app|next.?js|cloudfront.*s3|s3.*cloudfront/.test(t)) return 'STATIC_SITE';
    return 'WEB_APP'; // default - most common architecture
  };

  // -- Improvement 2: Protocol-aware connection labels ---------------------------
  // Build a per-pair midLabel lookup so the system prompt gives Claude precise guidance
  const buildConnectionLabels=(pattern)=>`
====================================================
CONNECTION DIRECTION & PROTOCOL LABELS
====================================================
Every connection goes FROM the caller TO the callee. Use these midLabels where the
protocol adds genuine information - not on every connection, only architecturally significant ones.

Canonical connection directions & labels by service pair:
  route53 -> cloudfront / elb / apigateway     midLabel: "DNS"
  users / globe -> route53                      midLabel: (none - obvious)
  waf -> cloudfront / apigateway / elb          midLabel: (none - filtering is implicit)
  cloudfront -> elb / apigateway                midLabel: "HTTPS 443"
  cloudfront -> s3                              midLabel: "GET /assets"
  elb / apigateway -> ec2 / ecs / lambda        midLabel: "HTTP" or "HTTPS"
  apigateway -> cognito                         midLabel: "JWT verify"
  apigateway -> lambda (sync invoke)            midLabel: "invoke"
  lambda -> dynamodb                            midLabel: "PutItem" (write) or "Query" (read)
  lambda -> rds / aurora                        midLabel: "TCP 5432" or "TCP 3306"
  lambda -> rdsProxy                            midLabel: "TCP 3306"
  rdsProxy -> aurora / rds                      midLabel: "TCP 3306" (pool)
  lambda / ec2 -> s3                            midLabel: "PutObject" or "GetObject"
  lambda / ec2 -> sqs (sending)                 midLabel: "SendMessage"
  sqs -> lambda (event trigger)                 midLabel: "trigger"
  lambda -> sns                                 midLabel: "Publish"
  sns -> sqs / lambda (fan-out)                 midLabel: "fan-out"
  ec2 / ecs -> aurora / rds                     midLabel: "TCP 3306" or "TCP 5432"
  ec2 / ecs -> elasticache                      midLabel: "Redis 6379"
  ec2 / ecs -> dynamodb                         midLabel: "HTTPS"
  kinesis -> lambda                             midLabel: "stream"
  lambda -> kinesis                             midLabel: "PutRecord"
  glue -> s3                                    midLabel: "read/write"
  glue -> redshift                              midLabel: "COPY"
  cloudwatch -> (any service)                   type:"line", bent:true, midLabel: (none)
  codecommit / github -> codebuild / codepipeline midLabel: "push"
  codebuild -> ecr                              midLabel: "push image"
  codepipeline -> codedeploy                    midLabel: "deploy"
  codedeploy -> ecs / ec2                       midLabel: "rolling deploy"

Pattern-specific notes for ${pattern}:
${pattern==='CICD'?'  Connect in sequence: source -> build -> pipeline -> deploy -> target compute. Horizontal layout, left to right. Use bent:false for all stage connections.':''}
${pattern==='DATA_PIPELINE'?'  Data flows LEFT to RIGHT. Sources fan INTO a central ingest service, then process, then store. Add midLabels showing data format where relevant ("JSON", "Parquet", "stream").':''}
${pattern==='MICROSERVICES'?'  Services that call each other synchronously: direct connection. Async: go via SQS. Show SQS as an intermediary element between the two services, not a direct connection.':''}
${pattern==='SERVERLESS'?'  API Gateway is the hub - it fans out to multiple Lambda functions. Each Lambda connects to its own data store. Do NOT use elb between API Gateway and Lambda.':''}
${pattern==='STATIC_SITE'?'  Users -> Route53 -> CloudFront -> (S3 for static, ALB for API). Two paths from CloudFront. Use bent:true for the CloudFront -> S3 connection.':''}
`;

  // -- Improvement 3: Automatic border grouping ----------------------------------
  // After Claude returns elements, compute tight-fitting borders deterministically
  // This guarantees borders always contain exactly the right elements, correctly sized
  // Hierarchical border calculator - computes correct nested border coordinates
  // from element positions using the strict padding rules.
  // This is deterministic JavaScript, not a prompt - Claude cannot get this wrong.
  const computeAutoGroupBorders=(elements,diagramBorders,ts,pattern)=>{
    if(!elements.length) return diagramBorders.length?diagramBorders:[];

    // Padding constants matching Rule 2
    const PAD={
      vpc:40, nacl:30, subnet:24, sg:16,
      label:20, // extra top space for label text
      sibling:30, // gap between sibling borders
      general:55, // fallback for non-nested patterns
    };

    const EW=130, EH=110; // element dimensions

    // --- Helper: tight bbox around a set of elements with given padding -------
    const bbox=(els,pad,extraTopForLabel=0)=>{
      if(!els.length) return null;
      const minX=Math.min(...els.map(e=>e.x));
      const minY=Math.min(...els.map(e=>e.y));
      const maxX=Math.max(...els.map(e=>e.x+(e.width||EW)));
      const maxY=Math.max(...els.map(e=>e.y+(e.height||EH)));
      return{
        x:Math.round((minX-pad)/10)*10,
        y:Math.round((minY-pad-extraTopForLabel)/10)*10,
        width:Math.round((maxX-minX+pad*2)/10)*10,
        height:Math.round((maxY-minY+pad*2+extraTopForLabel)/10)*10,
      };
    };

    // --- Detect if this is a VPC/subnet style diagram -------------------------
    const isVpcPattern=diagramBorders.some(b=>
      /vpc|subnet|nacl|network acl|security group/i.test(b.label||'')
    )||/vpc|subnet|nacl/i.test(pattern||'');

    // --- If Claude gave borders, rebuild them properly using hierarchy ---------
    if(diagramBorders.length>0){
      const rebuilt=[];

      // Sort borders by area descending (largest = outermost processed first)
      const sorted=[...diagramBorders].sort((a,b)=>(b.width*b.height)-(a.width*a.height));

      sorted.forEach(b=>{
        const label=(b.label||'').toLowerCase();
        const isVpc=/vpc/.test(label);
        const isNacl=/nacl|network acl/.test(label);
        const isSg=/security group|^sg/.test(label);
        const isPublicSubnet=/public subnet|public sub/.test(label);
        const isPrivateSubnet=/private subnet|private sub/.test(label);
        const isSubnet=/subnet/.test(label)&&!isNacl;

        // Find elements that Claude intended to be inside this border
        // Use generous matching (100px tolerance) then re-derive tight bbox
        const inside=elements.filter(e=>{
          const ex=e.x, ey=e.y, ew=e.width||EW, eh=e.height||EH;
          return ex>=b.x-120 && ex+ew<=b.x+b.width+120
              && ey>=b.y-120 && ey+eh<=b.y+b.height+120;
        });

        let pad=PAD.general;
        let topExtra=PAD.label;
        if(isVpc){pad=PAD.vpc;}
        else if(isNacl){pad=PAD.nacl;}
        else if(isSubnet){pad=PAD.subnet;}
        else if(isSg){pad=PAD.sg;}

        if(inside.length>0){
          const box=bbox(inside,pad,topExtra);
          if(box) rebuilt.push({...b,...box});
          else rebuilt.push(b);
        } else {
          rebuilt.push(b);
        }
      });

      // --- Fix sibling subnet sizing: all siblings must be same size ----------
      const publicSubnets=rebuilt.filter(b=>/public subnet|public sub/i.test(b.label||''));
      const privateSubnets=rebuilt.filter(b=>/private subnet|private sub/i.test(b.label||''));

      const uniformSiblings=(siblings)=>{
        if(siblings.length<2) return;
        const maxW=Math.max(...siblings.map(s=>s.width));
        const maxH=Math.max(...siblings.map(s=>s.height));
        siblings.forEach(s=>{s.width=maxW;s.height=maxH;});
      };
      uniformSiblings(publicSubnets);
      uniformSiblings(privateSubnets);

      // --- Fix sibling gaps: ensure exactly 30px between sibling borders ------
      const fixSiblingGaps=(siblings)=>{
        if(siblings.length<2) return;
        // Sort by x then y
        siblings.sort((a,b)=>a.x!==b.x?a.x-b.x:a.y-b.y);
        // Determine if siblings are in same row (similar y) or same column (similar x)
        const sameRow=Math.abs(siblings[0].y-siblings[1].y)<50;
        if(sameRow){
          // Reposition so they have exactly 30px gap, keeping first anchor
          for(let i=1;i<siblings.length;i++){
            siblings[i].x=siblings[i-1].x+siblings[i-1].width+PAD.sibling;
          }
        } else {
          for(let i=1;i<siblings.length;i++){
            siblings[i].y=siblings[i-1].y+siblings[i-1].height+PAD.sibling;
          }
        }
      };
      fixSiblingGaps(publicSubnets);
      fixSiblingGaps(privateSubnets);

      // --- Expand NACL to contain all subnets with 30px padding ---------------
      const naclBorder=rebuilt.find(b=>/nacl|network acl/i.test(b.label||''));
      if(naclBorder){
        const allSubnets=[...publicSubnets,...privateSubnets];
        if(allSubnets.length){
          const minX=Math.min(...allSubnets.map(s=>s.x));
          const minY=Math.min(...allSubnets.map(s=>s.y));
          const maxX=Math.max(...allSubnets.map(s=>s.x+s.width));
          const maxY=Math.max(...allSubnets.map(s=>s.y+s.height));
          naclBorder.x=minX-PAD.nacl;
          naclBorder.y=minY-PAD.nacl-PAD.label;
          naclBorder.width=(maxX-minX)+PAD.nacl*2;
          naclBorder.height=(maxY-minY)+PAD.nacl*2+PAD.label;
        }
      }

      // --- Expand VPC to contain NACL (or all subnets) with 40px padding ------
      const vpcBorder=rebuilt.find(b=>/^vpc/i.test(b.label||''));
      if(vpcBorder){
        const inner=naclBorder||{
          x:Math.min(...[...publicSubnets,...privateSubnets].map(s=>s.x)),
          y:Math.min(...[...publicSubnets,...privateSubnets].map(s=>s.y)),
          width:0,height:0,
        };
        if(naclBorder){
          vpcBorder.x=naclBorder.x-PAD.vpc;
          vpcBorder.y=naclBorder.y-PAD.vpc-PAD.label;
          vpcBorder.width=naclBorder.width+PAD.vpc*2;
          vpcBorder.height=naclBorder.height+PAD.vpc*2+PAD.label;
        }
      }

      // --- Fix SGs: each SG wraps its own element with 16px padding -----------
      const sgBorders=rebuilt.filter(b=>/security group|^sg/i.test(b.label||''));
      sgBorders.forEach(sg=>{
        const sgEls=elements.filter(e=>{
          return e.x>=sg.x-60 && e.x+(e.width||EW)<=sg.x+sg.width+60
              && e.y>=sg.y-60 && e.y+(e.height||EH)<=sg.y+sg.height+60;
        });
        if(sgEls.length){
          const box=bbox(sgEls,PAD.sg,PAD.label);
          if(box){sg.x=box.x;sg.y=box.y;sg.width=box.width;sg.height=box.height;}
        }
      });

      return rebuilt;
    }

    // --- Claude gave NO borders: auto-compute from element positions -----------
    const auto=[];
    const compute=elements.filter(e=>['ec2','ecs','eks','lambda','batch'].includes(e.service?.id));
    const data=elements.filter(e=>['aurora','rds','dynamodb','elasticache','rdsProxy','redshift'].includes(e.service?.id));
    const lbs=elements.filter(e=>e.service?.id==='elb');
    const lambdas=elements.filter(e=>e.service?.id==='lambda');

    if(['WEB_APP','SERVERLESS','MICROSERVICES'].includes(pattern)){
      const vpcEls=[...compute,...data,...lbs,...lambdas];
      if(vpcEls.length>=2){
        const box=bbox(vpcEls,PAD.vpc+PAD.nacl+PAD.subnet,PAD.label);
        if(box) auto.push({id:`ai_b_${ts}_vpc`,label:'VPC',...box,color:'#3b82f6',strokeWidth:2,strokeStyle:'solid',borderRadius:8});
      }
      if(lbs.length){
        const box=bbox(lbs,PAD.subnet,PAD.label);
        if(box) auto.push({id:`ai_b_${ts}_pub`,label:'Public Subnet',...box,color:'#10b981',strokeWidth:2,strokeStyle:'solid',borderRadius:6});
      }
      if(compute.length>=2){
        const box=bbox(compute,PAD.subnet,PAD.label);
        if(box) auto.push({id:`ai_b_${ts}_priv`,label:'Private Subnet',...box,color:'#f59e0b',strokeWidth:2,strokeStyle:'solid',borderRadius:6});
      }
    }
    if(pattern==='SERVERLESS'&&lambdas.length>=2){
      const box=bbox(lambdas,PAD.subnet,PAD.label);
      if(box) auto.push({id:`ai_b_${ts}_fns`,label:'Lambda Functions',...box,color:'#f59e0b',strokeWidth:2,strokeStyle:'solid',borderRadius:8});
    }
    return auto;
  };

  // -- Improvement 4: Two-pass generation ----------------------------------------
  // (genPhase state declared in modal props section above)

  // Pre-generation plan corrector - deterministically fixes known wrong choices
  // before they reach the generation pass. Claude gets these wrong reliably.
  const correctPlan=(plan,userPrompt)=>{
    const t=(userPrompt||'').toLowerCase();
    const isActiveActive=/active.active|multi.site|zero.rpo|zero.rto|all regions writ|no failover|simultaneously writ|both regions writ/.test(t);
    const isActivePas=/active.passive|warm standby|pilot light|promote.*failover|failover.*promote/.test(t);
    if(isActiveActive&&!isActivePas){
      // Replace any mention of aurora in the plan with dynamodb
      return plan
        .replace(/\baurora\b/gi,'dynamodb')
        .replace(/\bAurora\b/g,'DynamoDB')
        .replace(/Aurora Global\b/gi,'DynamoDB Global Tables')
        .replace(/aurora.*global/gi,'dynamodb global tables')
        +'\n\nCORRECTION APPLIED: User requested active-active. Aurora replaced with DynamoDB Global Tables. Aurora Global DB is active-PASSIVE (one writable primary). DynamoDB Global Tables is active-ACTIVE (every region writes simultaneously).';
    }
    return plan;
  };

  const buildPlanningPrompt=(pattern,userPrompt,providerName,isLiteral)=>`You are an expert ${providerName} cloud architect.
Read this architecture description and output a brief planning document. NO JSON - structured text only.

Description: "${userPrompt}"
Detected pattern: ${pattern}

${isLiteral?`
!!! LITERAL PROMPT - MOST IMPORTANT RULE !!!
The user has named specific components. Plan ONLY those exact components. Nothing else.
Do NOT add any service not explicitly mentioned in the description above.

Common services to NOT infer or add automatically:
- Internet Gateway (igw) - only add if the user said "internet gateway" or "igw"
- NAT Gateway - only add if the user said "nat gateway"
- Security Groups - only add if the user said "security groups" or "sg"
- NACLs - only add if the user said "nacl" or "network acl"
- Route 53 - only add if the user said "route 53" or "dns"
- ALB / Load Balancer - only add if the user said "load balancer" or "alb"
- CloudWatch - only add if the user said "cloudwatch" or "monitoring"
- WAF - only add if the user said "waf" or "firewall"
- RDS / Aurora / any database - only add if the user named a database
- Any EC2 instances - only add if the user said "ec2" or "instances"

Just because the user mentions "public subnets" does NOT mean add an Internet Gateway.
Just because they mention subnets does NOT mean add NACLs or security groups.

If the prompt says "2 public subnets and 2 private subnets" - plan exactly:
  SERVICES: vpc, publicSubnet x2, privateSubnet x2
  BORDERS: VPC border + 2 public subnet borders + 2 private subnet borders
  ELEMENTS: none unless named
  NOTHING ELSE.

Violating this rule by adding unrequested services is the #1 bug to avoid.
`:''}
${/vpc|subnet|nacl|security group/i.test(userPrompt)&&!isLiteral?`
VPC DIAGRAM RULES - CRITICAL, READ FIRST:
This is a VPC/subnet diagram. Follow these rules exactly:

WHAT GOES OUTSIDE THE VPC (above it, not inside any subnet):
  - Internet Gateway (igw) - always outside, above VPC
  - Route 53 - always outside, above VPC
  - CloudFront - always outside, above VPC
  - WAF - always outside, above VPC
  - Users/globe - always outside, above VPC
  - Application Load Balancer - OUTSIDE the VPC or in public subnet ONLY

WHAT GOES INSIDE SUBNETS:
  - EC2 instances - one per subnet
  - NAT Gateway - one per PUBLIC subnet AZ
  - RDS/Aurora - one per PRIVATE subnet AZ
  - ElastiCache - one per PRIVATE subnet AZ

SUBNET ELEMENT LIMIT: Each subnet AT MOST 2 elements. NEVER stack 3+.
EACH ELEMENT GETS ITS OWN SECURITY GROUP. No empty security groups.
`:''}
SPACING SYSTEM (the generation pass will enforce all 13 rules - plan for them):
  * All sibling containers: same size, 30px gaps between them
  * Nesting: VPC=40px padding, NACL=30px, Subnet=24px, SecurityGroup=16px
  * Container sizes derived bottom-up from content (never top-down)
  * Security hierarchy: VPC->NACL->Subnet->SecurityGroup->Element (each nested cleanly inside)
  * Every element mathematically centred within its parent

${isLiteral?'':`${buildRulesSection(userPrompt,pattern)}

CRITICAL DATABASE RULE:
"active-active" / "zero RPO" / "all regions writable" -> DYNAMODB Global Tables, NOT aurora.
"active-passive" / "warm standby" / "pilot light" -> aurora is appropriate.
`}
Output EXACTLY this structure (one line each):
SERVICES: [${isLiteral?'ONLY the exact services/components named in the prompt above':'comma-separated service IDs needed'}]
LAYOUT: [VERTICAL or HORIZONTAL]
TIERS: [${isLiteral?'only the components explicitly requested':'each tier and its services'}]
CONNECTIONS: [${isLiteral?'only connections between explicitly named components':'key connections'}]
BORDERS: [${isLiteral?'only borders for explicitly requested containers (vpc, subnets)':'logical groups with colour'}]
BUBBLES: [services needing explanation bubbles at x>=1300]
SCALE: [${isLiteral?'exactly as specified in prompt':'single-AZ or multi-AZ'}]`;

  const buildGenerationPromptWithPlan=(plan,pattern,userPrompt,providerName,svcIds,detailLevel,isLiteral=false)=>{
    const t=(userPrompt||'').toLowerCase();
    const isActiveActive=/active.active|multi.site|zero.rpo|zero.rto|all regions writ|no failover|simultaneously writ/.test(t);
    const isVpcDiagram=/vpc|subnet|nacl|security group/i.test(userPrompt);
    const rulesSection=buildRulesSection(userPrompt,pattern);
    return `You are an expert ${providerName} cloud architect creating a clean, professional architecture diagram.

${isLiteral?`
!!! LITERAL PROMPT - STRICT GENERATION RULE !!!
The user named specific components only. Generate EXACTLY those components. NOTHING MORE.
User asked for: "${userPrompt}"

DO NOT INFER OR ADD any of these unless they appear word-for-word in the prompt:
- Internet Gateway - "public subnet" does NOT imply IGW
- NAT Gateway - not implied by private subnets
- Security Groups - not implied by subnets
- NACLs - not implied by anything
- Route 53, CloudWatch, WAF, IAM, ALB, RDS, Aurora, ElastiCache, CloudFront
- ANY service not explicitly named above

If the prompt says "VPC with 2 public subnets and 2 private subnets" generate:
- 1 VPC border
- 2 public subnet borders (empty unless elements were asked for)
- 2 private subnet borders (empty unless elements were asked for)
- 0 elements, 0 security groups, 0 NACLs, 0 connections
THAT IS ALL.
`:`MOST IMPORTANT: Generate the services genuinely needed for this architecture.
${isActiveActive?`WARNING: ACTIVE-ACTIVE = dynamodb Global Tables NOT aurora.`:''}
${isVpcDiagram?`VPC RULES: Max 2 elements per subnet. One SG per element. No empty SGs.`:''}
`}
${isLiteral?'':rulesSection}
${detailLevel}

Available service IDs: ${svcIds}

ARCHITECTURE PLAN:
${plan}

LAYOUT:
${plan.includes('HORIZONTAL')
  ?'HORIZONTAL layout. Stages left to right, x: 60, 340, 620, 900, 1160. Items per stage spread vertically 220px apart, centred at y=290. Sibling containers same size, 30px gaps between them.'
  :'VERTICAL layout. Layers top to bottom:\n  y=60 users, y=240 DNS/security, y=420 CDN/edge, y=600 load balancing, y=800 compute, y=1020 data, y=1220 storage.\n  Compute items: x=400 and x=880 for 2 items; x=300, x=620, x=940 for 3 items.\n  Supporting services (cloudwatch etc): x=1080, y matching their primary layer.'
}

SPACING & SYMMETRY (all 13 rules apply - these are the most critical):
  [ ] Element sizes: width:130, height:110 always. All siblings same size.
  [ ] Nesting padding: VPC=40px, NACL=30px, Subnet=24px, SecurityGroup=16px inward on all sides
  [ ] Container sizing: calculated BOTTOM-UP from element sizes + padding (never top-down)
  [ ] Sibling gaps: exactly 30px between ALL sibling borders (horizontal AND vertical)
  [ ] Mathematical centering: elements centred within their parent using exact arithmetic
  [ ] Absolute minimums: 20px between any borders, 130px between any elements, never overlap
  [ ] Grid alignment: same-row elements share y coordinate, same-column share x coordinate
  [ ] Security hierarchy: VPC(solid)->NACL(dotted)->Subnet(solid)->SecurityGroup(dashed)->Element
  [ ] Label placement: always top-left, 8px inset, inside the border's top padding space
  [ ] Connection routing: bent:true to avoid diagonal cuts through unrelated containers
  [ ] ALB/NLB: minimum 2 compute targets in different AZs
  [ ] Bubbles: clean column at x>=1300 (vertical) or row at y>=700 (horizontal), never overlapping
  [ ] Modification: expand parent containers when adding elements - never squeeze or overlap

BUBBLE ANNOTATIONS:
  • Include bubbles for every significant service - explain WHY it's here in 1-2 sentences
  • ${plan.includes('HORIZONTAL')
    ?'Place ALL bubbles in a row BELOW the diagram: y=680-700, evenly spaced horizontally'
    :'Place ALL bubbles in a column on the FAR RIGHT: x=1300, starting at y=160, each 110px below the last'
  }
  • Bubble size: w=240, h=auto (calculated from text length), shape="textbox"
  • Colour by layer: DNS/internet=#f0f9ff/#3b82f6, compute=#fff7ed/#f59e0b, data=#f5f3ff/#8b5cf6
  • connectTo must be a valid element id

CONNECTION LABELS: No midLabels unless architecturally critical. Max 3 total.

${buildConnectionLabels(pattern)}

OUTPUT raw JSON only - no markdown, no explanation:
{
  "title": "Title (max 6 words)",
  "elements": [{"id":"uid","serviceId":"exact_id","label":"Name","x":640,"y":800,"width":130,"height":110}],
  "connections": [{"from":"a","to":"b","type":"arrow","bent":false}],
  "borders": [{"id":"vpc","label":"VPC","x":290,"y":540,"width":890,"height":570,"color":"#3b82f6"}],
  "bubbles": [{"id":"b1","text":"Explanation","shape":"textbox","x":1300,"y":160,"w":240,"h":65,"fillColor":"#f0f9ff","strokeColor":"#3b82f6","textColor":"#1e293b","connectTo":"uid"}]
}

VERIFY before outputting - every box must be true:
[ ] All serviceIds exist in available list
[ ] width:130 height:110 on every element - no exceptions
[ ] All siblings at same nesting level are identical size
[ ] Sibling borders have exactly 30px gap between them
[ ] Every element is mathematically centred within its parent container
[ ] No two borders overlap or are within 20px of each other
[ ] No two elements are within 130px of each other
[ ] Container sizes derived bottom-up (element+padding), not guessed
[ ] Border labels at top-left, 8px inset
[ ] Connections use bent:true to avoid crossing unrelated containers
[ ] ALB/NLB has >=2 compute targets in different AZs
[ ] Bubbles at x>=1300 (vertical) or y>=700 (horizontal), no overlaps
[ ] Valid JSON only`;
  };

  const generate=async()=>{
    if(!canGenerate) return;
    setStatus('generating');
    setErrorMsg('');
    setGenPhase('');

    const providerName=activeProvider.toUpperCase();
    const allSvcIds={
      aws:AWS_SERVICES.map(s=>s.id).join(', '),
      gcp:GCP_SERVICES.map(s=>s.id).join(', '),
      azure:AZURE_SERVICES.map(s=>s.id).join(', '),
    };
    const svcIds=allSvcIds[activeProvider]||allSvcIds.aws;

    // Literal vs conceptual detection
    // Literal: user names specific AWS services/components -> generate exactly those
    // Conceptual: user describes a pattern -> generate what that pattern requires
    const isLiteralPrompt=(()=>{
      const t=prompt.trim().toLowerCase();
      // Always conceptual if using architecture pattern language
      if(/highly.available|high.availab|disaster.recov|pilot.light|warm.standby|3.tier|three.tier|microservice|serverless|production.ready|fault.tolerant|cloud.native|well.architected|scalable|enterprise/.test(t)) return false;
      // Conceptual if NO specific AWS services mentioned
      const hasSpecificServices=/\b(vpc|subnet|subnets|ec2|rds|aurora|lambda|s3|dynamodb|ecs|eks|alb|elb|nat.?gateway|nacl|security.?group|cloudfront|route.?53|api.?gateway|sqs|sns|kinesis|elasticache|redshift|igw|internet.?gateway|cognito|cloudwatch|waf|iam)\b/.test(t);
      if(!hasSpecificServices) return false;
      // Literal if short AND names specific things (not a pattern description)
      return t.split(/\s+/).length < 40;
    })();

    const detailLevel=isLiteralPrompt
      ?`LITERAL PROMPT: Generate EXACTLY what the user asked for - nothing more.
No extra services, borders, or connections beyond what they explicitly named.
If they say "2 public subnets and 2 private subnets" - generate exactly those 4 subnets inside a VPC. No NACLs, no security groups, no NAT gateways unless they asked.`
      :`CONCEPTUAL PROMPT: Generate the services genuinely required for this architecture pattern.
Use AWS expertise to select appropriate components. Be selective - prefer fewer well-chosen services over many.
Complexity: ${complexity}.`;

    try {
      // -- Step 1: Classify pattern from user prompt (no API call needed) -----
      const pattern=classifyPattern(prompt.trim());

      const patternName=pattern.toLowerCase().split('_').join(' ');

      // -- Step 2: Planning pass ----------------------------------------------
      setGenPhase('planning');
      const planRaw=await callClaudeWithRetry({
        max_tokens:800,
        system:buildPlanningPrompt(pattern,prompt.trim(),providerName,isLiteralPrompt),
        messages:[{role:'user',content:`Plan a ${patternName} architecture for: ${prompt.trim()}`}],
      });

      // -- Step 3: Correct plan deterministically before generation ---------
      const correctedPlan=correctPlan(planRaw,prompt.trim());

      // -- Step 4: Generation pass (uses corrected plan as context) ---------
      setGenPhase('generating');
      const raw=await callClaudeWithRetry({
        max_tokens:8000,
        system:buildGenerationPromptWithPlan(correctedPlan,pattern,prompt.trim(),providerName,svcIds,detailLevel,isLiteralPrompt),
        messages:[{role:'user',content:`Generate the complete diagram JSON for this ${patternName} architecture. Original description: "${prompt.trim()}"`}],
      });

      // -- Step 4: Parse JSON -------------------------------------------------
      let diagram;
      try { diagram=safeParseJSON(raw); }
      catch(e){ throw new Error('Could not parse AI response. Please try again.'); }

      // -- Step 5: Map serviceIds -> full service objects ---------------------
      const allSvcs=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];
      const providerSvcs=activeProvider==='gcp'?GCP_SERVICES:activeProvider==='azure'?AZURE_SERVICES:AWS_SERVICES;
      const ts=Date.now();

      let elements=(diagram.elements||[]).map((el,i)=>{
        const svc=providerSvcs.find(s=>s.id===el.serviceId)
          ||allSvcs.find(s=>s.id===el.serviceId)
          ||providerSvcs[0];
        return{
          id:el.id||`ai_el_${ts}_${i}`,
          service:svc,
          x:Math.round((el.x||100+i*160)/10)*10,
          y:Math.round((el.y||100)/10)*10,
          width:el.width||130,
          height:el.height||110,
          customName:el.label!==svc.name?el.label:null,
        };
      });

      // -- Step 5b: VPC Layout Engine -----------------------------------------
      // ONLY fires for genuine VPC/subnet nested diagrams.
      // Reads Claude's grouping intent, recomputes ALL coordinates from padding rules.
      // Wrapped in try/catch - any failure falls through to Claude's positions.
      try{
        const isGenuineVpc=
          (diagram.borders||[]).filter(b=>/subnet/i.test(b.label||'')).length>=2
          &&(diagram.borders||[]).some(b=>/vpc/i.test(b.label||''));

        if(isGenuineVpc){
          const EW=130,EH=110,P_VPC=40,P_NACL=30,P_SUB=24,P_SG=16,LBL=20,GAP=30;
          const CANVAS_CX=600;
          const SG_W=EW+P_SG*2;         // 162
          const SG_H=EH+P_SG*2+LBL;    // 162
          const SUB_W=SG_W+P_SUB*2;     // 210

          const rawEls=diagram.elements||[];
          const rawBords=diagram.borders||[];

          // Classify borders
          const vpcBord=rawBords.find(b=>/^vpc/i.test(b.label||''));
          const naclBords=rawBords.filter(b=>/nacl/i.test(b.label||''));
          const subBords=rawBords.filter(b=>/subnet/i.test(b.label||'')&&!/nacl/i.test(b.label||''));
          const sgBords=rawBords.filter(b=>/security.?group|^sg[^l]/i.test(b.label||''));

          // Assign elements to subnets by NEAREST subnet border centre
          // Each element goes to exactly ONE subnet - the closest one
          const subnetGroups=subBords.map(sb=>({
            id:sb.id, label:sb.label||'Subnet',
            color:sb.color||(/public/i.test(sb.label||'')?'#10b981':'#f59e0b'),
            isPublic:/public/i.test(sb.label||''),
            origBorder:sb, els:[], sgLabels:[],
          }));

          // Assign each raw element to its nearest subnet by border centre distance
          rawEls.forEach(re=>{
            const ex=re.x+(re.width||EW)/2;
            const ey=re.y+(re.height||EH)/2;

            // Check if this element is likely OUTSIDE the VPC
            // (above the topmost subnet, or explicitly a gateway/dns/cdn service)
            const topSubY=Math.min(...subBords.map(b=>b.y));
            const vpcTop=vpcBord?vpcBord.y:topSubY-100;
            const isOutside=ey<vpcTop+20||
              /internet.?gateway|igw/i.test(re.label||'')||
              /route.?53/i.test(re.label||'')||
              /cloudfront/i.test(re.label||'')||
              /^waf$/i.test(re.label||'')||
              /^users?$/i.test(re.label||'');

            if(isOutside) return; // handled separately as outside element

            // Find nearest subnet by centre-to-centre distance
            let best=null, bestDist=Infinity;
            subnetGroups.forEach(sg=>{
              const scx=sg.origBorder.x+sg.origBorder.width/2;
              const scy=sg.origBorder.y+sg.origBorder.height/2;
              const dist=Math.abs(ex-scx)+Math.abs(ey-scy); // Manhattan distance
              if(dist<bestDist){bestDist=dist;best=sg;}
            });
            if(best) best.els.push(re);
          });

          // Assign SG labels to each element in each subnet
          subnetGroups.forEach(sg=>{
            sg.els.forEach(re=>{
              const sgB=sgBords.find(sgb=>{
                const scx=sgb.x+sgb.width/2, scy=sgb.y+sgb.height/2;
                const rex=re.x+(re.width||EW)/2, rey=re.y+(re.height||EH)/2;
                return Math.abs(rex-scx)<200&&Math.abs(rey-scy)<200;
              });
              sg.sgLabels.push(sgB?.label||('SG '+sg.label));
            });
          });

          // Outside elements: not assigned to any subnet
          const assignedIds=new Set(subnetGroups.flatMap(g=>g.els.map(e=>e.id)));
          const outsideEls=rawEls.filter(e=>!assignedIds.has(e.id));

          // Only proceed if we have meaningful grouping
          const totalAssigned=subnetGroups.reduce((s,g)=>s+g.els.length,0);
          if(totalAssigned===0) throw new Error('no elements assigned to subnets');

          const pubGroups=subnetGroups.filter(g=>g.isPublic);
          const privGroups=subnetGroups.filter(g=>!g.isPublic);

          // Compute INDEPENDENT heights per row - public row sized for pub elements only,
          // private row sized for priv elements only. Siblings within a row are uniform.
          const pubMaxEls=Math.max(...(pubGroups.length?pubGroups.map(g=>g.els.length):[1]),1);
          const privMaxEls=Math.max(...(privGroups.length?privGroups.map(g=>g.els.length):[1]),1);
          const subH=(n)=>P_SUB+LBL+n*SG_H+Math.max(0,n-1)*GAP+P_SUB;
          const PUB_SUB_H=subH(pubMaxEls);   // public subnets sized for their content
          const PRIV_SUB_H=subH(privMaxEls); // private subnets sized for their content

          // NACL and VPC dimensions using per-row heights
          const rowW=(n)=>n>0?n*SUB_W+Math.max(0,n-1)*GAP:0;
          const naclW=(rW)=>rW+P_NACL*2;
          const pubNaclH=PUB_SUB_H+P_NACL*2+LBL;
          const privNaclH=PRIV_SUB_H+P_NACL*2+LBL;
          const hasNacl=naclBords.length>0;
          const hasSeparateNacls=naclBords.length>=2;

          const pubNaclW=pubGroups.length>0?naclW(rowW(pubGroups.length)):0;
          const privNaclW=privGroups.length>0?naclW(rowW(privGroups.length)):0;
          const vpcInnerW=Math.max(pubNaclW,privNaclW,rowW(pubGroups.length),rowW(privGroups.length));
          const pubSectionH=pubGroups.length>0?(hasNacl?pubNaclH:PUB_SUB_H):0;
          const privSectionH=privGroups.length>0?(hasNacl?privNaclH:PRIV_SUB_H):0;
          const vpcInnerH=pubSectionH+(pubGroups.length>0&&privGroups.length>0?GAP:0)+privSectionH;
          const VPC_W=vpcInnerW+P_VPC*2;
          const VPC_H=vpcInnerH+P_VPC*2+LBL;
          const VPC_X=Math.round((CANVAS_CX-VPC_W/2)/10)*10;

          // Outside elements: stack vertically above VPC, centred
          const outsideSorted=[...outsideEls].sort((a,b)=>a.y-b.y);
          const OUTSIDE_STEP=190;
          const VPC_Y=60+outsideSorted.length*OUTSIDE_STEP+(outsideSorted.length>0?GAP:0);

          const newPos={};
          outsideSorted.forEach((oe,i)=>{
            newPos[oe.id]={x:Math.round((CANVAS_CX-EW/2)/10)*10,y:60+i*OUTSIDE_STEP};
          });

          // Place elements in subnets
          const pubNaclX=VPC_X+P_VPC+Math.round((vpcInnerW-pubNaclW)/2);
          const pubNaclY=VPC_Y+P_VPC+LBL;
          const pubSubX0=pubNaclX+(hasNacl?P_NACL:0);
          const pubSubY=pubNaclY+(hasNacl?P_NACL+LBL:0);

          pubGroups.forEach((g,gi)=>{
            const subX=pubSubX0+gi*(SUB_W+GAP);
            g.els.forEach((re,ei)=>{
              newPos[re.id]={
                x:Math.round((subX+P_SUB+P_SG)/10)*10,
                y:Math.round((pubSubY+P_SUB+LBL+ei*(SG_H+GAP)+P_SG+LBL)/10)*10,
              };
            });
          });

          const privNaclX=VPC_X+P_VPC+Math.round((vpcInnerW-privNaclW)/2);
          const privNaclY=pubNaclY+pubSectionH+(pubGroups.length>0?GAP:0);
          const privSubX0=privNaclX+(hasNacl?P_NACL:0);
          const privSubY=privNaclY+(hasNacl?P_NACL+LBL:0);

          privGroups.forEach((g,gi)=>{
            const subX=privSubX0+gi*(SUB_W+GAP);
            g.els.forEach((re,ei)=>{
              newPos[re.id]={
                x:Math.round((subX+P_SUB+P_SG)/10)*10,
                y:Math.round((privSubY+P_SUB+LBL+ei*(SG_H+GAP)+P_SG+LBL)/10)*10,
              };
            });
          });

          // Apply positions
          elements=elements.map((el,i)=>{
            const origId=diagram.elements[i]?.id;
            if(origId&&newPos[origId]) return{...el,...newPos[origId]};
            return el;
          });

          // Build borders
          const nb=[];
          nb.push({id:'_b_vpc',label:vpcBord?.label||'VPC',
            x:VPC_X,y:VPC_Y,width:VPC_W,height:VPC_H,
            color:'#3b82f6',strokeWidth:2,strokeStyle:'solid',borderRadius:8});

          if(pubGroups.length>0){
            if(hasNacl){
              const lbl=hasSeparateNacls
                ?(naclBords.find(n=>/public/i.test(n.label||''))||naclBords[0])?.label||'Public NACL'
                :naclBords[0]?.label||'NACL';
              nb.push({id:'_b_nacl_pub',label:lbl,
                x:pubNaclX,y:pubNaclY,width:pubNaclW,height:pubNaclH,
                color:'#1e293b',strokeWidth:2,strokeStyle:'dashed',borderRadius:6});
            }
            pubGroups.forEach((g,gi)=>{
              const subX=pubSubX0+gi*(SUB_W+GAP);
              nb.push({id:'_b_pub_'+gi,label:g.label,
                x:subX,y:pubSubY,width:SUB_W,height:PUB_SUB_H,
                color:g.color,strokeWidth:2,strokeStyle:'solid',borderRadius:6});
              g.els.forEach((_,ei)=>{
                nb.push({id:'_b_sg_pub_'+gi+'_'+ei,label:g.sgLabels[ei]||'SG',
                  x:subX+P_SUB,y:pubSubY+P_SUB+LBL+ei*(SG_H+GAP),
                  width:SG_W,height:SG_H,
                  color:'#ef4444',strokeWidth:1,strokeStyle:'dashed',borderRadius:4});
              });
            });
          }

          if(privGroups.length>0){
            if(hasNacl&&hasSeparateNacls){
              const lbl=(naclBords.find(n=>/private/i.test(n.label||''))||naclBords[1])?.label||'Private NACL';
              nb.push({id:'_b_nacl_priv',label:lbl,
                x:privNaclX,y:privNaclY,width:privNaclW,height:privNaclH,
                color:'#4b5563',strokeWidth:2,strokeStyle:'dashed',borderRadius:6});
            }
            privGroups.forEach((g,gi)=>{
              const subX=privSubX0+gi*(SUB_W+GAP);
              nb.push({id:'_b_priv_'+gi,label:g.label,
                x:subX,y:privSubY,width:SUB_W,height:PRIV_SUB_H,
                color:g.color,strokeWidth:2,strokeStyle:'solid',borderRadius:6});
              g.els.forEach((_,ei)=>{
                nb.push({id:'_b_sg_priv_'+gi+'_'+ei,label:g.sgLabels[ei]||'SG',
                  x:subX+P_SUB,y:privSubY+P_SUB+LBL+ei*(SG_H+GAP),
                  width:SG_W,height:SG_H,
                  color:'#ef4444',strokeWidth:1,strokeStyle:'dashed',borderRadius:4});
              });
            });
          }

          diagram._computedBorders=nb;
        }
      }catch(engineErr){
        // Engine failed - fall through, use Claude's coordinates as-is
        console.warn('VPC layout engine skipped:',engineErr.message);
      }


      // -- Build idMap after potential position overrides ---------------------
      const idMap={};
      elements.forEach((el,i)=>{ if(diagram.elements[i]?.id) idMap[diagram.elements[i].id]=el.id; });


      // -- Step 6: Build connections (preserve midLabel from Claude) ----------
      const connections=(diagram.connections||[]).map((c,i)=>({
        id:`ai_c_${ts}_${i}`,
        from:idMap[c.from]||c.from,
        to:idMap[c.to]||c.to,
        type:c.type||'arrow',
        bent:!!c.bent,
        color:'#3b82f6',
        strokeWidth:3,
        arrowSize:14,
        midLabel:c.midLabel||null,
      })).filter(c=>c.from&&c.to&&c.from!==c.to);

      // -- Step 7: Borders (use VPC engine output if available) --------------
      let borders;
      if(diagram._computedBorders){
        // VPC layout engine already computed exact borders - use them directly
        borders=diagram._computedBorders;
      } else {
        const rawBorders=(diagram.borders||[]).map((b,i)=>({
          id:b.id||`ai_b_${ts}_${i}`,
          x:Math.round((b.x||50)/10)*10,
          y:Math.round((b.y||50)/10)*10,
          width:b.width||400,
          height:b.height||300,
          color:b.color||'#3b82f6',
          strokeWidth:2,
          strokeStyle:'solid',
          borderRadius:8,
          label:b.label||'',
        }));
        borders=computeAutoGroupBorders(elements,rawBorders,ts,pattern);
      }

      // Null-safe border labels - prevent crash if border has missing fields
      const borderLabels=borders.filter(b=>b&&b.id&&b.label).map((b,i)=>({
        id:`ai_lbl_${ts}_${i}`,
        borderId:b.id,
        text:b.label,
        color:b.color||'#3b82f6',
        manualWidth:null,
        manualHeight:null,
      }));

      // -- Step 8: Bubbles ----------------------------------------------------
      const validBubbleShapes=['speech','rounded','rectangle','textbox','thought','cloud','shout'];
      const bubbles=(diagram.bubbles||[]).map((b,i)=>{
        const bW=Math.max(160,b.w||240);
        const bText=b.text||'';
        return{
          id:b.id||`ai_bbl_${ts}_${i}`,
          x:Math.round((b.x||200+i*240)/10)*10,
          y:Math.round((b.y||200)/10)*10,
          w:bW,
          h:calcBubbleHeight(bText,bW), // dynamic height based on text content
          shape:validBubbleShapes.includes(b.shape)?b.shape:'textbox',
          fillColor:b.fillColor||'#fffbeb',
          strokeColor:b.strokeColor||'#f59e0b',
          strokeWidth:1.5,
          text:bText,
          textColor:b.textColor||'#1e293b',
        };
      }).filter(b=>b.text&&b.text.trim()); // skip empty bubbles

      const bubbleConns=(diagram.bubbles||[])
        .filter(b=>b.connectTo&&b.text&&b.text.trim())
        .map((b,i)=>{
          const bubbleId=b.id||`ai_bbl_${ts}_${i}`;
          const targetId=idMap[b.connectTo]||b.connectTo;
          // Only connect if both endpoints exist - missing target = crash
          const targetEl=elements.find(e=>e.id===targetId);
          const sourceBubble=bubbles.find(bb=>bb.id===bubbleId);
          if(!targetEl||!sourceBubble) return null;
          return{id:`ai_bconn_${ts}_${i}`,from:bubbleId,to:targetId,type:'line',bent:false,color:'#f59e0b',strokeWidth:1.5,arrowSize:10};
        }).filter(Boolean);

      setCredits(c=>c-cost);
      setStatus('done');
      setGenPhase('');

      setTimeout(()=>{
        onGenerate(elements,[...connections,...bubbleConns],borders,diagram.title||'AI Generated Architecture',borderLabels,bubbles);
      },600);

    } catch(e) {
      console.error('AI generation error:',e);
      setStatus('error');
      setGenPhase('');
      setErrorMsg(e.message||'Something went wrong. Please try again.');
    }
  };

  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.65)',zIndex:800,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:cardBg,borderRadius:20,width:'100%',maxWidth:560,maxHeight:'92vh',overflowY:'auto',boxShadow:'0 24px 64px rgba(0,0,0,0.45)'}}>

        {/* Header */}
        <div style={{background:'linear-gradient(135deg,#7c3aed,#2563eb)',borderRadius:'20px 20px 0 0',padding:'20px 22px 18px'}}>
          <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between'}}>
            <div>
              <div style={{fontSize:20,fontWeight:800,color:'#fff',marginBottom:4}}>✨ Generate with AI</div>
              <div style={{fontSize:12,color:'rgba(255,255,255,0.8)'}}>Describe your architecture in plain English</div>
            </div>
            <button onClick={onClose} style={{background:'rgba(255,255,255,0.15)',border:'none',cursor:'pointer',color:'#fff',fontSize:18,lineHeight:1,borderRadius:8,padding:'4px 8px',marginTop:2}}>✕</button>
          </div>
          {/* Tab selector - Generate / Modify */}
          <div style={{display:'flex',gap:4,marginTop:14,background:'rgba(0,0,0,0.2)',borderRadius:10,padding:3,width:'100%'}}>
            <button onClick={()=>setModalTab('generate')}
              style={{flex:1,padding:'7px',borderRadius:8,border:'none',background:modalTab==='generate'?'rgba(255,255,255,0.95)':'transparent',color:modalTab==='generate'?'#7c3aed':'rgba(255,255,255,0.85)',cursor:'pointer',fontSize:12,fontWeight:700,transition:'all 0.15s'}}>
              ✨ Generate
            </button>
            <button onClick={()=>setModalTab('modify')}
              style={{flex:1,padding:'7px',borderRadius:8,border:'none',background:modalTab==='modify'?'rgba(255,255,255,0.95)':'transparent',color:modalTab==='modify'?'#7c3aed':'rgba(255,255,255,0.85)',cursor:'pointer',fontSize:12,fontWeight:700,transition:'all 0.15s',position:'relative'}}>
              🔧 Modify
              {!hasExistingDiagram&&<span style={{fontSize:9,marginLeft:4,opacity:0.7}}>(no diagram)</span>}
            </button>
          </div>
        </div>

        {/* -- MODIFY TAB ------------------------------------------- */}
        {modalTab==='modify'&&(
          <div style={{padding:'20px 22px 24px',display:'flex',flexDirection:'column',gap:14,flex:1,overflowY:'auto'}}>
            {!hasExistingDiagram?(
              <div style={{textAlign:'center',padding:'40px 20px'}}>
                <div style={{fontSize:40,marginBottom:12}}>🎨</div>
                <div style={{fontSize:15,fontWeight:700,color:textC,marginBottom:8}}>No diagram to modify</div>
                <div style={{fontSize:12,color:textMut,lineHeight:1.6,marginBottom:16}}>Generate a diagram first, then come back here to modify it with AI.</div>
                <button onClick={()=>setModalTab('generate')} style={{padding:'9px 20px',borderRadius:9,border:'none',background:accent,color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>
                  ✨ Generate a diagram {'->'}
                </button>
              </div>
            ):(
              <>
                {/* Current diagram summary */}
                <div style={{background:darkMode?'#0f172a':'#f8fafc',borderRadius:10,padding:'10px 14px',border:`1px solid ${borderC}`}}>
                  <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:5}}>Current diagram</div>
                  <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:4}}>{currentTitle||'Untitled Architecture'}</div>
                  <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                    {[[currentElements.length,'service'],[currentConnections.length,'connection'],[currentBorders.length,'group'],[currentBubbles.length,'annotation']].map(([n,lbl])=>(
                      <span key={lbl} style={{fontSize:11,color:textMut}}><span style={{fontWeight:800,color:accent}}>{n}</span> {lbl}{n!==1?'s':''}</span>
                    ))}
                  </div>
                </div>

                {/* Quick action chips */}
                {modifyStatus==='idle'&&(
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:7}}>Quick actions</div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                      {[
                        {label:'➕ Add monitoring',   text:'Add CloudWatch monitoring with alarms for the key services'},
                        {label:'➕ Add WAF',           text:'Add AWS WAF in front of the load balancer or CloudFront'},
                        {label:'➕ Add multi-AZ',     text:'Make the compute tier multi-AZ by duplicating instances across two availability zones'},
                        {label:'➕ Add IAM roles',    text:'Add IAM roles for each compute service with least-privilege permissions'},
                        {label:'🔄 Replace w/ ECS',  text:'Replace the EC2 instances with ECS Fargate tasks'},
                        {label:'🔄 Add redundancy',   text:'Add redundancy and high availability to any single points of failure'},
                        {label:'🔄 Make serverless', text:'Convert the compute tier to serverless using Lambda and API Gateway'},
                        {label:'❌ Remove monitoring',text:'Remove CloudWatch and any monitoring services'},
                      ].map(chip=>(
                        <button key={chip.label} onClick={()=>{setModifyPrompt(chip.text);setTimeout(()=>modifyRef.current?.focus(),50);}}
                          style={{padding:'5px 10px',borderRadius:20,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:11,fontWeight:600,whiteSpace:'nowrap',transition:'all 0.12s'}}
                          onMouseOver={e=>{e.currentTarget.style.background=accent+'14';e.currentTarget.style.borderColor=accent;e.currentTarget.style.color=accent;}}
                          onMouseOut={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.borderColor=borderC;e.currentTarget.style.color=textC;}}>
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Modification textarea */}
                {(modifyStatus==='idle'||modifyStatus==='error')&&(
                  <div>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
                      <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em'}}>
                        Instruction
                      </label>
                      {modifyPrompt.length>5&&(
                        <span style={{fontSize:10,color:accent,fontWeight:700,padding:'2px 8px',borderRadius:20,background:accent+'14'}}>
                          {classifyModification(modifyPrompt)==='subtractive'?'❌ Remove':classifyModification(modifyPrompt)==='replacement'?'🔄 Replace':classifyModification(modifyPrompt)==='structural'?'📐 Reorganise':'➕ Add / Modify'}
                        </span>
                      )}
                    </div>
                    <textarea ref={modifyRef} value={modifyPrompt} onChange={e=>setModifyPrompt(e.target.value)}
                      onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&canModify){e.preventDefault();modify();}}}
                      placeholder="e.g. Replace the EC2 instances with ECS Fargate tasks&#10;e.g. Remove the NAT Gateway&#10;e.g. Add IAM roles for each service"
                      rows={4} disabled={modifyStatus==='generating'}
                      style={{width:'100%',padding:'11px 13px',borderRadius:10,border:`1.5px solid ${modifyPrompt.length>5?accent:borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:13,resize:'vertical',outline:'none',fontFamily:'inherit',lineHeight:1.6,boxSizing:'border-box',transition:'border-color 0.2s'}}
                    />
                    <div style={{fontSize:10,color:textMut,marginTop:4,display:'flex',justifyContent:'space-between'}}>
                      <span>Supports: Add · Remove · Replace · Reorganise</span>
                      <span style={{opacity:0.7}}>⌘↵ to apply</span>
                    </div>
                  </div>
                )}

                {/* Error */}
                {modifyStatus==='error'&&(
                  <div style={{padding:'12px 14px',borderRadius:10,background:'#fee2e2',border:'1px solid #fca5a5'}}>
                    <div style={{fontSize:12,fontWeight:700,color:'#991b1b',marginBottom:4}}>Modification failed</div>
                    <div style={{fontSize:11,color:'#b91c1c',lineHeight:1.5,marginBottom:8}}>{modifyErrorMsg}</div>
                    <button onClick={()=>setModifyStatus('idle')} style={{padding:'4px 10px',borderRadius:6,border:'1px solid #f87171',background:'transparent',color:'#dc2626',cursor:'pointer',fontSize:11,fontWeight:600}}>Try Again</button>
                  </div>
                )}

                {/* Generating */}
                {modifyStatus==='generating'&&(
                  <div style={{textAlign:'center',padding:'20px 0'}}>
                    <div style={{width:36,height:36,border:'3.5px solid rgba(124,58,237,0.2)',borderTop:'3.5px solid #7c3aed',borderRadius:'50%',animation:'spin 0.8s linear infinite',margin:'0 auto 12px'}}/>
                    <div style={{fontSize:14,fontWeight:700,color:textC,marginBottom:4}}>
                      {modifyPhase==='analysing'?'Reading diagram…':'Applying changes…'}
                    </div>
                    <div style={{fontSize:11,color:textMut,marginBottom:14}}>
                      {modifyPhase==='analysing'?'Analysing current architecture state':'Claude is modifying your diagram'}
                    </div>
                    <div style={{height:5,borderRadius:3,background:darkMode?'#374151':'#e5e7eb',overflow:'hidden',maxWidth:260,margin:'0 auto'}}>
                      <div style={{height:'100%',borderRadius:3,background:'linear-gradient(90deg,#7c3aed,#6366f1)',width:modifyPhase==='analysing'?'30%':'85%',transition:'width 0.7s ease'}}/>
                    </div>
                  </div>
                )}

                {/* Success - modify again flow */}
                {modifyStatus==='done'&&(
                  <div>
                    <div style={{textAlign:'center',padding:'12px 0 16px',background:darkMode?'rgba(16,185,129,0.08)':'#f0fdf4',borderRadius:10,border:'1px solid #bbf7d0',marginBottom:4}}>
                      <div style={{fontSize:18,marginBottom:6}}>✅</div>
                      <div style={{fontSize:13,fontWeight:700,color:'#065f46',marginBottom:4}}>Diagram modified!</div>
                      {lastModifyPrompt&&<div style={{fontSize:11,color:'#047857',fontStyle:'italic',padding:'0 16px'}}>"{lastModifyPrompt.length>60?lastModifyPrompt.slice(0,60)+'…':lastModifyPrompt}"</div>}
                    </div>
                    <div style={{display:'flex',gap:8,marginTop:10}}>
                      <button onClick={()=>{setModifyStatus('idle');setModifyPrompt('');}}
                        style={{flex:1,padding:'11px',borderRadius:10,border:'none',background:'linear-gradient(135deg,#7c3aed,#6366f1)',color:'#fff',cursor:'pointer',fontSize:13,fontWeight:700}}>
                        🔧 Modify again
                      </button>
                      <button onClick={onClose}
                        style={{flex:1,padding:'11px',borderRadius:10,border:`1.5px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:13,fontWeight:700}}>
                        ✓ Done
                      </button>
                    </div>
                  </div>
                )}

                {/* Apply button */}
                {modifyStatus==='idle'&&(
                  <button onClick={modify} disabled={!canModify}
                    style={{padding:'13px',borderRadius:12,border:'none',background:canModify?'linear-gradient(135deg,#7c3aed,#6366f1)':'#9ca3af',color:'#fff',cursor:canModify?'pointer':'not-allowed',fontSize:14,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',gap:8,boxShadow:canModify?'0 4px 20px rgba(124,58,237,0.4)':'none',transition:'all 0.2s'}}>
                    🔧 Apply Modification · 2 credits
                  </button>
                )}

                <div style={{fontSize:10,color:textMut,textAlign:'center',lineHeight:1.5}}>
                  Saved to undo history before each modification · Press ↺ to revert
                </div>
              </>
            )}
          </div>
        )}

        {/* -- GENERATE TAB ------------------------------------------ */}
        {modalTab==='generate'&&(
        <div style={{padding:'20px 22px 24px',display:'flex',flexDirection:'column',gap:16}}>

          {/* Provider selector */}
          <div>
            <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:7}}>Cloud Provider</label>
            <div style={{display:'flex',gap:8}}>
              {CLOUD_PROVIDERS.map(p=>(
                <button key={p.id} onClick={()=>setActiveProvider(p.id)}
                  style={{flex:1,padding:'8px 6px',borderRadius:9,border:`2px solid ${activeProvider===p.id?p.color:borderC}`,background:activeProvider===p.id?p.color+'14':'transparent',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:3,transition:'all 0.15s'}}>
                  <span style={{fontSize:20}}>{p.logo}</span>
                  <span style={{fontSize:10,fontWeight:700,color:activeProvider===p.id?p.color:textMut}}>{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Prompt input */}
          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:7}}>
              <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em'}}>Describe your architecture</label>
              <button onClick={()=>setShowExample(s=>!s)} style={{background:'none',border:'none',cursor:'pointer',fontSize:11,color:accent,fontWeight:600}}>
                {showExample?'Hide examples':'See examples'}
              </button>
            </div>
            {showExample&&(
              <div style={{marginBottom:10,display:'flex',flexDirection:'column',gap:4,background:darkMode?'#0f172a':'#f8fafc',borderRadius:10,padding:'8px 10px',border:`1px solid ${borderC}`}}>
                {EXAMPLE_PROMPTS.map((ex,i)=>(
                  <button key={i} onClick={()=>{setPrompt(ex);setShowExample(false);textRef.current?.focus();}}
                    style={{textAlign:'left',padding:'5px 8px',borderRadius:6,border:'none',background:'transparent',cursor:'pointer',fontSize:11,color:textC,lineHeight:1.5}}
                    onMouseOver={e=>e.currentTarget.style.background=darkMode?'#1e2a3a':'#e8f0fe'}
                    onMouseOut={e=>e.currentTarget.style.background='transparent'}>
                    {'-> '}{ex}
                  </button>
                ))}
              </div>
            )}
            <textarea ref={textRef} value={prompt} onChange={e=>setPrompt(e.target.value)}
              placeholder="e.g. A VPC with 2 public and 2 private subnets, an internet gateway, NAT gateway, and EC2 instances..."
              rows={5} disabled={status==='generating'}
              style={{width:'100%',padding:'11px 13px',borderRadius:10,border:`1.5px solid ${prompt.length>10?accent:borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:13,resize:'vertical',outline:'none',fontFamily:'inherit',lineHeight:1.6,boxSizing:'border-box',transition:'border-color 0.2s'}}
            />
            <div style={{fontSize:10,color:prompt.length>10?'#10b981':textMut,marginTop:4,textAlign:'right',fontWeight:600}}>
              {prompt.length<10?`${10-prompt.length} more characters needed`:'✓ Ready to generate'}
            </div>
          </div>

          {/* Complexity selector */}
          <div>
            <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:7}}>Diagram Detail Level</label>
            <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
              {[
                {id:'simple',   label:'Simple',   desc:'4-8 elements',   cost:1, icon:'⚡'},
                {id:'standard', label:'Standard', desc:'8-16 elements',  cost:2, icon:'⚡⚡'},
                {id:'detailed', label:'Detailed', desc:'12-24 elements', cost:3, icon:'⚡⚡⚡'},
              ].map(opt=>(
                <button key={opt.id} onClick={()=>setComplexity(opt.id)}
                  style={{padding:'10px 8px',borderRadius:10,border:`2px solid ${complexity===opt.id?accent:borderC}`,background:complexity===opt.id?accent+'12':'transparent',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:4,transition:'all 0.15s'}}>
                  <span style={{fontSize:14}}>{opt.icon}</span>
                  <span style={{fontSize:12,fontWeight:700,color:complexity===opt.id?accent:textC}}>{opt.label}</span>
                  <span style={{fontSize:10,color:textMut}}>{opt.desc}</span>
                  <span style={{fontSize:10,fontWeight:700,color:accent}}>{opt.cost} credit{opt.cost>1?'s':''}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Error message */}
          {status==='error'&&(
            <div style={{padding:'10px 13px',borderRadius:9,background:'#fee2e2',border:'1px solid #fca5a5',fontSize:12,color:'#991b1b',lineHeight:1.5}}>
              ⚠️ {errorMsg}
            </div>
          )}

          {/* Generate button */}
          <button onClick={generate} disabled={!canGenerate}
            style={{padding:'14px',borderRadius:12,border:'none',background:canGenerate?'linear-gradient(135deg,#7c3aed,#2563eb)':'#9ca3af',color:'#fff',cursor:canGenerate?'pointer':'not-allowed',fontSize:15,fontWeight:800,display:'flex',alignItems:'center',justifyContent:'center',gap:10,boxShadow:canGenerate?'0 4px 20px rgba(124,58,237,0.4)':'none',transition:'all 0.2s',position:'relative',overflow:'hidden'}}>
            {status==='generating'?(
              <>
                <div style={{width:18,height:18,border:'2.5px solid rgba(255,255,255,0.3)',borderTop:'2.5px solid #fff',borderRadius:'50%',animation:'spin 0.8s linear infinite'}}/>
                {genPhase==='planning'?'Planning architecture…':'Generating diagram…'}
              </>
            ):status==='done'?(
              <>✅ Done! Loading diagram...</>
            ):(
              <>✨ Generate Diagram · {cost} credit{cost>1?'s':''}</>
            )}
          </button>
          {/* Two-phase progress indicator */}
          {status==='generating'&&(
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <div style={{flex:1,height:4,borderRadius:2,background:darkMode?'#374151':'#e5e7eb',overflow:'hidden'}}>
                <div style={{height:'100%',borderRadius:2,background:'linear-gradient(90deg,#7c3aed,#2563eb)',width:genPhase==='planning'?'40%':genPhase==='generating'?'85%':'10%',transition:'width 0.5s ease'}}/>
              </div>
              <span style={{fontSize:10,color:textMut,fontWeight:600,whiteSpace:'nowrap',minWidth:80}}>
                {genPhase==='planning'?'Step 1 of 2':'Step 2 of 2'}
              </span>
            </div>
          )}

          {/* Credit warning */}
          {credits<cost&&status==='idle'&&(
            <div style={{textAlign:'center',fontSize:12,color:'#ef4444',fontWeight:600}}>
              Not enough credits. Upgrade your plan to get more credits each month.
            </div>
          )}

          {/* Footer note */}
          <div style={{fontSize:11,color:textMut,textAlign:'center',lineHeight:1.6}}>
            AI may not place elements perfectly. Use the canvas tools to rearrange after generation.
            Credits reset on the 1st of each month.
          </div>
        </div>
        )} {/* end generate tab */}
        <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
      </div>
    </div>
  );
}

// --- CustomServiceModal --------------------------------------------------------
const CUSTOM_SVC_ICONS = [
  {g:'Smileys',  icons:['😀','😎','🤖','👾','🦾','🧠','👁️','🎯','🔮','💡']},
  {g:'Tech',     icons:['💻','🖥️','📱','⌨️','🖱️','🖨️','📡','📺','🔌','🔋']},
  {g:'Cloud',    icons:['☁️','⛅','🌤️','🌩️','🌪️','❄️','🌊','🔥','⚡','🌐']},
  {g:'Data',     icons:['🗄️','💾','💿','📀','📊','📈','📉','🗂️','📁','📂']},
  {g:'Security', icons:['🔐','🔒','🔓','🛡️','🔑','🗝️','⛔','🚫','✅','❌']},
  {g:'Network',  icons:['🌍','🌎','🌏','📡','🛰️','🔗','⛓️','🕸️','📶','📻']},
  {g:'Dev',      icons:['💻','⚙️','🔧','🔨','🛠️','🔩','🔬','🧪','📝','📋']},
  {g:'Symbols',  icons:['⭐','✨','💫','🔥','💥','🎯','🎪','🎨','🎭','🎬']},
  {g:'Letters',  icons:['λ','α','β','Ω','∑','∞','π','δ','Φ','Ψ']},
  {g:'Shapes',   icons:['⬡','⬢','◆','◇','▲','△','●','○','■','[ ]']},
];

const CUSTOM_SVC_COLORS = [
  {label:'AWS Orange',    value:'#FF9900'},
  {label:'GCP Blue',     value:'#4285F4'},
  {label:'Azure Blue',   value:'#0078D4'},
  {label:'Purple',       value:'#7c3aed'},
  {label:'Green',        value:'#059669'},
  {label:'Red',          value:'#dc2626'},
  {label:'Teal',         value:'#0891b2'},
  {label:'Pink',         value:'#db2777'},
  {label:'Slate',        value:'#475569'},
  {label:'Dark',         value:'#1e293b'},
];

function CustomServiceModal({darkMode,provider,onAdd,onClose}) {
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent='#2563eb';

  const [name,setName]=useState('');
  const [desc,setDesc]=useState('');
  const [category,setCategory]=useState('Compute');
  const [selectedIcon,setSelectedIcon]=useState('⚙️');
  const [selectedColor,setSelectedColor]=useState('#FF9900');
  const [iconSearch,setIconSearch]=useState('');
  const [iconTab,setIconTab]=useState('pick'); // 'pick' | 'emoji'
  const [emojiInput,setEmojiInput]=useState('');
  const [customEmoji,setCustomEmoji]=useState('');
  const nameRef=useRef(null);

  useEffect(()=>{ setTimeout(()=>nameRef.current?.focus(),100); },[]);

  const activeIcon=iconTab==='emoji'&&customEmoji?customEmoji:selectedIcon;

  const allFlatIcons=CUSTOM_SVC_ICONS.flatMap(g=>g.icons.map(ic=>({icon:ic,group:g.g})));
  const filteredIcons=iconSearch
    ?allFlatIcons.filter(i=>i.icon.includes(iconSearch)||i.group.toLowerCase().includes(iconSearch.toLowerCase()))
    :allFlatIcons;

  const CATEGORIES=['Compute','Storage','Database','Networking','Security','Developer','Messaging','Monitoring','AI/ML','Analytics','Other'];

  const handleAdd=()=>{
    if(!name.trim()) return;
    const newSvc={
      id:'custom_'+Date.now(),
      name:name.trim(),
      desc:desc.trim()||'Custom service',
      category,
      color:selectedColor,
      icon:activeIcon,
      provider,
      custom:true,
    };
    onAdd(newSvc);
    onClose();
  };

  return (
    <div onClick={e=>{if(e.target===e.currentTarget)onClose();}} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',zIndex:700,display:'flex',alignItems:'center',justifyContent:'center',padding:16}}>
      <div style={{background:cardBg,borderRadius:18,width:'100%',maxWidth:500,maxHeight:'90vh',overflowY:'auto',boxShadow:'0 20px 60px rgba(0,0,0,0.4)'}}>

        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 20px 0'}}>
          <div>
            <div style={{fontSize:16,fontWeight:800,color:textC}}>Add Custom Service</div>
            <div style={{fontSize:11,color:textMut,marginTop:2}}>Create a service not in the built-in list</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:22,lineHeight:1}}>x</button>
        </div>

        <div style={{padding:'16px 20px 24px',display:'flex',flexDirection:'column',gap:14}}>

          {/* Preview */}
          <div style={{display:'flex',alignItems:'center',justifyContent:'center',padding:'16px 0 8px'}}>
            <div style={{width:90,height:90,borderRadius:16,background:selectedColor,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:4,boxShadow:'0 4px 20px rgba(0,0,0,0.2)',border:'3px solid #1e293b'}}>
              <span style={{fontSize:32,lineHeight:1}}>{activeIcon}</span>
              <span style={{fontSize:10,fontWeight:700,color:'#fff',maxWidth:80,textAlign:'center',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{name||'Service Name'}</span>
            </div>
          </div>

          {/* Name */}
          <div>
            <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5}}>Service Name *</label>
            <input ref={nameRef} value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Amazon Bedrock"
              onKeyDown={e=>{if(e.key==='Enter'&&name.trim())handleAdd();}}
              style={{width:'100%',padding:'9px 12px',borderRadius:8,border:`1.5px solid ${name?accent:borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:13,boxSizing:'border-box',outline:'none',fontFamily:'inherit'}}/>
          </div>

          {/* Description */}
          <div>
            <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5}}>Description <span style={{fontWeight:400,textTransform:'none'}}>(optional)</span></label>
            <input value={desc} onChange={e=>setDesc(e.target.value)} placeholder="e.g. Generative AI foundation models"
              style={{width:'100%',padding:'9px 12px',borderRadius:8,border:`1.5px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:13,boxSizing:'border-box',outline:'none',fontFamily:'inherit'}}/>
          </div>

          {/* Category */}
          <div>
            <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5}}>Category</label>
            <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
              {CATEGORIES.map(cat=>(
                <button key={cat} onClick={()=>setCategory(cat)}
                  style={{padding:'5px 10px',borderRadius:20,border:`1.5px solid ${category===cat?accent:borderC}`,background:category===cat?accent:'transparent',color:category===cat?'#fff':textMut,cursor:'pointer',fontSize:11,fontWeight:600}}>
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {/* Color */}
          <div>
            <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5}}>Color</label>
            <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
              {CUSTOM_SVC_COLORS.map(c=>(
                <button key={c.value} onClick={()=>setSelectedColor(c.value)} title={c.label}
                  style={{width:28,height:28,borderRadius:7,background:c.value,border:selectedColor===c.value?'3px solid '+textC:'2px solid transparent',cursor:'pointer',flexShrink:0,transition:'transform 0.1s'}}
                  onMouseOver={e=>e.currentTarget.style.transform='scale(1.15)'}
                  onMouseOut={e=>e.currentTarget.style.transform='scale(1)'}/>
              ))}
              {/* Custom hex input */}
              <div style={{display:'flex',alignItems:'center',gap:4}}>
                <div style={{width:28,height:28,borderRadius:7,background:selectedColor,border:'2px solid '+borderC,flexShrink:0}}/>
                <input value={selectedColor} onChange={e=>setSelectedColor(e.target.value)} placeholder="#hex"
                  style={{width:72,padding:'4px 6px',borderRadius:6,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:11,fontFamily:'monospace'}}/>
              </div>
            </div>
          </div>

          {/* Icon picker */}
          <div>
            <label style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',display:'block',marginBottom:5}}>Icon</label>
            {/* Tabs */}
            <div style={{display:'flex',gap:0,marginBottom:8,borderRadius:8,overflow:'hidden',border:`1px solid ${borderC}`}}>
              {[['pick','Pick Emoji'],['emoji','Type / Paste']].map(([id,lbl])=>(
                <button key={id} onClick={()=>setIconTab(id)}
                  style={{flex:1,padding:'6px',border:'none',background:iconTab===id?accent:'transparent',color:iconTab===id?'#fff':textMut,cursor:'pointer',fontSize:11,fontWeight:600}}>
                  {lbl}
                </button>
              ))}
            </div>

            {iconTab==='pick'&&(<>
              <div style={{position:'relative',marginBottom:7}}>
                <Search size={11} style={{position:'absolute',left:7,top:8,color:'#9ca3af'}}/>
                <input value={iconSearch} onChange={e=>setIconSearch(e.target.value)} placeholder="Search icons…"
                  style={{width:'100%',paddingLeft:22,paddingRight:7,paddingTop:5,paddingBottom:5,borderRadius:6,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:11,boxSizing:'border-box'}}/>
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(8,1fr)',gap:4,maxHeight:160,overflowY:'auto',padding:2}}>
                {filteredIcons.map((ic,i)=>(
                  <button key={i} onClick={()=>setSelectedIcon(ic.icon)}
                    style={{padding:'6px 2px',borderRadius:7,border:`1.5px solid ${selectedIcon===ic.icon?accent:borderC}`,background:selectedIcon===ic.icon?accent+'18':'transparent',cursor:'pointer',fontSize:20,display:'flex',alignItems:'center',justifyContent:'center',transition:'all 0.1s'}}
                    title={ic.group}>
                    {ic.icon}
                  </button>
                ))}
              </div>
            </>)}

            {iconTab==='emoji'&&(
              <div>
                <div style={{fontSize:11,color:textMut,marginBottom:8,lineHeight:1.5}}>
                  Type any emoji, letter, or symbol. On iPhone: press 🌐 on keyboard for emoji picker.
                </div>
                <div style={{display:'flex',gap:10,alignItems:'center'}}>
                  <input value={emojiInput} onChange={e=>{setEmojiInput(e.target.value);setCustomEmoji(e.target.value.trim().slice(0,4));}}
                    placeholder="Type emoji or text…" maxLength={4}
                    style={{flex:1,padding:'10px 12px',borderRadius:8,border:`1.5px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:22,textAlign:'center',outline:'none',fontFamily:'inherit'}}/>
                  <div style={{width:52,height:52,borderRadius:10,background:selectedColor,display:'flex',alignItems:'center',justifyContent:'center',fontSize:26,border:'2px solid '+borderC}}>
                    {customEmoji||selectedIcon}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div style={{display:'flex',gap:10,paddingTop:4}}>
            <button onClick={onClose} style={{flex:1,padding:'11px',borderRadius:10,border:`1.5px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:13,fontWeight:600}}>
              Cancel
            </button>
            <button onClick={handleAdd} disabled={!name.trim()}
              style={{flex:2,padding:'11px',borderRadius:10,border:'none',background:name.trim()?accent:'#9ca3af',color:'#fff',cursor:name.trim()?'pointer':'not-allowed',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
              <Plus size={14}/> Add to Services
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- MobileElSheet - shape/color picker bottom sheet for selected element -----
function MobileElSheet({el,accent,textC,textMut,cardBg,borderC,updateEl,onDelete,onRename,onClose}) {
  return (
    <div style={{position:'absolute',bottom:52,left:0,right:0,zIndex:160,background:cardBg,borderTop:`2px solid ${accent}`,borderRadius:'14px 14px 0 0',boxShadow:'0 -4px 24px rgba(0,0,0,0.18)',padding:'14px 16px 12px',maxHeight:'55vh',overflowY:'auto',animation:'slideUpPanel 0.22s ease-out'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
        <span style={{fontSize:13,fontWeight:700,color:textC}}>Service Style</span>
        <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:18,lineHeight:1}}>✕</button>
      </div>
      {/* Shape grid */}
      <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Shape</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:5,marginBottom:12}}>
        {ELEMENT_SHAPES.map(s=>(
          <button key={s.id} onClick={()=>updateEl(el.id,{shape:s.id})}
            style={{padding:'7px 2px',borderRadius:8,border:`1.5px solid ${(el.shape||'rounded')===s.id?accent:'#d1d5db'}`,background:(el.shape||'rounded')===s.id?accent+'18':'transparent',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:3}}
            title={s.label}>
            <span style={{fontSize:20,lineHeight:1}}>{s.icon}</span>
            <span style={{fontSize:8,fontWeight:700,color:(el.shape||'rounded')===s.id?accent:textMut}}>{s.label}</span>
          </button>
        ))}
      </div>
      {/* Color row */}
      <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Color</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:12}}>
        <button onClick={()=>updateEl(el.id,{customColor:null})} title="Default"
          style={{width:28,height:28,borderRadius:7,background:el.service.color,border:!el.customColor?'3px solid #fbbf24':'2px solid transparent',cursor:'pointer',flexShrink:0}}/>
        {COLOR_PALETTE.map(c=>(
          <button key={c} onClick={()=>updateEl(el.id,{customColor:c})}
            style={{width:28,height:28,borderRadius:7,background:c,border:el.customColor===c?'3px solid #fbbf24':c==='#ffffff'?'2px solid #d1d5db':'2px solid transparent',cursor:'pointer',flexShrink:0}}/>
        ))}
      </div>
      {/* Actions */}
      <div style={{display:'flex',gap:8}}>
        <button onClick={()=>{onRename(el.id);onClose();}} style={{flex:1,padding:'8px',borderRadius:8,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:12,fontWeight:600}}>✏️ Rename</button>
        <button onClick={()=>{onDelete();onClose();}} style={{flex:1,padding:'8px',borderRadius:8,border:'1px solid #ef4444',background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:12,fontWeight:600}}>🗑 Delete</button>
      </div>
    </div>
  );
}

// --- Mobile bottom-sheet sub-components --------------------------------------
function MobileConnSheet({conn,accent,textC,textMut,cardBg,onClose,updateConn,save,setConnections,selectedConn,setSelectedConn}) {
  return (
    <div style={{position:'absolute',bottom:52,left:0,right:0,zIndex:160,background:cardBg,borderTop:`2px solid ${accent}`,borderRadius:'14px 14px 0 0',boxShadow:'0 -4px 24px rgba(0,0,0,0.18)',maxHeight:'82vh',display:'flex',flexDirection:'column',animation:'slideUpPanel 0.22s ease-out'}}>
      {/* Fixed header with close button - always visible */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 16px 10px',borderBottom:`1px solid rgba(0,0,0,0.06)`,flexShrink:0}}>
        <span style={{fontSize:13,fontWeight:700,color:textC}}>Connection Style</span>
        <button onClick={onClose} style={{background:accent,border:'none',cursor:'pointer',color:'#fff',fontSize:13,lineHeight:1,padding:'5px 14px',borderRadius:8,fontWeight:700}}>Done ✓</button>
      </div>
      {/* Scrollable body */}
      <div style={{overflowY:'auto',flex:1,padding:'10px 16px 20px'}}>
      <div style={{display:'flex',gap:8,marginBottom:10}}>
        <div style={{flex:1}}>
          <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:4}}>TYPE</div>
          <div style={{display:'flex',gap:4}}>
            {[['arrow','-> Arrow'],['line','- Line']].map(([t,lbl])=>(
              <button key={t} onClick={()=>updateConn(conn.id,{type:t})} style={{flex:1,padding:'5px 4px',borderRadius:6,border:`1.5px solid ${conn.type===t?accent:'#d1d5db'}`,background:conn.type===t?accent:'transparent',color:conn.type===t?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>{lbl}</button>
            ))}
          </div>
        </div>
        <div style={{flex:1}}>
          <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:4}}>PATH</div>
          <div style={{display:'flex',gap:4}}>
            {[[null,'Straight'],[true,'Bent'],['curve','Curve']].map(([val,lbl])=>{
              const active=val==='curve'?conn.pathStyle==='curve':val===true?conn.bent&&conn.pathStyle!=='curve':!conn.bent&&conn.pathStyle!=='curve';
              return <button key={String(val)} onClick={()=>updateConn(conn.id,val==='curve'?{pathStyle:'curve',bent:false}:val===true?{bent:true,pathStyle:null}:{bent:false,pathStyle:null})}
                style={{flex:1,padding:'5px 4px',borderRadius:6,border:`1.5px solid ${active?accent:'#d1d5db'}`,background:active?accent:'transparent',color:active?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>{lbl}</button>;
            })}
          </div>
        </div>
      </div>

      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>THICKNESS</div>
      <div style={{display:'flex',gap:4,marginBottom:6}}>
        {[['Thin',1],['Normal',3],['Thick',6],['XL',10]].map(([lbl,w])=>(
          <button key={lbl} onClick={()=>updateConn(conn.id,{strokeWidth:w})}
            style={{flex:1,padding:'5px 2px',borderRadius:6,border:`1.5px solid ${(conn.strokeWidth||3)===w?accent:'#d1d5db'}`,background:(conn.strokeWidth||3)===w?accent:'transparent',color:(conn.strokeWidth||3)===w?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>
            {lbl}
          </button>
        ))}
      </div>
      <SliderRow label="Custom Width" value={conn.strokeWidth||3} min={1} max={20} onChange={v=>updateConn(conn.id,{strokeWidth:v})} textMut={textMut} textC={textC}/>

      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>LINE STYLE</div>
      <div style={{display:'flex',gap:4,marginBottom:8}}>
        {[['Solid',null],['Dashed','dashed'],['Dotted','dotted']].map(([lbl,val])=>(
          <button key={lbl} onClick={()=>updateConn(conn.id,{dashStyle:val,animated:false})}
            style={{flex:1,padding:'5px 2px',borderRadius:6,border:`1.5px solid ${(conn.dashStyle||null)===val?accent:'#d1d5db'}`,background:(conn.dashStyle||null)===val?accent:'transparent',color:(conn.dashStyle||null)===val?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>
            {lbl}
          </button>
        ))}
      </div>

      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 10px',borderRadius:8,border:`1px solid ${accent}22`,background:`${accent}08`,marginBottom:8}}>
        <div>
          <div style={{fontSize:11,fontWeight:700,color:textC}}>Animated Dashes</div>
          <div style={{fontSize:10,color:textMut}}>Flowing dashes on this connection</div>
        </div>
        <button onClick={()=>updateConn(conn.id,{animated:!conn.animated,dashStyle:null,animation:null})}
          style={{width:38,height:21,borderRadius:11,border:'none',background:conn.animated?accent:'#d1d5db',cursor:'pointer',position:'relative',flexShrink:0}}>
          <span style={{position:'absolute',top:2,left:conn.animated?18:2,width:17,height:17,borderRadius:'50%',background:'#fff',transition:'left 0.2s',display:'block'}}/>
        </button>
      </div>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>CONNECTION ANIMATION</div>
      <div style={{display:'flex',gap:4,marginBottom:8,flexWrap:'wrap'}}>
        {[[null,'None'],[' pulse','Pulse 💓'],['colorshift','Colors 🎨']].map(([val,lbl])=>(
          <button key={String(val)} onClick={()=>updateConn(conn.id,{animation:val,animated:false})}
            style={{flex:1,padding:'5px 4px',borderRadius:7,border:`1.5px solid ${(conn.animation||null)===val?accent:'#d1d5db'}`,background:(conn.animation||null)===val?accent:'transparent',color:(conn.animation||null)===val?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700,minWidth:60}}>
            {lbl}
          </button>
        ))}
      </div>

      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>COLOR</div>
      <ColorGrid value={conn.color||'#3b82f6'} onChange={c=>updateConn(conn.id,{color:c})}/>
      {conn.type==='arrow'&&<SliderRow label="Arrow Size" value={conn.arrowSize||14} min={6} max={44} onChange={v=>updateConn(conn.id,{arrowSize:v})}/>}
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5,marginTop:6}}>LINE LABEL</div>
      <input value={conn.midLabel||''} onChange={e=>updateConn(conn.id,{midLabel:e.target.value})} placeholder="e.g. HTTPS 443, TCP 3306"
        style={{width:'100%',padding:'7px 10px',borderRadius:7,border:`1px solid #d1d5db`,background:cardBg,color:textC,fontSize:12,boxSizing:'border-box',marginBottom:8,fontFamily:'monospace'}}/>
      <button onClick={()=>{save();setConnections(p=>p.filter(c=>c.id!==selectedConn));setSelectedConn(null);}} style={{width:'100%',marginTop:4,padding:'8px',background:'#ef4444',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700}}>Delete Connection</button>
      </div>{/* end scrollable body */}
    </div>
  );
}

function MobileBorderSheet({b,accent,textC,textMut,cardBg,borderC,onClose,updateBorder,save,setBorders,setLabels,selectedBorder,setSelectedBorder}) {
  return (
    <div style={{position:'absolute',bottom:52,left:0,right:0,zIndex:160,background:cardBg,borderTop:'2px solid #7c3aed',borderRadius:'14px 14px 0 0',boxShadow:'0 -4px 24px rgba(0,0,0,0.18)',maxHeight:'82vh',display:'flex',flexDirection:'column',animation:'slideUpPanel 0.22s ease-out'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 16px 10px',borderBottom:'1px solid rgba(0,0,0,0.06)',flexShrink:0}}>
        <span style={{fontSize:13,fontWeight:700,color:textC}}>Border Style</span>
        <button onClick={onClose} style={{background:'#7c3aed',border:'none',cursor:'pointer',color:'#fff',fontSize:13,padding:'5px 14px',borderRadius:8,fontWeight:700}}>Done ✓</button>
      </div>
      <div style={{overflowY:'auto',flex:1,padding:'10px 16px 20px'}}>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>STROKE COLOR</div>
      <ColorGrid value={b.color} onChange={c=>updateBorder(b.id,{color:c})}/>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5,marginTop:8}}>FILL COLOR</div>
      <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:4}}>
        <button onClick={()=>updateBorder(b.id,{fillColor:'transparent'})} style={{padding:'4px 8px',borderRadius:6,border:`1.5px solid ${!b.fillColor||b.fillColor==='transparent'?accent:'#d1d5db'}`,background:!b.fillColor||b.fillColor==='transparent'?accent:'transparent',color:!b.fillColor||b.fillColor==='transparent'?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>None</button>
        <input type="color" value={b.fillColor&&b.fillColor!=='transparent'?b.fillColor:'#8b5cf6'} onChange={e=>updateBorder(b.id,{fillColor:e.target.value})} style={{width:32,height:28,borderRadius:6,border:`1px solid ${borderC}`,cursor:'pointer',padding:0}}/>
        <span style={{fontSize:10,color:textMut}}>Opacity: {Math.round((b.fillOpacity||0.08)*100)}%</span>
      </div>
      <input type="range" min={2} max={40} value={Math.round((b.fillOpacity||0.08)*100)} onChange={e=>updateBorder(b.id,{fillOpacity:Number(e.target.value)/100})} style={{width:'100%',accentColor:accent,marginBottom:8}}/>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>LINE STYLE</div>
      <div style={{display:'flex',gap:4,marginBottom:8}}>
        {['solid','dashed','dotted'].map(s=>(
          <button key={s} onClick={()=>updateBorder(b.id,{strokeStyle:s})} style={{flex:1,padding:'5px',borderRadius:6,border:`1.5px solid ${(b.strokeStyle||'solid')===s?accent:'#d1d5db'}`,background:(b.strokeStyle||'solid')===s?accent:'transparent',color:(b.strokeStyle||'solid')===s?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700,textTransform:'capitalize'}}>{s}</button>
        ))}
      </div>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>CORNERS</div>
      <div style={{display:'flex',gap:4,marginBottom:8}}>
        {[['Sharp',0],['Rounded',14],['Pill',32]].map(([lbl,r])=>(
          <button key={r} onClick={()=>updateBorder(b.id,{borderRadius:r})} style={{flex:1,padding:'5px',borderRadius:6,border:`1.5px solid ${(b.borderRadius||0)===r?accent:'#d1d5db'}`,background:(b.borderRadius||0)===r?accent:'transparent',color:(b.borderRadius||0)===r?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>{lbl}</button>
        ))}
      </div>
      <SliderRow label="Stroke Width" value={b.strokeWidth||2} min={1} max={10} onChange={v=>updateBorder(b.id,{strokeWidth:v})} textMut={textMut} textC={textC}/>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5,marginTop:6}}>BORDER ANIMATION</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:8}}>
        {[
          [null,'None','⬜'],
          ['pulse','Pulse','💓'],
          ['glow','Glow','✨'],
          ['march','Ants','🐜'],
          ['chase','Chase','⚡'],
          ['corners','Corners','✦'],
          ['colorshift','Colors','🎨'],
          ['rainbow','Rainbow','🌈'],
        ].map(([val,lbl,ic])=>(
          <button key={String(val)} onClick={()=>updateBorder(b.id,{animation:val})}
            style={{padding:'5px 2px',borderRadius:7,border:`1.5px solid ${(b.animation||null)===val?accent:'#d1d5db'}`,background:(b.animation||null)===val?accent:'transparent',color:(b.animation||null)===val?'#fff':textC,cursor:'pointer',fontSize:10,fontWeight:700,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
            <span style={{fontSize:14}}>{ic}</span>
            <span>{lbl}</span>
          </button>
        ))}
      </div>
      <button onClick={()=>{save();setBorders(p=>p.filter(x=>x.id!==selectedBorder));setLabels(p=>p.filter(l=>l.borderId!==selectedBorder));setSelectedBorder(null);}} style={{width:'100%',marginTop:4,padding:'8px',background:'#ef4444',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700}}>Delete Border</button>
      </div>{/* end scrollable body */}
    </div>
  );
}

function MobileBubbleSheet({b,accent,textC,textMut,cardBg,onClose,updateBubble,save,setBubbles,setConnections,selectedBubble,setSelectedBubble,embedded}) {
  const inner = (
    <>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>SHAPE</div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:10}}>
        {BUBBLE_SHAPES.map(sh=>(
          <button key={sh.id} onClick={()=>updateBubble(b.id,{shape:sh.id})} style={{padding:'6px',borderRadius:6,border:`1.5px solid ${b.shape===sh.id?accent:'#d1d5db'}`,background:b.shape===sh.id?accent:'transparent',color:b.shape===sh.id?'#fff':textC,fontSize:12,cursor:'pointer',fontWeight:600}}>{sh.label}</button>
        ))}
      </div>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>FILL COLOR</div>
      <ColorGrid value={b.fillColor} onChange={c=>updateBubble(b.id,{fillColor:c})} showNone/>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5,marginTop:10}}>TEXT CONTENT</div>
      <textarea value={b.text||''} onChange={e=>updateBubble(b.id,{text:e.target.value})}
        placeholder="Type bubble text…"
        rows={3}
        style={{width:'100%',padding:'8px 10px',borderRadius:7,border:`1px solid #d1d5db`,background:cardBg,color:textC,fontSize:13,boxSizing:'border-box',resize:'none',fontFamily:'Arial,sans-serif',marginBottom:8}}/>
      {/* Font family */}
      <select value={b.fontFamily||'Arial'} onChange={e=>updateBubble(b.id,{fontFamily:e.target.value})}
        style={{width:'100%',padding:'7px 10px',borderRadius:7,border:`1px solid #d1d5db`,background:cardBg,color:textC,fontSize:12,marginBottom:8,boxSizing:'border-box'}}>
        {['Arial','Georgia','Times New Roman','Courier New','Verdana','Trebuchet MS','Impact','Comic Sans MS','Palatino','Tahoma'].map(f=>(
          <option key={f} value={f} style={{fontFamily:f}}>{f}</option>
        ))}
      </select>
      <div style={{display:'flex',gap:6,marginBottom:8,alignItems:'center'}}>
        {[['B','textBold',{fontWeight:'700'}],['I','textItalic',{fontStyle:'italic'}],['U','textUnderline',{textDecoration:'underline'}]].map(([lbl,key,sty])=>(
          <button key={key} onClick={()=>updateBubble(b.id,{[key]:!b[key]})}
            style={{width:36,height:34,borderRadius:7,border:`1.5px solid ${b[key]?accent:'#d1d5db'}`,background:b[key]?accent:'transparent',color:b[key]?'#fff':textC,cursor:'pointer',fontSize:14,...sty}}>
            {lbl}
          </button>
        ))}
        <div style={{flex:1}}/>
        <span style={{fontSize:10,color:textMut}}>Size</span>
        <input type="number" min={8} max={48} value={b.textFontSize||13} onChange={e=>updateBubble(b.id,{textFontSize:Number(e.target.value)})}
          style={{width:50,padding:'5px 6px',borderRadius:7,border:`1px solid #d1d5db`,background:cardBg,color:textC,fontSize:12,textAlign:'center'}}/>
        <span style={{fontSize:10,color:textMut}}>px</span>
      </div>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5}}>TEXT COLOR</div>
      <ColorGrid value={b.textColor||'#1e293b'} onChange={c=>updateBubble(b.id,{textColor:c})}/>
      <div style={{fontSize:10,fontWeight:600,color:textMut,marginBottom:5,marginTop:10}}>STROKE COLOR</div>
      <ColorGrid value={b.strokeColor} onChange={c=>updateBubble(b.id,{strokeColor:c})}/>
      <SliderRow label="Stroke Width" value={b.strokeWidth||2} min={0} max={8} onChange={v=>updateBubble(b.id,{strokeWidth:v})} textMut={textMut} textC={textC}/>
      <button onClick={()=>{save();setBubbles(p=>p.filter(x=>x.id!==selectedBubble));setConnections(p=>p.filter(c=>c.from!==selectedBubble&&c.to!==selectedBubble));setSelectedBubble(null);}} style={{width:'100%',marginTop:4,padding:'8px',background:'#ef4444',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700}}>Delete Bubble</button>
    </>
  );
  if(embedded) return inner;
  return (
    <div style={{position:'absolute',bottom:52,left:0,right:0,zIndex:160,background:cardBg,borderTop:'2px solid #3b82f6',borderRadius:'14px 14px 0 0',boxShadow:'0 -4px 24px rgba(0,0,0,0.18)',maxHeight:'82vh',display:'flex',flexDirection:'column',animation:'slideUpPanel 0.22s ease-out'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 16px 10px',borderBottom:'1px solid rgba(0,0,0,0.06)',flexShrink:0}}>
        <span style={{fontSize:13,fontWeight:700,color:textC}}>Bubble Style</span>
        <button onClick={onClose} style={{background:'#3b82f6',border:'none',cursor:'pointer',color:'#fff',fontSize:13,padding:'5px 14px',borderRadius:8,fontWeight:700}}>Done ✓</button>
      </div>
      <div style={{overflowY:'auto',flex:1,padding:'10px 16px 20px'}}>
        {inner}
      </div>
    </div>
  );
}

// --- AwsDiagramBuilder --------------------------------------------------------
const AwsDiagramBuilder = (props) => {
  const darkModeProp = props.darkMode;
  const setDarkModeProp = props.setDarkMode;
  const initialDiagram = props.initialDiagram;
  const [darkModeInt,setDarkModeInt]=useState(false);
  const darkMode=darkModeProp!==undefined?darkModeProp:darkModeInt;
  const setDarkMode=setDarkModeProp||setDarkModeInt;
  const isMobile=useIsMobile();

  const [zoom,setZoom]=useState(1);
  const [elements,setElements]=useState([]);
  const [connections,setConnections]=useState([]);
  const [labels,setLabels]=useState([]);
  const [borders,setBorders]=useState([]);
  const [icons,setIcons]=useState([]);
  const [bubbles,setBubbles]=useState([]);
  const [texts,setTexts]=useState([]); // text banners

  // Single ref updated every render — guaranteed fresh, no closure issues
  const canvasStateRef=useRef({});
  const [selectedText,setSelectedText]=useState(null);
  const [editingText,setEditingText]=useState(null);
  const [showBannerEditor,setShowBannerEditor]=useState(false);
  const [showElSheet,setShowElSheet]=useState(false);
  const [showBubbleSheet,setShowBubbleSheet]=useState(false);
  const [showBubbleMenu,setShowBubbleMenu]=useState(false); // desktop bubble shape dropdown
  const [showUpgradeModal,setShowUpgradeModal]=useState(false);
  // User plan - 'free' | 'pro' | 'team' (will be wired to backend later)
  const [userPlan,setUserPlan]=useState('free');
  // Canvas watermark (Pro feature)
  const [watermarkImg,setWatermarkImg]=useState(null); // base64 data URL
  const [watermarkOpacity,setWatermarkOpacity]=useState(0.15);
  const [watermarkPos,setWatermarkPos]=useState('bottom-right'); // bottom-right | bottom-left | top-right | top-left | center
  const [watermarkSize,setWatermarkSize]=useState(120); // px at 100% zoom
  const [showWatermarkPanel,setShowWatermarkPanel]=useState(false);
  const watermarkFileRef=useRef(null);
  const [history,setHistory]=useState([]);

  const [searchTerm,setSearchTerm]=useState('');
  const [iconSearch,setIconSearch]=useState('');
  const [activeTab,setActiveTab]=useState('services');
  const [provider,setProvider]=useState('aws'); // 'aws' | 'gcp' | 'azure'
  const [showTemplates,setShowTemplates]=useState(false);
  const [draggingService,setDraggingService]=useState(null);
  const [showMobilePanel,setShowMobilePanel]=useState(false);
  const [showCustomSvcModal,setShowCustomSvcModal]=useState(false);
  const [customServices,setCustomServices]=useState([]);
  const [showAiModal,setShowAiModal]=useState(false);
  const [premiumGateFeature,setPremiumGateFeature]=useState(null);
  // Returns true if the caller should proceed with the action, false if it
  // was blocked and the gate modal is now showing instead.
  const tryPremiumAction=(featureName)=>{
    if(isPremiumGateActive()){setPremiumGateFeature(featureName);return false;}
    return true;
  };
  const [showIaCExportModal,setShowIaCExportModal]=useState(false);
  const [showTerraformImportModal,setShowTerraformImportModal]=useState(false);
  const [showImportModal,setShowImportModal]=useState(false);
  const [showValidationPanel,setShowValidationPanel]=useState(false);
  const [showCompareModal,setShowCompareModal]=useState(false);
  const [validationResults,setValidationResults]=useState(null);
  const [ignoredRecs,setIgnoredRecs]=useState(new Set());
  const [validationEnabled,setValidationEnabled]=useState(true);
  // Animation
  const [animEnabled,setAnimEnabled]=useState(false);
  const [animStyle,setAnimStyle]=useState('dataflow');
  const [animSpeed,setAnimSpeed]=useState('normal');
  const [showAnimPanel,setShowAnimPanel]=useState(false);
  const [isExportingGif,setIsExportingGif]=useState(false);
  const [animTick,setAnimTick]=useState(0);
  const animFrameRef=useRef(null);
  const animTickRef=useRef(0);
  // Phase 3 visual styles
  const [nodeVisualStyle,setNodeVisualStyle]=useState('solid');
  const [connVisualStyle,setConnVisualStyle]=useState('solid');
  // Animation Editor - global settings
  const [animColor,setAnimColor]=useState(null); // null = use element/connection colour
  const [animDirection,setAnimDirection]=useState('forward'); // forward | reverse | bidirectional
  const [animDotShape,setAnimDotShape]=useState('circle'); // circle | square | diamond | star | triangle
  const [animDotSize,setAnimDotSize]=useState(5);
  const [animGlowRadius,setAnimGlowRadius]=useState(10);
  const [animRingCount,setAnimRingCount]=useState(3);
  const [animOrbitCount,setAnimOrbitCount]=useState(2);
  const [animOrbitDir,setAnimOrbitDir]=useState('cw'); // cw | ccw
  const [animLightningColor,setAnimLightningColor]=useState('#818cf8');
  const [animLightningFreq,setAnimLightningFreq]=useState(4); // frames active per 20
  const [animLightningDir,setAnimLightningDir]=useState('forward'); // forward | reverse | bidirectional
  const [animLightningThickness,setAnimLightningThickness]=useState(2);
  const [animConstellationColor,setAnimConstellationColor]=useState('#6366f1');
  const [animConstellationDist,setAnimConstellationDist]=useState(400);
  const [animColorShiftStart,setAnimColorShiftStart]=useState(0);
  const [animColorShiftIntensity,setAnimColorShiftIntensity]=useState(0.08);
  const [animColorShiftPreset,setAnimColorShiftPreset]=useState('full');
  const [animPulseColor,setAnimPulseColor]=useState(null); // null = node colour
  const [animPulseRadius,setAnimPulseRadius]=useState(6);
  const [animPulseSync,setAnimPulseSync]=useState(false); // all pulse together
  const [animRippleColor,setAnimRippleColor]=useState(null);
  const [animRippleSpeed,setAnimRippleSpeed]=useState(50); // max expansion px
  const [animPacketLabels,setAnimPacketLabels]=useState([...PACKET_LABELS]);
  const [animPacketColor,setAnimPacketColor]=useState(null);
  const [animPacketTextColor,setAnimPacketTextColor]=useState('#ffffff');
  const [animPacketSize,setAnimPacketSize]=useState(1); // scale multiplier
  // Per-object overrides: connId -> {color, direction, label, speed}
  const [connAnimOverrides,setConnAnimOverrides]=useState({});
  // Per-object node overrides: elId -> {status, statusLabel, pulseColor}
  const [nodeAnimOverrides,setNodeAnimOverrides]=useState({});
  // Sequence order: array of element ids
  const [seqOrder,setSeqOrder]=useState([]);
  const [showAnimEditor,setShowAnimEditor]=useState(false);
  const [animEditorTab,setAnimEditorTab]=useState('global'); // global | perObject
  const [selectedAnimObj,setSelectedAnimObj]=useState(null); // {type:'conn'|'el', id}

  const [selectedEl,setSelectedEl]=useState(null);
  const [selectedBorder,setSelectedBorder]=useState(null);
  const [selectedIcon,setSelectedIcon]=useState(null);
  const [selectedBubble,setSelectedBubble]=useState(null);
  const [selectedLabelId,setSelectedLabelId]=useState(null);
  const [selectedConn,setSelectedConn]=useState(null);

  const [editingEl,setEditingEl]=useState(null);
  const [editingIcon,setEditingIcon]=useState(null);
  const [editingBubble,setEditingBubble]=useState(null);
  const [editingLabelId,setEditingLabelId]=useState(null);

  const [connMenu,setConnMenu]=useState(null);
  const [borderMenu,setBorderMenu]=useState(null);
  const [bubbleMenu,setBubbleMenu]=useState(null);

  const canvasRef=useRef(null);
  const [canvasOffset,setCanvasOffset]=useState({x:300,y:150});
  // Canvas background
  const [canvasBgTheme,setCanvasBgTheme]=useState('dots'); // dots | grid | blueprint | plain
  const [canvasBgColor,setCanvasBgColor]=useState(null); // null = use theme default
  // Border fill
  // (stored per-border as b.fillColor and b.fillOpacity)
  // Connection labels
  // (stored per-connection as conn.midLabel)
  // Alignment guides
  const [snapGuides,setSnapGuides]=useState([]);
  // Multi-select
  const [multiSel,setMultiSel]=useState(new Set());
  const [multiSelBox,setMultiSelBox]=useState(null); // {x1,y1,x2,y2} drag rect
  // Undo history panel
  const [showHistory,setShowHistory]=useState(false);
  // Custom emoji dot for animation
  const [animDotEmoji,setAnimDotEmoji]=useState(null); // null = use shape, string = emoji

  // --- Per-diagram animation settings bundle -------------------------------
  // All animation state above is otherwise global to the app session, which
  // means it silently carried over between different loaded diagrams. These
  // helpers snapshot/restore that whole bundle so each diagram keeps its own.
  const DEFAULT_ANIM_SETTINGS={
    animEnabled:false,animStyle:'dataflow',animSpeed:'normal',
    nodeVisualStyle:'solid',connVisualStyle:'solid',
    animColor:null,animDirection:'forward',animDotShape:'circle',animDotSize:5,
    animGlowRadius:10,animRingCount:3,animOrbitCount:2,animOrbitDir:'cw',
    animLightningColor:'#818cf8',animLightningFreq:4,animLightningDir:'forward',animLightningThickness:2,
    animConstellationColor:'#6366f1',animConstellationDist:400,
    animColorShiftStart:0,animColorShiftIntensity:0.08,animColorShiftPreset:'full',
    animPulseColor:null,animPulseRadius:6,animPulseSync:false,
    animRippleColor:null,animRippleSpeed:50,
    animPacketLabels:[...PACKET_LABELS],animPacketColor:null,animPacketTextColor:'#ffffff',animPacketSize:1,
    connAnimOverrides:{},nodeAnimOverrides:{},
    seqOrder:[],animDotEmoji:null,
  };
  const getAnimSettings=()=>({
    animEnabled,animStyle,animSpeed,nodeVisualStyle,connVisualStyle,
    animColor,animDirection,animDotShape,animDotSize,
    animGlowRadius,animRingCount,animOrbitCount,animOrbitDir,
    animLightningColor,animLightningFreq,animLightningDir,animLightningThickness,
    animConstellationColor,animConstellationDist,
    animColorShiftStart,animColorShiftIntensity,animColorShiftPreset,
    animPulseColor,animPulseRadius,animPulseSync,
    animRippleColor,animRippleSpeed,
    animPacketLabels,animPacketColor,animPacketTextColor,animPacketSize,
    connAnimOverrides,nodeAnimOverrides,
    seqOrder,animDotEmoji,
  });
  const applyAnimSettings=(s)=>{
    const a={...DEFAULT_ANIM_SETTINGS,...(s||{})};
    setAnimEnabled(a.animEnabled);setAnimStyle(a.animStyle);setAnimSpeed(a.animSpeed);
    setNodeVisualStyle(a.nodeVisualStyle);setConnVisualStyle(a.connVisualStyle);
    setAnimColor(a.animColor);setAnimDirection(a.animDirection);setAnimDotShape(a.animDotShape);setAnimDotSize(a.animDotSize);
    setAnimGlowRadius(a.animGlowRadius);setAnimRingCount(a.animRingCount);setAnimOrbitCount(a.animOrbitCount);setAnimOrbitDir(a.animOrbitDir);
    setAnimLightningColor(a.animLightningColor);setAnimLightningFreq(a.animLightningFreq);setAnimLightningDir(a.animLightningDir);setAnimLightningThickness(a.animLightningThickness);
    setAnimConstellationColor(a.animConstellationColor);setAnimConstellationDist(a.animConstellationDist);
    setAnimColorShiftStart(a.animColorShiftStart);setAnimColorShiftIntensity(a.animColorShiftIntensity);setAnimColorShiftPreset(a.animColorShiftPreset);
    setAnimPulseColor(a.animPulseColor);setAnimPulseRadius(a.animPulseRadius);setAnimPulseSync(a.animPulseSync);
    setAnimRippleColor(a.animRippleColor);setAnimRippleSpeed(a.animRippleSpeed);
    setAnimPacketLabels(a.animPacketLabels);setAnimPacketColor(a.animPacketColor);setAnimPacketTextColor(a.animPacketTextColor);setAnimPacketSize(a.animPacketSize);
    setConnAnimOverrides(a.connAnimOverrides);setNodeAnimOverrides(a.nodeAnimOverrides);
    setSeqOrder(a.seqOrder);setAnimDotEmoji(a.animDotEmoji);
  };

  const [isPanning,setIsPanning]=useState(false);
  const [panStart,setPanStart]=useState({x:0,y:0});

  const [drawMode,setDrawMode]=useState(null);
  const [drawStart,setDrawStart]=useState(null);
  const [previewPt,setPreviewPt]=useState(null);
  const [drawingBorder,setDrawingBorder]=useState(false);
  const [borderDragStart,setBorderDragStart]=useState(null);
  const [borderPreview,setBorderPreview]=useState(null);

  const drag=useRef(null);
  const touchRef=useRef(null);

  const [isPublic,setIsPublic]=useState(true);
  const [currentDiagramId,setCurrentDiagramId]=useState(()=>`diag_${Date.now()}`);
  const library=props.library||[];
  const setLibrary=props.setLibrary||(()=>{});
  const savedCount=library.length;
  const [showLibraryPanel,setShowLibraryPanel]=useState(false);
  const [diagramTitle,setDiagramTitle]=useState('');

  // Updated every render — saveDiagram reads from here to avoid stale closures
  canvasStateRef.current={elements,connections,borders,labels,icons,bubbles,texts,diagramTitle,currentDiagramId,isPublic,provider,animSettings:getAnimSettings()};
  const [editingTitle,setEditingTitle]=useState(false);
  const [toast,setToast]=useState(null);
  const titleInputRef=useRef(null);

  // Load diagram from profile/feed when opened via "Edit in Designer"
  useEffect(()=>{
    if(!initialDiagram)return;
    const detail=DIAGRAM_DETAILS[initialDiagram.id]||FEED_DIAGRAM_DETAILS[initialDiagram.id];
    if(!detail)return;

    // Convert DIAGRAM_DETAILS nodes -> canvas elements
    const svcMap={};
    const allServices=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];
    allServices.forEach(s=>{svcMap[s.id]=s;});
    // Build a color->service lookup for matching node colors to services
    const colorToSvc={
      '#FF9900':AWS_SERVICES.find(s=>s.id==='ec2'),
      '#527FFF':AWS_SERVICES.find(s=>s.id==='rds'),
      '#8C4FFF':AWS_SERVICES.find(s=>s.id==='vpc'),
      '#569A31':AWS_SERVICES.find(s=>s.id==='s3'),
      '#4B612C':AWS_SERVICES.find(s=>s.id==='codecommit'),
      '#DD344C':AWS_SERVICES.find(s=>s.id==='iam'),
      '#1e293b':AWS_SERVICES.find(s=>s.id==='codecommit'),
    };

    const newEls=detail.nodes.map((n,i)=>{
      // Try to find a matching AWS service by color, fallback to EC2
      const svc=colorToSvc[n.color]||allServices.find(s=>s.icon===n.icon)||allServices[0];
      return {
        id:`el_init_${i}`,
        service:svc,
        x:n.x+80,
        y:n.y+60,
        width:n.w||120,
        height:n.h||100,
        customName:n.label,
      };
    });

    const newConns=detail.edges.map(([a,b],i)=>({
      id:`c_init_${i}`,
      from:newEls[a]?.id,
      to:newEls[b]?.id,
      type:'arrow',
      bent:false,
      color:'#3b82f6',
      strokeWidth:3,
      arrowSize:14,
    })).filter(c=>c.from&&c.to);

    setElements(newEls);
    setConnections(newConns);
    setLabels([]);
    setBorders([]);
    setIcons([]);
    setBubbles([]);
    setHistory([]);
    setDiagramTitle(initialDiagram.title||'');
    setIsPublic(initialDiagram.visibility!=='private');
    setCurrentDiagramId(initialDiagram.id);
    setZoom(0.9);
    setCanvasOffset({x:60,y:40});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[initialDiagram?.id]);

  // Styles
  const bg=darkMode?'#111827':'#eff6ff';
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent='#2563eb';

  const activeProvider=CLOUD_PROVIDERS.find(p=>p.id===provider)||CLOUD_PROVIDERS[0];
  const providerCustom=customServices.filter(s=>s.provider===provider);
  const allProviderSvc=[...activeProvider.services,...providerCustom];
  const filteredSvc=allProviderSvc.filter(s=>s.name.toLowerCase().includes(searchTerm.toLowerCase())||s.category.toLowerCase().includes(searchTerm.toLowerCase()));
  const filteredIcons2=ICON_LIBRARY.filter(i=>i.name.toLowerCase().includes(iconSearch.toLowerCase())||i.category.toLowerCase().includes(iconSearch.toLowerCase()));
  const connData=connMenu?connections.find(c=>c.id===connMenu.connId):null;
  const borderData=borderMenu?borders.find(b=>b.id===borderMenu.borderId):null;
  const bubbleData=bubbleMenu?bubbles.find(b=>b.id===bubbleMenu.bubbleId):null;

  const btnStyle=(active,col='#2563eb')=>({padding:'6px',borderRadius:7,border:'none',cursor:'pointer',background:active?col:'transparent',color:active?'#fff':textC,display:'flex',alignItems:'center'});

  // Helpers
  const toCanvas=useCallback(e=>{
    const r=canvasRef.current.getBoundingClientRect();
    return{x:(e.clientX-r.left-canvasOffset.x)/zoom,y:(e.clientY-r.top-canvasOffset.y)/zoom};
  },[canvasOffset,zoom]);

  const touchToCanvas=(clientX,clientY)=>{
    const r=canvasRef.current.getBoundingClientRect();
    return{x:(clientX-r.left-canvasOffset.x)/zoom,y:(clientY-r.top-canvasOffset.y)/zoom};
  };

  const eW=e=>{
    if(!e) return 80;
    if(e.fontSize!==undefined) return Math.max(80, (e.text||'Text Banner').length*(e.fontSize||28)*0.55); // text banner
    return e.w||e.width||e.size||80;
  };
  const eH=e=>{
    if(!e) return 40;
    if(e.fontSize!==undefined) return (e.fontSize||28)+16; // text banner
    if(e.w!==undefined&&e.h!==undefined) return e.h; // bubble
    return e.height||e.size||80;
  };

  const findById=useCallback(id=>{
    if(!id)return undefined;
    return elements.find(e=>e.id===id)||borders.find(b=>b.id===id)||icons.find(i=>i.id===id)||bubbles.find(b=>b.id===id)||texts.find(t=>t.id===id);
  },[elements,borders,icons,bubbles,texts]);

  const connPt=(ent,side)=>{
    if(!ent)return{x:0,y:0};
    const w=eW(ent),h=eH(ent),cx=ent.x+w/2,cy=ent.y+h/2;
    if(side==='top')return{x:cx,y:ent.y};
    if(side==='bottom')return{x:cx,y:ent.y+h};
    if(side==='left')return{x:ent.x,y:cy};
    if(side==='right')return{x:ent.x+w,y:cy};
    return{x:cx,y:cy};
  };

  const bestPts=(a,b)=>{
    if(!a||!b)return{from:{x:0,y:0},to:{x:0,y:0}};
    const dx=(b.x+eW(b)/2)-(a.x+eW(a)/2),dy=(b.y+eH(b)/2)-(a.y+eH(a)/2);
    const as=Math.abs(dx)>Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'bottom':'top');
    const bs=Math.abs(dx)>Math.abs(dy)?(dx>0?'left':'right'):(dy>0?'top':'bottom');
    return{from:connPt(a,as),to:connPt(b,bs)};
  };

  // History
  const snap=useCallback((action='Edit')=>({action,ts:Date.now(),elements:JSON.parse(JSON.stringify(elements)),connections:JSON.parse(JSON.stringify(connections)),labels:JSON.parse(JSON.stringify(labels)),borders:JSON.parse(JSON.stringify(borders)),icons:JSON.parse(JSON.stringify(icons)),bubbles:JSON.parse(JSON.stringify(bubbles)),texts:JSON.parse(JSON.stringify(texts))}),[elements,connections,labels,borders,icons,bubbles,texts]);

  // Zoom to fit all content in view
  const zoomToFit=useCallback(()=>{
    const all=[
      ...elements.map(el=>({x:el.x,y:el.y,x2:el.x+el.width,y2:el.y+el.height})),
      ...borders.map(b=>({x:b.x,y:b.y,x2:b.x+b.width,y2:b.y+b.height})),
      ...icons.map(i=>({x:i.x,y:i.y,x2:i.x+i.size,y2:i.y+i.size})),
      ...bubbles.map(b=>({x:b.x,y:b.y,x2:b.x+b.w,y2:b.y+b.h})),
      ...texts.map(t=>({x:t.x,y:t.y,x2:t.x+300,y2:t.y+(t.fontSize||28)+10})),
    ];
    if(!all.length) return;
    const pad=48;
    const minX=Math.min(...all.map(a=>a.x));
    const minY=Math.min(...all.map(a=>a.y));
    const maxX=Math.max(...all.map(a=>a.x2));
    const maxY=Math.max(...all.map(a=>a.y2));
    const contentW=maxX-minX;
    const contentH=maxY-minY;
    const r=canvasRef.current?.getBoundingClientRect();
    if(!r||!r.width||!r.height) return;
    const toolbarH=isMobile?112:52;
    const availW=r.width-pad*2;
    const availH=r.height-toolbarH-pad*2;
    const newZoom=Math.min(2,Math.max(0.15,Math.min(availW/contentW,availH/contentH)));
    // Center the content in the available area
    const scaledW=contentW*newZoom;
    const scaledH=contentH*newZoom;
    const offsetX=(availW-scaledW)/2+pad-minX*newZoom;
    const offsetY=(availH-scaledH)/2+pad-minY*newZoom;
    setZoom(parseFloat(newZoom.toFixed(2)));
    setCanvasOffset({x:offsetX,y:offsetY});
  },[elements,borders,icons,bubbles,texts,isMobile,canvasRef]);

  // Animation RAF loop
  useEffect(()=>{
    if(!animEnabled){
      if(animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      return;
    }
    const speedMs=ANIM_SPEEDS.find(s=>s.id===animSpeed)?.ms||60;
    let last=0;
    const tick=(ts)=>{
      if(ts-last>=speedMs){
        last=ts;
        animTickRef.current=(animTickRef.current+1)%1000;
        setAnimTick(t=>t+1);
      }
      animFrameRef.current=requestAnimationFrame(tick);
    };
    animFrameRef.current=requestAnimationFrame(tick);
    return ()=>{ if(animFrameRef.current) cancelAnimationFrame(animFrameRef.current); };
  },[animEnabled,animSpeed]);
  const save=useCallback((action)=>setHistory(p=>[...p.slice(-30),snap(action)]),[snap]);
  const undo=()=>{
    if(!history.length)return;
    const p=history[history.length-1];
    setElements(p.elements);setConnections(p.connections);setLabels(p.labels);
    setBorders(p.borders);setIcons(p.icons||[]);setBubbles(p.bubbles||[]);
    setHistory(h=>h.slice(0,-1));
  };

  const toggleDraw=mode=>{
    if(drawMode===mode){setDrawMode(null);setDrawStart(null);setPreviewPt(null);}
    else{setDrawMode(mode);setDrawStart(null);setPreviewPt(null);clearSel();}
  };

  const tryConnect=useCallback(entity=>{
    if(!drawStart){setDrawStart(entity);return;}
    if(drawStart.id===entity.id)return;
    save();
    const isBent=drawMode==='bent-arrow'||drawMode==='bent-line';
    const isArrow=drawMode==='straight-arrow'||drawMode==='bent-arrow';
    setConnections(prev=>[...prev,{id:`c${Date.now()}`,from:drawStart.id,to:entity.id,type:isArrow?'arrow':'line',bent:isBent,color:'#3b82f6',strokeWidth:3,arrowSize:14}]);
    setDrawStart(null);setPreviewPt(null);
  },[drawStart,drawMode,save]);

  const clearSel=()=>{setSelectedEl(null);setSelectedBorder(null);setSelectedIcon(null);setSelectedBubble(null);setSelectedLabelId(null);setSelectedConn(null);setSelectedText(null);};
  const closeMenus=()=>{setConnMenu(null);setBorderMenu(null);setBubbleMenu(null);};

  const startDrag=(type,e,extra)=>{e.stopPropagation();const{x,y}=toCanvas(e);drag.current={type,mouseX:x,mouseY:y,...extra};};

  // Element handlers
  const onElDown=(e,el)=>{
    if(e.target.tagName==='INPUT')return;
    if(drawMode){tryConnect(el);return;}
    closeMenus();
    if(e.shiftKey||e.metaKey){
      // Shift/cmd click - add to or remove from multi-select
      setMultiSel(prev=>{const n=new Set(prev);n.has(el.id)?n.delete(el.id):n.add(el.id);return n;});
      setSelectedEl(null);
      return;
    }
    if(multiSel.size>0&&multiSel.has(el.id)){
      // Dragging a multi-selected group
      setSelectedEl(el.id);
      if(showAnimEditor){setSelectedAnimObj({type:'el',id:el.id});setAnimEditorTab('perObject');}
      const{x,y}=touchToCanvas(e.clientX,e.clientY);
      drag.current={type:'multi',mouseX:x,mouseY:y,origPositions:Object.fromEntries([...multiSel].map(id=>{const el=elements.find(e=>e.id===id);return[id,{x:el?.x||0,y:el?.y||0}];}))};
      return;
    }
    setMultiSel(new Set());
    setSelectedEl(el.id);setSelectedBorder(null);setSelectedIcon(null);setSelectedBubble(null);setSelectedLabelId(null);setSelectedConn(null);
    if(showAnimEditor){setSelectedAnimObj({type:'el',id:el.id});setAnimEditorTab('perObject');}
    startDrag('el',e,{id:el.id,origX:el.x,origY:el.y});
  };
  const elLastTap=useRef({});
  const onElTouchStart=(e,el)=>{
    e.stopPropagation();
    e.preventDefault(); // Blocks iOS synthetic dblclick/mousedown events from firing
    const t=e.touches[0];
    const{x,y}=touchToCanvas(t.clientX,t.clientY);
    const now=Date.now();
    const lastTap=elLastTap.current[el.id]||0;
    const isDoubleTap=now-lastTap<350&&selectedEl===el.id;
    elLastTap.current[el.id]=now;
    if(isDoubleTap){
      // Double-tap - open style sheet, don't start drag
      setShowElSheet(true);
      return;
    }
    // First tap - select, close sheet, start drag
    setShowElSheet(false);
    setSelectedEl(el.id);setSelectedBorder(null);setSelectedIcon(null);setSelectedBubble(null);setSelectedLabelId(null);setSelectedConn(null);
    drag.current={type:'el',id:el.id,mouseX:x,mouseY:y,origX:el.x,origY:el.y};
    touchRef.current={lastX:t.clientX,lastY:t.clientY,moved:false};
  };
  const onElDblClick=(e,el)=>{
    e.stopPropagation();
    if(isMobile) return; // Mobile uses double-tap in onElTouchStart instead
    setShowElSheet(true); // Show style panel on desktop double-click
  };
  const onElResizeDown=(e,el)=>{e.stopPropagation();e.preventDefault();const{x,y}=toCanvas(e);drag.current={type:'el-resize',id:el.id,mouseX:x,mouseY:y,origW:el.width,origH:el.height};};

  const onIconDown=(e,ic)=>{
    if(e.target.tagName==='INPUT')return;
    if(drawMode){tryConnect(ic);return;}
    closeMenus();
    setSelectedIcon(ic.id);setSelectedEl(null);setSelectedBorder(null);setSelectedBubble(null);setSelectedLabelId(null);setSelectedConn(null);
    startDrag('icon',e,{id:ic.id,origX:ic.x,origY:ic.y});
  };
  const onIconTouchStart=(e,ic)=>{
    e.stopPropagation();
    const t=e.touches[0];const{x,y}=touchToCanvas(t.clientX,t.clientY);
    setSelectedIcon(ic.id);drag.current={type:'icon',id:ic.id,mouseX:x,mouseY:y,origX:ic.x,origY:ic.y};
    touchRef.current={lastX:t.clientX,lastY:t.clientY,moved:false};
  };
  const onIconDblClick=(e,ic)=>{e.stopPropagation();setEditingIcon(ic.id);};
  const onIconResizeDown=(e,ic)=>{e.stopPropagation();e.preventDefault();const{x,y}=toCanvas(e);drag.current={type:'icon-resize',id:ic.id,mouseX:x,mouseY:y,origSize:ic.size};};

  const onBorderDown=(e,b)=>{
    if(drawMode){tryConnect(b);return;}
    closeMenus();
    setSelectedBorder(b.id);setSelectedEl(null);setSelectedIcon(null);setSelectedBubble(null);setSelectedLabelId(null);setSelectedConn(null);
    startDrag('border',e,{id:b.id,origX:b.x,origY:b.y});
  };
  const onBorderResizeDown=(e,b)=>{e.stopPropagation();e.preventDefault();const{x,y}=toCanvas(e);drag.current={type:'border-resize',id:b.id,mouseX:x,mouseY:y,origW:b.width,origH:b.height};};

  const bubbleLastTap=useRef({});
  const onBubbleDown=(e,b)=>{
    if(e.target.tagName==='TEXTAREA'||e.target.tagName==='INPUT')return;
    if(drawMode){tryConnect(b);return;}
    closeMenus();
    setSelectedBubble(b.id);setSelectedEl(null);setSelectedBorder(null);setSelectedIcon(null);setSelectedLabelId(null);setSelectedConn(null);
    startDrag('bubble',e,{id:b.id,origX:b.x,origY:b.y});
  };
  const onBubbleTouchStart=(e,b)=>{
    if(drawMode){e.stopPropagation();tryConnect(b);return;}
    e.preventDefault(); // block synthetic mouse events but let touchmove propagate to canvas
    const t=e.touches[0];
    const{x,y}=touchToCanvas(t.clientX,t.clientY);
    const now=Date.now();
    const last=bubbleLastTap.current[b.id]||0;
    const isDouble=now-last<350&&selectedBubble===b.id;
    bubbleLastTap.current[b.id]=now;
    if(isDouble){
      setSelectedBubble(b.id);
      setShowBubbleSheet(true);
      return;
    }
    // First tap - select and start drag
    setShowBubbleSheet(false);
    setSelectedBubble(b.id);setSelectedEl(null);setSelectedBorder(null);setSelectedIcon(null);setSelectedLabelId(null);setSelectedConn(null);
    drag.current={type:'bubble',id:b.id,mouseX:x,mouseY:y,origX:b.x,origY:b.y};
    touchRef.current={lastX:t.clientX,lastY:t.clientY,moved:false};
  };
  const onBubbleResizeDown=(e,b)=>{e.stopPropagation();e.preventDefault();const{x,y}=toCanvas(e);drag.current={type:'bubble-resize',id:b.id,mouseX:x,mouseY:y,origW:b.w,origH:b.h};};

  const onLabelDown=(e,lbl)=>{e.stopPropagation();closeMenus();setSelectedLabelId(lbl.id);setSelectedBorder(null);setSelectedEl(null);setSelectedIcon(null);setSelectedBubble(null);setSelectedConn(null);drag.current=null;};
  const onLabelResizeDown=(e,lbl)=>{e.stopPropagation();e.preventDefault();const{x,y}=toCanvas(e);drag.current={type:'label-resize',id:lbl.id,mouseX:x,mouseY:y,origW:lbl.manualWidth||80,origH:lbl.manualHeight||26};};

  // Canvas mouse
  const onCanvasMove=e=>{
    if(drawingBorder&&borderDragStart){
      const{x,y}=toCanvas(e);
      setBorderPreview({x:Math.min(borderDragStart.x,x),y:Math.min(borderDragStart.y,y),w:Math.abs(x-borderDragStart.x),h:Math.abs(y-borderDragStart.y)});
      return;
    }
    if(drawMode&&drawStart){const{x,y}=toCanvas(e);setPreviewPt({x,y});}
    if(drag.current){
      const{x,y}=toCanvas(e);
      const dx=x-drag.current.mouseX,dy=y-drag.current.mouseY;
      const s10=v=>Math.round(v/10)*10;
      const d=drag.current;
      if(d.type==='multi'){
        // Move all selected elements together
        setElements(prev=>prev.map(el=>{
          if(!multiSel.has(el.id))return el;
          const orig=d.origPositions[el.id];
          if(!orig)return el;
          return{...el,x:Math.round((orig.x+dx)/10)*10,y:Math.round((orig.y+dy)/10)*10};
        }));
      }

      else if(d.type==='el'){
        const newX=s10(d.origX+dx), newY=s10(d.origY+dy);
        const dragged=elements.find(e=>e.id===d.id);
        if(dragged){
          const others=elements.filter(e=>e.id!==d.id);
          const cx=newX+dragged.width/2, cy=newY+dragged.height/2;
          const guides=[];
          const THRESH=8;
          for(const o of others){
            const ocx=o.x+o.width/2,ocy=o.y+o.height/2;
            // Horizontal alignments
            if(Math.abs(cy-ocy)<THRESH) guides.push({type:'h',pos:ocy});
            if(Math.abs(newY-o.y)<THRESH) guides.push({type:'h',pos:o.y});
            if(Math.abs(newY+dragged.height-o.y)<THRESH) guides.push({type:'h',pos:o.y});
            if(Math.abs(newY-(o.y+o.height))<THRESH) guides.push({type:'h',pos:o.y+o.height});
            if(Math.abs(newY+dragged.height-(o.y+o.height))<THRESH) guides.push({type:'h',pos:o.y+o.height});
            // Vertical alignments
            if(Math.abs(cx-ocx)<THRESH) guides.push({type:'v',pos:ocx});
            if(Math.abs(newX-o.x)<THRESH) guides.push({type:'v',pos:o.x});
            if(Math.abs(newX+dragged.width-o.x)<THRESH) guides.push({type:'v',pos:o.x});
            if(Math.abs(newX-(o.x+o.width))<THRESH) guides.push({type:'v',pos:o.x+o.width});
            if(Math.abs(newX+dragged.width-(o.x+o.width))<THRESH) guides.push({type:'v',pos:o.x+o.width});
          }
          setSnapGuides(guides);
        }
        setElements(prev=>prev.map(el=>el.id===d.id?{...el,x:newX,y:newY}:el));
      }
      else if(d.type==='el-resize') setElements(prev=>prev.map(el=>el.id===d.id?{...el,width:Math.max(60,s10(d.origW+dx)),height:Math.max(50,s10(d.origH+dy))}:el));
      else if(d.type==='border') setBorders(prev=>prev.map(b=>b.id===d.id?{...b,x:s10(d.origX+dx),y:s10(d.origY+dy)}:b));
      else if(d.type==='border-resize') setBorders(prev=>prev.map(b=>b.id===d.id?{...b,width:Math.max(80,s10(d.origW+dx)),height:Math.max(60,s10(d.origH+dy))}:b));
      else if(d.type==='icon') setIcons(prev=>prev.map(i=>i.id===d.id?{...i,x:s10(d.origX+dx),y:s10(d.origY+dy)}:i));
      else if(d.type==='icon-resize') setIcons(prev=>prev.map(i=>i.id===d.id?{...i,size:Math.max(32,Math.round(d.origSize+Math.max(dx,dy)))}:i));
      else if(d.type==='bubble') setBubbles(prev=>prev.map(b=>b.id===d.id?{...b,x:s10(d.origX+dx),y:s10(d.origY+dy)}:b));
      else if(d.type==='bubble-resize') setBubbles(prev=>prev.map(b=>b.id===d.id?{...b,w:Math.max(80,Math.round(d.origW+dx)),h:Math.max(50,Math.round(d.origH+dy))}:b));
      else if(d.type==='label-resize') setLabels(prev=>prev.map(l=>l.id===d.id?{...l,manualWidth:Math.max(40,Math.round(d.origW+dx)),manualHeight:Math.max(20,Math.round(d.origH+dy))}:l));
      else if(d.type==='text') setTexts(prev=>prev.map(t=>t.id===d.id?{...t,x:s10(d.origX+dx),y:s10(d.origY+dy)}:t));
      return;
    }
    if(isPanning){
      const dx=e.clientX-panStart.x,dy=e.clientY-panStart.y;
      setCanvasOffset(p=>({x:p.x+dx,y:p.y+dy}));
      setPanStart({x:e.clientX,y:e.clientY});
    }
  };

  const onCanvasUp=()=>{
    setSnapGuides([]);
    if(drawingBorder&&borderDragStart&&borderPreview){
      if(borderPreview.w>40&&borderPreview.h>30){
        save();
        setBorders(prev=>[...prev,{id:`b${Date.now()}`,x:borderPreview.x,y:borderPreview.y,width:borderPreview.w,height:borderPreview.h,color:'#3b82f6',strokeWidth:2,strokeStyle:'solid',borderRadius:0}]);
      }
      setBorderDragStart(null);setBorderPreview(null);return;
    }
    if(drag.current){save();drag.current=null;}
    setIsPanning(false);
  };

  const onCanvasDown=e=>{
    if(drawingBorder){const{x,y}=toCanvas(e);setBorderDragStart({x,y});return;}
    if(drawMode)return;
    if(e.target===e.currentTarget){
      closeMenus();clearSel();setEditingEl(null);setEditingIcon(null);
      setMultiSel(new Set());
      setShowElSheet(false);
      setShowBubbleSheet(false);      setIsPanning(true);setPanStart({x:e.clientX,y:e.clientY});
    }
  };

  // Touch handlers
  const onTouchStart=e=>{
    try {
      if(e.touches.length===1){
        const t=e.touches[0];
        touchRef.current={startX:t.clientX,startY:t.clientY,lastX:t.clientX,lastY:t.clientY,moved:false};
      } else if(e.touches.length===2){
        const dx=e.touches[0].clientX-e.touches[1].clientX;
        const dy=e.touches[0].clientY-e.touches[1].clientY;
        touchRef.current={pinchDist:Math.hypot(dx,dy),startZoom:zoom,pinch:true};
      }
    } catch(_){ touchRef.current=null; }
  };

  const onTouchMove=e=>{
    try {
      e.preventDefault();
      if(!touchRef.current) return;
      if(e.touches.length===2){
        // Pinch zoom - guard every property access
        if(!touchRef.current.pinch||touchRef.current.pinchDist==null||touchRef.current.startZoom==null) return;
        const dx=e.touches[0].clientX-e.touches[1].clientX;
        const dy=e.touches[0].clientY-e.touches[1].clientY;
        const dist=Math.hypot(dx,dy);
        if(!dist||!touchRef.current.pinchDist) return;
        const ratio=dist/touchRef.current.pinchDist;
        const sz=touchRef.current.startZoom;
        if(sz==null) return;
        setZoom(()=>Math.min(3,Math.max(0.3,+(sz*ratio).toFixed(2))));
        return;
      }
      if(e.touches.length===1&&touchRef.current&&!touchRef.current.pinch){
        const t=e.touches[0];
        if(touchRef.current.lastX==null||touchRef.current.lastY==null) return;
        const dx=t.clientX-touchRef.current.lastX;
        const dy=t.clientY-touchRef.current.lastY;
        touchRef.current.lastX=t.clientX;touchRef.current.lastY=t.clientY;touchRef.current.moved=true;
        if(drag.current){
          const{x,y}=touchToCanvas(t.clientX,t.clientY);
          const ddx=x-drag.current.mouseX,ddy=y-drag.current.mouseY;
          const s10=v=>Math.round(v/10)*10;const d=drag.current;
          if(d.type==='el'){
            const newX=s10(d.origX+ddx),newY=s10(d.origY+ddy);
            const dragged=elements.find(e=>e.id===d.id);
            if(dragged){
              const others=elements.filter(e=>e.id!==d.id);
              const cx=newX+dragged.width/2,cy=newY+dragged.height/2;
              const guides=[];
              const THRESH=8;
              let didSnap=false;
              for(const o of others){
                const ocx=o.x+o.width/2,ocy=o.y+o.height/2;
                if(Math.abs(cy-ocy)<THRESH){guides.push({type:'h',pos:ocy});didSnap=true;}
                if(Math.abs(newY-o.y)<THRESH){guides.push({type:'h',pos:o.y});didSnap=true;}
                if(Math.abs(newY+dragged.height-o.y)<THRESH){guides.push({type:'h',pos:o.y});didSnap=true;}
                if(Math.abs(newY-(o.y+o.height))<THRESH){guides.push({type:'h',pos:o.y+o.height});didSnap=true;}
                if(Math.abs(newY+dragged.height-(o.y+o.height))<THRESH){guides.push({type:'h',pos:o.y+o.height});didSnap=true;}
                if(Math.abs(cx-ocx)<THRESH){guides.push({type:'v',pos:ocx});didSnap=true;}
                if(Math.abs(newX-o.x)<THRESH){guides.push({type:'v',pos:o.x});didSnap=true;}
                if(Math.abs(newX+dragged.width-o.x)<THRESH){guides.push({type:'v',pos:o.x});didSnap=true;}
                if(Math.abs(newX-(o.x+o.width))<THRESH){guides.push({type:'v',pos:o.x+o.width});didSnap=true;}
                if(Math.abs(newX+dragged.width-(o.x+o.width))<THRESH){guides.push({type:'v',pos:o.x+o.width});didSnap=true;}
              }
              setSnapGuides(guides);
              // (haptic removed - not accessible from iOS Safari web browser)
            }
            setElements(prev=>prev.map(el=>el.id===d.id?{...el,x:newX,y:newY}:el));
          }
          else if(d.type==='el-resize') setElements(prev=>prev.map(el=>el.id===d.id?{...el,width:Math.max(60,s10(d.origW+ddx)),height:Math.max(50,s10(d.origH+ddy))}:el));
          else if(d.type==='icon') setIcons(prev=>prev.map(i=>i.id===d.id?{...i,x:s10(d.origX+ddx),y:s10(d.origY+ddy)}:i));
          else if(d.type==='icon-resize') setIcons(prev=>prev.map(i=>i.id===d.id?{...i,size:Math.max(32,Math.round(d.origSize+Math.max(ddx,ddy)))}:i));
          else if(d.type==='bubble') setBubbles(prev=>prev.map(b=>b.id===d.id?{...b,x:s10(d.origX+ddx),y:s10(d.origY+ddy)}:b));
          else if(d.type==='text') setTexts(prev=>prev.map(t=>t.id===d.id?{...t,x:s10(d.origX+ddx),y:s10(d.origY+ddy)}:t));
          else if(d.type==='border') setBorders(prev=>prev.map(b=>b.id===d.id?{...b,x:s10(d.origX+ddx),y:s10(d.origY+ddy)}:b));
        } else {
          setCanvasOffset(p=>({x:p.x+dx,y:p.y+dy}));
        }
      }
    } catch(_) {
      // Silently swallow any stale-ref errors from touch events
      // firing between renders (common on iOS Safari after canvas replacement)
      touchRef.current=null;
      drag.current=null;
    }
  };

  const onTouchEnd=()=>{
    try{ if(drag.current){ save(); drag.current=null; } }catch(_){}
    touchRef.current=null;
    setSnapGuides([]);
  };

  const addToCenter=item=>{
    save();
    const r=canvasRef.current?.getBoundingClientRect()||{width:400,height:600};
    const cx=Math.round((r.width/2-canvasOffset.x)/zoom/10)*10;
    const cy=Math.round((r.height/2-canvasOffset.y)/zoom/10)*10;
    if(item.type==='service'){
      setElements(prev=>[...prev,{id:`el${Date.now()}`,service:item.data,x:cx-60,y:cy-50,width:120,height:100,customName:null}]);
    } else {
      setIcons(prev=>[...prev,{id:`ic${Date.now()}`,iconDef:item.data,x:cx-30,y:cy-30,size:60,label:item.data.name}]);
    }
    setShowMobilePanel(false);
  };

  // Connection handlers
  const onConnClick=(e,connId)=>{
    e.stopPropagation();clearSel();setSelectedConn(connId);
    if(showAnimEditor){setSelectedAnimObj({type:'conn',id:connId});setAnimEditorTab('perObject');}
  };
  const onConnRightClick=(e,connId)=>{e.preventDefault();e.stopPropagation();closeMenus();setSelectedConn(connId);setConnMenu({connId,x:e.clientX,y:e.clientY});};
  const updateConn=(id,updates)=>{save();setConnections(prev=>prev.map(c=>c.id===id?{...c,...updates}:c));};
  const updateEl=(id,updates)=>{save();setElements(prev=>prev.map(el=>el.id===id?{...el,...updates}:el));};

  const onBorderRightClick=(e,b)=>{e.preventDefault();e.stopPropagation();closeMenus();setSelectedBorder(b.id);setBorderMenu({borderId:b.id,x:e.clientX,y:e.clientY});};
  const updateBorder=(id,updates)=>{save();setBorders(prev=>prev.map(b=>b.id===id?{...b,...updates}:b));if(updates.color)setLabels(prev=>prev.map(l=>l.borderId===id?{...l,color:updates.color}:l));setBorderMenu(null);};

  const onBubbleRightClick=(e,b)=>{e.preventDefault();e.stopPropagation();closeMenus();setSelectedBubble(b.id);setBubbleMenu({bubbleId:b.id,x:e.clientX,y:e.clientY});};
  const updateBubble=(id,updates)=>{save();setBubbles(prev=>prev.map(b=>b.id===id?{...b,...updates}:b));};

  const handleAddLabel=()=>{
    if(!selectedBorder){alert('Select a border first.');return;}
    const existing=labels.find(l=>l.borderId===selectedBorder);
    if(existing){setEditingLabelId(existing.id);return;}
    const b=borders.find(b=>b.id===selectedBorder);if(!b)return;
    save();
    const nl={id:`lbl${Date.now()}`,borderId:selectedBorder,text:'',color:b.color,manualWidth:null,manualHeight:null};
    setLabels(prev=>[...prev,nl]);setSelectedLabelId(nl.id);setEditingLabelId(nl.id);
  };

  const handleAddBubble=shape=>{
    save();
    const r=canvasRef.current.getBoundingClientRect();
    const cx=(r.width/2-canvasOffset.x)/zoom,cy=(r.height/2-canvasOffset.y)/zoom;
    const nb={id:`bbl${Date.now()}`,x:Math.round((cx-110)/10)*10,y:Math.round((cy-65)/10)*10,w:220,h:120,shape,fillColor:'#ffffff',strokeColor:'#3b82f6',strokeWidth:2,text:'',textColor:'#1e293b'};
    setBubbles(prev=>[...prev,nb]);setSelectedBubble(nb.id);setEditingBubble(nb.id);
  };

  const handleAddBanner=()=>{
    save();
    const r=canvasRef.current.getBoundingClientRect();
    const cx=(r.width/2-canvasOffset.x)/zoom;
    const cy=(r.height/2-canvasOffset.y)/zoom;
    const nb={
      id:`txt${Date.now()}`,
      x:Math.round((cx-100)/10)*10,
      y:Math.round((cy-20)/10)*10,
      text:'Text Banner',
      fontFamily:'Arial',
      fontSize:32,
      fontWeight:'bold',
      fontStyle:'normal',
      textDecoration:'none',
      color:darkMode?'#ffffff':'#1e293b',
      align:'center',
      opacity:1,
    };
    setTexts(prev=>[...prev,nb]);
    setSelectedText(nb.id);
    setShowBannerEditor(true);
  };

  const handleDelete=useCallback(()=>{
    if(selectedConn){save();setConnections(p=>p.filter(c=>c.id!==selectedConn));setSelectedConn(null);return;}
    if(selectedLabelId){save();setLabels(p=>p.filter(l=>l.id!==selectedLabelId));setSelectedLabelId(null);return;}
    if(selectedBubble){save();setBubbles(p=>p.filter(b=>b.id!==selectedBubble));setConnections(p=>p.filter(c=>c.from!==selectedBubble&&c.to!==selectedBubble));setSelectedBubble(null);return;}
    if(selectedText){save();setTexts(p=>p.filter(t=>t.id!==selectedText));setSelectedText(null);setShowBannerEditor(false);return;}
    if(selectedIcon){save();setIcons(p=>p.filter(i=>i.id!==selectedIcon));setConnections(p=>p.filter(c=>c.from!==selectedIcon&&c.to!==selectedIcon));setSelectedIcon(null);return;}
    if(selectedBorder){save();setLabels(p=>p.filter(l=>l.borderId!==selectedBorder));setBorders(p=>p.filter(b=>b.id!==selectedBorder));setConnections(p=>p.filter(c=>c.from!==selectedBorder&&c.to!==selectedBorder));setSelectedBorder(null);return;}
    if(selectedEl){save();setElements(p=>p.filter(el=>el.id!==selectedEl));setConnections(p=>p.filter(c=>c.from!==selectedEl&&c.to!==selectedEl));setSelectedEl(null);}
  },[selectedConn,selectedLabelId,selectedBubble,selectedText,selectedIcon,selectedBorder,selectedEl,save]);

  useEffect(()=>{
    const h=e=>{
      if(e.key==='Escape'){setDrawingBorder(false);setBorderDragStart(null);setBorderPreview(null);setDrawMode(null);setDrawStart(null);setPreviewPt(null);return;}
      if((e.key==='Delete'||e.key==='Backspace')&&document.activeElement.tagName!=='TEXTAREA'&&document.activeElement.tagName!=='INPUT')handleDelete();
    };
    window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h);
  },[handleDelete]);

  const handleDrop=e=>{
    e.preventDefault();if(!draggingService)return;
    const{x,y}=toCanvas(e);save();
    if(draggingService.type==='service'){
      setElements(prev=>[...prev,{id:`el${Date.now()}`,service:draggingService.data,x:Math.round(x/10)*10,y:Math.round(y/10)*10,width:120,height:100,customName:null}]);
    } else {
      setIcons(prev=>[...prev,{id:`ic${Date.now()}`,iconDef:draggingService.data,x:Math.round(x/10)*10-30,y:Math.round(y/10)*10-30,size:60,label:draggingService.data.name}]);
    }
    setDraggingService(null);
  };

  const loadTemplate=t=>{
    save();
    const newEls=t.elements.map((el,i)=>{const svc=AWS_SERVICES.find(s=>s.id===el.service);if(!svc)return null;return{id:`el${Date.now()}${i}`,service:svc,x:el.x+200,y:el.y+80,width:120,height:100,customName:null};}).filter(Boolean);
    const newConns=t.connections.map(c=>({id:`c${Date.now()}${Math.random()}`,from:newEls[c.from]?.id,to:newEls[c.to]?.id,type:'arrow',bent:false,color:'#3b82f6',strokeWidth:3,arrowSize:14})).filter(c=>c.from&&c.to);
    setElements(prev=>[...prev,...newEls]);setConnections(prev=>[...prev,...newConns]);setShowTemplates(false);
  };

  const [showShareModal,setShowShareModal]=useState(false);
  const [sharePreviewUrl,setSharePreviewUrl]=useState(null);

  // saveDiagram reads from canvasStateRef which is updated every render
  const saveDiagram=async(overridePublic)=>{
    const s=canvasStateRef.current;
    const has=(s.elements||[]).length||(s.borders||[]).length||(s.icons||[]).length||(s.bubbles||[]).length;
    if(!has){
      setToast({msg:'Add some elements to the canvas first.',type:'info'});
      setTimeout(()=>setToast(null),3000);
      return;
    }
    const title=(s.diagramTitle||'').trim()||'Untitled Diagram';
    setDiagramTitle(title);
    const pub=overridePublic!==undefined?overridePublic:s.isPublic;

    // Build thumbnail from snapshot — draws elements/borders from canvasStateRef directly
    let thumbnail=null;
    try{
      const els=s.elements||[];
      const bords=s.borders||[];
      const lbls=s.labels||[];
      const conns=s.connections||[];
      const all=[
        ...els.map(el=>({x:el.x,y:el.y,x2:el.x+(el.width||130),y2:el.y+(el.height||110)})),
        ...bords.map(b=>({x:b.x,y:b.y-30,x2:b.x+b.width,y2:b.y+b.height})),
      ];
      if(all.length){
        const pad=40;
        const minX=Math.min(...all.map(a=>a.x))-pad;
        const minY=Math.min(...all.map(a=>a.y))-pad;
        const maxX=Math.max(...all.map(a=>a.x2))+pad;
        const maxY=Math.max(...all.map(a=>a.y2))+pad;
        const W=Math.min(640,maxX-minX), H=Math.min(400,maxY-minY);
        const scale=Math.min(W/(maxX-minX),H/(maxY-minY));
        const cnv=document.createElement('canvas');
        cnv.width=Math.round(W);cnv.height=Math.round(H);
        const ctx=cnv.getContext('2d');
        ctx.fillStyle=darkMode?'#111827':'#eff6ff';
        ctx.fillRect(0,0,cnv.width,cnv.height);
        ctx.save();ctx.scale(scale,scale);ctx.translate(-minX,-minY);
        // Draw borders
        bords.forEach(b=>{
          ctx.strokeStyle=b.color||'#3b82f6';ctx.lineWidth=(b.strokeWidth||2)/scale;
          ctx.setLineDash(b.strokeStyle==='dashed'?[8,4]:b.strokeStyle==='dotted'?[2,3]:[]);
          const r=b.borderRadius||0;
          if(r>0){
            ctx.beginPath();ctx.roundRect(b.x,b.y,b.width,b.height,r);ctx.stroke();
          }else{ctx.strokeRect(b.x,b.y,b.width,b.height);}
          ctx.setLineDash([]);
          const lbl=lbls.find(l=>l.borderId===b.id);
          if(lbl?.text){
            const fs=Math.round(11/scale);
            ctx.font=`bold ${fs}px Arial`;
            const lw=ctx.measureText(lbl.text).width+12,lh=Math.round(20/scale);
            ctx.fillStyle=b.color||'#3b82f6';ctx.fillRect(b.x,b.y,lw,lh);
            ctx.fillStyle='#fff';ctx.textAlign='left';ctx.textBaseline='middle';
            ctx.fillText(lbl.text,b.x+5,b.y+lh/2);
          }
        });
        // Draw connections
        conns.forEach(c=>{
          const fe=els.find(e=>e.id===c.from),te=els.find(e=>e.id===c.to);
          if(!fe||!te)return;
          const x1=fe.x+(fe.width||130)/2,y1=fe.y+(fe.height||110);
          const x2=te.x+(te.width||130)/2,y2=te.y;
          ctx.strokeStyle=c.color||'#3b82f6';ctx.lineWidth=(c.strokeWidth||2)/scale;
          ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
        });
        // Draw elements
        els.forEach(el=>{
          const svc=el.service;if(!svc)return;
          const w=el.width||130,h=el.height||110,r=Math.min(12,w*0.1);
          ctx.fillStyle=svc.color||'#3b82f6';
          ctx.beginPath();ctx.roundRect(el.x,el.y,w,h,r);ctx.fill();
          ctx.strokeStyle='rgba(0,0,0,0.3)';ctx.lineWidth=1.5/scale;ctx.stroke();
          const iconSz=Math.round(h*0.35);
          ctx.font=`${iconSz}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.fillStyle='#fff';
          ctx.fillText(svc.icon,el.x+w/2,el.y+h*0.42);
          const lblSz=Math.max(8,Math.round(h*0.1));
          ctx.font=`bold ${lblSz}px Arial`;
          ctx.fillText(el.customName||svc.name,el.x+w/2,el.y+h*0.78);
        });
        ctx.restore();
        thumbnail=cnv.toDataURL('image/png');
      }
    }catch(e){console.warn('Thumbnail generation failed:',e);}

    const entryColors=[...new Set((s.elements||[]).map(e=>e.service?.color||'#3b82f6'))].slice(0,3);
    const entry={
      id:s.currentDiagramId,
      title,
      provider:s.provider,
      elements:s.elements||[],
      connections:s.connections||[],
      borders:s.borders||[],
      labels:s.labels||[],
      icons:s.icons||[],
      bubbles:s.bubbles||[],
      texts:s.texts||[],
      thumbnail,
      colors:entryColors.length?entryColors:['#3b82f6','#f59e0b','#10b981'],
      // Convert elements to nodes format for SVG thumbnail display
      nodes:(s.elements||[]).slice(0,12).map(e=>({x:e.x,y:e.y,w:e.width||130,h:e.height||110,label:e.customName||e.service?.name||'',color:e.service?.color||'#3b82f6',icon:e.service?.icon||'⬜'})),
      edges:(s.connections||[]).slice(0,20).map(c=>{const fi=(s.elements||[]).findIndex(e=>e.id===c.from),ti=(s.elements||[]).findIndex(e=>e.id===c.to);return[fi,ti];}).filter(([a,b])=>a>=0&&b>=0),
      isPublic:pub,
      animSettings:s.animSettings,
      createdAt:Date.now(),
      updatedAt:Date.now(),
    };
    const existingInLibrary=library.some(d=>d.id===entry.id);
    setToast({msg:'Saving…',type:'info'});
    try{
      if(existingInLibrary){
        await apiRequest(`/diagrams/${entry.id}`,{method:'PUT',body:entryToApiPayload(entry)});
      } else {
        const created=await apiRequest('/diagrams',{method:'POST',body:entryToApiPayload(entry)});
        entry.id=created.diagramId;
        setCurrentDiagramId(created.diagramId); // future saves of this same diagram now PUT instead of POST
      }
      if(pub){
        await apiRequest(`/diagrams/${entry.id}/publish`,{method:'POST',body:{caption:''}});
      }
      setLibrary(prev=>{
        const existing=prev.findIndex(d=>d.id===entry.id);
        const updated=existing>=0
          ?prev.map((d,i)=>i===existing?{...d,...entry,updatedAt:Date.now()}:d)
          :[{...entry,createdAt:Date.now()},...prev];
        return updated.slice(0,50);
      });
      setToast({msg:pub?`"${title}" posted to feed! 🚀`:`"${title}" saved to library! 💾`,type:'success'});
    }catch(err){
      setToast({msg:`Save failed: ${err.message}`,type:'error'});
    }
    setTimeout(()=>setToast(null),4000);
  };

  const handlePublish=()=>saveDiagram(true);
  const handleSave=()=>saveDiagram(false);

  const handleDeleteFromLibrary=async(id)=>{
    const prevLibrary=library;
    setLibrary(prev=>prev.filter(d=>d.id!==id)); // optimistic — reverted below if the API call fails
    try{
      await apiRequest(`/diagrams/${id}`,{method:'DELETE'});
    }catch(err){
      setLibrary(prevLibrary);
      setToast({msg:`Could not delete: ${err.message}`,type:'error'});
      setTimeout(()=>setToast(null),4000);
    }
  };

  const loadFromLibrary=async(d)=>{
    let full=d;
    if(d._isLight){
      setToast({msg:'Loading diagram…',type:'info'});
      try{
        const apiData=await apiRequest(`/diagrams/${d.id}`,{method:'GET',auth:false});
        full=apiToEntry(apiData);
      }catch(err){
        setToast({msg:`Could not load "${d.title||'diagram'}": ${err.message}`,type:'error'});
        setTimeout(()=>setToast(null),4000);
        return;
      }
    }
    save();
    setElements(full.elements||[]);
    setConnections(full.connections||[]);
    setBorders(full.borders||[]);
    setLabels(full.labels||[]);
    setIcons(full.icons||[]);
    setBubbles(full.bubbles||[]);
    setTexts(full.texts||[]);
    setHistory([]);
    setCurrentDiagramId(full.id);
    setDiagramTitle(full.title||'');
    applyAnimSettings(full.animSettings);
    setZoom(0.75);setCanvasOffset({x:60,y:40});
    setShowLibraryPanel(false);
    setToast({msg:`"${full.title||'Diagram'}" loaded from library.`,type:'success'});
    setTimeout(()=>setToast(null),4000);
  };

  // Build diagram image and return data URL (synchronous canvas render)
  const buildDiagramDataUrl=(format='png')=>{
    const all=[...elements.map(el=>({x:el.x,y:el.y,x2:el.x+el.width,y2:el.y+el.height})),...borders.map(b=>({x:b.x,y:b.y-30,x2:b.x+b.width,y2:b.y+b.height})),...icons.map(i=>({x:i.x,y:i.y,x2:i.x+i.size,y2:i.y+i.size+20})),...bubbles.map(b=>({x:b.x,y:b.y,x2:b.x+b.w,y2:b.y+b.h+50})),...texts.map(t=>({x:t.x,y:t.y,x2:t.x+600,y2:t.y+(t.fontSize||28)+16}))];
    if(!all.length) return null;
    const pad=80;
    const minX=Math.min(...all.map(a=>a.x))-pad,minY=Math.min(...all.map(a=>a.y))-pad;
    const maxX=Math.max(...all.map(a=>a.x2))+pad,maxY=Math.max(...all.map(a=>a.y2))+pad;
    const cnv=document.createElement('canvas');cnv.width=maxX-minX;cnv.height=maxY-minY;
    const ctx=cnv.getContext('2d');ctx.fillStyle=darkMode?'#111827':'#eff6ff';ctx.fillRect(0,0,cnv.width,cnv.height);
    const rr=(x,y,w,h,r)=>{r=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();};
    borders.forEach(b=>{const x=b.x-minX,y=b.y-minY,rad=b.borderRadius||0;ctx.strokeStyle=b.color;ctx.lineWidth=b.strokeWidth||2;ctx.setLineDash(b.strokeStyle==='dashed'?[10,5]:b.strokeStyle==='dotted'?[2,3]:[]);if(rad>0){rr(x,y,b.width,b.height,rad);ctx.stroke();}else ctx.strokeRect(x,y,b.width,b.height);ctx.setLineDash([]);const lbl=labels.find(l=>l.borderId===b.id);if(lbl?.text){ctx.font='bold 13px Arial';const lw=lbl.manualWidth||ctx.measureText(lbl.text).width+20,lh=lbl.manualHeight||26;ctx.fillStyle=lbl.color||b.color;ctx.fillRect(x,y,lw,lh);ctx.fillStyle='#fff';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(lbl.text,x+8,y+lh/2);}});
    bubbles.forEach(b=>{const ox=b.x-minX,oy=b.y-minY;ctx.save();ctx.translate(ox,oy);const parts=buildBubbleParts(b.shape,b.w,b.h);const fill=b.fillColor==='transparent'?null:(b.fillColor||'#fff');parts.forEach(p=>{if(p.type==='path'){const path=new Path2D(p.d);if(fill){ctx.fillStyle=fill;ctx.fill(path);}ctx.strokeStyle=b.strokeColor||'#3b82f6';ctx.lineWidth=b.strokeWidth||2;ctx.stroke(path);}else if(p.type==='ellipse'){ctx.beginPath();ctx.ellipse(p.cx,p.cy,p.rx,p.ry,0,0,Math.PI*2);if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.strokeStyle=b.strokeColor||'#3b82f6';ctx.lineWidth=b.strokeWidth||2;ctx.stroke();}else if(p.type==='circle'){ctx.beginPath();ctx.arc(p.cx,p.cy,p.r,0,Math.PI*2);if(fill){ctx.fillStyle=fill;ctx.fill();}ctx.strokeStyle=b.strokeColor||'#3b82f6';ctx.lineWidth=b.strokeWidth||2;ctx.stroke();}});if(b.text){ctx.fillStyle=b.textColor||'#1e293b';ctx.font='bold 13px Arial';ctx.textAlign='center';ctx.textBaseline='top';const mw=b.w-28;const words=b.text.split(' ');let line='',lines2=[];words.forEach(w=>{const tt=line+(line?' ':'')+w;if(ctx.measureText(tt).width>mw&&line){lines2.push(line);line=w;}else line=tt;});if(line)lines2.push(line);const sy=(b.shape==='thought'||b.shape==='cloud')?b.h*0.15:14;lines2.forEach((ln,idx)=>ctx.fillText(ln,b.w/2,sy+idx*18));}ctx.restore();});
    connections.forEach(conn=>{const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;const pts=bestPts(from,to);const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;ctx.strokeStyle=conn.color||'#3b82f6';ctx.lineWidth=conn.strokeWidth||3;ctx.setLineDash([]);ctx.beginPath();if(conn.bent){const mx=(x1+x2)/2;ctx.moveTo(x1,y1);ctx.lineTo(mx,y1);ctx.lineTo(mx,y2);ctx.lineTo(x2,y2);}else{ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);}ctx.stroke();if(conn.type==='arrow'){const angle=Math.atan2(y2-y1,x2-x1);const as=conn.arrowSize||14;ctx.fillStyle=conn.color||'#3b82f6';ctx.beginPath();ctx.moveTo(x2,y2);ctx.lineTo(x2-as*Math.cos(angle-0.45),y2-as*Math.sin(angle-0.45));ctx.lineTo(x2-as*Math.cos(angle+0.45),y2-as*Math.sin(angle+0.45));ctx.closePath();ctx.fill();}});
    elements.forEach(el=>{const x=el.x-minX,y=el.y-minY;const iconSz=Math.max(16,Math.round(Math.min(el.width,el.height)*0.38));const lblSz=Math.max(9,Math.round(Math.min(el.width,el.height)*0.11));ctx.fillStyle=el.service.color;rr(x,y,el.width,el.height,Math.min(16,el.width*0.12));ctx.fill();ctx.strokeStyle='#1e293b';ctx.lineWidth=3;ctx.stroke();ctx.fillStyle='#fff';ctx.font=`${iconSz}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(el.service.icon,x+el.width/2,y+el.height/2-lblSz*0.8);ctx.font=`bold ${lblSz}px Arial`;ctx.fillText(el.customName||el.service.name,x+el.width/2,y+el.height/2+iconSz*0.6);});
    icons.forEach(ic=>{const x=ic.x-minX,y=ic.y-minY;const icSz=Math.round(ic.size*0.68);const lblSz=Math.max(9,Math.round(ic.size*0.18));ctx.font=`${icSz}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(ic.iconDef.icon,x+ic.size/2,y+ic.size/2);if(ic.label){ctx.font=`bold ${lblSz}px Arial`;ctx.fillStyle=darkMode?'#f1f5f9':'#1e293b';ctx.fillText(ic.label,x+ic.size/2,y+ic.size+lblSz);}});
    // Draw text banners
    texts.forEach(t=>{
      const x=t.x-minX, y=t.y-minY;
      const fs=t.fontSize||28;
      const fw=t.fontWeight||'bold';
      const fi=t.fontStyle||'normal';
      const ff=t.fontFamily||'Arial';
      ctx.save();
      ctx.globalAlpha=t.opacity!=null?t.opacity:1;
      ctx.fillStyle=t.color||'#1e293b';
      ctx.font=`${fi} ${fw} ${fs}px ${ff}`;
      ctx.textAlign=t.align||'left';
      ctx.textBaseline='top';
      if(t.textDecoration==='underline'){
        // Draw text then underline manually since canvas doesn't support textDecoration
        const measured=ctx.measureText(t.text||'');
        const tx=t.align==='center'?x:t.align==='right'?x+600:x;
        ctx.fillText(t.text||'',tx,y);
        ctx.strokeStyle=t.color||'#1e293b';
        ctx.lineWidth=Math.max(1,fs*0.06);
        const uw=measured.width;
        const ux=t.align==='center'?tx-uw/2:t.align==='right'?tx-uw:tx;
        ctx.beginPath();ctx.moveTo(ux,y+fs+2);ctx.lineTo(ux+uw,y+fs+2);ctx.stroke();
      } else {
        const tx=t.align==='center'?x:t.align==='right'?x+600:x;
        ctx.fillText(t.text||'',tx,y);
      }
      ctx.restore();
    });
    // Draw watermark overlay if set
    if(watermarkImg){
      return new Promise(resolve=>{
        const img=new Image();
        img.onload=()=>{
          const W=cnv.width,H=cnv.height;
          const wmW=watermarkSize,wmH=Math.round(watermarkSize*img.naturalHeight/Math.max(img.naturalWidth,1));
          const pad2=16;
          const posMap={
            'bottom-right':{x:W-wmW-pad2,y:H-wmH-pad2},
            'bottom-left':{x:pad2,y:H-wmH-pad2},
            'top-right':{x:W-wmW-pad2,y:pad2},
            'top-left':{x:pad2,y:pad2},
            'center':{x:Math.round((W-wmW)/2),y:Math.round((H-wmH)/2)},
          };
          const pos=posMap[watermarkPos]||posMap['bottom-right'];
          ctx.globalAlpha=watermarkOpacity;
          ctx.drawImage(img,pos.x,pos.y,wmW,wmH);
          ctx.globalAlpha=1;
          resolve(cnv.toDataURL(`image/${format}`,1.0));
        };
        img.onerror=()=>resolve(cnv.toDataURL(`image/${format}`,1.0));
        img.src=watermarkImg;
      });
    }
    return Promise.resolve(cnv.toDataURL(`image/${format}`,1.0));
  };

  // Export: build + download
  const exportDiagram=async format=>{
    const has=elements.length||borders.length||icons.length||bubbles.length;
    if(!has){setToast({msg:'Nothing to export!',type:'info'});setTimeout(()=>setToast(null),3000);return;}
    setTimeout(async()=>{
      const dataUrl=await buildDiagramDataUrl(format);
      if(!dataUrl)return;
      const a=document.createElement('a');a.download=`archforge-${Date.now()}.${format}`;a.href=dataUrl;document.body.appendChild(a);a.click();document.body.removeChild(a);
    },0);
  };

  // Pure JS GIF encoder - no workers, no CDN dependencies, runs on main thread
  // Based on the LZW + GIF89a spec implemented directly in JS
  const exportGif=async()=>{
    const has=elements.length||borders.length||icons.length||bubbles.length;
    if(!has){setToast({msg:'Nothing to export!',type:'info'});setTimeout(()=>setToast(null),3000);return;}
    setIsExportingGif(true);
    setToast({msg:'Building animated GIF… ⏳',type:'info'});

    // Yield to allow React to render the toast before heavy work
    await new Promise(r=>setTimeout(r,80));

    try{
      const totalFrames=GIF_FRAMES[animSpeed]||30;
      const frameDelay=ANIM_SPEEDS.find(s=>s.id===animSpeed)?.ms||60;

      // Use IDENTICAL bounds logic as buildDiagramDataUrl - proven to work for PNG
      const all=[
        ...elements.map(el=>({x:el.x,y:el.y,x2:el.x+el.width,y2:el.y+el.height})),
        ...borders.map(b=>({x:b.x,y:b.y-30,x2:b.x+b.width,y2:b.y+b.height})),
        ...icons.map(i=>({x:i.x,y:i.y,x2:i.x+i.size,y2:i.y+i.size+20})),
        ...bubbles.map(b=>({x:b.x,y:b.y,x2:b.x+b.w,y2:b.y+b.h+50})),
      ];
      if(!all.length){setIsExportingGif(false);return;}
      const pad=80;
      const minX=Math.min(...all.map(a=>a.x))-pad;
      const minY=Math.min(...all.map(a=>a.y))-pad;
      const maxX=Math.max(...all.map(a=>a.x2))+pad;
      const maxY=Math.max(...all.map(a=>a.y2))+pad;
      // Full resolution (matches PNG export exactly)
      const fullW=maxX-minX;
      const fullH=maxY-minY;
      // Scale down for GIF output - cap at 720px longest side
      const sc=Math.min(1,720/Math.max(fullW,fullH));
      const gW=Math.round(fullW*sc);
      const gH=Math.round(fullH*sc);

      // Draw one animation frame at FULL resolution, then scale to gWxgH
      const rr=(ctx,x,y,w,h,r)=>{
        r=Math.min(r,w/2,h/2);
        ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);
        ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);
        ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);
        ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);
        ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();
      };

      const drawFrame=fi=>{
        // Step 1: render at full diagram resolution (no scaling - identical to PNG)
        const full=document.createElement('canvas');
        full.width=fullW; full.height=fullH;
        const ctx=full.getContext('2d');

        // Background
        ctx.fillStyle=darkMode?'#111827':'#eff6ff';
        ctx.fillRect(0,0,fullW,fullH);

        // Dot grid
        ctx.fillStyle=darkMode?'rgba(255,255,255,0.04)':'rgba(99,102,241,0.07)';
        for(let gxi=0;gxi<fullW;gxi+=20)for(let gyi=0;gyi<fullH;gyi+=20){
          ctx.beginPath();ctx.arc(gxi,gyi,1,0,Math.PI*2);ctx.fill();
        }

        // Borders (use b.x-minX, b.y-minY - same as buildDiagramDataUrl)
        borders.forEach(b=>{
          const x=b.x-minX,y=b.y-minY;
          ctx.strokeStyle=b.color;ctx.lineWidth=b.strokeWidth||2;
          ctx.setLineDash(b.strokeStyle==='dashed'?[10,5]:b.strokeStyle==='dotted'?[2,3]:[]);
          ctx.strokeRect(x,y,b.width,b.height);ctx.setLineDash([]);
          const lbl=labels.find(l=>l.borderId===b.id);
          if(lbl?.text){
            ctx.font='bold 13px Arial';
            const lw=ctx.measureText(lbl.text).width+20,lh=26;
            ctx.fillStyle=lbl.color||b.color;ctx.fillRect(x,y,lw,lh);
            ctx.fillStyle='#fff';ctx.textAlign='left';ctx.textBaseline='middle';
            ctx.fillText(lbl.text,x+8,y+lh/2);
          }
        });

        // Connections - Phase 3 visual styles
        connections.forEach((conn,ci)=>{
          const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
          const pts=bestPts(from,to);
          const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
          const color=conn.color||'#3b82f6';
          const fromColor=from.customColor||from.service?.color||color;
          const toColor=to.customColor||to.service?.color||color;
          const sw=conn.strokeWidth||3;

          // Line stroke
          if(connVisualStyle==='gradient'){
            const grad=ctx.createLinearGradient(x1,y1,x2,y2);
            grad.addColorStop(0,fromColor);grad.addColorStop(1,toColor);
            ctx.strokeStyle=grad;
          } else {
            ctx.strokeStyle=color;
          }
          ctx.lineWidth=sw;ctx.setLineDash([]);
          ctx.globalAlpha=connVisualStyle==='particle'?0.35:1;
          ctx.beginPath();
          if(conn.bent){const mx=(x1+x2)/2;ctx.moveTo(x1,y1);ctx.lineTo(mx,y1);ctx.lineTo(mx,y2);ctx.lineTo(x2,y2);}
          else{ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);}
          ctx.stroke();
          ctx.globalAlpha=1;
          // Arrowhead
          if(conn.type==='arrow'){
            const ang=Math.atan2(y2-y1,x2-x1),as=conn.arrowSize||14;
            ctx.fillStyle=connVisualStyle==='gradient'?toColor:color;
            ctx.beginPath();ctx.moveTo(x2,y2);
            ctx.lineTo(x2-as*Math.cos(ang-0.45),y2-as*Math.sin(ang-0.45));
            ctx.lineTo(x2-as*Math.cos(ang+0.45),y2-as*Math.sin(ang+0.45));
            ctx.closePath();ctx.fill();
          }
          // Particle streaming dots
          if(connVisualStyle==='particle'){
            const lineLen=Math.hypot(x2-x1,y2-y1);if(lineLen<8)return;
            [0,0.25,0.5,0.75].forEach((off,pi)=>{
              const ph=((fi+(pi*8)+(ci*5))%30)/30;
              const pp=0.05+((ph+off)%0.90)*0.90;
              const px=x1+(x2-x1)*pp,py=y1+(y2-y1)*pp;
              const op=0.4+Math.sin(ph*Math.PI*2)*0.35;
              const r=2.5+Math.sin(ph*Math.PI*2)*1;
              ctx.fillStyle=color;ctx.globalAlpha=op*0.2;
              ctx.beginPath();ctx.arc(px,py,r+3,0,Math.PI*2);ctx.fill();
              ctx.globalAlpha=op;
              ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);ctx.fill();
            });
            ctx.globalAlpha=1;
          }
        });

        // Elements - Phase 3 node visual styles applied in GIF frames
        elements.forEach((el,ei)=>{
          const x=el.x-minX,y=el.y-minY;
          const baseColor=el.customColor||el.service.color;
          const iconSz=Math.max(16,Math.round(Math.min(el.width,el.height)*0.38));
          const lblSz=Math.max(9,Math.round(Math.min(el.width,el.height)*0.11));
          ctx.shadowBlur=0;
          if(nodeVisualStyle==='glass'){
            ctx.fillStyle=baseColor+'22';
            rr(ctx,x,y,el.width,el.height,Math.min(16,el.width*0.12));ctx.fill();
            ctx.strokeStyle=baseColor+'88';ctx.lineWidth=2;ctx.stroke();
          } else if(nodeVisualStyle==='neon'){
            ctx.fillStyle=darkMode?'#0f172a':'#1e293b';
            rr(ctx,x,y,el.width,el.height,Math.min(16,el.width*0.12));ctx.fill();
            ctx.strokeStyle=baseColor;ctx.lineWidth=3;ctx.stroke();
            // Neon glow: draw stroke again with alpha for halo effect (avoids shadowBlur)
            ctx.strokeStyle=baseColor+'55';ctx.lineWidth=8;ctx.stroke();
            ctx.strokeStyle=baseColor;ctx.lineWidth=2;ctx.stroke();
          } else if(nodeVisualStyle==='gradient'){
            const grad=ctx.createRadialGradient(x+el.width*0.3,y+el.height*0.3,0,x+el.width/2,y+el.height/2,Math.max(el.width,el.height)*0.7);
            grad.addColorStop(0,baseColor);grad.addColorStop(0.6,baseColor+'88');grad.addColorStop(1,'#1e293b');
            ctx.fillStyle=grad;
            rr(ctx,x,y,el.width,el.height,Math.min(16,el.width*0.12));ctx.fill();
            ctx.strokeStyle='#1e293b';ctx.lineWidth=3;ctx.stroke();
          } else {
            ctx.fillStyle=baseColor;
            rr(ctx,x,y,el.width,el.height,Math.min(16,el.width*0.12));ctx.fill();
            ctx.strokeStyle='#1e293b';ctx.lineWidth=3;ctx.stroke();
          }
          const labelColor=nodeVisualStyle==='glass'?baseColor:'#fff';
          ctx.fillStyle=labelColor;
          ctx.font=`${iconSz}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.fillText(el.service.icon,x+el.width/2,y+el.height/2-lblSz*0.8);
          ctx.font=`bold ${lblSz}px Arial`;
          ctx.fillText(el.customName||el.service.name,x+el.width/2,y+el.height/2+iconSz*0.6);
        });

        // Pulse animation - glowing ellipse rings drawn ON TOP of nodes (matches SVG overlay)
        if(animStyle==='pulse'){
          elements.forEach((el,ei)=>{
            const phase=((fi+(ei*5))%30)/30;
            const glowR=6+Math.sin(phase*Math.PI*2)*4;
            const opacity=0.3+Math.sin(phase*Math.PI*2)*0.25;
            const color=el.customColor||el.service.color;
            const cx=el.x-minX+el.width/2, cy=el.y-minY+el.height/2;
            const rx=el.width/2+glowR, ry=el.height/2+glowR;
            // Outer glow ring
            ctx.strokeStyle=color;
            ctx.lineWidth=3;
            ctx.globalAlpha=opacity;
            ctx.beginPath();
            ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);
            ctx.stroke();
            // Inner fill glow
            ctx.fillStyle=color;
            ctx.globalAlpha=opacity*0.08;
            ctx.beginPath();
            ctx.ellipse(cx,cy,el.width/2+glowR*0.4,el.height/2+glowR*0.4,0,0,Math.PI*2);
            ctx.fill();
            ctx.globalAlpha=1;
          });
        }

        // Sequence animation - dashed rect ring + corner dots + highlighted connections (matches SVG overlay)
        if(animStyle==='sequence'&&elements.length){
          const step=Math.floor((fi/4)%elements.length);
          const activeEl=elements[step];
          if(activeEl){
            const color=activeEl.customColor||activeEl.service.color;
            const x=activeEl.x-minX, y=activeEl.y-minY;
            // Dashed highlight rect around active element
            ctx.strokeStyle=color;
            ctx.lineWidth=3;
            ctx.globalAlpha=0.9;
            ctx.setLineDash([12,6]);
            ctx.strokeRect(x-8,y-8,activeEl.width+16,activeEl.height+16);
            ctx.setLineDash([]);
            // Corner sparkle dots
            ctx.fillStyle=color;
            ctx.globalAlpha=0.8;
            [[x,y],[x+activeEl.width,y],[x,y+activeEl.height],[x+activeEl.width,y+activeEl.height]].forEach(([sx,sy])=>{
              ctx.beginPath();ctx.arc(sx,sy,4,0,Math.PI*2);ctx.fill();
            });
            // Highlight connected lines with dashed overlay
            ctx.globalAlpha=0.5;
            ctx.strokeStyle=color;
            ctx.lineWidth=4;
            ctx.setLineDash([8,4]);
            connections.filter(c=>c.from===activeEl.id||c.to===activeEl.id).forEach(conn=>{
              const from=findById(conn.from),to=findById(conn.to);
              if(!from||!to)return;
              const pts=bestPts(from,to);
              ctx.beginPath();
              ctx.moveTo(pts.from.x-minX,pts.from.y-minY);
              ctx.lineTo(pts.to.x-minX,pts.to.y-minY);
              ctx.stroke();
            });
            ctx.setLineDash([]);
            ctx.globalAlpha=1;
          }
        }

        // Icons
        icons.forEach(ic=>{
          const x=ic.x-minX,y=ic.y-minY;
          const icSz=Math.round(ic.size*0.68);
          ctx.font=`${icSz}px Arial`;ctx.textAlign='center';ctx.textBaseline='middle';
          ctx.fillText(ic.iconDef?.icon||'⚙️',x+ic.size/2,y+ic.size/2);
        });

        // Data flow dots (at full resolution, phase 0.05->0.95 keeps dots off nodes)
        if(animStyle==='dataflow'&&connections.length){
          connections.forEach((conn,ci)=>{
            const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
            if((connAnimOverrides[conn.id]||{}).disabled) return;
            const pts=bestPts(from,to);
            const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
            const lineLen=Math.hypot(x2-x1,y2-y1);
            if(lineLen<8) return;
            const color=conn.color||'#3b82f6';
            const rawPhase=((fi+(ci*7))%30)/30;
            const phase=0.05+rawPhase*0.90;
            const dotX=x1+(x2-x1)*phase,dotY=y1+(y2-y1)*phase;
            // Glow ring
            ctx.fillStyle=color;ctx.globalAlpha=0.2;
            ctx.beginPath();ctx.arc(dotX,dotY,10,0,Math.PI*2);ctx.fill();
            // Main dot
            ctx.globalAlpha=1;
            ctx.fillStyle=color;
            ctx.beginPath();ctx.arc(dotX,dotY,5,0,Math.PI*2);ctx.fill();
            // Trail
            [1,2,3].forEach(t=>{
              const tp=Math.max(0.05,phase-t*0.05);
              const tx=x1+(x2-x1)*tp,ty=y1+(y2-y1)*tp;
              ctx.globalAlpha=Math.max(0,0.22-t*0.07);
              ctx.beginPath();ctx.arc(tx,ty,Math.max(1,5-t),0,Math.PI*2);ctx.fill();
            });
            ctx.globalAlpha=1;
          });
        }

        // Phase 2 - Data Packets: labelled pill packets travelling along connections
        if(animStyle==='packets'&&connections.length){
          connections.forEach((conn,ci)=>{
            const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
            if((connAnimOverrides[conn.id]||{}).disabled) return;
            const pts=bestPts(from,to);
            const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
            const lineLen=Math.hypot(x2-x1,y2-y1);if(lineLen<8)return;
            const color=conn.color||'#3b82f6';
            const label=PACKET_LABELS[ci%PACKET_LABELS.length];
            const rawPhase=((fi+(ci*7))%30)/30;
            const phase=0.05+rawPhase*0.90;
            const px=x1+(x2-x1)*phase, py=y1+(y2-y1)*phase;
            // Pill background
            ctx.font='bold 9px Arial';
            const pw=ctx.measureText(label).width+12, ph2=16;
            ctx.fillStyle=color;ctx.globalAlpha=0.92;
            // Rounded pill
            const pr=ph2/2;
            ctx.beginPath();
            ctx.moveTo(px-pw/2+pr,py-ph2/2);
            ctx.lineTo(px+pw/2-pr,py-ph2/2);
            ctx.arcTo(px+pw/2,py-ph2/2,px+pw/2,py,pr);
            ctx.lineTo(px+pw/2,py+ph2/2-pr);
            ctx.arcTo(px+pw/2,py+ph2/2,px+pw/2-pr,py+ph2/2,pr);
            ctx.lineTo(px-pw/2+pr,py+ph2/2);
            ctx.arcTo(px-pw/2,py+ph2/2,px-pw/2,py,pr);
            ctx.lineTo(px-pw/2,py-ph2/2+pr);
            ctx.arcTo(px-pw/2,py-ph2/2,px-pw/2+pr,py-ph2/2,pr);
            ctx.closePath();ctx.fill();
            // Pill border
            ctx.strokeStyle='rgba(255,255,255,0.7)';ctx.lineWidth=1;ctx.stroke();
            // Label text
            ctx.globalAlpha=1;ctx.fillStyle='#fff';
            ctx.textAlign='center';ctx.textBaseline='middle';
            ctx.fillText(label,px,py+1);
            // Leading dot
            ctx.fillStyle='#fff';ctx.globalAlpha=0.7;
            ctx.beginPath();ctx.arc(px,py,2,0,Math.PI*2);ctx.fill();
            ctx.globalAlpha=1;
          });
        }

        // Phase 2 - Status Indicators: health dots with pulsing rings on each service
        if(animStyle==='status'){
          elements.forEach((el,ei)=>{
            const{color,label}=statusColor(ei);
            const phase=((fi+(ei*3))%20)/20;
            const pulseR=4+Math.sin(phase*Math.PI*2)*2;
            const dotX=el.x-minX+el.width-8;
            const dotY=el.y-minY+8;
            // Pulsing outer ring
            ctx.fillStyle=color;
            ctx.globalAlpha=0.2+Math.sin(phase*Math.PI*2)*0.15;
            ctx.beginPath();ctx.arc(dotX,dotY,pulseR*1.8,0,Math.PI*2);ctx.fill();
            // Solid status dot
            ctx.globalAlpha=0.95;
            ctx.fillStyle=color;
            ctx.beginPath();ctx.arc(dotX,dotY,5,0,Math.PI*2);ctx.fill();
            ctx.strokeStyle='#fff';ctx.lineWidth=1.5;ctx.stroke();
            // Label pill for non-OK statuses
            if(label!=='OK'){
              ctx.font='bold 8px Arial';
              const lw=ctx.measureText(label).width+8;
              ctx.fillStyle=color;ctx.globalAlpha=0.88;
              ctx.beginPath();ctx.arc(dotX+8+lw/2,dotY,7,0,Math.PI*2);ctx.fill();
              ctx.fillRect(dotX+8,dotY-7,lw,14);
              ctx.beginPath();ctx.arc(dotX+8+lw,dotY,7,0,Math.PI*2);ctx.fill();
              ctx.globalAlpha=1;
              ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';
              ctx.fillText(label,dotX+8+lw/2,dotY+1);
            }
            ctx.globalAlpha=1;
          });
        }

        // -- 🌊 Ripple: concentric rings expand from each node --------------
        if(animStyle==='ripple'){
          elements.forEach((el,ei)=>{
            const color=el.customColor||el.service.color;
            const cx=el.x-minX+el.width/2, cy=el.y-minY+el.height/2;
            [0,1,2].forEach(ri=>{
              const phase=((fi+(ei*4)+(ri*10))%30)/30;
              const r=el.width/2+8+phase*50;
              const op=Math.max(0,0.55-phase*0.55);
              ctx.strokeStyle=color;ctx.lineWidth=2;ctx.globalAlpha=op;
              ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();
            });
          });
          ctx.globalAlpha=1;
        }

        // -- ⚡ Lightning: jagged electric arc flashes along connections ------
        if(animStyle==='lightning'){
          connections.forEach((conn,ci)=>{
            const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
            const pts=bestPts(from,to);
            const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
            const color=conn.color||'#818cf8';
            const active=((fi+(ci*11))%20)<4; if(!active)return;
            const segs=6; const dx=(x2-x1)/segs, dy=(y2-y1)/segs;
            const pts2=[[x1,y1]];
            for(let s=1;s<segs;s++){
              const jag=(fi*7+ci*13+s*17)%20-10;
              pts2.push([x1+dx*s+jag,y1+dy*s-jag]);
            }
            pts2.push([x2,y2]);
            ctx.lineJoin='round';
            // white halo
            ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.globalAlpha=0.35;
            ctx.beginPath();pts2.forEach(([px,py],i)=>i===0?ctx.moveTo(px,py):ctx.lineTo(px,py));ctx.stroke();
            // colour core
            ctx.strokeStyle=color;ctx.lineWidth=2;ctx.globalAlpha=0.9;
            ctx.beginPath();pts2.forEach(([px,py],i)=>i===0?ctx.moveTo(px,py):ctx.lineTo(px,py));ctx.stroke();
            // inner bright
            ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.globalAlpha=0.5;
            ctx.beginPath();pts2.forEach(([px,py],i)=>i===0?ctx.moveTo(px,py):ctx.lineTo(px,py));ctx.stroke();
          });
          ctx.globalAlpha=1;
        }

        // -- 🔄 Orbit: satellite dots orbit each node -------------------------
        if(animStyle==='orbit'){
          elements.forEach((el,ei)=>{
            const color=el.customColor||el.service.color;
            const cx=el.x-minX+el.width/2, cy=el.y-minY+el.height/2;
            const baseR=Math.max(el.width,el.height)/2+16;
            [0,1,2].forEach(oi=>{
              const speed=1+oi*0.4, offset=oi*(Math.PI*2/3);
              const angle=(fi/30*Math.PI*2*speed)+offset;
              const rx=baseR+(oi*8), ry=baseR*0.55+(oi*5);
              const ox=cx+Math.cos(angle)*rx, oy=cy+Math.sin(angle)*ry;
              const r=3.5-oi*0.8;
              ctx.fillStyle=color;ctx.globalAlpha=0.15;
              ctx.beginPath();ctx.arc(ox,oy,r*2,0,Math.PI*2);ctx.fill();
              ctx.globalAlpha=0.85;
              ctx.beginPath();ctx.arc(ox,oy,r,0,Math.PI*2);ctx.fill();
            });
          });
          ctx.globalAlpha=1;
        }

        // -- 🌐 Network Mesh: shockwave cascades through connected nodes -------
        if(animStyle==='mesh'){
          // Faint mesh lines between nearby nodes
          ctx.strokeStyle='#6366f1';ctx.lineWidth=0.5;ctx.globalAlpha=0.1;
          elements.forEach((a,ai)=>elements.forEach((b,bi)=>{
            if(bi<=ai)return;
            const dist=Math.hypot(a.x-b.x,a.y-b.y); if(dist>400)return;
            ctx.beginPath();ctx.moveTo(a.x-minX+a.width/2,a.y-minY+a.height/2);
            ctx.lineTo(b.x-minX+b.width/2,b.y-minY+b.height/2);ctx.stroke();
          }));
          const srcIdx=Math.floor(fi/12)%Math.max(1,elements.length);
          const src=elements[srcIdx]; if(src){
            const srcColor=src.customColor||src.service.color;
            const wavePhase=(fi%12)/12;
            const cx=src.x-minX+src.width/2, cy=src.y-minY+src.height/2;
            ctx.strokeStyle=srcColor;ctx.lineWidth=2;ctx.globalAlpha=0.55-wavePhase*0.5;
            ctx.beginPath();ctx.arc(cx,cy,20+wavePhase*120,0,Math.PI*2);ctx.stroke();
            connections.filter(c=>c.from===src.id||c.to===src.id).forEach(conn=>{
              const other=findById(conn.from===src.id?conn.to:conn.from); if(!other)return;
              const arrivalPhase=Math.max(0,wavePhase-0.5)*2; if(arrivalPhase<=0)return;
              const oc=other.customColor||other.service.color;
              const ox=other.x-minX+other.width/2, oy=other.y-minY+other.height/2;
              ctx.strokeStyle=oc;ctx.globalAlpha=0.45-arrivalPhase*0.4;
              ctx.beginPath();ctx.arc(ox,oy,10+arrivalPhase*40,0,Math.PI*2);ctx.stroke();
            });
          }
          ctx.globalAlpha=1;
        }

        // -- 🔥 Heatmap: traffic intensity shown by speed & brightness ---------
        if(animStyle==='heatmap'){
          connections.forEach((conn,ci)=>{
            const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
            const pts=bestPts(from,to);
            const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
            const traffic=[0.9,0.3,0.7,0.5,0.95,0.2,0.8][ci%7];
            const speed=0.5+traffic*2, brightness=0.3+traffic*0.7;
            const heatColor=traffic>0.7?'#ef4444':traffic>0.4?'#f59e0b':'#22c55e';
            const phase=((fi*speed+(ci*7))%30)/30;
            const dotX=x1+(x2-x1)*phase, dotY=y1+(y2-y1)*phase;
            ctx.strokeStyle=heatColor;ctx.lineWidth=1+traffic*3;ctx.globalAlpha=brightness*0.4;
            ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
            ctx.fillStyle=heatColor;ctx.globalAlpha=brightness;
            ctx.beginPath();ctx.arc(dotX,dotY,3+traffic*4,0,Math.PI*2);ctx.fill();
            ctx.globalAlpha=brightness*0.2;
            ctx.beginPath();ctx.arc(dotX,dotY,6+traffic*6,0,Math.PI*2);ctx.fill();
          });
          ctx.globalAlpha=1;
        }

        // -- 💓 Heartbeat: ECG spike travels along each connection -------------
        if(animStyle==='heartbeat'){
          const cycleLen=30;
          connections.forEach((conn,ci)=>{
            const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
            const pts=bestPts(from,to);
            const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
            const color=conn.color||'#10b981';
            const len=Math.hypot(x2-x1,y2-y1); if(len<10)return;
            const ang=Math.atan2(y2-y1,x2-x1);
            const nx=Math.cos(ang+Math.PI/2), ny=Math.sin(ang+Math.PI/2);
            const phase=((fi+(ci*9))%cycleLen)/cycleLen;
            const ecg=p=>{
              if(p<0.3||p>0.7)return 0;
              const lp=(p-0.3)/0.4;
              if(lp<0.3)return lp*0.3;
              if(lp<0.45)return 0.09+(lp-0.3)*3;
              if(lp<0.55)return 0.09+0.45-(lp-0.45)*6;
              if(lp<0.65)return Math.max(0,(lp-0.55)*2);
              return 0;
            };
            const N=30;
            ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.globalAlpha=0.9;ctx.lineJoin='round';
            ctx.beginPath();
            for(let i=0;i<=N;i++){
              const t=i/N, wp=((phase+t*0.4)%1);
              const bx=x1+(x2-x1)*t, by=y1+(y2-y1)*t;
              const amp=ecg(wp)*40;
              if(i===0)ctx.moveTo(bx+nx*amp,by+ny*amp);
              else ctx.lineTo(bx+nx*amp,by+ny*amp);
            }
            ctx.stroke();
            ctx.strokeStyle='#fff';ctx.lineWidth=1;ctx.globalAlpha=0.25;
            ctx.beginPath();
            for(let i=0;i<=N;i++){
              const t=i/N, wp=((phase+t*0.4)%1);
              const bx=x1+(x2-x1)*t, by=y1+(y2-y1)*t;
              const amp=ecg(wp)*40;
              if(i===0)ctx.moveTo(bx+nx*amp,by+ny*amp);
              else ctx.lineTo(bx+nx*amp,by+ny*amp);
            }
            ctx.stroke();
          });
          ctx.globalAlpha=1;
        }

        // -- 🌟 Constellation: faint star-field lines between nearby nodes ------
        if(animStyle==='constellation'){
          const drift=Math.sin(fi/20)*3;
          ctx.strokeStyle='#a5b4fc';ctx.lineWidth=0.8;
          elements.forEach((a,ai)=>elements.forEach((b,bi)=>{
            if(bi<=ai)return;
            const dist=Math.hypot(a.x-b.x,a.y-b.y); if(dist>350)return;
            const op=0.08+0.07*Math.sin((fi/15+ai*1.3+bi*0.7));
            ctx.globalAlpha=op;
            ctx.beginPath();
            ctx.moveTo(a.x-minX+a.width/2+drift,a.y-minY+a.height/2);
            ctx.lineTo(b.x-minX+b.width/2,b.y-minY+b.height/2);
            ctx.stroke();
          }));
          // Twinkling star dots at each node centre
          elements.forEach((el,ei)=>{
            const starPh=(fi/20+ei*0.8)%1;
            const r=1.5+Math.sin(starPh*Math.PI*2)*0.8;
            const cx=el.x-minX+el.width/2, cy=el.y-minY+el.height/2;
            ctx.fillStyle='#e0e7ff';ctx.globalAlpha=0.5+Math.sin(starPh*Math.PI*2)*0.3;
            ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();
          });
          ctx.globalAlpha=1;
        }

        // -- 🎯 Ping: radar pings travel and acknowledge on arrival -------------
        if(animStyle==='ping'){
          connections.forEach((conn,ci)=>{
            const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
            const pts=bestPts(from,to);
            const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
            const color=conn.color||'#06b6d4';
            const phase=((fi+(ci*11))%40)/40;
            const px=x1+(x2-x1)*phase, py=y1+(y2-y1)*phase;
            // Expanding ping circle from source
            ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.globalAlpha=Math.max(0,0.6-phase*0.6);
            ctx.beginPath();ctx.arc(x1,y1,phase*30,0,Math.PI*2);ctx.stroke();
            // Travelling dot
            ctx.fillStyle=color;ctx.globalAlpha=0.9;
            ctx.beginPath();ctx.arc(px,py,4,0,Math.PI*2);ctx.fill();
            ctx.globalAlpha=0.2;
            ctx.beginPath();ctx.arc(px,py,8,0,Math.PI*2);ctx.fill();
            // Acknowledgement ring at destination
            const ackPhase=((fi+(ci*11)+36)%40)/40;
            if(ackPhase<0.25){
              ctx.strokeStyle=color;ctx.lineWidth=2;ctx.globalAlpha=Math.max(0,0.7-ackPhase*2.5);
              ctx.beginPath();ctx.arc(x2,y2,ackPhase*50,0,Math.PI*2);ctx.stroke();
            }
          });
          ctx.globalAlpha=1;
        }

        // -- 🏄 Flow Streams: liquid particle rivers along connections ---------
        if(animStyle==='streams'){
          connections.forEach((conn,ci)=>{
            const from=findById(conn.from),to=findById(conn.to);if(!from||!to)return;
            const pts=bestPts(from,to);
            const x1=pts.from.x-minX,y1=pts.from.y-minY,x2=pts.to.x-minX,y2=pts.to.y-minY;
            const color=conn.color||'#3b82f6';
            const len=Math.hypot(x2-x1,y2-y1); if(len<10)return;
            const nx=(y1-y2)/len, ny=(x2-x1)/len; // perpendicular
            // Faint guide
            ctx.strokeStyle=color;ctx.lineWidth=3;ctx.globalAlpha=0.1;
            ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
            // 8 particles
            for(let pi=0;pi<8;pi++){
              const speed=0.7+pi*0.08;
              const phase=((fi*speed+(ci*7)+(pi*3.75))%30)/30;
              const jitter=((pi*17+ci*11)%10-5)*0.5;
              const px=x1+(x2-x1)*phase+nx*jitter;
              const py=y1+(y2-y1)*phase+ny*jitter;
              const r=1.5+Math.sin(phase*Math.PI*3)*1.2;
              const op=0.25+Math.sin(phase*Math.PI*2)*0.35;
              ctx.fillStyle=color;ctx.globalAlpha=op*0.15;
              ctx.beginPath();ctx.arc(px,py,r*2.5,0,Math.PI*2);ctx.fill();
              ctx.globalAlpha=op;
              ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);ctx.fill();
            }
          });
          ctx.globalAlpha=1;
        }

        // -- 🎨 Colour Shift: warm/cool mood gradient overlay ------------------
        if(animStyle==='colorshift'){
          const ph=(fi%60)/60;
          const hue=Math.round(ph*360);
          const sat=60+Math.sin(ph*Math.PI*2)*20;
          // Diagonal gradient overlay matching the CSS filter approach
          const grad=ctx.createLinearGradient(0,0,fullW,fullH);
          grad.addColorStop(0,`hsla(${hue},${sat}%,50%,0.08)`);
          grad.addColorStop(1,`hsla(${(hue+120)%360},${sat}%,50%,0.05)`);
          ctx.fillStyle=grad;ctx.globalAlpha=1;
          ctx.fillRect(0,0,fullW,fullH);
        }

        // Watermark
        ctx.shadowBlur=0;ctx.globalAlpha=1;
        ctx.font='bold 10px Arial';ctx.fillStyle='rgba(148,163,184,0.6)';
        ctx.textAlign='right';ctx.textBaseline='bottom';
        ctx.fillText('Made with CloudForger',fullW-6,fullH-5);
        const out=document.createElement('canvas');
        out.width=gW; out.height=gH;
        const octx=out.getContext('2d');
        octx.imageSmoothingEnabled=true;
        octx.imageSmoothingQuality='high';
        octx.drawImage(full,0,0,gW,gH);
        return out;
      };

      // -- Pure-JS GIF encoder -----------------------------------------------
      const encodeGIF=(frames,delayCS)=>{
        // All frames MUST be the same size - use first frame as authoritative
        const W=frames[0].width, H=frames[0].height;

        const bytes=[];
        const wb=b=>bytes.push(b&0xFF);
        const ws=s=>{wb(s&0xFF);wb((s>>8)&0xFF);};
        const wStr=s=>{for(let i=0;i<s.length;i++)wb(s.charCodeAt(i));};

        // Palette: 6x6x6 RGB cube (216) + greyscale ramp (40) = 256 entries
        const pal=[];
        for(let r=0;r<6;r++)for(let g=0;g<6;g++)for(let b=0;b<6;b++)
          pal.push([r*51,g*51,b*51]);
        for(let i=0;i<40;i++){const v=Math.round(i*6.5);pal.push([v,v,v]);}
        while(pal.length<256)pal.push([0,0,0]);

        // Nearest colour lookup (fast - no search needed with cube palette)
        const nearest=(r,g,b)=>{
          const cr=Math.round(r/51),cg=Math.round(g/51),cb=Math.round(b/51);
          const cubeIdx=cr*36+cg*6+cb;
          const grey=Math.round((r*0.299+g*0.587+b*0.114)/6.5);
          const greyIdx=216+Math.min(39,grey);
          const dc=(r-pal[cubeIdx][0])**2+(g-pal[cubeIdx][1])**2+(b-pal[cubeIdx][2])**2;
          const dg=(r-pal[greyIdx][0])**2+(g-pal[greyIdx][1])**2+(b-pal[greyIdx][2])**2;
          return dg<dc?greyIdx:cubeIdx;
        };

        // Quantize a canvas to palette indices
        const quantize=cnv=>{
          // Force-read at exact WxH - redraws if canvas is different size
          let src=cnv;
          if(cnv.width!==W||cnv.height!==H){
            src=document.createElement('canvas');
            src.width=W;src.height=H;
            src.getContext('2d').drawImage(cnv,0,0,W,H);
          }
          const d=src.getContext('2d').getImageData(0,0,W,H).data;
          const idx=new Uint8Array(W*H);
          for(let i=0;i<W*H;i++)idx[i]=nearest(d[i*4],d[i*4+1],d[i*4+2]);
          return idx;
        };

        // LZW encoder
        const lzw=(indices,minSz)=>{
          const clear=1<<minSz,eoi=clear+1;
          let cs=minSz+1,lim=(1<<cs),code=clear+2;
          const tbl=new Map();
          const out=[];let buf=0,bits=0;
          const emit=c=>{buf|=(c<<bits);bits+=cs;while(bits>=8){out.push(buf&255);buf>>=8;bits-=8;}};
          emit(clear);
          if(!indices.length){emit(eoi);if(bits)out.push(buf&255);return out;}
          let str=indices[0];
          for(let i=1;i<indices.length;i++){
            const k=indices[i],key=(str<<8)|k;
            if(tbl.has(key)){str=tbl.get(key);}
            else{
              emit(str);
              if(code>=4096){emit(clear);tbl.clear();code=clear+2;cs=minSz+1;lim=1<<cs;}
              else{tbl.set(key,code++);if(code>lim&&cs<12){cs++;lim=1<<cs;}}
              str=k;
            }
          }
          emit(str);emit(eoi);if(bits)out.push(buf&255);
          return out;
        };

        const subBlocks=data=>{
          let i=0;
          while(i<data.length){const n=Math.min(255,data.length-i);wb(n);for(let j=0;j<n;j++)wb(data[i++]);}
          wb(0);
        };

        // GIF89a header
        wStr('GIF89a');ws(W);ws(H);
        wb(0xF7);wb(0);wb(0); // gct flag, 256 colours
        for(const c of pal){wb(c[0]);wb(c[1]);wb(c[2]);}

        // Netscape loop extension
        wStr('\x21\xFF\x0BNETSCAPE2.0\x03\x01');ws(0);wb(0);

        // Write each frame
        for(const cnv of frames){
          const idx=quantize(cnv);
          wStr('\x21\xF9\x04\x00');ws(delayCS);wb(0);wb(0); // GCE
          wStr('\x2C');ws(0);ws(0);ws(W);ws(H);wb(0);       // image descriptor
          wb(8);                                              // LZW min code size
          subBlocks(lzw(idx,8));
        }

        wb(0x3B);
        return new Uint8Array(bytes);
      };

      // ---- Render frames (yield between batches to keep UI responsive) ----
      const frameCanvases=[];
      const batchSize=5;
      for(let i=0;i<totalFrames;i++){
        frameCanvases.push(drawFrame(i));
        if(i%batchSize===batchSize-1) await new Promise(r=>setTimeout(r,0));
      }

      setToast({msg:'Encoding GIF… almost done ✨',type:'info'});
      await new Promise(r=>setTimeout(r,0));

      const delayCS=Math.round(frameDelay/10);
      const gifBytes=encodeGIF(frameCanvases,delayCS);
      const blob=new Blob([gifBytes],{type:'image/gif'});
      const url=URL.createObjectURL(blob);
      const safeName=(diagramTitle||'archforge').toLowerCase().replace(/[^a-z0-9]+/g,'-');
      const a=document.createElement('a');
      a.download=`${safeName}-animated.gif`;
      a.href=url;document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),2000);

      setIsExportingGif(false);
      setToast({msg:'Animated GIF downloaded! 🎉 Perfect for LinkedIn posts.',type:'success'});
      setTimeout(()=>setToast(null),5000);

    }catch(e){
      console.error('GIF export error:',e);
      setIsExportingGif(false);
      setToast({msg:`GIF export failed: ${e.message}`,type:'info'});
      setTimeout(()=>setToast(null),5000);
    }
  };

  // Share diagram - Web Share API (mobile) or clipboard+download (desktop)
  const shareDiagram=async(platform)=>{
    const has=elements.length||borders.length||icons.length||bubbles.length;
    if(!has){setToast({msg:'Add some elements to share!',type:'info'});setTimeout(()=>setToast(null),3000);setShowShareModal(false);return;}
    setShowShareModal(false);

    const title=diagramTitle||'My AWS Architecture';
    const caption=`Check out my AWS architecture diagram "${title}" built with CloudForger! 🚀 #AWS #CloudArchitecture #CloudForger`;
    const dataUrl=await buildDiagramDataUrl('png');
    if(!dataUrl){setToast({msg:'Nothing to export!',type:'info'});setTimeout(()=>setToast(null),3000);return;}

    // Build file for Web Share API
    const res=await fetch(dataUrl);
    const blob=await res.blob();
    const file=new File([blob],`${title}.png`,{type:'image/png'});

    // Mobile: Web Share API opens native share sheet with image attached
    // User picks LinkedIn / Instagram / TikTok directly from the sheet
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{
        await navigator.share({files:[file],title,text:caption});
        return;
      }catch(e){
        if(e.name==='AbortError') return;
      }
    }

    // Desktop fallback: copy caption to clipboard + download image
    try{ await navigator.clipboard.writeText(caption); }catch(_){}
    const a=document.createElement('a');
    a.download=`${title}.png`;a.href=dataUrl;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setToast({msg:'Caption copied & image downloaded - paste and attach when posting! ✅',type:'success'});
    setTimeout(()=>setToast(null),7000);
  };

  // Open share modal and pre-render preview
  const openShareModal=()=>{
    const has=elements.length||borders.length||icons.length||bubbles.length;
    if(!has){setToast({msg:'Add some elements first.',type:'info'});setTimeout(()=>setToast(null),3000);return;}
    setTimeout(async()=>{
      const url=await buildDiagramDataUrl('png');
      setSharePreviewUrl(url);
      setShowShareModal(true);
    },0);
  };

  // Render connection
  const renderConn=conn=>{
    const from=findById(conn.from),to=findById(conn.to);
    if(!from||!to)return null;
    const pts=bestPts(from,to);
    const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
    const color=conn.color||'#3b82f6',sw=conn.strokeWidth||3,as=conn.arrowSize||14;
    const isSelected=selectedConn===conn.id;
    const fromColor=(from.customColor||from.service?.color||color);
    const toColor=(to.customColor||to.service?.color||color);
    const isGradient=connVisualStyle==='gradient';
    const isParticle=connVisualStyle==='particle';
    // Animated dashes: flowing when conn.animated=true and full animation is off
    const isAnimDash=!!conn.animated&&!animEnabled;
    // Static dash style
    const staticDash=conn.dashStyle==='dashed'?`${8/zoom} ${5/zoom}`:conn.dashStyle==='dotted'?`${2/zoom} ${4/zoom}`:null;
    // Path: straight, bent, or bezier curve
    let pathD,arrowAngle;
    if(conn.pathStyle==='curve'){
      const dy=Math.abs(y2-y1),dx=Math.abs(x2-x1);
      const bend=Math.min(dy,dx)*0.5+40;
      const cpx=(x1+x2)/2,cpy=Math.min(y1,y2)-bend;
      pathD=`M${x1},${y1} Q${cpx},${cpy} ${x2},${y2}`;
      arrowAngle=Math.atan2(y2-cpy,x2-cpx)*180/Math.PI;
    } else if(conn.bent){
      const mx=(x1+x2)/2;
      pathD=`M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}`;
      arrowAngle=y2>y1?90:-90;
    } else {
      pathD=`M${x1},${y1} L${x2},${y2}`;
      arrowAngle=Math.atan2(y2-y1,x2-x1)*180/Math.PI;
    }
    const gradId=`grad_${conn.id}`;
    const animDashLen=20/zoom, animGapLen=10/zoom;
    const particleDots=isParticle?[0,0.25,0.5,0.75].map((off,pi)=>{
      const ph=((animTickRef.current+(pi*8))%30)/30;
      const pp=0.05+(ph*0.90+off)%0.90;
      return {x:x1+(x2-x1)*pp, y:y1+(y2-y1)*pp, op:0.4+Math.sin(ph*Math.PI*2)*0.35, r:2.5+Math.sin(ph*Math.PI*2)*1};
    }):[];
    return (
      <g key={conn.id}>
        {isGradient&&(
          <defs>
            <linearGradient id={gradId} x1={x1} y1={y1} x2={x2} y2={y2} gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor={fromColor}/>
              <stop offset="100%" stopColor={toColor}/>
            </linearGradient>
          </defs>
        )}
        {isAnimDash&&<style>{`@keyframes dashflow_${conn.id}{to{stroke-dashoffset:-${(animDashLen+animGapLen).toFixed(1)}}}`}</style>}
        <path d={pathD} stroke="transparent" strokeWidth={Math.max(sw+16,22)} fill="none" style={{cursor:'pointer'}} onClick={e=>onConnClick(e,conn.id)} onContextMenu={e=>onConnRightClick(e,conn.id)}/>
        {isSelected&&<path d={pathD} stroke="#fbbf24" strokeWidth={sw+6} fill="none" strokeDasharray="6 3" style={{pointerEvents:'none'}}/>}
        <path d={pathD}
          stroke={isGradient?`url(#${gradId})`:color}
          strokeWidth={sw} fill="none"
          strokeDasharray={isAnimDash?`${animDashLen} ${animGapLen}`:staticDash||undefined}
          style={{
            pointerEvents:'none',
            animation:isAnimDash?`dashflow_${conn.id} 0.5s linear infinite`:
              conn.animation==='pulse'?`pulseWave 1.4s ease-in-out infinite`:
              conn.animation==='colorshift'?`connColorShift 3s linear infinite`:undefined,
            '--sw':sw,
          }}
          opacity={isParticle?0.35:1}/>
        {conn.type==='arrow'&&<g transform={`translate(${x2},${y2}) rotate(${arrowAngle})`} style={{pointerEvents:'none'}}><path d={`M0,0 L${-as},${-as*0.5} L${-as},${as*0.5} Z`} fill={isGradient?toColor:color}/></g>}
        {conn.bent&&!conn.pathStyle&&<circle cx={(x1+x2)/2} cy={(y1+y2)/2} r={4} fill={color} opacity={0.5} style={{pointerEvents:'none'}}/>}
        {isParticle&&particleDots.map((d,pi)=>(
          <g key={pi} style={{pointerEvents:'none'}}>
            <circle cx={d.x} cy={d.y} r={(d.r+3)/zoom} fill={color} opacity={d.op*0.2}/>
            <circle cx={d.x} cy={d.y} r={d.r/zoom} fill={color} opacity={d.op}/>
          </g>
        ))}
        {conn.midLabel&&conn.midLabel.trim()&&(()=>{
          const mx=(x1+x2)/2, my=(y1+y2)/2;
          const lw=(conn.midLabel.length*7+12)/zoom, lh=18/zoom;
          return(
            <g style={{pointerEvents:'none'}}>
              <rect x={mx-lw/2} y={my-lh/2} width={lw} height={lh} rx={4/zoom} fill={cardBg||'#fff'} stroke={color} strokeWidth={1/zoom} opacity={0.95}/>
              <text x={mx} y={my+5/zoom} textAnchor="middle" fill={color} fontSize={10/zoom} fontWeight="700" fontFamily="Arial">{conn.midLabel}</text>
            </g>
          );
        })()}
      </g>
    );
  };

  // Separate renderer for labels only - called after animation overlay so labels always sit on top
  const renderConnLabel=conn=>{
    if(!conn.midLabel||!conn.midLabel.trim()) return null;
    const from=findById(conn.from),to=findById(conn.to);
    if(!from||!to) return null;
    const pts=bestPts(from,to);
    const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
    const color=conn.color||'#3b82f6';
    const mx=(x1+x2)/2, my=(y1+y2)/2;
    const lw=(conn.midLabel.length*7+16)/zoom, lh=20/zoom;
    return(
      <g key={`lbl_${conn.id}`} style={{pointerEvents:'none'}}>
        <rect x={mx-lw/2} y={my-lh/2} width={lw} height={lh} rx={4/zoom}
          fill={cardBg||'#ffffff'} stroke={color} strokeWidth={1.5/zoom} opacity={1}/>
        <text x={mx} y={my+5.5/zoom} textAnchor="middle" fill={color}
          fontSize={10.5/zoom} fontWeight="800" fontFamily="Arial">{conn.midLabel}</text>
      </g>
    );
  };

  // -- JSX --------------------------------------------------------------------
  return (
    <div style={{height:'100%',background:bg,color:textC,fontFamily:'Inter,Arial,sans-serif',display:'flex',flexDirection:'column',overflow:'hidden'}}>
      <div style={{display:'flex',flex:1,overflow:'hidden'}}>

        {/* Desktop sidebar */}
        {!isMobile&&(
          <div style={{width:240,background:cardBg,borderRight:`1px solid ${borderC}`,display:'flex',flexDirection:'column',flexShrink:0}}>
            {/* Tab bar */}
            <div style={{display:'flex',borderBottom:`1px solid ${borderC}`}}>
              {['services','icons'].map(tab=>(
                <button key={tab} onClick={()=>setActiveTab(tab)} style={{flex:1,padding:'9px 4px',fontSize:11,fontWeight:600,cursor:'pointer',border:'none',background:activeTab===tab?accent:'transparent',color:activeTab===tab?'#fff':textC}}>
                  {tab==='services'?'Services':'Icons'}
                </button>
              ))}
            </div>
            {/* Provider switcher - shown only on Services tab */}
            {activeTab==='services'&&(
              <div style={{display:'flex',gap:4,padding:'8px 8px 4px',borderBottom:`1px solid ${borderC}`}}>
                {CLOUD_PROVIDERS.map(p=>(
                  <button key={p.id} onClick={()=>setProvider(p.id)}
                    style={{flex:1,padding:'5px 2px',borderRadius:7,border:`1.5px solid ${provider===p.id?p.color:borderC}`,background:provider===p.id?p.color+'18':'transparent',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:2,transition:'all 0.15s'}}>
                    <span style={{fontSize:16}}>{p.logo}</span>
                    <span style={{fontSize:9,fontWeight:700,color:provider===p.id?p.color:textMut}}>{p.name}</span>
                  </button>
                ))}
              </div>
            )}
            <div style={{flex:1,overflowY:'auto',padding:8}}>
              {activeTab==='services'&&(<>
                {/* AI Generate button */}
                <button onClick={()=>{if(tryPremiumAction('Generate with AI'))setShowAiModal(true);}} style={{width:'100%',marginBottom:5,padding:'8px',background:'linear-gradient(135deg,#7c3aed,#2563eb)',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6,boxShadow:'0 2px 10px rgba(124,58,237,0.35)'}}>
                  ✨ Generate with AI
                </button>
                {/* Import Terraform button */}
                <button onClick={()=>{if(tryPremiumAction('Import from Terraform'))setShowTerraformImportModal(true);}}
                  style={{width:'100%',marginBottom:5,padding:'8px',background:'linear-gradient(135deg,#0f766e,#0e7490)',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6,boxShadow:'0 2px 10px rgba(14,116,144,0.35)'}}>
                  📂 Import from Terraform
                </button>
                {/* Import from Image/Document button */}
                <button onClick={()=>{if(tryPremiumAction('Import from Image / Doc'))setShowImportModal(true);}}
                  style={{width:'100%',marginBottom:5,padding:'8px',background:'linear-gradient(135deg,#0369a1,#0284c7)',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6,boxShadow:'0 2px 10px rgba(3,105,161,0.35)'}}>
                  📥 Import from Image / Doc
                </button>
                {/* My Library button */}
                <button onClick={()=>setShowLibraryPanel(true)}
                  style={{width:'100%',marginBottom:5,padding:'8px',background:darkMode?'#374151':'#f1f5f9',color:textC,border:`1px solid ${borderC}`,borderRadius:8,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                  🗂️ My Library {savedCount>0&&`(${savedCount})`}
                </button>
                {/* Terraform Export button */}
                <button onClick={()=>{const has=elements.length||borders.length;if(!has){return;}if(tryPremiumAction('Export IaC Code'))setShowIaCExportModal(true);}} title={!elements.length&&!borders.length?'Add elements to the canvas first':'Export infrastructure code (Terraform, CloudFormation, CDK)'}
                  style={{width:'100%',marginBottom:7,padding:'8px',background:elements.length||borders.length?'linear-gradient(135deg,#0f766e,#0891b2)':'#6b7280',color:'#fff',border:'none',borderRadius:8,cursor:elements.length||borders.length?'pointer':'not-allowed',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6,boxShadow:elements.length||borders.length?'0 2px 10px rgba(8,145,178,0.35)':'none',opacity:elements.length||borders.length?1:0.6}}>
                  {'</>'} Export IaC Code
                </button>
                <button onClick={()=>setShowTemplates(s=>!s)} style={{width:'100%',marginBottom:7,padding:'7px',background:accent,color:'#fff',border:'none',borderRadius:7,cursor:'pointer',fontSize:11,fontWeight:600,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                  <Layers size={13}/> Templates
                </button>
                {showTemplates&&ARCHITECTURE_TEMPLATES.map(t=>(
                  <div key={t.id} onClick={()=>loadTemplate(t)} style={{marginBottom:5,padding:'7px 9px',borderRadius:7,border:`1px solid ${borderC}`,cursor:'pointer',display:'flex',alignItems:'center',gap:7,fontSize:11}}>
                    <span style={{fontSize:16}}>{t.icon}</span>
                    <div><div style={{fontWeight:600}}>{t.name}</div><div style={{color:'#9ca3af',fontSize:10}}>{t.description}</div></div>
                  </div>
                ))}
                <div style={{position:'relative',marginBottom:7}}>
                  <Search size={12} style={{position:'absolute',left:7,top:8,color:'#9ca3af'}}/>
                  <input value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} placeholder="Search…" style={{width:'100%',paddingLeft:24,paddingRight:7,paddingTop:6,paddingBottom:6,borderRadius:6,border:`1px solid ${borderC}`,background:cardBg,color:textC,fontSize:11,boxSizing:'border-box'}}/>
                </div>
                {/* Add custom service button */}
                <button onClick={()=>setShowCustomSvcModal(true)} style={{width:'100%',marginBottom:7,padding:'6px 8px',borderRadius:7,border:`1.5px dashed ${accent}`,background:'transparent',color:accent,cursor:'pointer',fontSize:11,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                  <Plus size={12}/> Add Custom Service
                </button>
                {filteredSvc.map(s=>(
                  <div key={s.id} draggable onDragStart={()=>setDraggingService({type:'service',data:s})} style={{marginBottom:4,padding:'6px 8px',borderRadius:7,border:`1px solid ${borderC}`,borderLeft:`4px solid ${s.color}`,cursor:'grab',display:'flex',alignItems:'center',gap:7,fontSize:11,position:'relative'}}
                    title={s.custom?'Custom service (drag to canvas)':s.desc}>
                    <span style={{fontSize:17}}>{s.icon}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,display:'flex',alignItems:'center',gap:4}}>
                        {s.name}
                        {s.custom&&<span style={{fontSize:8,padding:'1px 4px',borderRadius:3,background:accent+'22',color:accent,fontWeight:700}}>CUSTOM</span>}
                      </div>
                      <div style={{color:'#9ca3af',fontSize:10}}>{s.desc}</div>
                    </div>
                    {s.custom&&<button onClick={e=>{e.stopPropagation();setCustomServices(p=>p.filter(x=>x.id!==s.id));}} style={{background:'none',border:'none',cursor:'pointer',color:'#ef4444',fontSize:14,padding:'0 2px',lineHeight:1,flexShrink:0}} title="Remove custom service">x</button>}
                  </div>
                ))}
              </>)}
              {activeTab==='icons'&&(<>
                <div style={{position:'relative',marginBottom:7}}>
                  <Search size={12} style={{position:'absolute',left:7,top:8,color:'#9ca3af'}}/>
                  <input value={iconSearch} onChange={e=>setIconSearch(e.target.value)} placeholder="Search…" style={{width:'100%',paddingLeft:24,paddingRight:7,paddingTop:6,paddingBottom:6,borderRadius:6,border:`1px solid ${borderC}`,background:cardBg,color:textC,fontSize:11,boxSizing:'border-box'}}/>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:5}}>
                  {filteredIcons2.map(ic=>(
                    <div key={ic.id} draggable onDragStart={()=>setDraggingService({type:'icon',data:ic})} style={{padding:'5px 3px',borderRadius:7,border:`1px solid ${borderC}`,cursor:'grab',display:'flex',flexDirection:'column',alignItems:'center',gap:2}}>
                      <span style={{fontSize:22}}>{ic.icon}</span>
                      <span style={{fontSize:9,textAlign:'center',color:'#6b7280'}}>{ic.name}</span>
                    </div>
                  ))}
                </div>
              </>)}
            </div>
          </div>
        )}

        {/* Main area */}
        <div style={{flex:1,position:'relative',overflow:'hidden'}}>

          {/* Desktop toolbar */}
          {!isMobile&&(
            <div style={{position:'absolute',top:10,right:10,zIndex:100,background:cardBg,border:`1px solid ${borderC}`,borderRadius:11,padding:'5px 7px',boxShadow:'0 2px 12px rgba(0,0,0,0.10)',display:'flex',alignItems:'center',gap:3,flexWrap:'wrap',maxWidth:'calc(100% - 180px)'}}>
              <button onClick={()=>setZoom(z=>Math.min(z+0.1,3))} style={btnStyle(false)} title="Zoom In"><ZoomIn size={14}/></button>
              <button onClick={()=>setZoom(z=>Math.max(z-0.1,0.3))} style={btnStyle(false)} title="Zoom Out"><ZoomOut size={14}/></button>
              <button onClick={undo} disabled={!history.length} style={{...btnStyle(false),opacity:history.length?1:0.3}} title="Undo"><Undo size={14}/></button>
              <button onClick={zoomToFit} title="Zoom to fit" style={btnStyle(false)}><span style={{fontSize:13}}>⊡</span></button>
              <button onClick={()=>setShowHistory(v=>!v)} title="History" style={btnStyle(showHistory,'#f59e0b')}><span style={{fontSize:12}}>🕐</span></button>
              <div style={{width:1,height:20,background:borderC,margin:'0 2px'}}/>
              <button onClick={()=>{if(drawingBorder){setDrawingBorder(false);setBorderDragStart(null);setBorderPreview(null);}else{setDrawingBorder(true);setDrawMode(null);}}} style={btnStyle(drawingBorder,'#7c3aed')} title="Draw Border"><Square size={14}/></button>
              <button onClick={()=>toggleDraw('straight-arrow')} style={btnStyle(drawMode==='straight-arrow')} title="Straight Arrow"><ArrowRight size={14}/></button>
              <button onClick={()=>toggleDraw('straight-line')} style={btnStyle(drawMode==='straight-line','#16a34a')} title="Straight Line"><Move size={14}/></button>
              <button onClick={()=>toggleDraw('bent-arrow')} style={btnStyle(drawMode==='bent-arrow','#ea580c')} title="Bent Arrow"><CornerDownRight size={14}/></button>
              <button onClick={()=>toggleDraw('bent-line')} style={btnStyle(drawMode==='bent-line','#0891b2')} title="Bent Line"><CornerDownRight size={14} style={{opacity:0.6}}/></button>
              <div style={{width:1,height:20,background:borderC,margin:'0 2px'}}/>
              <button onClick={handleAddLabel} title={selectedBorder?'Add label':'Select border first'} style={{...btnStyle(false),color:selectedBorder?accent:'#9ca3af',cursor:selectedBorder?'pointer':'not-allowed',fontWeight:700,fontSize:11,gap:3}}>
                <Type size={13}/> Label
              </button>
              <div style={{position:'relative'}}>
                <button onClick={()=>setShowBubbleMenu(v=>!v)}
                  style={{padding:'6px 8px',borderRadius:7,border:`1.5px solid ${showBubbleMenu?accent:'transparent'}`,background:showBubbleMenu?accent+'18':'transparent',color:textC,cursor:'pointer',fontWeight:700,fontSize:11,display:'flex',alignItems:'center',gap:3}}>
                  <MessageSquare size={13}/> Bubble ▾
                </button>
                {showBubbleMenu&&(
                  <div style={{position:'absolute',top:34,left:0,background:cardBg,border:`1px solid ${borderC}`,borderRadius:9,padding:6,display:'flex',flexDirection:'column',gap:2,boxShadow:'0 4px 16px rgba(0,0,0,0.18)',zIndex:400,minWidth:140}}
                    onMouseLeave={()=>setShowBubbleMenu(false)}>
                    {BUBBLE_SHAPES.map(sh=>(
                      <button key={sh.id} onClick={()=>{handleAddBubble(sh.id);setShowBubbleMenu(false);}}
                        style={{padding:'7px 12px',borderRadius:6,border:'none',background:'transparent',cursor:'pointer',textAlign:'left',fontSize:12,fontWeight:500,color:textC,width:'100%'}}
                        onMouseEnter={e=>e.currentTarget.style.background=darkMode?'#374151':'#dbeafe'}
                        onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                        {sh.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Text Banner button */}
              <button onClick={()=>{if(selectedText){setShowBannerEditor(true);}else{handleAddBanner();}}} title="Add text banner"
                style={{...btnStyle(!!selectedText,'#f59e0b'),fontWeight:700,fontSize:11,gap:3}}>
                <Type size={13}/> Text
              </button>
              <button onClick={handleDelete} style={{...btnStyle(false),color:'#ef4444'}}><Trash2 size={14}/></button>
              <div style={{width:1,height:20,background:borderC,margin:'0 2px'}}/>
              {['png','jpeg'].map(fmt=>(
                <button key={fmt} onClick={()=>exportDiagram(fmt)} style={{padding:'4px 8px',borderRadius:6,border:'none',background:'transparent',color:textC,cursor:'pointer',fontWeight:700,fontSize:10}}>
                  {fmt.toUpperCase()}
                </button>
              ))}
              <button onClick={exportGif} disabled={isExportingGif||(!elements.length&&!borders.length)} title="Export animated GIF"
                style={{padding:'4px 8px',borderRadius:6,border:'none',background:'transparent',color:isExportingGif?textMut:'#a855f7',cursor:isExportingGif||(!elements.length&&!borders.length)?'not-allowed':'pointer',fontWeight:700,fontSize:10,opacity:elements.length||borders.length?1:0.4}}>
                {isExportingGif?'GIF…':'GIF'}
              </button>
              <div style={{width:1,height:20,background:borderC,margin:'0 2px'}}/>
              <button onClick={()=>setShowAnimPanel(p=>!p)} title="Animation settings"
                style={{...btnStyle(animEnabled||showAnimPanel,'#a855f7'),fontSize:10,fontWeight:700,gap:3,padding:'5px 8px',position:'relative'}}>
                {animEnabled?'◎ Anim ON':'◎ Animate'}
              </button>
              <button onClick={()=>{if((elements.length||borders.length)&&tryPremiumAction('Architecture Validation'))setShowValidationPanel(p=>!p);}}
                title={!elements.length&&!borders.length?'Add elements first':'Validate architecture'}
                style={{...btnStyle(showValidationPanel,'#10b981'),fontSize:10,fontWeight:700,gap:3,padding:'5px 8px',opacity:elements.length||borders.length?1:0.4,cursor:elements.length||borders.length?'pointer':'not-allowed'}}>
                ✓ Validate
              </button>
              <button onClick={()=>{if(elements.length&&tryPremiumAction('Architecture Comparison'))setShowCompareModal(true);}}
                title={!elements.length?'Add elements first':'Compare with another architecture'}
                style={{...btnStyle(showCompareModal,'#6366f1'),fontSize:10,fontWeight:700,gap:3,padding:'5px 8px',opacity:elements.length?1:0.4,cursor:elements.length?'pointer':'not-allowed'}}>
                ⚖️ Compare
              </button>
            </div>
          )}

          {/* Mobile toolbar */}
          {isMobile&&(
            <div style={{position:'absolute',top:8,left:0,right:0,zIndex:100,display:'flex',flexDirection:'column',gap:5,padding:'0 8px'}}>
              {/* Row 1: Zoom / Undo / Add */}
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:4}}>
                <div style={{display:'flex',gap:3,background:cardBg,border:`1px solid ${borderC}`,borderRadius:9,padding:'4px 5px',boxShadow:'0 2px 8px rgba(0,0,0,0.12)'}}>
                  <button onClick={()=>setZoom(z=>Math.max(z-0.2,0.3))} style={btnStyle(false)}><ZoomOut size={15}/></button>
                  <span style={{fontSize:11,fontWeight:700,color:textMut,alignSelf:'center',minWidth:30,textAlign:'center'}}>{Math.round(zoom*100)}%</span>
                  <button onClick={()=>setZoom(z=>Math.min(z+0.2,3))} style={btnStyle(false)}><ZoomIn size={15}/></button>
                  <div style={{width:1,height:18,background:borderC,margin:'0 1px'}}/>
                  <button onClick={undo} disabled={!history.length} style={{...btnStyle(false),opacity:history.length?1:0.3}}><Undo size={15}/></button>
                  <div style={{width:1,height:18,background:borderC,margin:'0 1px'}}/>
                  <button onClick={zoomToFit} title="Zoom to fit" style={btnStyle(false)}><span style={{fontSize:12}}>⊡</span></button>
                </div>
                <button onClick={()=>setShowMobilePanel(p=>!p)} style={{background:showMobilePanel?accent:cardBg,border:`1px solid ${showMobilePanel?accent:borderC}`,color:showMobilePanel?'#fff':textC,borderRadius:9,padding:'7px 14px',fontSize:12,fontWeight:700,cursor:'pointer',boxShadow:'0 2px 8px rgba(0,0,0,0.12)',flexShrink:0}}>
                  {showMobilePanel?'✕ Close':'+ Add'}
                </button>
              </div>

              {/* Row 2: Draw tools */}
              <div style={{display:'flex',alignItems:'center',gap:3,background:cardBg,border:`1px solid ${borderC}`,borderRadius:9,padding:'4px 6px',boxShadow:'0 2px 8px rgba(0,0,0,0.10)'}}>
                {/* Border */}
                <button onClick={()=>{if(drawingBorder){setDrawingBorder(false);setBorderDragStart(null);setBorderPreview(null);}else{setDrawingBorder(true);setDrawMode(null);}}}
                  style={{...btnStyle(drawingBorder,'#7c3aed'),flexDirection:'column',gap:1,padding:'4px 6px',minWidth:36}} title="Draw Border">
                  <Square size={14}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>Border</span>
                </button>
                <div style={{width:1,height:28,background:borderC}}/>
                {/* Arrows */}
                <button onClick={()=>toggleDraw('straight-arrow')} style={{...btnStyle(drawMode==='straight-arrow'),flexDirection:'column',gap:1,padding:'4px 5px',minWidth:32}} title="Straight Arrow">
                  <ArrowRight size={14}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>Arrow</span>
                </button>
                <button onClick={()=>toggleDraw('bent-arrow')} style={{...btnStyle(drawMode==='bent-arrow','#ea580c'),flexDirection:'column',gap:1,padding:'4px 5px',minWidth:32}} title="Bent Arrow">
                  <CornerDownRight size={14}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>Bent</span>
                </button>
                {/* Lines */}
                <button onClick={()=>toggleDraw('straight-line')} style={{...btnStyle(drawMode==='straight-line','#16a34a'),flexDirection:'column',gap:1,padding:'4px 5px',minWidth:30}} title="Straight Line">
                  <Move size={14}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>Line</span>
                </button>
                <button onClick={()=>toggleDraw('bent-line')} style={{...btnStyle(drawMode==='bent-line','#0891b2'),flexDirection:'column',gap:1,padding:'4px 5px',minWidth:30}} title="Bent Line">
                  <CornerDownRight size={14} style={{opacity:0.7}}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>B.Line</span>
                </button>
                <div style={{width:1,height:28,background:borderC}}/>
                {/* Label */}
                <button onClick={handleAddLabel} title={selectedBorder?'Add label to border':'Select a border first'}
                  style={{...btnStyle(false),flexDirection:'column',gap:1,padding:'4px 5px',minWidth:32,color:selectedBorder?accent:'#9ca3af',cursor:selectedBorder?'pointer':'not-allowed'}}>
                  <Type size={14}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>Label</span>
                </button>
                {/* Bubble - tap to cycle through shapes */}
                <button onClick={()=>handleAddBubble('speech')} title="Add speech bubble"
                  style={{...btnStyle(false),flexDirection:'column',gap:1,padding:'4px 5px',minWidth:34}}>
                  <MessageSquare size={14}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>Bubble</span>
                </button>
              {/* Text Banner */}
                <button onClick={()=>{
                  if(selectedText){setShowBannerEditor(true);}
                  else{handleAddBanner();}
                }} title="Add text banner"
                  style={{...btnStyle(selectedText,'#f59e0b'),flexDirection:'column',gap:1,padding:'4px 5px',minWidth:32}}>
                  <Type size={14}/>
                  <span style={{fontSize:8,fontWeight:700,lineHeight:1}}>Text</span>
                </button>
                <div style={{flex:1}}/>
                {/* Delete */}
                <button onClick={handleDelete} style={{...btnStyle(false),color:'#ef4444',padding:'4px 6px'}} title="Delete selected"><Trash2 size={15}/></button>
              </div>
            </div>
          )}

          {/* Desktop status */}
          {!isMobile&&(
            <div style={{position:'absolute',top:10,left:10,zIndex:100,background:'#fbbf24',color:'#1c1917',padding:'4px 10px',borderRadius:7,fontSize:11,fontWeight:700,boxShadow:'0 2px 6px rgba(0,0,0,0.08)'}}>
              {zoom.toFixed(1)}x
              {drawMode&&` · ${drawMode.includes('arrow')?'-> arrow':'- line'} ${drawMode.includes('bent')?'(bent)':'(straight)'} - click 2 items`}
              {drawingBorder&&' · drag to draw border · Esc to stop'}
              {!drawMode&&!drawingBorder&&selectedBorder&&' · border selected - click Label ↑'}
              {!drawMode&&selectedConn&&' · connection selected - right-click to style'}
            </div>
          )}

          {/* Mobile draw hint */}
          {isMobile&&drawMode&&(
            <div style={{position:'absolute',top:126,left:'50%',transform:'translateX(-50%)',zIndex:100,background:accent,color:'#fff',padding:'5px 14px',borderRadius:999,fontSize:12,fontWeight:700,whiteSpace:'nowrap',boxShadow:'0 2px 8px rgba(0,0,0,0.2)'}}>
              Tap 2 items to connect · <button onClick={()=>toggleDraw(drawMode)} style={{background:'none',border:'none',color:'#fff',cursor:'pointer',fontWeight:700,fontSize:12,padding:0}}>Cancel</button>
            </div>
          )}
          {/* Mobile border draw hint */}
          {isMobile&&drawingBorder&&(
            <div style={{position:'absolute',top:126,left:'50%',transform:'translateX(-50%)',zIndex:100,background:'#7c3aed',color:'#fff',padding:'5px 14px',borderRadius:999,fontSize:12,fontWeight:700,whiteSpace:'nowrap',boxShadow:'0 2px 8px rgba(0,0,0,0.2)'}}>
              Drag to draw border · <button onClick={()=>{setDrawingBorder(false);setBorderDragStart(null);setBorderPreview(null);}} style={{background:'none',border:'none',color:'#fff',cursor:'pointer',fontWeight:700,fontSize:12,padding:0}}>Cancel</button>
            </div>
          )}

          {/* Desktop element shape/color panel - appears below selected element */}
          {!isMobile&&selectedEl&&showElSheet&&!editingEl&&!drawMode&&(()=>{
            const el=elements.find(e=>e.id===selectedEl);
            if(!el) return null;
            const panelX=Math.min(el.x*zoom+canvasOffset.x, window.innerWidth-280);
            const panelY=el.y*zoom+canvasOffset.y+(el.height||100)*zoom+8;
            const panelTop=panelY+200>window.innerHeight?el.y*zoom+canvasOffset.y-210:panelY;
            return (
              <div style={{position:'absolute',left:Math.max(4,panelX),top:Math.max(50,panelTop),zIndex:300,background:cardBg,border:`1.5px solid ${borderC}`,borderRadius:12,boxShadow:'0 8px 32px rgba(0,0,0,0.18)',padding:'12px 14px',width:268,pointerEvents:'all'}}
                onMouseDown={e=>e.stopPropagation()}>
                {/* Header with close button */}
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:9}}>
                  <div style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em'}}>Shape</div>
                  <button onClick={()=>setShowElSheet(false)} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:16,lineHeight:1,padding:'0 2px'}}>✕</button>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:5,marginBottom:12}}>
                  {ELEMENT_SHAPES.map(s=>(
                    <button key={s.id} onClick={()=>updateEl(el.id,{shape:s.id})}
                      style={{padding:'6px 2px',borderRadius:7,border:`1.5px solid ${(el.shape||'rounded')===s.id?accent:borderC}`,background:(el.shape||'rounded')===s.id?accent+'18':'transparent',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:3,transition:'all 0.12s'}}
                      title={s.label}>
                      <span style={{fontSize:18,lineHeight:1}}>{s.icon}</span>
                      <span style={{fontSize:8,fontWeight:700,color:(el.shape||'rounded')===s.id?accent:textMut}}>{s.label}</span>
                    </button>
                  ))}
                </div>
                <div style={{fontSize:11,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:7}}>Color</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:5,marginBottom:6}}>
                  {/* Service default */}
                  <button onClick={()=>updateEl(el.id,{customColor:null})} title="Service default color"
                    style={{width:24,height:24,borderRadius:6,background:el.service.color,border:!el.customColor?'3px solid #fbbf24':'2px solid transparent',cursor:'pointer',flexShrink:0}}/>
                  {COLOR_PALETTE.map(c=>(
                    <button key={c} onClick={()=>updateEl(el.id,{customColor:c})} title={c}
                      style={{width:24,height:24,borderRadius:6,background:c,border:el.customColor===c?'3px solid #fbbf24':c==='#ffffff'?'2px solid #d1d5db':'2px solid transparent',cursor:'pointer',flexShrink:0}}/>
                  ))}
                </div>
                <div style={{display:'flex',gap:6}}>
                  <button onClick={()=>setEditingEl(el.id)} style={{flex:1,padding:'6px',borderRadius:7,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:11,fontWeight:600}}>✏️ Rename</button>
                  <button onClick={handleDelete} style={{flex:1,padding:'6px',borderRadius:7,border:'1px solid #ef4444',background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:11,fontWeight:600}}>🗑 Delete</button>
                </div>
              </div>
            );
          })()}

          {/* Mobile element shape/color sheet - only on double-tap */}
          {isMobile&&selectedEl&&!editingEl&&!drawMode&&elements.find(e=>e.id===selectedEl)&&showElSheet&&<MobileElSheet
            el={elements.find(e=>e.id===selectedEl)}
            accent={accent} textC={textC} textMut={textMut} cardBg={cardBg} borderC={borderC}
            updateEl={updateEl} onDelete={handleDelete} onRename={id=>setEditingEl(id)}
            onClose={()=>setShowElSheet(false)}
          />}

          {/* Mobile connection editor - bottom sheet when a connection is selected */}
          {isMobile&&selectedConn&&!drawMode&&connections.find(c=>c.id===selectedConn)&&<MobileConnSheet conn={connections.find(c=>c.id===selectedConn)} accent={accent} textC={textC} textMut={textMut} cardBg={cardBg} onClose={()=>setSelectedConn(null)} updateConn={updateConn} save={save} setConnections={setConnections} selectedConn={selectedConn} setSelectedConn={setSelectedConn}/>}

          {/* Mobile border editor - bottom sheet */}
          {isMobile&&selectedBorder&&!drawMode&&!selectedConn&&borders.find(x=>x.id===selectedBorder)&&<MobileBorderSheet b={borders.find(x=>x.id===selectedBorder)} accent={accent} textC={textC} textMut={textMut} cardBg={cardBg} borderC={borderC} onClose={()=>setSelectedBorder(null)} updateBorder={updateBorder} save={save} setBorders={setBorders} setLabels={setLabels} selectedBorder={selectedBorder} setSelectedBorder={setSelectedBorder}/>}

          {/* Mobile bubble editor - bottom sheet */}
          {selectedBubble&&showBubbleSheet&&!drawMode&&!selectedConn&&!selectedBorder&&bubbles.find(x=>x.id===selectedBubble)&&(
            isMobile
              ?<MobileBubbleSheet b={bubbles.find(x=>x.id===selectedBubble)} accent={accent} textC={textC} textMut={textMut} cardBg={cardBg} onClose={()=>setShowBubbleSheet(false)} updateBubble={updateBubble} save={save} setBubbles={setBubbles} setConnections={setConnections} selectedBubble={selectedBubble} setSelectedBubble={setSelectedBubble}/>
              :(()=>{
                const b=bubbles.find(x=>x.id===selectedBubble);
                if(!b)return null;
                const panelX=Math.min(b.x*zoom+canvasOffset.x,window.innerWidth-290);
                const panelY=b.y*zoom+canvasOffset.y+(b.h||100)*zoom+8;
                const panelTop=panelY+300>window.innerHeight?b.y*zoom+canvasOffset.y-310:panelY;
                return(
                  <div style={{position:'absolute',left:Math.max(4,panelX),top:Math.max(50,panelTop),zIndex:300,background:cardBg,border:`1.5px solid ${borderC}`,borderRadius:12,boxShadow:'0 8px 32px rgba(0,0,0,0.18)',width:280,maxHeight:'70vh',overflow:'auto',pointerEvents:'all'}}
                    onMouseDown={e=>e.stopPropagation()}>
                    <div style={{padding:'12px 14px 10px',borderBottom:`1px solid ${borderC}`,display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,background:cardBg,zIndex:1}}>
                      <span style={{fontSize:12,fontWeight:700,color:textC}}>Bubble Style</span>
                      <button onClick={()=>setShowBubbleSheet(false)} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:16}}>✕</button>
                    </div>
                    <div style={{padding:'10px 14px 16px'}}>
                      <MobileBubbleSheet b={b} accent={accent} textC={textC} textMut={textMut} cardBg={cardBg} onClose={()=>setShowBubbleSheet(false)} updateBubble={updateBubble} save={save} setBubbles={setBubbles} setConnections={setConnections} selectedBubble={selectedBubble} setSelectedBubble={setSelectedBubble} embedded/>
                    </div>
                  </div>
                );
              })()
          )}

          {/* AI Generate Modal */}
          {showUpgradeModal&&(
            <UpgradeModal darkMode={darkMode} userPlan={userPlan}
              onClose={()=>setShowUpgradeModal(false)}
              onUpgrade={(planId,billing)=>{
                // Stripe redirect will go here when backend is wired
                setToast({msg:`🚀 Redirecting to checkout for ${planId}…`,type:'info'});
                setTimeout(()=>setToast(null),3000);
                setShowUpgradeModal(false);
              }}/>
          )}
          {premiumGateFeature&&(
            <PremiumFeatureGate darkMode={darkMode} featureName={premiumGateFeature} onClose={()=>setPremiumGateFeature(null)}/>
          )}
          {showAiModal&&(
            <AiGenerateModal
              darkMode={darkMode}
              provider={provider}
              onClose={()=>setShowAiModal(false)}
              currentElements={elements}
              currentConnections={connections}
              currentBorders={borders}
              currentBubbles={bubbles}
              currentLabels={labels}
              currentTitle={diagramTitle}
              onPreModify={()=>{save();}} // snapshot undo before modify
              onGenerate={(els,conns,bords,title,lbls,bbls)=>{
                // Clear any in-flight touch/drag state before replacing canvas
                touchRef.current=null;
                drag.current=null;
                save();
                setElements(els);
                setConnections(conns);
                setBorders(bords);
                setLabels(lbls||[]);
                setIcons([]);
                setBubbles(bbls||[]);
                setHistory([]);
                setCurrentDiagramId(`diag_${Date.now()}`);
                applyAnimSettings(null);
                if(title) setDiagramTitle(title);
                setZoom(0.75);
                setCanvasOffset({x:60,y:40});
                setShowAiModal(false);
                const hadBubbles=bbls&&bbls.length>0;
                setToast({msg:`Diagram generated${hadBubbles?` with ${bbls.length} annotation${bbls.length>1?'s':''}`:''} ✨ Feel free to edit and rearrange.`,type:'success'});
                setTimeout(()=>setToast(null),5000);
              }}
            />
          )}

          {/* Terraform Modal */}
          {showIaCExportModal&&(
            <IaCExportModal
              darkMode={darkMode}
              provider={provider}
              elements={elements}
              borders={borders}
              labels={labels}
              connections={connections}
              diagramTitle={diagramTitle}
              onClose={()=>setShowIaCExportModal(false)}
            />
          )}

          {/* Animation Editor Panel */}
          {showAnimEditor&&(
            <AnimationEditorPanel
              darkMode={darkMode}
              isMobile={isMobile}
              animStyle={animStyle}
              animColor={animColor} setAnimColor={setAnimColor}
              animDirection={animDirection} setAnimDirection={setAnimDirection}
              animDotShape={animDotShape} setAnimDotShape={setAnimDotShape}
              animDotEmoji={animDotEmoji} setAnimDotEmoji={setAnimDotEmoji}
              animDotSize={animDotSize} setAnimDotSize={setAnimDotSize}
              animGlowRadius={animGlowRadius} setAnimGlowRadius={setAnimGlowRadius}
              animRingCount={animRingCount} setAnimRingCount={setAnimRingCount}
              animOrbitCount={animOrbitCount} setAnimOrbitCount={setAnimOrbitCount}
              animOrbitDir={animOrbitDir} setAnimOrbitDir={setAnimOrbitDir}
              animLightningColor={animLightningColor} setAnimLightningColor={setAnimLightningColor}
              animLightningFreq={animLightningFreq} setAnimLightningFreq={setAnimLightningFreq}
              animLightningDir={animLightningDir} setAnimLightningDir={setAnimLightningDir}
              animLightningThickness={animLightningThickness} setAnimLightningThickness={setAnimLightningThickness}
              animConstellationColor={animConstellationColor} setAnimConstellationColor={setAnimConstellationColor}
              animConstellationDist={animConstellationDist} setAnimConstellationDist={setAnimConstellationDist}
              animColorShiftStart={animColorShiftStart} setAnimColorShiftStart={setAnimColorShiftStart}
              animColorShiftIntensity={animColorShiftIntensity} setAnimColorShiftIntensity={setAnimColorShiftIntensity}
              animColorShiftPreset={animColorShiftPreset} setAnimColorShiftPreset={setAnimColorShiftPreset}
              animPulseColor={animPulseColor} setAnimPulseColor={setAnimPulseColor}
              animPulseRadius={animPulseRadius} setAnimPulseRadius={setAnimPulseRadius}
              animPulseSync={animPulseSync} setAnimPulseSync={setAnimPulseSync}
              animRippleColor={animRippleColor} setAnimRippleColor={setAnimRippleColor}
              animRippleSpeed={animRippleSpeed} setAnimRippleSpeed={setAnimRippleSpeed}
              animPacketLabels={animPacketLabels} setAnimPacketLabels={setAnimPacketLabels}
              animPacketColor={animPacketColor} setAnimPacketColor={setAnimPacketColor}
              animPacketTextColor={animPacketTextColor} setAnimPacketTextColor={setAnimPacketTextColor}
              animPacketSize={animPacketSize} setAnimPacketSize={setAnimPacketSize}
              connAnimOverrides={connAnimOverrides} setConnAnimOverrides={setConnAnimOverrides}
              nodeAnimOverrides={nodeAnimOverrides} setNodeAnimOverrides={setNodeAnimOverrides}
              seqOrder={seqOrder} setSeqOrder={setSeqOrder}
              elements={elements} connections={connections}
              selectedAnimObj={selectedAnimObj} setSelectedAnimObj={setSelectedAnimObj}
              animEditorTab={animEditorTab} setAnimEditorTab={setAnimEditorTab}
              onClose={()=>setShowAnimEditor(false)}
              cardBg={cardBg} textC={textC} textMut={textMut} borderC={borderC} accent={accent}
            />
          )}

          {/* Animation Settings Panel */}
          {showAnimPanel&&(
            <div style={{
              position:'absolute',
              ...(isMobile
                ? {bottom:52,left:0,right:0,borderRadius:'16px 16px 0 0',maxHeight:'82vh',width:'100%'}
                : {top:48,right:8,borderRadius:14,width:250,maxHeight:'calc(100vh - 120px)'}),
              zIndex:300,background:cardBg,border:`1.5px solid #a855f7`,
              boxShadow:isMobile?'0 -8px 32px rgba(168,85,247,0.25)':'0 8px 32px rgba(168,85,247,0.2)',
              display:'flex',flexDirection:'column',pointerEvents:'all',
            }}
              onMouseDown={e=>e.stopPropagation()}>
              {/* Fixed header */}
              <div style={{padding:'14px 16px 10px',flexShrink:0,borderBottom:`1px solid ${borderC}`}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <span style={{fontSize:12,fontWeight:800,color:textC}}>◎ Animations & Visual Styles</span>
                  <button onClick={()=>setShowAnimPanel(false)} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:16,lineHeight:1}}>✕</button>
                </div>
              </div>
              {/* Scrollable body */}
              <div style={{overflowY:'auto',flex:1,padding:'12px 16px 20px'}}>
              {/* Enable toggle */}
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12,padding:'8px 10px',borderRadius:9,background:animEnabled?'rgba(168,85,247,0.1)':'transparent',border:`1px solid ${animEnabled?'#a855f7':borderC}`}}>
                <span style={{fontSize:12,fontWeight:700,color:animEnabled?'#a855f7':textMut}}>Enable Animations</span>
                <button onClick={()=>setAnimEnabled(v=>!v)} style={{width:38,height:22,borderRadius:11,border:'none',background:animEnabled?'#a855f7':borderC,cursor:'pointer',position:'relative',transition:'background 0.2s'}}>
                  <span style={{position:'absolute',top:3,left:animEnabled?18:3,width:16,height:16,borderRadius:'50%',background:'#fff',transition:'left 0.2s',display:'block'}}/>
                </button>
              </div>
              {/* Style picker */}
              <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Style</div>
              <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:12}}>
                {ANIM_STYLES.map(s=>(
                  <button key={s.id} onClick={()=>{setAnimStyle(s.id);setAnimEnabled(true);}}
                    style={{padding:'7px 10px',borderRadius:8,border:`1.5px solid ${animStyle===s.id?'#a855f7':borderC}`,background:animStyle===s.id?'rgba(168,85,247,0.1)':'transparent',cursor:'pointer',textAlign:'left',display:'flex',alignItems:'center',gap:8}}>
                    <span style={{fontSize:16,width:20,textAlign:'center'}}>{s.icon}</span>
                    <div>
                      <div style={{fontSize:11,fontWeight:700,color:animStyle===s.id?'#a855f7':textC}}>{s.label}</div>
                      <div style={{fontSize:9,color:textMut,lineHeight:1.3}}>{s.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
              {/* Speed picker */}
              <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Speed</div>
              <div style={{display:'flex',gap:5,marginBottom:12}}>
                {ANIM_SPEEDS.map(s=>(
                  <button key={s.id} onClick={()=>setAnimSpeed(s.id)}
                    style={{flex:1,padding:'5px',borderRadius:7,border:`1.5px solid ${animSpeed===s.id?'#a855f7':borderC}`,background:animSpeed===s.id?'rgba(168,85,247,0.1)':'transparent',color:animSpeed===s.id?'#a855f7':textMut,cursor:'pointer',fontSize:10,fontWeight:700}}>
                    {s.label}
                  </button>
                ))}
              </div>
              {/* GIF export */}
              <button onClick={()=>{setShowAnimPanel(false);exportGif();}} disabled={isExportingGif||(!elements.length&&!borders.length)}
                style={{width:'100%',padding:'9px',borderRadius:9,border:'none',background:isExportingGif||(!elements.length&&!borders.length)?'#6b7280':'linear-gradient(135deg,#7c3aed,#a855f7)',color:'#fff',cursor:isExportingGif||(!elements.length&&!borders.length)?'not-allowed':'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                {isExportingGif?'⏳ Building GIF…':'🎬 Export Animated GIF'}
              </button>

              {/* Phase 3 divider */}
              <div style={{borderTop:`1px solid ${borderC}`,margin:'10px 0 8px'}}/>
              <div style={{fontSize:10,fontWeight:700,color:'#f59e0b',textTransform:'uppercase',letterSpacing:'0.07em',marginBottom:8}}>✦ Phase 3 Visual Styles</div>

              {/* Node visual style */}
              <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Node Style</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:4,marginBottom:10}}>
                {NODE_VISUAL_STYLES.map(s=>(
                  <button key={s.id} onClick={()=>setNodeVisualStyle(s.id)}
                    style={{padding:'6px 4px',borderRadius:7,border:`1.5px solid ${nodeVisualStyle===s.id?'#f59e0b':borderC}`,background:nodeVisualStyle===s.id?'rgba(245,158,11,0.1)':'transparent',cursor:'pointer',textAlign:'left'}}>
                    <div style={{fontSize:10,fontWeight:700,color:nodeVisualStyle===s.id?'#f59e0b':textC}}>{s.label}</div>
                    <div style={{fontSize:8,color:textMut,lineHeight:1.3}}>{s.desc}</div>
                  </button>
                ))}
              </div>

              {/* Connection visual style */}
              <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Connection Style</div>
              <div style={{display:'flex',flexDirection:'column',gap:4,marginBottom:10}}>
                {CONN_VISUAL_STYLES.map(s=>(
                  <button key={s.id} onClick={()=>setConnVisualStyle(s.id)}
                    style={{padding:'5px 8px',borderRadius:7,border:`1.5px solid ${connVisualStyle===s.id?'#f59e0b':borderC}`,background:connVisualStyle===s.id?'rgba(245,158,11,0.1)':'transparent',cursor:'pointer',textAlign:'left',display:'flex',alignItems:'center',gap:6}}>
                    <div>
                      <div style={{fontSize:10,fontWeight:700,color:connVisualStyle===s.id?'#f59e0b':textC}}>{s.label}</div>
                      <div style={{fontSize:8,color:textMut}}>{s.desc}</div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Canvas Background */}
              <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Canvas Background</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:4,marginBottom:6}}>
                {[
                  {id:'dots',label:'Dots',icon:'⋯',desc:'Classic dot grid'},
                  {id:'grid',label:'Grid',icon:'⊞',desc:'Fine line grid'},
                  {id:'blueprint',label:'Blueprint',icon:'📐',desc:'Dark blue technical'},
                  {id:'plain',label:'Plain',icon:'[ ]',desc:'No pattern'},
                ].map(t=>(
                  <button key={t.id} onClick={()=>setCanvasBgTheme(t.id)}
                    style={{padding:'6px 4px',borderRadius:7,border:`1.5px solid ${canvasBgTheme===t.id?'#f59e0b':borderC}`,background:canvasBgTheme===t.id?'rgba(245,158,11,0.1)':'transparent',cursor:'pointer',textAlign:'left'}}>
                    <div style={{fontSize:12,marginBottom:1}}>{t.icon} <span style={{fontSize:10,fontWeight:700,color:canvasBgTheme===t.id?'#f59e0b':textC}}>{t.label}</span></div>
                    <div style={{fontSize:8,color:textMut}}>{t.desc}</div>
                  </button>
                ))}
              </div>
              <div style={{display:'flex',gap:6,alignItems:'center',marginBottom:10}}>
                <span style={{fontSize:10,color:textMut,fontWeight:600}}>BG Colour</span>
                <button onClick={()=>setCanvasBgColor(null)} style={{padding:'3px 8px',borderRadius:5,border:`1px solid ${!canvasBgColor?'#f59e0b':borderC}`,background:!canvasBgColor?'rgba(245,158,11,0.1)':'transparent',color:!canvasBgColor?'#f59e0b':textMut,cursor:'pointer',fontSize:10,fontWeight:600}}>Auto</button>
                <input type="color" value={canvasBgColor||'#111827'} onChange={e=>setCanvasBgColor(e.target.value)}
                  style={{width:28,height:26,borderRadius:6,border:`1px solid ${borderC}`,cursor:'pointer',padding:0}}/>
                {canvasBgColor&&<span style={{fontSize:10,color:textMut}}>{canvasBgColor}</span>}
              </div>

              {/* Zoom to fit */}
              <button onClick={()=>{zoomToFit();setShowAnimPanel(false);}}
                style={{width:'100%',padding:'8px',borderRadius:9,border:`1.5px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:11,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6,marginBottom:6}}>
                ⊡ Zoom to Fit All Content
              </button>

              <div style={{fontSize:10,color:textMut,textAlign:'center',paddingTop:4}}>GIF plays on LinkedIn, Notion, Slack</div>

              {/* Edit animations button */}
              <div style={{borderTop:`1px solid ${borderC}`,paddingTop:10,marginTop:6}}>
                <button onClick={()=>{setShowAnimEditor(true);setShowAnimPanel(false);}}
                  style={{width:'100%',padding:'9px',borderRadius:9,border:`1.5px solid #f59e0b`,background:'rgba(245,158,11,0.08)',color:'#f59e0b',cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                  ✦ Edit Animation Settings
                </button>
              </div>
              </div>{/* end scrollable body */}
            </div>
          )}

          {/* Terraform Import Modal */}
          {showLibraryPanel&&(
            <LibraryPanel
              darkMode={darkMode}
              library={library}
              onClose={()=>setShowLibraryPanel(false)}
              onLoad={(d)=>loadFromLibrary(d)}
              onDelete={(id)=>handleDeleteFromLibrary(id)}
              currentDiagramId={currentDiagramId}
            />
          )}

          {showCompareModal&&(
            <ArchitectureCompareModal
              darkMode={darkMode}
              provider={provider}
              library={library}
              elements={elements}
              borders={borders}
              labels={labels}
              connections={connections}
              bubbles={bubbles}
              diagramTitle={diagramTitle}
              currentDiagramId={currentDiagramId}
              onClose={()=>setShowCompareModal(false)}
              callClaude={callClaudeWithRetry}
            />
          )}

          {showImportModal&&(
            <DiagramImportModal
              darkMode={darkMode}
              provider={provider}
              onClose={()=>setShowImportModal(false)}
              onGenerate={(els,conns,bords,title,lbls,bbls)=>{
                touchRef.current=null;drag.current=null;save();
                setElements(els);setConnections(conns);setBorders(bords);
                setLabels(lbls||[]);setIcons([]);setBubbles(bbls||[]);
                setTexts([]);setHistory([]);
                setCurrentDiagramId(`diag_${Date.now()}`);
                applyAnimSettings(null);
                if(title)setDiagramTitle(title);
                setZoom(0.75);setCanvasOffset({x:60,y:40});
                setShowImportModal(false);
                setToast({msg:`Diagram imported! ${els.length} services · ${bbls?.length||0} annotations ✨`,type:'success'});
                setTimeout(()=>setToast(null),6000);
              }}
            />
          )}

          {showTerraformImportModal&&(
            <TerraformImportModal
              darkMode={darkMode}
              provider={provider}
              onClose={()=>setShowTerraformImportModal(false)}
              onGenerate={(els,conns,bords,title,lbls,bbls)=>{
                touchRef.current=null; drag.current=null; save();
                setElements(els); setConnections(conns); setBorders(bords);
                setLabels(lbls||[]); setIcons([]); setBubbles(bbls||[]);
                setHistory([]);
                setCurrentDiagramId(`diag_${Date.now()}`);
                applyAnimSettings(null);
                if(title) setDiagramTitle(title);
                setZoom(0.75); setCanvasOffset({x:60,y:40});
                setShowTerraformImportModal(false);
                setToast({msg:`Terraform imported! ${els.length} resources · ${bbls?.length||0} annotations ✨`,type:'success'});
                setTimeout(()=>setToast(null),6000);
              }}
            />
          )}

          {/* Undo History Panel */}
          {showHistory&&(
            <div style={{position:'absolute',top:isMobile?120:52,right:8,zIndex:350,background:cardBg,border:`1.5px solid #f59e0b`,borderRadius:12,boxShadow:'0 8px 28px rgba(245,158,11,0.18)',width:220,maxHeight:340,display:'flex',flexDirection:'column'}}
              onMouseDown={e=>e.stopPropagation()}>
              <div style={{padding:'10px 12px 8px',borderBottom:`1px solid ${borderC}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
                <span style={{fontSize:12,fontWeight:800,color:'#f59e0b'}}>🕐 History</span>
                <button onClick={()=>setShowHistory(false)} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:16}}>✕</button>
              </div>
              <div style={{flex:1,overflowY:'auto',padding:6}}>
                {history.length===0&&<div style={{fontSize:11,color:textMut,padding:'8px 6px',textAlign:'center'}}>No actions yet</div>}
                {[...history].reverse().map((h,i)=>(
                  <button key={i} onClick={()=>{
                    const idx=history.length-1-i;
                    setElements(history[idx].elements);setConnections(history[idx].connections);
                    setLabels(history[idx].labels);setBorders(history[idx].borders);
                    setIcons(history[idx].icons||[]);setBubbles(history[idx].bubbles||[]);
                    setTexts(history[idx].texts||[]);
                    setHistory(h=>h.slice(0,idx));
                    setShowHistory(false);
                  }}
                    style={{width:'100%',padding:'6px 8px',borderRadius:7,border:`1px solid ${borderC}`,background:i===0?'rgba(245,158,11,0.08)':'transparent',color:textC,cursor:'pointer',fontSize:11,textAlign:'left',marginBottom:3,display:'flex',alignItems:'center',gap:6}}>
                    <span style={{fontSize:14}}>{i===0?'↩️':'⬅️'}</span>
                    <div>
                      <div style={{fontWeight:600}}>{h.action||'Edit'}</div>
                      <div style={{fontSize:9,color:textMut}}>{new Date(h.ts).toLocaleTimeString()}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Multi-select toolbar */}
          {multiSel.size>0&&(
            <div style={{position:'absolute',bottom:isMobile?60:16,left:'50%',transform:'translateX(-50%)',zIndex:350,background:cardBg,border:`1.5px solid #3b82f6`,borderRadius:12,boxShadow:'0 4px 20px rgba(59,130,246,0.25)',padding:'8px 14px',display:'flex',alignItems:'center',gap:10}}
              onMouseDown={e=>e.stopPropagation()}>
              <span style={{fontSize:12,fontWeight:700,color:'#3b82f6'}}>{multiSel.size} selected</span>
              <div style={{width:1,height:18,background:borderC}}/>
              <button onClick={()=>{
                const colour=prompt('Enter a hex colour (e.g. #3b82f6):');
                if(colour){save('Recolour');setElements(prev=>prev.map(el=>multiSel.has(el.id)?{...el,customColor:colour}:el));}
              }} style={{padding:'4px 10px',borderRadius:7,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:11,fontWeight:600}}>🎨 Colour</button>
              <button onClick={()=>{
                save('Delete');
                setElements(prev=>prev.filter(el=>!multiSel.has(el.id)));
                setConnections(prev=>prev.filter(c=>!multiSel.has(c.from)&&!multiSel.has(c.to)));
                setMultiSel(new Set());
              }} style={{padding:'4px 10px',borderRadius:7,border:'none',background:'#ef4444',color:'#fff',cursor:'pointer',fontSize:11,fontWeight:700}}>🗑 Delete</button>
              <button onClick={()=>setMultiSel(new Set())} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:16,lineHeight:1}}>✕</button>
            </div>
          )}

          {showBannerEditor&&selectedText&&texts.find(t=>t.id===selectedText)&&(
            <BannerEditorPanel
              darkMode={darkMode}
              isMobile={isMobile}
              banner={texts.find(t=>t.id===selectedText)}
              onUpdate={(id,upd)=>{setTexts(p=>p.map(t=>t.id===id?{...t,...upd}:t));}}
              onDelete={(id)=>{save();setTexts(p=>p.filter(t=>t.id!==id));setSelectedText(null);setShowBannerEditor(false);}}
              onClose={()=>setShowBannerEditor(false)}
              cardBg={cardBg} textC={textC} textMut={textMut} borderC={borderC} accent={accent}
            />
          )}

          {/* Validation Side Panel */}
          {showValidationPanel&&(
            <ValidationPanel
              darkMode={darkMode}
              provider={provider}
              elements={elements}
              borders={borders}
              labels={labels}
              connections={connections}
              bubbles={bubbles}
              diagramTitle={diagramTitle}
              ignoredRecs={ignoredRecs}
              setIgnoredRecs={setIgnoredRecs}
              validationEnabled={validationEnabled}
              setValidationEnabled={setValidationEnabled}
              validationResults={validationResults}
              setValidationResults={setValidationResults}
              isMobile={isMobile}
              onClose={()=>setShowValidationPanel(false)}
              setToast={setToast}
            />
          )}

          {/* Custom Service Modal */}
          {showCustomSvcModal&&(
            <CustomServiceModal
              darkMode={darkMode}
              provider={provider}
              onAdd={svc=>setCustomServices(p=>[...p,svc])}
              onClose={()=>setShowCustomSvcModal(false)}
            />
          )}

          {/* Share Modal */}
          {showShareModal&&(
            <div onClick={e=>{if(e.target===e.currentTarget){setShowShareModal(false);setSharePreviewUrl(null);}}} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:500,display:'flex',alignItems:'flex-end',justifyContent:'center'}}>
              <div style={{background:cardBg,borderRadius:'20px 20px 0 0',padding:'20px 20px 40px',width:'100%',maxWidth:500,boxShadow:'0 -8px 40px rgba(0,0,0,0.3)',animation:'slideUpPanel 0.25s ease-out',maxHeight:'90vh',overflowY:'auto'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:4}}>
                  <span style={{fontSize:16,fontWeight:800,color:textC}}>Share Diagram</span>
                  <button onClick={()=>{setShowShareModal(false);setSharePreviewUrl(null);}} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:22,lineHeight:1}}>✕</button>
                </div>
                <p style={{fontSize:12,color:textMut,marginBottom:14}}>{diagramTitle||'Untitled Diagram'}</p>

                {/* Diagram preview */}
                {sharePreviewUrl&&(
                  <div style={{borderRadius:12,overflow:'hidden',border:`1px solid ${borderC}`,marginBottom:18,background:darkMode?'#0f172a':'#f8fafc',maxHeight:200,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <img src={sharePreviewUrl} alt="Diagram preview" style={{width:'100%',height:'auto',maxHeight:200,objectFit:'contain',display:'block'}}/>
                  </div>
                )}

                {/* How sharing works notice */}
                <div style={{background:darkMode?'rgba(37,99,235,0.12)':'#eff6ff',border:`1px solid ${darkMode?'rgba(37,99,235,0.3)':'#bfdbfe'}`,borderRadius:10,padding:'12px 14px',marginBottom:16,fontSize:12,color:darkMode?'#93c5fd':'#1d4ed8',lineHeight:1.8}}>
                  <div style={{fontWeight:700,marginBottom:2}}>📱 On iPhone / Android:</div>
                  <div>Tap any button {'->'} your phone's <strong>native share sheet opens</strong> with the diagram image already attached {'->'} pick LinkedIn, Instagram, TikTok or any app.</div>
                  <div style={{marginTop:6,fontWeight:700}}>🖥️ On desktop:</div>
                  <div>Caption copied to clipboard + image downloads. Paste and attach when posting.</div>
                </div>

                {/* Platform grid */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,marginBottom:18}}>
                  {[
                    {id:'linkedin',  label:'LinkedIn',  bg:'#0A66C2',    icon:'in', textIcon:true},
                    {id:'facebook',  label:'Facebook',  bg:'#1877F2',    icon:'f',  textIcon:true},
                    {id:'instagram', label:'Instagram', bg:'linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)', icon:'📷', textIcon:false},
                    {id:'tiktok',    label:'TikTok',    bg:'#010101',    icon:'♪',  textIcon:false},
                  ].map(p=>(
                    <button key={p.id} onClick={()=>shareDiagram(p.id)}
                      style={{display:'flex',flexDirection:'column',alignItems:'center',gap:7,padding:'12px 6px',borderRadius:14,border:`1px solid ${borderC}`,background:cardBg,cursor:'pointer',transition:'all 0.15s'}}
                      onMouseOver={e=>{e.currentTarget.style.transform='scale(1.05)';e.currentTarget.style.borderColor=accent;}}
                      onMouseOut={e=>{e.currentTarget.style.transform='scale(1)';e.currentTarget.style.borderColor=borderC;}}>
                      <div style={{width:46,height:46,borderRadius:13,background:p.bg,display:'flex',alignItems:'center',justifyContent:'center',fontSize:p.textIcon?18:22,fontWeight:900,color:'#fff',fontFamily:'Georgia,serif',flexShrink:0,letterSpacing:'-1px'}}>
                        {p.icon}
                      </div>
                      <span style={{fontSize:10,fontWeight:700,color:textC,textAlign:'center'}}>{p.label}</span>
                    </button>
                  ))}
                </div>

                {/* Export row */}
                <div style={{borderTop:`1px solid ${borderC}`,paddingTop:14}}>
                  <p style={{fontSize:11,color:textMut,marginBottom:10,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em'}}>Download Only</p>
                  <div style={{display:'flex',gap:8}}>
                    {['png','jpeg'].map(fmt=>(
                      <button key={fmt} onClick={()=>{exportDiagram(fmt);}} style={{flex:1,padding:'10px',borderRadius:10,border:`1px solid ${borderC}`,background:darkMode?'#374151':'#f8fafc',color:textC,cursor:'pointer',fontSize:13,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:6}}>
                        ⬇ {fmt.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Publish bar */}
          <div style={{position:'absolute',bottom:0,left:0,right:0,zIndex:100,background:cardBg,borderTop:`1px solid ${borderC}`,padding:isMobile?'7px 10px':'9px 14px',display:'flex',alignItems:'center',gap:isMobile?6:10,boxShadow:'0 -2px 12px rgba(0,0,0,0.08)'}}>
            {editingTitle?(
              <input ref={titleInputRef} value={diagramTitle} onChange={e=>setDiagramTitle(e.target.value)} onBlur={()=>setEditingTitle(false)} onKeyDown={e=>{if(e.key==='Enter'||e.key==='Escape')setEditingTitle(false);}} placeholder="Untitled Diagram" autoFocus
                style={{flex:1,maxWidth:isMobile?'100%':280,padding:'5px 10px',fontSize:13,fontWeight:600,borderRadius:7,border:`1.5px solid ${accent}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,outline:'none',fontFamily:'Inter,Arial,sans-serif'}}/>
            ):(
              <div onClick={()=>setEditingTitle(true)} style={{flex:1,maxWidth:isMobile?130:280,padding:'5px 10px',fontSize:isMobile?12:13,fontWeight:600,borderRadius:7,border:`1.5px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:diagramTitle?textC:(darkMode?'#4b5563':'#9ca3af'),cursor:'text',userSelect:'none',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                {diagramTitle||(isMobile?'Name…':'Click to name diagram…')}
              </div>
            )}
            <div style={{display:'flex',alignItems:'center',gap:0,border:`1.5px solid ${borderC}`,borderRadius:8,overflow:'hidden',flexShrink:0}}>
              <button onClick={()=>setIsPublic(true)} style={{padding:isMobile?'5px 7px':'5px 12px',border:'none',cursor:'pointer',fontSize:isMobile?11:12,fontWeight:700,background:isPublic?accent:'transparent',color:isPublic?'#fff':textMut}}>
                🌐{!isMobile&&' Public'}
              </button>
              <div style={{width:1,height:28,background:borderC}}/>
              <button onClick={()=>setIsPublic(false)} style={{padding:isMobile?'5px 7px':'5px 12px',border:'none',cursor:'pointer',fontSize:isMobile?11:12,fontWeight:700,background:!isPublic?'#7c3aed':'transparent',color:!isPublic?'#fff':textMut}}>
                🔒{!isMobile&&' Private'}
              </button>
            </div>
            {!isMobile&&<span style={{fontSize:11,color:textMut}}>{isPublic?'-> visible to followers':'-> only visible to you'}</span>}
            <div style={{flex:1}}/>
            {/* Watermark button */}
            <button onClick={()=>setShowWatermarkPanel(v=>!v)}
              title="Add watermark / logo"
              style={{padding:'5px 8px',borderRadius:7,border:`1px solid ${watermarkImg?'#6366f1':borderC}`,background:watermarkImg?'rgba(99,102,241,0.1)':'transparent',color:watermarkImg?'#6366f1':textMut,cursor:'pointer',fontSize:12,fontWeight:700,flexShrink:0,display:'flex',alignItems:'center',gap:3}}>
              🖼{!isMobile&&' Logo'}
            </button>
            {/* Upgrade CTA - shown to free users */}
            {userPlan==='free'&&(
              <button onClick={()=>setShowUpgradeModal(true)}
                style={{padding:'5px 10px',borderRadius:7,border:'none',background:'linear-gradient(135deg,#6366f1,#8b5cf6)',color:'#fff',cursor:'pointer',fontSize:11,fontWeight:800,flexShrink:0,display:'flex',alignItems:'center',gap:4,boxShadow:'0 2px 10px rgba(99,102,241,0.35)'}}>
                ⚡{!isMobile&&' Upgrade'}
              </button>
            )}
            {userPlan!=='free'&&(
              <div style={{padding:'4px 8px',borderRadius:7,background:'linear-gradient(135deg,#6366f1,#8b5cf6)',color:'#fff',fontSize:10,fontWeight:800,flexShrink:0}}>
                {userPlan==='team'?'🏢 Team':'⚡ Pro'}
              </div>
            )}
            {/* Share button - both mobile & desktop */}
            <button onClick={openShareModal} style={{padding:isMobile?'7px 10px':'7px 14px',borderRadius:8,border:`1.5px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:isMobile?12:13,fontWeight:700,flexShrink:0,display:'flex',alignItems:'center',gap:5}}>
              {!isMobile&&'Share'} 🔗
            </button>
            {/* Save privately to library */}
            <button onClick={handleSave}
              style={{padding:isMobile?'7px 10px':'7px 16px',borderRadius:8,border:`1.5px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:isMobile?12:13,fontWeight:800,flexShrink:0}}>
              💾{!isMobile&&' Save'}
            </button>
            {/* Post publicly to feed */}
            <button onClick={handlePublish}
              style={{padding:isMobile?'7px 12px':'7px 22px',borderRadius:8,border:'none',cursor:'pointer',fontSize:isMobile?12:13,fontWeight:800,color:'#fff',flexShrink:0,background:'linear-gradient(135deg,#2563eb,#1d4ed8)',boxShadow:'0 2px 10px rgba(37,99,235,0.35)'}}>
              🚀{!isMobile&&' Post'}
            </button>
            <button onClick={()=>setShowLibraryPanel(true)}
              style={{padding:'7px 10px',borderRadius:8,border:`1.5px solid ${borderC}`,background:savedCount>0?'#6366f1':'transparent',color:savedCount>0?'#fff':textMut,cursor:'pointer',fontSize:12,fontWeight:700,flexShrink:0,display:'flex',alignItems:'center',gap:5}}>
              🗂️ {savedCount} saved
            </button>
          </div>

          {toast&&(
            <div style={{position:'absolute',bottom:68,left:'50%',transform:'translateX(-50%)',zIndex:200,pointerEvents:'none',background:toast.type==='success'?(darkMode?'#064e3b':'#d1fae5'):(darkMode?'#1e1b4b':'#e0e7ff'),border:`1px solid ${toast.type==='success'?(darkMode?'#10b981':'#6ee7b7'):(darkMode?'#6d28d9':'#a5b4fc')}`,color:toast.type==='success'?(darkMode?'#6ee7b7':'#065f46'):(darkMode?'#a5b4fc':'#3730a3'),borderRadius:10,padding:'10px 20px',fontSize:13,fontWeight:600,boxShadow:'0 4px 20px rgba(0,0,0,0.15)',whiteSpace:'nowrap',animation:'slideUp 0.25s ease-out'}}>
              {toast.msg}
            </div>
          )}
          <style>{`
@keyframes slideUp{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
@keyframes slideUpPanel{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes borderPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.6;transform:scale(1.004)}}
@keyframes borderGlow{0%,100%{box-shadow:0 0 0 0 var(--bc,#8b5cf6)}50%{box-shadow:0 0 18px 8px var(--bc,#8b5cf6)}}
@keyframes marchAnts{to{stroke-dashoffset:-30}}
@keyframes colorShiftBorder{0%{border-color:#8b5cf6}25%{border-color:#ef4444}50%{border-color:#f59e0b}75%{border-color:#10b981}100%{border-color:#8b5cf6}}
@keyframes cornerSpark{0%,100%{opacity:0.4;transform:scale(0.8)}50%{opacity:1;transform:scale(1.3)}}
@keyframes pulseWave{0%{stroke-opacity:0.3;stroke-width:var(--sw,3)}50%{stroke-opacity:1;stroke-width:calc(var(--sw,3)*1.8)}100%{stroke-opacity:0.3;stroke-width:var(--sw,3)}}
@keyframes connColorShift{0%{stroke:#3b82f6}25%{stroke:#8b5cf6}50%{stroke:#ef4444}75%{stroke:#f59e0b}100%{stroke:#3b82f6}}
@keyframes rainbowBorder{0%{border-color:#3b82f6}16%{border-color:#8b5cf6}33%{border-color:#ef4444}50%{border-color:#f59e0b}66%{border-color:#10b981}83%{border-color:#ec4899}100%{border-color:#3b82f6}}
          `}</style>

          {/* Canvas */}
          <div ref={canvasRef}
            onDragOver={e=>e.preventDefault()} onDrop={handleDrop}
            onMouseMove={onCanvasMove} onMouseUp={onCanvasUp}
            onMouseDown={onCanvasDown} onMouseLeave={onCanvasUp}
            onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            style={{width:'100%',height:isMobile?'calc(100% - 52px)':'calc(100% - 52px)',marginTop:isMobile?112:0,
              ...(()=>{
                const bgCol=canvasBgColor||(darkMode?'#111827':'#eff6ff');
                const dotCol=darkMode?'#374151':'#cbd5e1';
                if(canvasBgTheme==='blueprint') return{background:'#1a3a5c',backgroundImage:`linear-gradient(rgba(100,180,255,0.15) 1px,transparent 1px),linear-gradient(90deg,rgba(100,180,255,0.15) 1px,transparent 1px)`,backgroundSize:`${20*zoom}px ${20*zoom}px`,backgroundPosition:`${canvasOffset.x}px ${canvasOffset.y}px`};
                if(canvasBgTheme==='grid') return{background:bgCol,backgroundImage:`linear-gradient(${dotCol}44 1px,transparent 1px),linear-gradient(90deg,${dotCol}44 1px,transparent 1px)`,backgroundSize:`${20*zoom}px ${20*zoom}px`,backgroundPosition:`${canvasOffset.x}px ${canvasOffset.y}px`};
                if(canvasBgTheme==='plain') return{background:bgCol};
                // dots (default)
                return{background:bgCol,backgroundImage:`radial-gradient(circle,${dotCol} 1px,transparent 1px)`,backgroundSize:`${20*zoom}px ${20*zoom}px`,backgroundPosition:`${canvasOffset.x}px ${canvasOffset.y}px`};
              })(),
              cursor:isPanning?'grabbing':drawMode||drawingBorder?'crosshair':'grab',position:'relative',userSelect:'none',touchAction:'none'}}>

            {/* SVG connections */}
            <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:50}}>
              {/* Border SVG animations - marching ants, neon chase, corner sparkles */}
              <g transform={`translate(${canvasOffset.x},${canvasOffset.y}) scale(${zoom})`}>
                {borders.map(b=>{
                  if(!b.animation) return null;
                  const r=b.borderRadius||0;
                  if(b.animation==='march'){
                    const dash=12,gap=8;
                    return(
                      <rect key={b.id} x={b.x} y={b.y} width={b.width} height={b.height}
                        rx={r} ry={r} fill="none"
                        stroke={b.color} strokeWidth={(b.strokeWidth||2)+1}
                        strokeDasharray={`${dash} ${gap}`}
                        style={{animation:'marchAnts 0.5s linear infinite',pointerEvents:'none'}}/>
                    );
                  }
                  if(b.animation==='chase'){
                    // Dot racing around perimeter
                    const perim=2*(b.width+b.height);
                    const t=(animTickRef.current%60)/60;
                    const dist=t*perim;
                    let cx,cy;
                    if(dist<b.width){cx=b.x+dist;cy=b.y;}
                    else if(dist<b.width+b.height){cx=b.x+b.width;cy=b.y+(dist-b.width);}
                    else if(dist<2*b.width+b.height){cx=b.x+b.width-(dist-b.width-b.height);cy=b.y+b.height;}
                    else{cx=b.x;cy=b.y+b.height-(dist-2*b.width-b.height);}
                    return(
                      <g key={b.id} style={{pointerEvents:'none'}}>
                        <circle cx={cx} cy={cy} r={6/zoom} fill={b.color} opacity={0.9}/>
                        <circle cx={cx} cy={cy} r={12/zoom} fill={b.color} opacity={0.25}/>
                      </g>
                    );
                  }
                  if(b.animation==='corners'){
                    const corners=[[b.x,b.y],[b.x+b.width,b.y],[b.x+b.width,b.y+b.height],[b.x,b.y+b.height]];
                    return(
                      <g key={b.id} style={{pointerEvents:'none'}}>
                        {corners.map(([x,y],i)=>{
                          const ph=((animTickRef.current+(i*15))%60)/60;
                          const sc=0.8+Math.sin(ph*Math.PI*2)*0.5;
                          const op=0.4+Math.sin(ph*Math.PI*2)*0.6;
                          return <polygon key={i} points={`${x},${y-8/zoom*sc} ${x+6/zoom*sc},${y+5/zoom*sc} ${x-6/zoom*sc},${y+5/zoom*sc}`} fill={b.color} opacity={op}/>;
                        })}
                      </g>
                    );
                  }
                  return null;
                })}
              </g>
              <g transform={`translate(${canvasOffset.x},${canvasOffset.y}) scale(${zoom})`} style={{pointerEvents:'all'}}>
                {connections.map(c=>renderConn(c))}
                {drawMode&&drawStart&&previewPt&&<path d={drawMode.includes('bent')?`M${drawStart.x+eW(drawStart)/2},${drawStart.y+eH(drawStart)/2} L${(drawStart.x+eW(drawStart)/2+previewPt.x)/2},${drawStart.y+eH(drawStart)/2} L${(drawStart.x+eW(drawStart)/2+previewPt.x)/2},${previewPt.y} L${previewPt.x},${previewPt.y}`:`M${drawStart.x+eW(drawStart)/2},${drawStart.y+eH(drawStart)/2} L${previewPt.x},${previewPt.y}`} stroke="#3b82f6" strokeWidth={2} strokeDasharray="6 4" fill="none" style={{pointerEvents:'none'}}/>}
              </g>
              {/* Alignment snap guides - appear only on alignment, Figma-style */}
              {snapGuides.map((g,i)=>(
                g.type==='h'
                  ?<line key={i} x1={0} y1={g.pos*zoom+canvasOffset.y} x2="100%" y2={g.pos*zoom+canvasOffset.y}
                    stroke="#ef4444" strokeWidth={1} opacity={0.9}/>
                  :<line key={i} x1={g.pos*zoom+canvasOffset.x} y1={0} x2={g.pos*zoom+canvasOffset.x} y2="100%"
                    stroke="#ef4444" strokeWidth={1} opacity={0.9}/>
              ))}
            </svg>

            {/* Animation overlay - renders above all canvas elements */}
          {animEnabled&&connections.length>0&&(
            <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:90,overflow:'hidden'}}>
              <g transform={`translate(${canvasOffset.x},${canvasOffset.y}) scale(${zoom})`}>
                {animStyle==='dataflow'&&connections.map((conn,ci)=>{
                  const from=findById(conn.from),to=findById(conn.to);
                  if(!from||!to) return null;
                  const pts=bestPts(from,to);
                  const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
                  // Skip if connection has zero or near-zero length (element being dragged mid-frame)
                  const lineLen=Math.hypot(x2-x1,y2-y1);
                  if(lineLen<10) return null;
                  const ov=connAnimOverrides[conn.id]||{};
                  if(ov.disabled) return null;
                  const color=ov.color||animColor||conn.color||'#3b82f6';
                  const dir=ov.direction||animDirection;
                  const dotR=(ov.size||animDotSize)/zoom;
                  const glowR=(animGlowRadius)/zoom;
                  const shape=animDotShape;
                  // Emoji: per-connection override takes priority over global
                  const emoji=ov.dotEmoji!==undefined?ov.dotEmoji:animDotEmoji;
                  const makeDot=(cx,cy,r,op)=>{
                    if(emoji) return <text key={`${cx},${cy}`} x={cx} y={cy+r*0.85} textAnchor="middle" fontSize={r*2.2} opacity={op} style={{userSelect:'none'}}>{emoji}</text>;
                    if(shape==='square') return <rect key={`${cx},${cy}`} x={cx-r} y={cy-r} width={r*2} height={r*2} fill={color} opacity={op}/>;
                    if(shape==='diamond') return <polygon key={`${cx},${cy}`} points={`${cx},${cy-r} ${cx+r},${cy} ${cx},${cy+r} ${cx-r},${cy}`} fill={color} opacity={op}/>;
                    if(shape==='triangle') return <polygon key={`${cx},${cy}`} points={`${cx},${cy-r} ${cx+r},${cy+r} ${cx-r},${cy+r}`} fill={color} opacity={op}/>;
                    if(shape==='star'){const s=r*0.4;return <polygon key={`${cx},${cy}`} points={`${cx},${cy-r} ${cx+s},${cy-s} ${cx+r},${cy} ${cx+s},${cy+s} ${cx},${cy+r} ${cx-s},${cy+s} ${cx-r},${cy} ${cx-s},${cy-s}`} fill={color} opacity={op}/>;}
                    return <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} fill={color} opacity={op}/>;
                  };
                  const renderDots=(reversed)=>{
                    const ax=reversed?x2:x1, ay=reversed?y2:y1, bx=reversed?x1:x2, by=reversed?y1:y2;
                    const phase=0.05+((animTickRef.current+(ci*7))%30)/30*0.90;
                    const dotX=ax+(bx-ax)*phase, dotY=ay+(by-ay)*phase;
                    return (<g>
                      {!emoji&&<circle cx={dotX} cy={dotY} r={glowR} fill={color} opacity={0.18}/>}
                      {makeDot(dotX,dotY,dotR,0.95)}
                      {!emoji&&[1,2,3].map(t=>{
                        const tp=phase-t*0.06;
                        // Skip trail dots that fall before the start of the line (avoids pile-up at 0)
                        if(tp<=0) return null;
                        return makeDot(ax+(bx-ax)*tp,ay+(by-ay)*tp,(dotR*(1-t*0.2)),0.28-t*0.07);
                      })}
                    </g>);
                  };
                  return (
                    <g key={conn.id}>
                      {(dir==='forward'||dir==='bidirectional')&&renderDots(false)}
                      {(dir==='reverse'||dir==='bidirectional')&&renderDots(true)}
                    </g>
                  );
                })}
                {animStyle==='pulse'&&elements.map((el,ei)=>{
                  const ov=nodeAnimOverrides[el.id]||{};
                  const phase=animPulseSync?((animTickRef.current)%30)/30:((animTickRef.current+(ei*5))%30)/30;
                  const glowR=animPulseRadius+Math.sin(phase*Math.PI*2)*4;
                  const opacity=0.3+Math.sin(phase*Math.PI*2)*0.25;
                  const cx=el.x+el.width/2,cy=el.y+el.height/2;
                  const color=ov.pulseColor||animPulseColor||el.customColor||el.service.color;
                  return (
                    <g key={el.id}>
                      <ellipse cx={cx} cy={cy} rx={el.width/2+glowR} ry={el.height/2+glowR}
                        fill="none" stroke={color} strokeWidth={3/zoom} opacity={opacity}/>
                      <ellipse cx={cx} cy={cy} rx={el.width/2+glowR*0.4} ry={el.height/2+glowR*0.4}
                        fill={color} opacity={opacity*0.08}/>
                    </g>
                  );
                })}
                {animStyle==='sequence'&&(()=>{
                  if(!connections.length) return null;
                  const totalSteps=elements.length;
                  const step=Math.floor((animTickRef.current/4)%totalSteps);
                  const activeEl=elements[step];
                  if(!activeEl) return null;
                  const color=activeEl.customColor||activeEl.service.color;
                  return (
                    <g>
                      <rect x={activeEl.x-8} y={activeEl.y-8} width={activeEl.width+16} height={activeEl.height+16}
                        rx={16} fill="none" stroke={color} strokeWidth={3/zoom} opacity={0.9}
                        strokeDasharray={`${12/zoom} ${6/zoom}`}/>
                      {[[activeEl.x,activeEl.y],[activeEl.x+activeEl.width,activeEl.y],[activeEl.x,activeEl.y+activeEl.height],[activeEl.x+activeEl.width,activeEl.y+activeEl.height]].map(([sx,sy],i)=>(
                        <circle key={i} cx={sx} cy={sy} r={4/zoom} fill={color} opacity={0.8}/>
                      ))}
                      {connections.filter(c=>c.from===activeEl.id||c.to===activeEl.id).map(conn=>{
                        const from=findById(conn.from),to=findById(conn.to);
                        if(!from||!to) return null;
                        const pts=bestPts(from,to);
                        return <line key={conn.id} x1={pts.from.x} y1={pts.from.y} x2={pts.to.x} y2={pts.to.y}
                          stroke={color} strokeWidth={4/zoom} opacity={0.5} strokeDasharray={`${8/zoom} ${4/zoom}`}/>;
                      })}
                      {/* Step counter pill */}
                      <g transform={`translate(${activeEl.x+activeEl.width/2},${activeEl.y-22})`}>
                        <rect x={-24/zoom} y={-10/zoom} width={48/zoom} height={18/zoom} rx={9/zoom} fill={color} opacity={0.9}/>
                        <text x={0} y={3/zoom} textAnchor="middle" fill="#fff" fontSize={10/zoom} fontWeight="700" fontFamily="Arial">
                          {step+1}/{totalSteps}
                        </text>
                      </g>
                    </g>
                  );
                })()}

                {/* Phase 2 - Data Packets: labelled packets travel along connections */}
                {animStyle==='packets'&&connections.map((conn,ci)=>{
                  const from=findById(conn.from),to=findById(conn.to);
                  if(!from||!to) return null;
                  const pts=bestPts(from,to);
                  const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
                  const ov=connAnimOverrides[conn.id]||{};
                  if(ov.disabled) return null;
                  const color=ov.color||animPacketColor||conn.color||'#3b82f6';
                  const textClr=animPacketTextColor||'#ffffff';
                  const label=ov.label||animPacketLabels[ci%animPacketLabels.length]||PACKET_LABELS[ci%PACKET_LABELS.length];
                  const sz=animPacketSize;
                  const dir=ov.direction||animDirection;
                  const renderPacket=(reversed,key)=>{
                    const ax=reversed?x2:x1,ay=reversed?y2:y1,bx=reversed?x1:x2,by=reversed?y1:y2;
                    const phase=0.05+((animTickRef.current+(ci*7)+(reversed?15:0))%30)/30*0.90;
                    const px=ax+(bx-ax)*phase, py=ay+(by-ay)*phase;
                    const pw=(label.length*6+10)*sz, ph2=16*sz;
                    return (
                      <g key={key} transform={`translate(${px},${py})`}>
                        <rect x={-pw/2/zoom} y={-ph2/2/zoom} width={pw/zoom} height={ph2/zoom}
                          rx={ph2/2/zoom} fill={color} opacity={0.92} stroke={textClr} strokeWidth={1/zoom}/>
                        <text x={0} y={5*sz/zoom} textAnchor="middle" fill={textClr}
                          fontSize={9*sz/zoom} fontWeight="700" fontFamily="Arial,sans-serif">
                          {label}
                        </text>
                        <circle cx={0} cy={0} r={3*sz/zoom} fill={textClr} opacity={0.7}/>
                      </g>
                    );
                  };
                  return (
                    <g key={conn.id}>
                      {(dir==='forward'||dir==='bidirectional')&&renderPacket(false,'f')}
                      {(dir==='reverse'||dir==='bidirectional')&&renderPacket(true,'r')}
                    </g>
                  );
                })}

                {/* Phase 2 - Status Indicators: health dots pulse on each service */}
                {animStyle==='status'&&elements.map((el,ei)=>{
                  const{color,label}=statusColor(ei);
                  const phase=((animTickRef.current+(ei*3))%20)/20;
                  const pulseR=(4+Math.sin(phase*Math.PI*2)*2)/zoom;
                  const dotX=el.x+el.width-8/zoom;
                  const dotY=el.y+8/zoom;
                  return (
                    <g key={el.id}>
                      {/* Pulsing outer ring */}
                      <circle cx={dotX} cy={dotY} r={pulseR*1.8} fill={color} opacity={0.2+Math.sin(phase*Math.PI*2)*0.15}/>
                      {/* Solid dot */}
                      <circle cx={dotX} cy={dotY} r={5/zoom} fill={color} stroke="#fff" strokeWidth={1.5/zoom} opacity={0.95}/>
                      {/* Status label pill on hover-like always-visible for GIF */}
                      {label!=='OK'&&(
                        <g transform={`translate(${dotX+8/zoom},${dotY})`}>
                          <rect x={0} y={-7/zoom} width={28/zoom} height={14/zoom} rx={7/zoom} fill={color} opacity={0.88}/>
                          <text x={14/zoom} y={4/zoom} textAnchor="middle" fill="#fff" fontSize={8/zoom} fontWeight="700" fontFamily="Arial">{label}</text>
                        </g>
                      )}
                    </g>
                  );
                })}

                {/* -- Ripple: concentric rings expand from each node -- */}
                {animStyle==='ripple'&&elements.map((el,ei)=>{
                  const t=animTickRef.current;
                  const color=animRippleColor||el.customColor||el.service.color;
                  const cx=el.x+el.width/2, cy=el.y+el.height/2;
                  const numRings=animRingCount;
                  return <g key={el.id}>{Array.from({length:numRings},(_,ri)=>{
                    const phase=((t+(ei*4)+(ri*Math.floor(30/numRings)))%30)/30;
                    const r=(el.width/2+8+phase*animRippleSpeed)/zoom;
                    return <circle key={ri} cx={cx} cy={cy} r={r} fill="none"
                      stroke={color} strokeWidth={2/zoom} opacity={Math.max(0,0.6-phase*0.6)}/>;
                  })}</g>;
                })}

                {/* -- Lightning: electric arcs flash along connections -- */}
                {animStyle==='lightning'&&connections.map((conn,ci)=>{
                  const from=findById(conn.from),to=findById(conn.to); if(!from||!to)return null;
                  const pts=bestPts(from,to);
                  const ov=connAnimOverrides[conn.id]||{};
                  if(ov.disabled) return null;
                  const ldir=ov.direction||animLightningDir;
                  const lcolor=ov.color||animLightningColor;
                  const lthick=animLightningThickness;
                  const lfreq=animLightningFreq;
                  const t=animTickRef.current;
                  const active=((t+(ci*11))%20)<lfreq;
                  if(!active) return null;
                  const renderArc=(x1,y1,x2,y2,key='')=>{
                    const segs=6; const dx=(x2-x1)/segs, dy=(y2-y1)/segs;
                    const pts2=[[x1,y1]];
                    for(let s=1;s<segs;s++){
                      const jag=((t*7+ci*13+s*17)%20-10)/zoom*2;
                      pts2.push([x1+dx*s+jag,y1+dy*s-jag]);
                    }
                    pts2.push([x2,y2]);
                    const d=pts2.map((p,i)=>(i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
                    return (
                      <g key={key}>
                        <path d={d} stroke="#fff" strokeWidth={(lthick+2)/zoom} fill="none" opacity={0.35}/>
                        <path d={d} stroke={lcolor} strokeWidth={lthick/zoom} fill="none" opacity={0.9}/>
                        <path d={d} stroke="#fff" strokeWidth={1/zoom} fill="none" opacity={0.55}/>
                      </g>
                    );
                  };
                  const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
                  return (
                    <g key={conn.id}>
                      {(ldir==='forward'||ldir==='bidirectional')&&renderArc(x1,y1,x2,y2,'f')}
                      {(ldir==='reverse'||ldir==='bidirectional')&&renderArc(x2,y2,x1,y1,'r')}
                    </g>
                  );
                })}

                {/* -- Orbit: satellite dots orbit each node -- */}
                {animStyle==='orbit'&&elements.map((el,ei)=>{
                  const t=animTickRef.current; const color=el.customColor||el.service.color;
                  const cx=el.x+el.width/2, cy=el.y+el.height/2;
                  const baseR=(Math.max(el.width,el.height)/2+16)/zoom;
                  const dirMult=animOrbitDir==='ccw'?-1:1;
                  return <g key={el.id}>{Array.from({length:animOrbitCount},(_,oi)=>{
                    const speed=(1+oi*0.4)*dirMult; const offset=oi*(Math.PI*2/animOrbitCount);
                    const angle=(t/30*Math.PI*2*speed)+offset;
                    const rx=baseR+(oi*8/zoom), ry=baseR*0.55+(oi*5/zoom);
                    const ox=cx+Math.cos(angle)*rx, oy=cy+Math.sin(angle)*ry;
                    const r=(3.5-oi*0.8)/zoom;
                    return <g key={oi}>
                      <circle cx={ox} cy={oy} r={r*2} fill={color} opacity={0.15}/>
                      <circle cx={ox} cy={oy} r={r} fill={color} opacity={0.85}/>
                    </g>;
                  })}</g>;
                })}

                {/* -- Mesh: shockwave cascades through connected nodes -- */}
                {animStyle==='mesh'&&(()=>{
                  if(!elements.length) return null;
                  const t=animTickRef.current;
                  const srcIdx=Math.floor(t/12)%elements.length;
                  const src=elements[srcIdx]; if(!src) return null;
                  const srcColor=src.customColor||src.service.color;
                  const wavePhase=(t%12)/12;
                  // Background faint mesh lines between all nearby nodes
                  const meshLines=[];
                  elements.forEach((a,ai)=>elements.forEach((b,bi)=>{
                    if(bi<=ai)return;
                    const dist=Math.hypot(a.x-b.x,a.y-b.y);
                    if(dist>400)return;
                    meshLines.push(<line key={ai+'-'+bi}
                      x1={a.x+a.width/2} y1={a.y+a.height/2}
                      x2={b.x+b.width/2} y2={b.y+b.height/2}
                      stroke="#6366f1" strokeWidth={0.5/zoom} opacity={0.12}/>);
                  }));
                  return <g>
                    {meshLines}
                    {/* Expanding shockwave ring from source */}
                    <circle cx={src.x+src.width/2} cy={src.y+src.height/2}
                      r={(20+wavePhase*120)/zoom} fill="none"
                      stroke={srcColor} strokeWidth={2/zoom} opacity={0.6-wavePhase*0.55}/>
                    {/* Pulse arriving at connected nodes */}
                    {connections.filter(c=>c.from===src.id||c.to===src.id).map(conn=>{
                      const other=findById(conn.from===src.id?conn.to:conn.from); if(!other)return null;
                      const arrivalPhase=Math.max(0,wavePhase-0.5)*2;
                      if(arrivalPhase<=0)return null;
                      const oc=other.customColor||other.service.color;
                      return <circle key={conn.id} cx={other.x+other.width/2} cy={other.y+other.height/2}
                        r={(10+arrivalPhase*40)/zoom} fill="none"
                        stroke={oc} strokeWidth={2/zoom} opacity={0.5-arrivalPhase*0.45}/>;
                    })}
                  </g>;
                })()}

                {/* -- Heatmap: traffic intensity by speed & brightness -- */}
                {animStyle==='heatmap'&&connections.map((conn,ci)=>{
                  const from=findById(conn.from),to=findById(conn.to); if(!from||!to)return null;
                  const pts=bestPts(from,to);
                  const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
                  // "Traffic" is deterministic by ci - varied but consistent
                  const traffic=[0.9,0.3,0.7,0.5,0.95,0.2,0.8][ci%7];
                  const speed=0.5+traffic*2; const brightness=0.3+traffic*0.7;
                  const heatColor=traffic>0.7?'#ef4444':traffic>0.4?'#f59e0b':'#22c55e';
                  const phase=((animTickRef.current*speed+(ci*7))%30)/30;
                  const dotX=x1+(x2-x1)*phase, dotY=y1+(y2-y1)*phase;
                  const sw=(1+traffic*3)/zoom;
                  return <g key={conn.id}>
                    <line x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke={heatColor} strokeWidth={sw} opacity={brightness*0.4}/>
                    <circle cx={dotX} cy={dotY} r={(3+traffic*4)/zoom} fill={heatColor} opacity={brightness}/>
                    <circle cx={dotX} cy={dotY} r={(6+traffic*6)/zoom} fill={heatColor} opacity={brightness*0.2}/>
                  </g>;
                })}

                {/* -- Heartbeat: ECG spike along connections -- */}
                {animStyle==='heartbeat'&&(()=>{
                  const t=animTickRef.current; const cycleLen=30;
                  return connections.map((conn,ci)=>{
                    const from=findById(conn.from),to=findById(conn.to); if(!from||!to)return null;
                    const pts=bestPts(from,to);
                    const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
                    const color=conn.color||'#10b981';
                    const phase=((t+(ci*9))%cycleLen)/cycleLen;
                    // ECG shape: flat->rise->sharp spike->drop->flat
                    const ecg=p=>{
                      if(p<0.3||p>0.7)return 0;
                      const lp=(p-0.3)/0.4;
                      if(lp<0.3)return lp*0.3;
                      if(lp<0.45)return 0.09+(lp-0.3)*3;
                      if(lp<0.55)return 0.09+0.45-(lp-0.45)*6;
                      if(lp<0.65)return Math.max(0,(lp-0.55)*2);
                      return 0;
                    };
                    // Draw 12 points along the line with perpendicular ECG displacement
                    const len=Math.hypot(x2-x1,y2-y1); if(len<10)return null;
                    const nx=(y1-y2)/len, ny=(x2-x1)/len; // normal
                    const ptArr=Array.from({length:12},(_,i)=>{
                      const t2=(i/11); const disp=ecg((phase+t2*0.3)%1)*40/zoom;
                      return [(x1+(x2-x1)*t2)+(nx*disp),(y1+(y2-y1)*t2)+(ny*disp)];
                    });
                    const d=ptArr.map((p,i)=>(i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
                    return <g key={conn.id}>
                      <path d={d} stroke={color} strokeWidth={2.5/zoom} fill="none" opacity={0.9} strokeLinejoin="round"/>
                      <path d={d} stroke="#fff" strokeWidth={1/zoom} fill="none" opacity={0.3}/>
                    </g>;
                  });
                })()}

                {/* -- Constellation: faint star-field mesh between nearby nodes -- */}
                {animStyle==='constellation'&&(()=>{
                  const t=animTickRef.current;
                  const drift=Math.sin(t/20)*3;
                  const cColor=animConstellationColor;
                  const cDist=animConstellationDist;
                  return <g opacity={0.7}>
                    {elements.map((a,ai)=>elements.map((b,bi)=>{
                      if(bi<=ai)return null;
                      const dist=Math.hypot(a.x-b.x,a.y-b.y);
                      if(dist>cDist)return null;
                      const op=0.08+0.07*Math.sin((t/15+ai*1.3+bi*0.7));
                      return <line key={ai+'-'+bi}
                        x1={a.x+a.width/2+drift} y1={a.y+a.height/2}
                        x2={b.x+b.width/2} y2={b.y+b.height/2}
                        stroke={cColor} strokeWidth={0.8/zoom} opacity={op}/>;
                    }))}
                    {elements.map((el,ei)=>{
                      const starPh=(t/20+ei*0.8)%1;
                      const r=(1.5+Math.sin(starPh*Math.PI*2)*0.8)/zoom;
                      return <circle key={el.id} cx={el.x+el.width/2} cy={el.y+el.height/2}
                        r={r} fill={cColor} opacity={0.5+Math.sin(starPh*Math.PI*2)*0.3}/>;
                    })}
                  </g>;
                })()}

                {/* -- Ping: radar pings travel and acknowledge on arrival -- */}
                {animStyle==='ping'&&connections.map((conn,ci)=>{
                  const from=findById(conn.from),to=findById(conn.to); if(!from||!to)return null;
                  const pts=bestPts(from,to);
                  const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
                  const color=conn.color||'#06b6d4';
                  const phase=((animTickRef.current+(ci*11))%40)/40;
                  const px=x1+(x2-x1)*phase, py=y1+(y2-y1)*phase;
                  // Ping dot travelling
                  const arrived=phase>0.9;
                  // Acknowledgement ring at destination when ping arrives
                  const ackPhase=((animTickRef.current+(ci*11)+36)%40)/40;
                  const showAck=ackPhase<0.25;
                  return <g key={conn.id}>
                    {/* Ping radar circle */}
                    <circle cx={x1} cy={y1} r={(phase*30)/zoom} fill="none"
                      stroke={color} strokeWidth={1.5/zoom} opacity={Math.max(0,0.6-phase*0.6)}/>
                    {/* Travelling ping dot */}
                    <circle cx={px} cy={py} r={4/zoom} fill={color} opacity={0.9}/>
                    <circle cx={px} cy={py} r={8/zoom} fill={color} opacity={0.2}/>
                    {/* Acknowledgement pulse at destination */}
                    {showAck&&<circle cx={x2} cy={y2} r={(ackPhase*50)/zoom} fill="none"
                      stroke={color} strokeWidth={2/zoom} opacity={0.7-ackPhase*2.5}/>}
                  </g>;
                })}

                {/* -- Flow Streams: liquid particle rivers along connections -- */}
                {animStyle==='streams'&&connections.map((conn,ci)=>{
                  const from=findById(conn.from),to=findById(conn.to); if(!from||!to)return null;
                  const pts=bestPts(from,to);
                  const x1=pts.from.x,y1=pts.from.y,x2=pts.to.x,y2=pts.to.y;
                  const color=conn.color||'#3b82f6';
                  const t=animTickRef.current;
                  const len=Math.hypot(x2-x1,y2-y1); if(len<10)return null;
                  // 8 particles per stream at varying speeds & sizes
                  const particles=Array.from({length:8},(_,pi)=>{
                    const speed=0.7+pi*0.08;
                    const phase=((t*speed+(ci*7)+(pi*3.75))%30)/30;
                    const jitter=((pi*17+ci*11)%10-5)/zoom*0.5;
                    const nx=(y1-y2)/len,ny=(x2-x1)/len;
                    return {
                      x:x1+(x2-x1)*phase+nx*jitter,
                      y:y1+(y2-y1)*phase+ny*jitter,
                      r:(1.5+Math.sin(phase*Math.PI*3)*1.2)/zoom,
                      op:0.25+Math.sin(phase*Math.PI*2)*0.35,
                    };
                  });
                  return <g key={conn.id}>
                    {/* Faint stream guide */}
                    <line x1={x1} y1={y1} x2={x2} y2={y2}
                      stroke={color} strokeWidth={3/zoom} opacity={0.12}/>
                    {particles.map((p,pi)=><g key={pi}>
                      <circle cx={p.x} cy={p.y} r={p.r*2.5} fill={color} opacity={p.op*0.15}/>
                      <circle cx={p.x} cy={p.y} r={p.r} fill={color} opacity={p.op}/>
                    </g>)}
                  </g>;
                })}

              </g>
            </svg>
          )}

            {/* Phase 3+ - Colour Shift overlay */}
            {animEnabled&&animStyle==='colorshift'&&<ColorShiftOverlay tick={animTickRef.current}/>}

            {/* Connection labels - above animation overlays but BELOW all UI panels */}
            {connections.some(c=>c.midLabel&&c.midLabel.trim())&&(
              <svg style={{position:'absolute',inset:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:95}}>
                <g transform={`translate(${canvasOffset.x},${canvasOffset.y}) scale(${zoom})`}>
                  {connections.map(c=>renderConnLabel(c))}
                </g>
              </svg>
            )}
          

          {/* DOM layer */}
            <div style={{transform:`translate(${canvasOffset.x}px,${canvasOffset.y}px) scale(${zoom})`,transformOrigin:'0 0',position:'absolute',width:10000,height:10000,zIndex:10}}>

              {/* Borders */}
              {borders.map(b=>{
                const lbl=labels.find(l=>l.borderId===b.id);
                return (
                  <div key={b.id} onMouseDown={e=>onBorderDown(e,b)} onContextMenu={e=>onBorderRightClick(e,b)}
                    style={{position:'absolute',left:b.x,top:b.y,width:b.width,height:b.height,
                      border:`${b.strokeWidth||2}px ${b.strokeStyle||'solid'} ${b.color}`,
                      borderRadius:b.borderRadius?`${b.borderRadius}px`:0,
                      cursor:drawMode?'crosshair':'move',boxSizing:'border-box',
                      outline:selectedBorder===b.id?'2px solid #a855f7':(drawMode?`2px dashed ${b.color}`:'none'),
                      outlineOffset:2,
                      background:b.fillColor&&b.fillColor!=='transparent'?b.fillColor+(Math.round((b.fillOpacity||0.08)*255).toString(16).padStart(2,'0')):'transparent',
                      // Border animations
                      ...(b.animation==='pulse'?{animation:'borderPulse 2s ease-in-out infinite'}:{}),
                      ...(b.animation==='glow'?{animation:'borderGlow 2s ease-in-out infinite','--bc':b.color}:{}),
                      ...(b.animation==='colorshift'?{animation:'colorShiftBorder 4s linear infinite'}:{}),
                      ...(b.animation==='rainbow'?{animation:'rainbowBorder 3s linear infinite'}:{}),
                    }}>
                    {lbl&&<BorderLabel label={lbl} isSelected={selectedLabelId===lbl.id} isEditing={editingLabelId===lbl.id}
                      onMouseDown={e=>onLabelDown(e,lbl)} onResizeDown={e=>onLabelResizeDown(e,lbl)}
                      onDoubleClick={e=>{e.stopPropagation();setEditingLabelId(lbl.id);setSelectedLabelId(lbl.id);}}
                      onTextChange={t=>setLabels(prev=>prev.map(l=>l.id===lbl.id?{...l,text:t}:l))}
                      onBlur={()=>{setEditingLabelId(null);save();}}/>}
                    {selectedBorder===b.id&&!drawMode&&<div onMouseDown={e=>onBorderResizeDown(e,b)} style={{position:'absolute',right:0,bottom:0,width:13,height:13,background:'#8b5cf6',cursor:'se-resize',borderTopLeftRadius:3}}/>}
                    {drawMode&&<div onMouseDown={e=>{e.stopPropagation();onBorderDown(e,b);}} style={{position:'absolute',inset:0,cursor:'crosshair',zIndex:5,background:'transparent'}}/>}
                  </div>
                );
              })}

              {drawingBorder&&borderDragStart&&borderPreview&&<div style={{position:'absolute',left:borderPreview.x,top:borderPreview.y,width:borderPreview.w,height:borderPreview.h,border:'2px dashed #7c3aed',pointerEvents:'none'}}/>}

              {/* Bubbles */}
              {bubbles.map(b=>(
                <SpeechBubble key={b.id} bubble={b} isSelected={selectedBubble===b.id} isEditing={editingBubble===b.id} inDrawMode={!!drawMode}
                  onMouseDown={e=>onBubbleDown(e,b)}
                  onTouchStart={e=>onBubbleTouchStart(e,b)}
                  onDoubleClick={e=>{e.stopPropagation();if(!isMobile){setShowBubbleSheet(true);setSelectedBubble(b.id);}else{setShowBubbleSheet(true);}}}
                  onContextMenu={e=>onBubbleRightClick(e,b)}
                  onTextChange={t=>setBubbles(prev=>prev.map(x=>x.id===b.id?{...x,text:t}:x))}
                  onBlur={()=>{setEditingBubble(null);save();}}
                  onResizeDown={e=>onBubbleResizeDown(e,b)}/>
              ))}

              {/* Elements */}
              {elements.map(el=>{
                const iconSize=Math.max(16,Math.round(Math.min(el.width,el.height)*0.38));
                const labelSize=Math.max(9,Math.round(Math.min(el.width,el.height)*0.11));
                const elShape=ELEMENT_SHAPES.find(s=>s.id===(el.shape||'rounded'))||ELEMENT_SHAPES[0];
                const elW=elShape.forceSquare?Math.min(el.width,el.height):el.width;
                const elH=elShape.forceSquare?Math.min(el.width,el.height):el.height;
                const baseColor=el.customColor||el.service.color;

                // Phase 3 node visual style
                const getNodeStyle=()=>{
                  const isMultiSel=multiSel.has(el.id);
                  const multiRing=isMultiSel?{outline:'2.5px solid #3b82f6',outlineOffset:3}:{};
                  const base={position:'absolute',left:el.x,top:el.y,width:elW,height:elH,borderRadius:elShape.borderRadius,clipPath:elShape.clip||undefined,cursor:drawMode?'crosshair':'move',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',overflow:'hidden',outline:drawMode?'2px dashed rgba(255,255,255,0.7)':(isMultiSel?'2.5px solid #3b82f6':'none'),outlineOffset:isMultiSel?3:2};
                  if(nodeVisualStyle==='glass'){return{...base,...multiRing,backgroundColor:`${baseColor}22`,backdropFilter:'blur(12px)',WebkitBackdropFilter:'blur(12px)',border:selectedEl===el.id?'2px solid #fbbf24':`1.5px solid ${baseColor}88`,boxShadow:`0 4px 20px ${baseColor}33, inset 0 1px 0 rgba(255,255,255,0.2)`};}
                  if(nodeVisualStyle==='neon'){return{...base,...multiRing,backgroundColor:darkMode?'#0f172a':'#1e293b',border:selectedEl===el.id?'2px solid #fbbf24':`2px solid ${baseColor}`,boxShadow:`0 0 12px ${baseColor}88, 0 0 30px ${baseColor}44, inset 0 0 12px ${baseColor}11`};}
                  if(nodeVisualStyle==='gradient'){return{...base,...multiRing,background:`radial-gradient(circle at 30% 30%, ${baseColor}, ${baseColor}88 60%, #1e293b)`,border:selectedEl===el.id?'3px solid #fbbf24':'3px solid transparent',boxShadow:'0 4px 16px rgba(0,0,0,0.35)'};}
                  // Default solid - use transparent border when unselected to avoid dark glitch on overlap
                  return{...base,...multiRing,backgroundColor:baseColor,border:selectedEl===el.id?'3px solid #fbbf24':'3px solid transparent',boxShadow:'0 4px 12px rgba(0,0,0,0.22)'};
                };
                const labelColor=nodeVisualStyle==='glass'?baseColor:'#fff';
                return (
                  <div key={el.id}
                    onMouseDown={e=>onElDown(e,el)}
                    onTouchStart={e=>onElTouchStart(e,el)}
                    onDoubleClick={e=>onElDblClick(e,el)}
                    style={getNodeStyle()}>
                    <div style={{fontSize:iconSize,lineHeight:1,userSelect:'none',pointerEvents:'none',marginBottom:2,filter:nodeVisualStyle==='neon'?`drop-shadow(0 0 6px ${baseColor})`:'none'}}>{el.service.icon}</div>
                    {editingEl===el.id
                      ?<RenameInput value={el.customName??el.service.name} onChange={v=>setElements(prev=>prev.map(x=>x.id===el.id?{...x,customName:v}:x))} onBlur={()=>{setEditingEl(null);save();}} style={{color:'#1e293b',maxWidth:elW-12,fontSize:labelSize}}/>
                      :<div style={{fontSize:labelSize,fontWeight:700,color:labelColor,userSelect:'none',pointerEvents:'none',textAlign:'center',padding:'0 4px',wordBreak:'break-word',maxWidth:'100%',textShadow:nodeVisualStyle==='neon'?`0 0 8px ${baseColor}, 0 0 16px ${baseColor}`:'none'}}>{el.customName||el.service.name}</div>
                    }
                    {selectedEl===el.id&&editingEl!==el.id&&<div onMouseDown={e=>onElResizeDown(e,el)} onTouchStart={e=>{e.stopPropagation();e.preventDefault();const t=e.touches[0];const{x,y}=touchToCanvas(t.clientX,t.clientY);drag.current={type:'el-resize',id:el.id,mouseX:x,mouseY:y,origW:el.width,origH:el.height};}} style={{position:'absolute',right:0,bottom:0,width:18,height:18,background:'#fbbf24',cursor:'se-resize',borderTopLeftRadius:3,touchAction:'none',zIndex:20}}/>}
                  </div>
                );
              })}

              {/* Icons */}
              {icons.map(ic=>{
                const icLabelSize=Math.max(9,Math.round(ic.size*0.18));
                return (
                  <div key={ic.id}
                    onMouseDown={e=>onIconDown(e,ic)}
                    onTouchStart={e=>onIconTouchStart(e,ic)}
                    onDoubleClick={e=>onIconDblClick(e,ic)}
                    style={{position:'absolute',left:ic.x,top:ic.y,width:ic.size,cursor:drawMode?'crosshair':'move',outline:selectedIcon===ic.id?'2px solid #fbbf24':(drawMode?'2px dashed #3b82f6':'none'),outlineOffset:2,borderRadius:8}}>
                    <div style={{width:ic.size,height:ic.size,display:'flex',alignItems:'center',justifyContent:'center',fontSize:Math.round(ic.size*0.68),lineHeight:1,userSelect:'none',pointerEvents:'none'}}>{ic.iconDef.icon}</div>
                    {editingIcon===ic.id
                      ?<RenameInput value={ic.label} onChange={v=>setIcons(prev=>prev.map(x=>x.id===ic.id?{...x,label:v}:x))} onBlur={()=>{setEditingIcon(null);save();}} style={{color:textC,marginTop:2,fontSize:icLabelSize}}/>
                      :<div style={{fontSize:icLabelSize,fontWeight:600,textAlign:'center',marginTop:3,color:darkMode?'#e2e8f0':'#1e293b',userSelect:'none',pointerEvents:'none',wordBreak:'break-word'}}>{ic.label}</div>
                    }
                    {selectedIcon===ic.id&&editingIcon!==ic.id&&<div onMouseDown={e=>onIconResizeDown(e,ic)} onTouchStart={e=>{e.stopPropagation();e.preventDefault();const t=e.touches[0];const{x,y}=touchToCanvas(t.clientX,t.clientY);drag.current={type:'icon-resize',id:ic.id,mouseX:x,mouseY:y,origSize:ic.size};}} style={{position:'absolute',right:-4,bottom:0,width:18,height:18,background:'#fbbf24',cursor:'se-resize',borderRadius:3,touchAction:'none',zIndex:20}}/>}
                  </div>
                );
              })}

              {/* Text Banners - inside transform div so they move with canvas */}
              {texts.map(t=>{
                const isSelected=selectedText===t.id;
                const ff=t.fontFamily||'Arial';
                const fs=t.fontSize||28;
                const fw=t.fontWeight||'normal';
                const fi=t.fontStyle||'normal';
                const td=t.textDecoration||'none';
                const col=t.color||(darkMode?'#ffffff':'#1e293b');
                const al=t.align||'center';
                return(
                  <div key={t.id}
                    onMouseDown={e=>{
                      e.stopPropagation();
                      if(drawMode){tryConnect(t);return;}
                      if(isSelected){
                        const{x,y}=touchToCanvas(e.clientX,e.clientY);
                        drag.current={type:'text',id:t.id,mouseX:x,mouseY:y,origX:t.x,origY:t.y};
                      } else {
                        clearSel();
                        setSelectedText(t.id);
                        setShowBannerEditor(false);
                        const{x,y}=touchToCanvas(e.clientX,e.clientY);
                        drag.current={type:'text',id:t.id,mouseX:x,mouseY:y,origX:t.x,origY:t.y};
                      }
                    }}
                    onTouchStart={e=>{
                      if(drawMode){e.stopPropagation();tryConnect(t);return;}
                      e.stopPropagation();
                      e.preventDefault();
                      const tc=e.touches[0];
                      const{x,y}=touchToCanvas(tc.clientX,tc.clientY);
                      if(isSelected){
                        drag.current={type:'text',id:t.id,mouseX:x,mouseY:y,origX:t.x,origY:t.y};
                        touchRef.current={startX:tc.clientX,startY:tc.clientY,lastX:tc.clientX,lastY:tc.clientY,moved:false};
                      } else {
                        clearSel();
                        setSelectedText(t.id);
                        setShowBannerEditor(false);
                        drag.current={type:'text',id:t.id,mouseX:x,mouseY:y,origX:t.x,origY:t.y};
                        touchRef.current={startX:tc.clientX,startY:tc.clientY,lastX:tc.clientX,lastY:tc.clientY,moved:false};
                      }
                    }}
                    onDoubleClick={e=>{e.stopPropagation();setShowBannerEditor(true);}}
                    style={{position:'absolute',left:t.x,top:t.y,cursor:'move',userSelect:'none',
                      outline:isSelected?`2px solid #f59e0b`:'none',outlineOffset:6,
                      padding:t.bgColor&&t.bgColor!=='transparent'?'6px 10px':'2px 6px',
                      borderRadius:t.bgColor&&t.bgColor!=='transparent'?8:4,
                      background:t.bgColor&&t.bgColor!=='transparent'
                        ?t.bgColor+(Math.round((t.bgOpacity||0.9)*255).toString(16).padStart(2,'0'))
                        :'transparent',
                      border:t.borderColor&&t.borderColor!=='transparent'
                        ?`${t.borderWidth||2}px solid ${t.borderColor}`
                        :'none',
                      zIndex:60,
                      // Ensure all child elements pass mouse events up to this div
                      WebkitUserSelect:'none',MozUserSelect:'none',msUserSelect:'none'}}>
                    {editingText===t.id?(
                      <input
                        autoFocus
                        value={t.text}
                        onChange={e=>setTexts(p=>p.map(x=>x.id===t.id?{...x,text:e.target.value}:x))}
                        onBlur={()=>{setEditingText(null);save();}}
                        onKeyDown={e=>{if(e.key==='Escape'||e.key==='Enter'){setEditingText(null);save();}e.stopPropagation();}}
                        style={{fontFamily:ff,fontSize:fs,fontWeight:fw,fontStyle:fi,textDecoration:td,color:col,textAlign:al,background:'transparent',border:'none',outline:'none',minWidth:80,width:Math.max(80,t.text.length*fs*0.6),opacity:t.opacity||1}}
                      />
                    ):(
                      <span style={{
                        fontFamily:ff,fontSize:fs,fontWeight:fw,fontStyle:fi,
                        textDecoration:td,color:col,textAlign:al,
                        display:'block',whiteSpace:'pre',opacity:t.opacity||1,
                        pointerEvents:'none',lineHeight:1.2,
                        textShadow:(!t.bgColor||t.bgColor==='transparent')?(col==='#ffffff'||col==='#fff'?'0 1px 3px rgba(0,0,0,0.5)':'0 1px 2px rgba(255,255,255,0.1)'):'none',
                      }}>
                        {t.iconPrefix?`${t.iconPrefix} `:''}{t.text||'Text Banner'}
                      </span>
                    )}
                  </div>
                );
              })}

            </div>
          </div>

          {/* Canvas Watermark - fixed position relative to canvas viewport, not transform */}
          {watermarkImg&&(()=>{
            const r=canvasRef.current?.getBoundingClientRect();
            const pad=16;
            const posStyles={
              'bottom-right':{bottom:pad+(isMobile?52:0),right:pad},
              'bottom-left':{bottom:pad+(isMobile?52:0),left:pad},
              'top-right':{top:pad+(isMobile?112:52),right:pad},
              'top-left':{top:pad+(isMobile?112:52),left:pad},
              'center':{top:'50%',left:'50%',transform:'translate(-50%,-50%)'},
            };
            return(
              <div style={{position:'absolute',...(posStyles[watermarkPos]||posStyles['bottom-right']),zIndex:55,pointerEvents:'none'}}>
                <img src={watermarkImg} alt="watermark"
                  style={{width:watermarkSize,height:'auto',opacity:watermarkOpacity,userSelect:'none',pointerEvents:'none',maxWidth:200}}/>
              </div>
            );
          })()}

          {/* Watermark Panel */}
          {showWatermarkPanel&&(
            <div style={{position:'absolute',top:isMobile?120:52,right:8,zIndex:350,background:cardBg,border:`1.5px solid #6366f1`,borderRadius:13,boxShadow:'0 8px 28px rgba(99,102,241,0.2)',width:250,maxHeight:'80vh',display:'flex',flexDirection:'column'}}
              onMouseDown={e=>e.stopPropagation()}>
              <div style={{padding:'12px 14px 10px',borderBottom:`1px solid ${borderC}`,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                <span style={{fontSize:13,fontWeight:800,color:'#6366f1'}}>🖼 Watermark / Logo</span>
                <button onClick={()=>setShowWatermarkPanel(false)} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:18}}>✕</button>
              </div>
              <div style={{flex:1,overflowY:'auto',padding:'12px 14px 16px'}}>
                {/* Upload */}
                <input ref={watermarkFileRef} type="file" accept="image/*" style={{display:'none'}}
                  onChange={e=>{
                    const file=e.target.files?.[0]; if(!file)return;
                    const reader=new FileReader();
                    reader.onload=ev=>setWatermarkImg(ev.target.result);
                    reader.readAsDataURL(file);
                  }}/>
                <button onClick={()=>watermarkFileRef.current?.click()}
                  style={{width:'100%',padding:'10px',borderRadius:9,border:`2px dashed #6366f1`,background:'rgba(99,102,241,0.06)',color:'#6366f1',cursor:'pointer',fontSize:12,fontWeight:700,marginBottom:10}}>
                  {watermarkImg?'🔄 Change Image':'📁 Upload Logo / Image'}
                </button>
                {watermarkImg&&(
                  <div style={{textAlign:'center',marginBottom:10}}>
                    <img src={watermarkImg} alt="preview" style={{maxWidth:100,maxHeight:60,borderRadius:6,border:`1px solid ${borderC}`}}/>
                  </div>
                )}
                {/* Position */}
                <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',letterSpacing:'0.06em',marginBottom:6}}>Position</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:10}}>
                  {[['top-left','↖'],['top-right','↗'],['center','⊙'],['bottom-left','↙'],['bottom-right','↘']].map(([pos,ic])=>(
                    <button key={pos} onClick={()=>setWatermarkPos(pos)}
                      style={{padding:'7px 4px',borderRadius:7,border:`1.5px solid ${watermarkPos===pos?'#6366f1':borderC}`,background:watermarkPos===pos?'rgba(99,102,241,0.1)':'transparent',color:watermarkPos===pos?'#6366f1':textMut,cursor:'pointer',fontSize:16,fontWeight:700,gridColumn:pos==='center'?'2':'auto'}}>
                      {ic}
                    </button>
                  ))}
                </div>
                {/* Size */}
                <div style={{fontSize:10,fontWeight:700,color:textMut,textTransform:'uppercase',marginBottom:4}}>Size</div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:10,color:textMut}}>Width</span>
                  <span style={{fontSize:10,fontWeight:700,color:textC}}>{watermarkSize}px</span>
                </div>
                <input type="range" min={40} max={300} value={watermarkSize} onChange={e=>setWatermarkSize(Number(e.target.value))}
                  style={{width:'100%',accentColor:'#6366f1',marginBottom:10}}/>
                {/* Opacity */}
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:10,color:textMut}}>Opacity</span>
                  <span style={{fontSize:10,fontWeight:700,color:textC}}>{Math.round(watermarkOpacity*100)}%</span>
                </div>
                <input type="range" min={5} max={100} value={Math.round(watermarkOpacity*100)} onChange={e=>setWatermarkOpacity(Number(e.target.value)/100)}
                  style={{width:'100%',accentColor:'#6366f1',marginBottom:10}}/>
                {/* Remove */}
                {watermarkImg&&(
                  <button onClick={()=>{setWatermarkImg(null);setShowWatermarkPanel(false);}}
                    style={{width:'100%',padding:'7px',borderRadius:7,border:'1px solid #ef4444',background:'transparent',color:'#ef4444',cursor:'pointer',fontSize:11,fontWeight:600}}>
                    Remove Watermark
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Mobile add panel */}
          {isMobile&&showMobilePanel&&(
            <div style={{position:'absolute',left:0,right:0,bottom:52,zIndex:150,background:cardBg,borderTop:`1px solid ${borderC}`,borderRadius:'14px 14px 0 0',boxShadow:'0 -4px 24px rgba(0,0,0,0.18)',maxHeight:'60vh',display:'flex',flexDirection:'column',animation:'slideUpPanel 0.25s ease-out'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 14px 8px'}}>
                <span style={{fontSize:14,fontWeight:700,color:textC}}>Add to canvas</span>
                <button onClick={()=>setShowMobilePanel(false)} style={{background:'none',border:'none',cursor:'pointer',color:textMut,fontSize:20,lineHeight:1}}>✕</button>
              </div>
              <div style={{display:'flex',borderBottom:`1px solid ${borderC}`,paddingLeft:14}}>
                {['services','icons'].map(tab=>(
                  <button key={tab} onClick={()=>setActiveTab(tab)} style={{padding:'7px 16px',border:'none',background:'transparent',cursor:'pointer',fontSize:12,fontWeight:600,color:activeTab===tab?accent:textMut,borderBottom:activeTab===tab?`2px solid ${accent}`:'2px solid transparent'}}>
                    {tab==='services'?'Services':'Icons'}
                  </button>
                ))}
              </div>
              <div style={{flex:1,overflowY:'auto',padding:10}}>
                {activeTab==='services'&&(<>
                  {/* Provider switcher */}
                  <div style={{display:'flex',gap:6,marginBottom:10}}>
                    {CLOUD_PROVIDERS.map(p=>(
                      <button key={p.id} onClick={()=>setProvider(p.id)}
                        style={{flex:1,padding:'7px 4px',borderRadius:9,border:`1.5px solid ${provider===p.id?p.color:borderC}`,background:provider===p.id?p.color+'18':'transparent',cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:2,transition:'all 0.15s'}}>
                        <span style={{fontSize:18}}>{p.logo}</span>
                        <span style={{fontSize:10,fontWeight:700,color:provider===p.id?p.color:textMut}}>{p.name}</span>
                      </button>
                    ))}
                  </div>
                  <div style={{display:'flex',gap:8,marginBottom:10,overflowX:'auto',paddingBottom:4}}>
                    {/* AI Generate button in mobile panel */}
                    <button onClick={()=>{if(tryPremiumAction('Generate with AI')){setShowAiModal(true);setShowMobilePanel(false);}}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:'none',background:'linear-gradient(135deg,#7c3aed,#2563eb)',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5,boxShadow:'0 2px 8px rgba(124,58,237,0.3)'}}>
                      ✨ Generate with AI
                    </button>
                    {/* Import Terraform button in mobile panel */}
                    <button onClick={()=>{if(tryPremiumAction('Import from Terraform')){setShowTerraformImportModal(true);setShowMobilePanel(false);}}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:'none',background:'linear-gradient(135deg,#0f766e,#0e7490)',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5,boxShadow:'0 2px 8px rgba(14,116,144,0.3)'}}>
                      📂 Terraform
                    </button>
                    <button onClick={()=>{if(tryPremiumAction('Import from Image / Doc')){setShowImportModal(true);setShowMobilePanel(false);}}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:'none',background:'linear-gradient(135deg,#0369a1,#0284c7)',color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5,boxShadow:'0 2px 8px rgba(3,105,161,0.3)'}}>
                      📥 Import
                    </button>
                    <button onClick={()=>{setShowLibraryPanel(true);setShowMobilePanel(false);}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5}}>
                      🗂️ Library{savedCount>0?` (${savedCount})`:''} 
                    </button>
                    {/* Terraform button in mobile panel */}
                    <button onClick={()=>{if((elements.length||borders.length)&&tryPremiumAction('Export IaC Code')){setShowIaCExportModal(true);setShowMobilePanel(false);}}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:'none',background:elements.length||borders.length?'linear-gradient(135deg,#0f766e,#0891b2)':'#6b7280',color:'#fff',cursor:elements.length||borders.length?'pointer':'not-allowed',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5,opacity:elements.length||borders.length?1:0.6}}>
                      {'</>'} Terraform
                    </button>
                    {/* Validate button in mobile panel */}
                    <button onClick={()=>{if((elements.length||borders.length)&&tryPremiumAction('Architecture Validation')){setShowValidationPanel(p=>!p);setShowMobilePanel(false);}}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:'none',background:elements.length||borders.length?'linear-gradient(135deg,#059669,#10b981)':'#6b7280',color:'#fff',cursor:elements.length||borders.length?'pointer':'not-allowed',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5,opacity:elements.length||borders.length?1:0.6}}>
                      ✓ Validate
                    </button>
                    {/* Compare button in mobile panel */}
                    <button onClick={()=>{if(elements.length&&tryPremiumAction('Architecture Comparison')){setShowCompareModal(true);setShowMobilePanel(false);}}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:'none',background:elements.length?'linear-gradient(135deg,#6366f1,#4f46e5)':'#6b7280',color:'#fff',cursor:elements.length?'pointer':'not-allowed',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5,opacity:elements.length?1:0.6}}>
                      ⚖️ Compare
                    </button>
                    {/* Animate button in mobile panel */}
                    <button onClick={()=>{setShowAnimPanel(p=>!p);setShowMobilePanel(false);}} style={{flexShrink:0,padding:'7px 14px',borderRadius:8,border:`1.5px solid ${animEnabled?'#a855f7':borderC}`,background:animEnabled?'rgba(168,85,247,0.15)':'transparent',color:animEnabled?'#a855f7':textC,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',gap:5}}>
                      ◎ {animEnabled?'Anim ON':'Animate'}
                    </button>
                    {ARCHITECTURE_TEMPLATES.map(t=>(
                      <button key={t.id} onClick={()=>{loadTemplate(t);setShowMobilePanel(false);}} style={{flexShrink:0,padding:'6px 12px',borderRadius:8,border:`1px solid ${borderC}`,background:cardBg,color:textC,cursor:'pointer',fontSize:11,fontWeight:600,display:'flex',alignItems:'center',gap:5}}>
                        <span>{t.icon}</span>{t.name}
                      </button>
                    ))}
                  </div>
                  <div style={{position:'relative',marginBottom:8}}>
                    <Search size={12} style={{position:'absolute',left:8,top:9,color:'#9ca3af'}}/>
                    <input value={searchTerm} onChange={e=>setSearchTerm(e.target.value)} placeholder="Search services…" style={{width:'100%',paddingLeft:26,paddingRight:8,paddingTop:7,paddingBottom:7,borderRadius:7,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:12,boxSizing:'border-box',outline:'none'}}/>
                  </div>
                  {/* Add custom service button */}
                  <button onClick={()=>setShowCustomSvcModal(true)} style={{width:'100%',marginBottom:10,padding:'8px',borderRadius:8,border:`1.5px dashed ${accent}`,background:'transparent',color:accent,cursor:'pointer',fontSize:12,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center',gap:5}}>
                    <Plus size={13}/> Add Custom Service
                  </button>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:7}}>
                    {filteredSvc.map(s=>(
                      <button key={s.id} onClick={()=>addToCenter({type:'service',data:s})} style={{padding:'10px 6px',borderRadius:9,border:`1px solid ${s.custom?accent:borderC}`,borderLeft:`4px solid ${s.color}`,background:s.custom?accent+'08':cardBg,cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:4,position:'relative'}}>
                        <span style={{fontSize:22}}>{s.icon}</span>
                        <span style={{fontSize:10,fontWeight:600,color:textC,textAlign:'center'}}>{s.name}</span>
                        {s.custom&&<span style={{position:'absolute',top:4,right:4,fontSize:7,padding:'1px 3px',borderRadius:2,background:accent,color:'#fff',fontWeight:700}}>✦</span>}
                      </button>
                    ))}
                  </div>
                </>)}
                {activeTab==='icons'&&(<>
                  <div style={{position:'relative',marginBottom:8}}>
                    <Search size={12} style={{position:'absolute',left:8,top:9,color:'#9ca3af'}}/>
                    <input value={iconSearch} onChange={e=>setIconSearch(e.target.value)} placeholder="Search icons…" style={{width:'100%',paddingLeft:26,paddingRight:8,paddingTop:7,paddingBottom:7,borderRadius:7,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:12,boxSizing:'border-box',outline:'none'}}/>
                  </div>
                  <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:7}}>
                    {filteredIcons2.map(ic=>(
                      <button key={ic.id} onClick={()=>addToCenter({type:'icon',data:ic})} style={{padding:'10px 4px',borderRadius:9,border:`1px solid ${borderC}`,background:cardBg,cursor:'pointer',display:'flex',flexDirection:'column',alignItems:'center',gap:3}}>
                        <span style={{fontSize:24}}>{ic.icon}</span>
                        <span style={{fontSize:9,color:textMut,textAlign:'center'}}>{ic.name}</span>
                      </button>
                    ))}
                  </div>
                </>)}
              </div>
            </div>
          )}

        </div>
      </div>

      {/* Context menus */}
      {connMenu&&connData&&(
        <CtxMenu pos={connMenu} title="Connection Style" onClose={()=>setConnMenu(null)} darkMode={darkMode}>
          <SL>Type</SL>
          <div style={{display:'flex',gap:5,marginBottom:10}}>
            {[['arrow','-> Arrow'],['line','- Line']].map(([t,lbl])=>(
              <button key={t} onClick={()=>updateConn(connData.id,{type:t})} style={{flex:1,padding:'5px',borderRadius:6,border:`1.5px solid ${connData.type===t?accent:'#d1d5db'}`,background:connData.type===t?accent:'transparent',color:connData.type===t?'#fff':textC,fontSize:12,cursor:'pointer',fontWeight:700}}>{lbl}</button>
            ))}
          </div>
          <SL>Path</SL>
          <div style={{display:'flex',gap:5,marginBottom:10}}>
            {[[false,'Straight'],[true,'Bent']].map(([val,lbl])=>(
              <button key={String(val)} onClick={()=>updateConn(connData.id,{bent:val})} style={{flex:1,padding:'5px',borderRadius:6,border:`1.5px solid ${connData.bent===val?accent:'#d1d5db'}`,background:connData.bent===val?accent:'transparent',color:connData.bent===val?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>{lbl}</button>
            ))}
          </div>
          <SL>Color</SL>
          <ColorGrid value={connData.color||'#3b82f6'} onChange={c=>updateConn(connData.id,{color:c})}/>
          <SliderRow label="Stroke Width" value={connData.strokeWidth||3} min={1} max={16} onChange={v=>updateConn(connData.id,{strokeWidth:v})}/>
          <SliderRow label="Arrow Size" value={connData.arrowSize||14} min={6} max={44} onChange={v=>updateConn(connData.id,{arrowSize:v})}/>
          <button onClick={()=>{save();setConnections(p=>p.filter(c=>c.id!==connData.id));setConnMenu(null);setSelectedConn(null);}} style={{width:'100%',marginTop:6,padding:'7px',background:'#ef4444',color:'#fff',border:'none',borderRadius:7,cursor:'pointer',fontSize:12,fontWeight:700}}>Delete Connection</button>
        </CtxMenu>
      )}

      {borderMenu&&borderData&&(
        <CtxMenu pos={borderMenu} title="Border Style" onClose={()=>setBorderMenu(null)} darkMode={darkMode}>
          <SL>Color</SL>
          <ColorGrid value={borderData.color} onChange={c=>updateBorder(borderData.id,{color:c})}/>
          <SL>Line Style</SL>
          <select value={borderData.strokeStyle||'solid'} onChange={e=>updateBorder(borderData.id,{strokeStyle:e.target.value})} style={{width:'100%',padding:'5px 7px',borderRadius:6,border:`1.5px solid ${borderC}`,background:cardBg,color:textC,fontSize:12,marginBottom:8}}>
            <option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option>
          </select>
          <SliderRow label="Stroke Width" value={borderData.strokeWidth||2} min={1} max={10} onChange={v=>updateBorder(borderData.id,{strokeWidth:v})}/>
          <SL>Corners</SL>
          <div style={{display:'flex',gap:5,marginBottom:10}}>
            {[['Sharp',0],['Rounded',14],['Pill',32]].map(([lbl,r])=>(
              <button key={r} onClick={()=>updateBorder(borderData.id,{borderRadius:r})} style={{flex:1,padding:'5px',borderRadius:6,border:`1.5px solid ${(borderData.borderRadius||0)===r?accent:'#d1d5db'}`,background:(borderData.borderRadius||0)===r?accent:'transparent',color:(borderData.borderRadius||0)===r?'#fff':textC,fontSize:11,cursor:'pointer',fontWeight:700}}>{lbl}</button>
            ))}
          </div>
          <button onClick={()=>{save();setBorders(p=>p.filter(b=>b.id!==borderData.id));setLabels(p=>p.filter(l=>l.borderId!==borderData.id));setSelectedBorder(null);setBorderMenu(null);}} style={{width:'100%',padding:'7px',background:'#ef4444',color:'#fff',border:'none',borderRadius:7,cursor:'pointer',fontSize:12,fontWeight:700}}>Delete Border</button>
        </CtxMenu>
      )}

      {bubbleMenu&&bubbleData&&(
        <CtxMenu pos={bubbleMenu} title="Bubble Style" onClose={()=>setBubbleMenu(null)} darkMode={darkMode}>
          <SL>Shape</SL>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:5,marginBottom:10}}>
            {BUBBLE_SHAPES.map(sh=>(
              <button key={sh.id} onClick={()=>updateBubble(bubbleData.id,{shape:sh.id})} style={{padding:'6px',borderRadius:6,border:`1.5px solid ${bubbleData.shape===sh.id?accent:'#d1d5db'}`,background:bubbleData.shape===sh.id?accent:'transparent',color:bubbleData.shape===sh.id?'#fff':textC,fontSize:12,cursor:'pointer',fontWeight:600}}>{sh.label}</button>
            ))}
          </div>
          <SL>Fill Color</SL>
          <ColorGrid value={bubbleData.fillColor} onChange={c=>updateBubble(bubbleData.id,{fillColor:c})} showNone/>
          <SL>Stroke Color</SL>
          <ColorGrid value={bubbleData.strokeColor} onChange={c=>updateBubble(bubbleData.id,{strokeColor:c})}/>
          <SL>Text Color</SL>
          <ColorGrid value={bubbleData.textColor||'#1e293b'} onChange={c=>updateBubble(bubbleData.id,{textColor:c})}/>
          <SliderRow label="Stroke Width" value={bubbleData.strokeWidth||2} min={0} max={8} onChange={v=>updateBubble(bubbleData.id,{strokeWidth:v})}/>
          <button onClick={()=>{save();setBubbles(p=>p.filter(b=>b.id!==bubbleData.id));setConnections(p=>p.filter(c=>c.from!==bubbleData.id&&c.to!==bubbleData.id));setSelectedBubble(null);setBubbleMenu(null);}} style={{width:'100%',marginTop:4,padding:'7px',background:'#ef4444',color:'#fff',border:'none',borderRadius:7,cursor:'pointer',fontSize:12,fontWeight:700}}>Delete Bubble</button>
        </CtxMenu>
      )}
    </div>
  );
};

// --- Sample diagram data ------------------------------------------------------
const SAMPLE_DIAGRAMS = [
  { id:'d1', title:'3-tier web app on AWS',       category:'infra',      date:'Apr 10, 2026', views:312, tags:['EC2','RDS','ELB'],           colors:['#FF9900','#527FFF','#8C4FFF'] },
  { id:'d2', title:'EKS microservices cluster',   category:'infra',      date:'Apr 6, 2026',  views:198, tags:['EKS','ECR','ALB'],            colors:['#FF9900','#569A31','#527FFF'] },
  { id:'d3', title:'GitHub Actions -> ECS deploy', category:'cicd',       date:'Apr 1, 2026',  views:445, tags:['CodeBuild','ECS','ECR'],      colors:['#4B612C','#FF9900','#527FFF'] },
  { id:'d4', title:'Serverless REST API',         category:'serverless', date:'Mar 24, 2026', views:220, tags:['Lambda','API GW','DynamoDB'], colors:['#FF9900','#8C4FFF','#527FFF'] },
  { id:'d5', title:'Multi-region failover',       category:'infra',      date:'Mar 18, 2026', views:176, tags:['Route53','CloudFront'],       colors:['#8C4FFF','#569A31','#FF9900'] },
  { id:'d6', title:'CodePipeline blue/green',     category:'cicd',       date:'Mar 12, 2026', views:133, tags:['CodeDeploy','ECS'],           colors:['#4B612C','#FF9900','#8C4FFF'] },
  { id:'d7', title:'Event-driven architecture',   category:'serverless', date:'Mar 5, 2026',  views:289, tags:['SQS','Lambda','SNS'],         colors:['#FF9900','#569A31','#527FFF'] },
  { id:'d8', title:'VPC networking baseline',     category:'infra',      date:'Feb 28, 2026', views:102, tags:['VPC','IGW','NAT'],            colors:['#8C4FFF','#527FFF','#569A31'] },
  { id:'d9', title:'Serverless image processor',  category:'serverless', date:'Feb 20, 2026', views:87,  tags:['Lambda','S3','Rekognition'],  colors:['#FF9900','#569A31','#DD344C'] },
];

// --- DiagramThumb -------------------------------------------------------------
function DiagramThumb({ colors }) {
  const [c1,c2,c3]=colors;
  const nodes=[{x:24,y:22,w:56,h:30},{x:110,y:22,w:56,h:30},{x:196,y:22,w:56,h:30},{x:67,y:80,w:56,h:30},{x:153,y:80,w:56,h:30}];
  const nodeCols=[c1,c2,c3,c2,c1];
  const lines=[[52,37,110,37],[166,37,196,37],[80,52,95,80],[183,52,181,80],[122,52,140,95],[166,52,153,80]];
  return (
    <svg viewBox="0 0 276 124" style={{width:'100%',height:'100%',display:'block'}}>
      {lines.map(([x1,y1,x2,y2],i)=><line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(100,116,139,0.35)" strokeWidth="1.5" strokeDasharray="4 2"/>)}
      {nodes.map((n,i)=>(
        <g key={i}>
          <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="5" fill={nodeCols[i]} opacity="0.88"/>
          <rect x={n.x+4} y={n.y+4} width={n.w-8} height="5" rx="2" fill="rgba(255,255,255,0.3)"/>
        </g>
      ))}
    </svg>
  );
}

// --- DIAGRAM_DETAILS ----------------------------------------------------------
const DIAGRAM_DETAILS = {
  d1:{description:'A classic three-tier web application on AWS. Route 53 handles DNS, CloudFront serves static assets, an ALB load balances across two EC2 instances in separate AZs, and data is persisted in a Multi-AZ RDS PostgreSQL cluster.',nodes:[{x:160,y:30,w:100,h:44,label:'Route 53',color:'#8C4FFF',icon:'🌍'},{x:160,y:110,w:100,h:44,label:'CloudFront',color:'#8C4FFF',icon:'⚡'},{x:160,y:190,w:100,h:44,label:'ELB / ALB',color:'#8C4FFF',icon:'⚖️'},{x:60,y:280,w:100,h:44,label:'EC2 (AZ-a)',color:'#FF9900',icon:'🖥️'},{x:260,y:280,w:100,h:44,label:'EC2 (AZ-b)',color:'#FF9900',icon:'🖥️'},{x:160,y:370,w:100,h:44,label:'RDS Multi-AZ',color:'#527FFF',icon:'🗄️'}],edges:[[0,1],[1,2],[2,3],[2,4],[3,5],[4,5]],comments:[{user:'Sarah K.',time:'2 days ago',text:'Have you considered Aurora Serverless instead of RDS to handle traffic spikes more gracefully?'},{user:'Mike T.',time:'5 days ago',text:'Love the multi-AZ redundancy. Add WAF in front of CloudFront for OWASP protection.'}]},
  d2:{description:'Production EKS cluster with auto-scaling node groups, ECR for container images, ALB ingress controller, and RDS for persistence.',nodes:[{x:160,y:30,w:100,h:44,label:'ALB Ingress',color:'#8C4FFF',icon:'⚖️'},{x:160,y:110,w:100,h:44,label:'EKS Cluster',color:'#FF9900',icon:'☸️'},{x:40,y:200,w:100,h:44,label:'Node Group A',color:'#FF9900',icon:'🖥️'},{x:160,y:200,w:100,h:44,label:'Node Group B',color:'#FF9900',icon:'🖥️'},{x:280,y:200,w:100,h:44,label:'ECR Registry',color:'#569A31',icon:'📦'},{x:160,y:300,w:100,h:44,label:'RDS Postgres',color:'#527FFF',icon:'🐘'}],edges:[[0,1],[1,2],[1,3],[1,4],[2,5],[3,5]],comments:[{user:'Dana R.',time:'3 days ago',text:'Are you using Karpenter or managed node group auto-scaler? Karpenter has much faster scale-out.'}]},
  d3:{description:'End-to-end CI/CD triggered by GitHub pushes. CodeBuild builds and tests, Docker image pushed to ECR, deployed to ECS Fargate via CodeDeploy blue/green.',nodes:[{x:60,y:40,w:100,h:44,label:'GitHub Repo',color:'#1e293b',icon:'📝'},{x:220,y:40,w:100,h:44,label:'CodePipeline',color:'#4B612C',icon:'🔄'},{x:160,y:130,w:100,h:44,label:'CodeBuild',color:'#4B612C',icon:'🔨'},{x:60,y:220,w:100,h:44,label:'ECR Registry',color:'#569A31',icon:'📦'},{x:260,y:220,w:100,h:44,label:'CodeDeploy',color:'#4B612C',icon:'🚀'},{x:160,y:310,w:100,h:44,label:'ECS Fargate',color:'#FF9900',icon:'🐳'}],edges:[[0,1],[1,2],[2,3],[2,4],[3,5],[4,5]],comments:[{user:'Priya S.',time:'1 day ago',text:'Add a manual approval gate in CodePipeline before the prod CodeDeploy stage.'}]},
  d4:{description:'Fully serverless REST API. API Gateway handles routing and throttling, Lambda functions execute business logic, DynamoDB provides low-latency NoSQL storage.',nodes:[{x:160,y:30,w:100,h:44,label:'Route 53',color:'#8C4FFF',icon:'🌍'},{x:160,y:110,w:100,h:44,label:'API Gateway',color:'#8C4FFF',icon:'🚪'},{x:60,y:200,w:100,h:44,label:'Lambda GET',color:'#FF9900',icon:'λ'},{x:260,y:200,w:100,h:44,label:'Lambda POST',color:'#FF9900',icon:'λ'},{x:160,y:290,w:100,h:44,label:'DynamoDB',color:'#527FFF',icon:'⚡'}],edges:[[0,1],[1,2],[1,3],[2,4],[3,4]],comments:[{user:'Tom L.',time:'2 days ago',text:'Try Lambda power tuning to optimize memory/cost. Huge savings on high-traffic routes.'}]},
  d5:{description:'Active-passive multi-region failover. Route 53 health checks detect failure and failover within 60 seconds. CloudFront provides global edge caching.',nodes:[{x:160,y:20,w:100,h:44,label:'Route 53',color:'#8C4FFF',icon:'🌍'},{x:160,y:100,w:100,h:44,label:'CloudFront',color:'#8C4FFF',icon:'⚡'},{x:60,y:190,w:110,h:44,label:'us-east-1 (Pri)',color:'#FF9900',icon:'🖥️'},{x:230,y:190,w:110,h:44,label:'eu-west-1 (Sec)',color:'#569A31',icon:'🖥️'},{x:60,y:280,w:110,h:44,label:'RDS Primary',color:'#527FFF',icon:'🗄️'},{x:230,y:280,w:110,h:44,label:'RDS Replica',color:'#527FFF',icon:'🗄️'}],edges:[[0,1],[1,2],[1,3],[2,4],[4,5]],comments:[{user:'Emma W.',time:'4 days ago',text:'What is your RTO target? 60s DNS + warm standby should get under 2 minutes total.'}]},
  d6:{description:'Blue/green ECS deployment pipeline orchestrated by CodePipeline with CodeDeploy managing traffic shifting between blue and green task sets.',nodes:[{x:160,y:30,w:110,h:44,label:'CodeCommit',color:'#4B612C',icon:'📝'},{x:160,y:110,w:110,h:44,label:'CodeBuild',color:'#4B612C',icon:'🔨'},{x:60,y:200,w:110,h:44,label:'ECS Blue',color:'#FF9900',icon:'🐳'},{x:240,y:200,w:110,h:44,label:'ECS Green',color:'#569A31',icon:'🐳'},{x:160,y:290,w:110,h:44,label:'CodeDeploy',color:'#4B612C',icon:'🚀'},{x:160,y:370,w:110,h:44,label:'ALB (Live)',color:'#8C4FFF',icon:'⚖️'}],edges:[[0,1],[1,2],[1,3],[2,4],[3,4],[4,5]],comments:[{user:'Raj P.',time:'3 days ago',text:'Using linear10PercentEvery1Minute or canary config? For prod I prefer canary.'}]},
  d7:{description:'Event-driven microservices using SNS fan-out and SQS queuing. Publishers emit to SNS which fans out to SQS queues. Lambda subscribers process async with DLQ support.',nodes:[{x:160,y:30,w:100,h:44,label:'Publisher',color:'#1e293b',icon:'📤'},{x:160,y:110,w:100,h:44,label:'SNS Topic',color:'#FF9900',icon:'🔔'},{x:60,y:200,w:100,h:44,label:'SQS Queue A',color:'#FF9900',icon:'📬'},{x:260,y:200,w:100,h:44,label:'SQS Queue B',color:'#FF9900',icon:'📬'},{x:60,y:290,w:100,h:44,label:'Lambda A',color:'#FF9900',icon:'λ'},{x:260,y:290,w:100,h:44,label:'Lambda B',color:'#FF9900',icon:'λ'}],edges:[[0,1],[1,2],[1,3],[2,4],[3,5]],comments:[{user:'Lena M.',time:'1 day ago',text:'DLQs in place? I always add CloudWatch alarms on DLQ depth to catch processing failures.'}]},
  d8:{description:'Standard VPC baseline with public and private subnets across two AZs. Internet Gateway for public inbound, NAT Gateways for private outbound.',nodes:[{x:160,y:20,w:100,h:44,label:'Internet GW',color:'#8C4FFF',icon:'🌐'},{x:60,y:110,w:110,h:44,label:'Public Sub A',color:'#569A31',icon:'🟢'},{x:230,y:110,w:110,h:44,label:'Public Sub B',color:'#569A31',icon:'🟢'},{x:60,y:210,w:110,h:44,label:'NAT GW A',color:'#FF9900',icon:'🔀'},{x:230,y:210,w:110,h:44,label:'NAT GW B',color:'#FF9900',icon:'🔀'},{x:60,y:300,w:110,h:44,label:'Private Sub A',color:'#527FFF',icon:'🔒'},{x:230,y:300,w:110,h:44,label:'Private Sub B',color:'#527FFF',icon:'🔒'}],edges:[[0,1],[0,2],[1,3],[2,4],[3,5],[4,6]],comments:[{user:'Nat G.',time:'5 days ago',text:'Enable VPC Flow Logs - invaluable for debugging security group rules.'}]},
  d9:{description:'Serverless image processing pipeline. S3 events trigger Lambda which calls Rekognition for label detection, stores results in DynamoDB, publishes to output S3 bucket.',nodes:[{x:60,y:40,w:110,h:44,label:'S3 Input',color:'#569A31',icon:'🪣'},{x:230,y:40,w:110,h:44,label:'Lambda',color:'#FF9900',icon:'λ'},{x:60,y:150,w:110,h:44,label:'Rekognition',color:'#DD344C',icon:'👁️'},{x:230,y:150,w:110,h:44,label:'DynamoDB',color:'#527FFF',icon:'⚡'},{x:160,y:260,w:110,h:44,label:'S3 Output',color:'#569A31',icon:'🪣'}],edges:[[0,1],[1,2],[1,3],[2,4],[3,4]],comments:[{user:'Yuki H.',time:'2 days ago',text:'What confidence threshold for Rekognition labels? We found 80% is a good balance.'}]},
};

// --- Shared: convert DIAGRAM_DETAILS/FEED_DIAGRAM_DETAILS nodes/edges into ----
// full canvas elements/connections (same mapping used when opening a feed/profile
// diagram in the Designer). Reused by the Feed "Compare" feature so unsaved
// example/feed diagrams can be compared without first saving them.
function buildElementsFromDetail(detail) {
  if(!detail||!detail.nodes) return {elements:[],connections:[]};
  const allServices=[...AWS_SERVICES,...GCP_SERVICES,...AZURE_SERVICES];
  const colorToSvc={
    '#FF9900':AWS_SERVICES.find(s=>s.id==='ec2'),
    '#527FFF':AWS_SERVICES.find(s=>s.id==='rds'),
    '#8C4FFF':AWS_SERVICES.find(s=>s.id==='vpc'),
    '#569A31':AWS_SERVICES.find(s=>s.id==='s3'),
    '#4B612C':AWS_SERVICES.find(s=>s.id==='codecommit'),
    '#DD344C':AWS_SERVICES.find(s=>s.id==='iam'),
    '#1e293b':AWS_SERVICES.find(s=>s.id==='codecommit'),
  };
  const newEls=detail.nodes.map((n,i)=>{
    const svc=colorToSvc[n.color]||allServices.find(s=>s.icon===n.icon)||allServices[0];
    return { id:`el_feed_${i}`, service:svc, x:n.x+80, y:n.y+60, width:n.w||120, height:n.h||100, customName:n.label };
  });
  const newConns=(detail.edges||[]).map(([a,b],i)=>({
    id:`c_feed_${i}`, from:newEls[a]?.id, to:newEls[b]?.id, type:'arrow', bent:false, color:'#3b82f6', strokeWidth:3, arrowSize:14,
  })).filter(c=>c.from&&c.to);
  return {elements:newEls, connections:newConns};
}


// --- Diagram details for feed posts ------------------------------------------
const FEED_DIAGRAM_DETAILS = {
  fp1d:{
    description:'Fully automated blue/green deployment pipeline for ECS services. GitHub pushes trigger CodePipeline, CodeBuild builds and pushes the Docker image to ECR, then CodeDeploy shifts traffic between the blue and green ECS task sets with zero downtime.',
    comments:[{user:'Alex K.',time:'2 hrs ago',text:'What CDK construct are you using for the CodeDeploy blue/green config? We\'ve been doing this manually.'},{user:'Sarah Kim',time:'5 hrs ago',text:'Love this. We use the same pattern but with an approval step before prod traffic cut-over.'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'GitHub Repo',   color:'#1e293b',icon:'📝'},
    {x:80,y:90,w:110,h:44,label:'CodePipeline',  color:'#4B612C',icon:'🔄'},
    {x:80,y:160,w:110,h:44,label:'CodeBuild',    color:'#4B612C',icon:'🔨'},
    {x:20,y:235,w:110,h:44,label:'ECR Registry', color:'#569A31',icon:'📦'},
    {x:150,y:235,w:110,h:44,label:'CodeDeploy',  color:'#4B612C',icon:'🚀'},
    {x:40,y:310,w:80,h:44,label:'ECS Blue',      color:'#FF9900',icon:'🐳'},
    {x:150,y:310,w:80,h:44,label:'ECS Green',    color:'#569A31',icon:'🐳'},
  ],edges:[[0,1],[1,2],[2,3],[2,4],[3,5],[4,6]]},

  fp2d:{
    description:'Fully managed Kafka streaming platform on Amazon MSK with multi-AZ redundancy. Producers send events to MSK topics, consumers process streams in real-time, and data is archived to S3 and loaded into Redshift for analytics.',
    comments:[{user:'Mike Torres',time:'1 hr ago',text:'MSK vs self-managed Kafka is a no-brainer for ops teams. What retention period are you using on the topics?'},{user:'Dana R.',time:'3 hrs ago',text:'Are you using MSK Connect for the S3 sink or a custom Lambda consumer?'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'Producers',     color:'#1e293b',icon:'📤'},
    {x:80,y:95,w:110,h:44,label:'Amazon MSK',    color:'#FF9900',icon:'📨'},
    {x:20,y:175,w:100,h:44,label:'Consumer A',   color:'#527FFF',icon:'💻'},
    {x:150,y:175,w:100,h:44,label:'Consumer B',  color:'#527FFF',icon:'💻'},
    {x:80,y:255,w:110,h:44,label:'S3 Data Lake', color:'#569A31',icon:'🪣'},
    {x:80,y:330,w:110,h:44,label:'Redshift',     color:'#8C4FFF',icon:'📊'},
  ],edges:[[0,1],[1,2],[1,3],[2,4],[3,4],[4,5]]},

  fp3d:{
    description:'Lambda architecture with provisioned concurrency on critical hot paths to eliminate cold starts. API Gateway routes traffic to warm Lambda instances, reducing p99 latency from 4s to under 200ms. CloudWatch tracks concurrency utilization.',
    comments:[{user:'Chris M.',time:'2 hrs ago',text:'What memory setting are you using? We found 512MB with provisioned concurrency beat 1024MB on-demand for our use case.'},{user:'Priya S.',time:'4 hrs ago',text:'Lambda Power Tuning is great for finding the right memory/concurrency tradeoff. Have you run it on these functions?'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'API Gateway',        color:'#8C4FFF',icon:'🚪'},
    {x:80,y:95,w:110,h:44,label:'Lambda (Warm)',       color:'#FF9900',icon:'λ'},
    {x:20,y:175,w:100,h:44,label:'Provisioned Conc.', color:'#FF9900',icon:'⚡'},
    {x:150,y:175,w:100,h:44,label:'On-demand',         color:'#FF9900',icon:'λ'},
    {x:80,y:255,w:110,h:44,label:'DynamoDB',           color:'#527FFF',icon:'⚡'},
    {x:80,y:330,w:110,h:44,label:'CloudWatch',         color:'#FF9900',icon:'📊'},
  ],edges:[[0,1],[1,2],[1,3],[2,4],[3,4],[1,5]]},

  fp4d:{
    description:'Enterprise AWS Organizations landing zone with Control Tower. Separate accounts for production, staging, sandbox and log archiving. Service Control Policies restrict dangerous actions across all accounts. GuardDuty runs organization-wide.',
    comments:[{user:'Emma Wei',time:'3 hrs ago',text:'Do you use Account Factory for Terraform or the native Control Tower Account Factory? We\'ve been evaluating both.'},{user:'Priya S.',time:'6 hrs ago',text:'We run the exact same pattern. One tip: enable AWS Config aggregator at the management account level for org-wide compliance visibility.'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'Management Acct',  color:'#DD344C',icon:'👑'},
    {x:80,y:95,w:110,h:44,label:'Control Tower',    color:'#8C4FFF',icon:'🏗️'},
    {x:10,y:175,w:90,h:44,label:'Prod Account',     color:'#FF9900',icon:'🏭'},
    {x:115,y:175,w:90,h:44,label:'Staging Acct',    color:'#569A31',icon:'🔬'},
    {x:220,y:175,w:90,h:44,label:'Sandbox Acct',    color:'#527FFF',icon:'🧪'},
    {x:80,y:255,w:110,h:44,label:'Log Archive',     color:'#DD344C',icon:'📋'},
    {x:80,y:330,w:110,h:44,label:'SCPs + GuardDuty',color:'#DD344C',icon:'🛡️'},
  ],edges:[[0,1],[1,2],[1,3],[1,4],[2,5],[3,5],[4,5],[1,6]]},

  fp5d:{
    description:'GitOps deployment workflow using GitHub Actions to build and push to ECR, with ArgoCD managing continuous delivery to EKS clusters. Every merged PR automatically syncs to staging, and a manual promotion deploys to production.',
    comments:[{user:'Sarah Kim',time:'5 hrs ago',text:'ArgoCD Image Updater is a game-changer for this workflow. Automatically updates the image tag in your GitOps repo when ECR gets a new push.'},{user:'Mike T.',time:'7 hrs ago',text:'How are you handling secrets management across the EKS clusters? External Secrets Operator + Secrets Manager?'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'GitHub Repo',    color:'#1e293b',icon:'📝'},
    {x:80,y:95,w:110,h:44,label:'GitHub Actions', color:'#1e293b',icon:'⚙️'},
    {x:80,y:170,w:110,h:44,label:'ECR Registry',  color:'#569A31',icon:'📦'},
    {x:80,y:245,w:110,h:44,label:'ArgoCD',         color:'#FF9900',icon:'🔁'},
    {x:25,y:320,w:100,h:44,label:'EKS Staging',    color:'#527FFF',icon:'☸️'},
    {x:145,y:320,w:100,h:44,label:'EKS Prod',      color:'#FF9900',icon:'☸️'},
  ],edges:[[0,1],[1,2],[2,3],[3,4],[3,5]]},

  fp6d:{
    description:'Cost-optimized analytics cluster using EC2 Spot Fleet with a mixed instance policy. EMR processes S3 input data across Spot and On-Demand instances. Results land in an output S3 bucket and are loaded into Redshift. Monthly EC2 cost reduced 71%.',
    comments:[{user:'Chris M.',time:'8 hrs ago',text:'What allocation strategy are you using? capacity-optimized worked best for us to avoid interruptions on long-running jobs.'},{user:'Dana R.',time:'10 hrs ago',text:'Are you using EMR managed scaling or a fixed cluster size? We found managed scaling saved another 20-30% on top of Spot pricing.'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'S3 Data Input',     color:'#569A31',icon:'🪣'},
    {x:80,y:95,w:110,h:44,label:'EMR Spot Cluster',  color:'#FF9900',icon:'⚡'},
    {x:20,y:175,w:100,h:44,label:'Spot Fleet (m5)',  color:'#FF9900',icon:'🖥️'},
    {x:150,y:175,w:100,h:44,label:'On-Demand (m5)',  color:'#527FFF',icon:'🖥️'},
    {x:80,y:255,w:110,h:44,label:'S3 Output',        color:'#569A31',icon:'🪣'},
    {x:80,y:330,w:110,h:44,label:'Redshift',         color:'#8C4FFF',icon:'📊'},
  ],edges:[[0,1],[1,2],[1,3],[2,4],[3,4],[4,5]]},

  fp7d:{
    description:'DDoS protection stack using CloudFront + WAF v2 + Shield Advanced. AWS Managed Rule Groups block OWASP Top 10. Shield Advanced provides 24/7 DDoS response support and cost protection. An ALB sits behind WAF to route to application servers.',
    comments:[{user:'Emma Wei',time:'1 day ago',text:'Which managed rule groups saved you? We use AWSManagedRulesCommonRuleSet and AWSManagedRulesKnownBadInputsRuleSet as a baseline.'},{user:'Sarah K.',time:'1 day ago',text:'Shield Advanced subscription costs $3k/month. Worth it if you\'ve been hit before, but for smaller apps WAF alone covers most attack vectors.'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'CloudFront',       color:'#8C4FFF',icon:'⚡'},
    {x:80,y:95,w:110,h:44,label:'WAF v2',            color:'#DD344C',icon:'🛡️'},
    {x:20,y:175,w:100,h:44,label:'Shield Advanced', color:'#DD344C',icon:'🔰'},
    {x:150,y:175,w:100,h:44,label:'Managed Rules',  color:'#DD344C',icon:'📋'},
    {x:80,y:255,w:110,h:44,label:'ALB',              color:'#8C4FFF',icon:'⚖️'},
    {x:80,y:330,w:110,h:44,label:'EC2 / ECS',        color:'#FF9900',icon:'🖥️'},
  ],edges:[[0,1],[1,2],[1,3],[2,4],[3,4],[4,5]]},

  fp8d:{
    description:'Real-time log analytics pipeline replacing a self-managed ELK stack. Application logs flow into Kinesis Firehose, a Lambda function transforms and enriches the records, then data fans out to S3 for long-term storage and OpenSearch for live querying via Kibana.',
    comments:[{user:'Mike T.',time:'2 days ago',text:'What batch size and buffer interval are you using on Firehose? We found 5MB / 60s is a good balance between cost and query latency.'},{user:'Chris M.',time:'2 days ago',text:'How are you handling index lifecycle management in OpenSearch? Hot/warm/cold tiers can bring down storage costs significantly on large log volumes.'}],
    nodes:[
    {x:80,y:20,w:110,h:44,label:'Log Sources',       color:'#1e293b',icon:'📤'},
    {x:80,y:95,w:110,h:44,label:'Kinesis Firehose',  color:'#FF9900',icon:'🔥'},
    {x:80,y:170,w:110,h:44,label:'Lambda Transform', color:'#FF9900',icon:'λ'},
    {x:20,y:250,w:100,h:44,label:'S3 Archive',       color:'#569A31',icon:'🪣'},
    {x:150,y:250,w:100,h:44,label:'OpenSearch',      color:'#527FFF',icon:'🔍'},
    {x:80,y:330,w:110,h:44,label:'Kibana Dashboard', color:'#527FFF',icon:'📊'},
  ],edges:[[0,1],[1,2],[2,3],[2,4],[4,5]]},
};

function FullDiagramSVG({ diagram, darkMode }) {
  const detail = DIAGRAM_DETAILS[diagram.id] || FEED_DIAGRAM_DETAILS[diagram.id];
  // Also support inline nodes/edges stored in the diagram object (saved library entries)
  const nodes = (detail?.nodes) || diagram.nodes;
  const edges = (detail?.edges) || diagram.edges;
  if (!nodes||!nodes.length) return null;
  const padX=40, padY=20;
  const maxX=Math.max(...nodes.map(n=>n.x+n.w))+padX;
  const maxY=Math.max(...nodes.map(n=>n.y+n.h))+padY;
  const cx=n=>n.x+n.w/2, cy=n=>n.y+n.h/2;
  const gridColor=darkMode?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.04)';
  return (
    <svg viewBox={`0 0 ${maxX} ${maxY}`} style={{width:'100%',height:'100%',display:'block'}}>
      <defs>
        <pattern id="dgrid" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill={gridColor}/>
        </pattern>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill="#3b82f6" opacity="0.7"/>
        </marker>
      </defs>
      <rect width={maxX} height={maxY} fill="url(#dgrid)"/>
      {(edges||[]).map(([a,b],i)=>{
        const from=nodes[a],to=nodes[b];
        if(!from||!to) return null;
        const x1=cx(from),y1=from.y+from.h,x2=cx(to),y2=to.y,my=(y1+y2)/2;
        return <path key={i} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} stroke="#3b82f6" strokeWidth="1.8" fill="none" strokeDasharray="5 3" opacity="0.6" markerEnd="url(#arrow)"/>;
      })}
      {nodes.map((n,i)=>{
        const iconSize=Math.round(n.h*0.4),lblSize=Math.round(n.h*0.18);
        return (
          <g key={i}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="8" fill={n.color} opacity="0.92" stroke={darkMode?'rgba(255,255,255,0.12)':'rgba(0,0,0,0.15)'} strokeWidth="1.5"/>
            <rect x={n.x+4} y={n.y+4} width={n.w-8} height={n.h*0.28} rx="4" fill="rgba(255,255,255,0.2)"/>
            <text x={cx(n)} y={n.y+n.h*0.45} textAnchor="middle" dominantBaseline="middle" fontSize={iconSize} style={{userSelect:'none'}}>{n.icon}</text>
            <text x={cx(n)} y={n.y+n.h*0.82} textAnchor="middle" dominantBaseline="middle" fontSize={lblSize} fontWeight="700" fill="#ffffff" style={{userSelect:'none',fontFamily:'Inter,Arial,sans-serif'}}>{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// --- ProfilePage --------------------------------------------------------------
function ProfilePage({ darkMode, onViewDiagram }) {
  const isMobile=useIsMobile();
  const bg=darkMode?'#111827':'#eff6ff';
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent=darkMode?'#67e8f9':'#2563eb';
  const accentBg=darkMode?'rgba(103,232,249,0.1)':'#eff6ff';

  const [profile,setProfile]=useState({name:'Alex Johnson',handle:'@alexj',title:'AWS Solutions Architect',bio:'Senior solutions architect at TechCorp. I design cloud infrastructure diagrams, CI/CD pipelines, and serverless architectures.',location:'San Francisco, CA',website:'alexj.dev',avatarUrl:null});
  const [editing,setEditing]=useState(false);
  const [draft,setDraft]=useState({...profile});
  const [filterCat,setFilterCat]=useState('all');
  const fileRef=useRef(null);

  const FILTERS=[{id:'all',label:'All'},{id:'infra',label:'Infrastructure'},{id:'cicd',label:'CI/CD'},{id:'serverless',label:'Serverless'}];
  const shown=filterCat==='all'?SAMPLE_DIAGRAMS:SAMPLE_DIAGRAMS.filter(d=>d.category===filterCat);
  const totalViews=SAMPLE_DIAGRAMS.reduce((a,d)=>a+d.views,0);
  const openEdit=()=>{setDraft({...profile});setEditing(true);};
  const saveEdit=()=>{setProfile({...draft});setEditing(false);};

  const handleAvatarFile=e=>{
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>{setProfile(p=>({...p,avatarUrl:ev.target.result}));setDraft(d=>({...d,avatarUrl:ev.target.result}));};
    reader.readAsDataURL(file);
  };

  const inp=(field,placeholder,area)=>{
    const s={width:'100%',padding:'7px 10px',fontSize:13,borderRadius:7,border:`1px solid ${borderC}`,background:cardBg,color:textC,outline:'none',boxSizing:'border-box',fontFamily:'Inter,Arial,sans-serif'};
    return area
      ?<textarea value={draft[field]} onChange={e=>setDraft(d=>({...d,[field]:e.target.value}))} placeholder={placeholder} rows={3} style={{...s,resize:'vertical',lineHeight:1.5}}/>
      :<input value={draft[field]} onChange={e=>setDraft(d=>({...d,[field]:e.target.value}))} placeholder={placeholder} style={s}/>;
  };

  const initials=(profile.name||'U').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();

  return (
    <div style={{flex:1,overflowY:'auto',background:bg}}>
      {/* Edit modal */}
      {editing&&(
        <div onClick={e=>{if(e.target===e.currentTarget)setEditing(false);}} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:'1rem'}}>
          <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'1.4rem 1.5rem',width:420,maxWidth:'100%',maxHeight:'90vh',overflowY:'auto'}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:14}}>
              <span style={{fontSize:15,fontWeight:700,color:textC}}>Edit profile</span>
              <button onClick={()=>setEditing(false)} style={{background:'none',border:'none',cursor:'pointer',color:textMut,display:'flex'}}><X size={18}/></button>
            </div>
            <div style={{display:'flex',justifyContent:'center',marginBottom:12}}>
              <div onClick={()=>fileRef.current.click()} style={{width:70,height:70,borderRadius:'50%',overflow:'hidden',cursor:'pointer',border:`2px dashed ${borderC}`,display:'flex',alignItems:'center',justifyContent:'center',background:accentBg,position:'relative'}}>
                {draft.avatarUrl?<img src={draft.avatarUrl} alt="avatar" style={{width:'100%',height:'100%',objectFit:'cover'}}/>:<span style={{fontSize:22,fontWeight:700,color:accent}}>{initials}</span>}
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}} onChange={handleAvatarFile}/>
            {[['name','Display name','Alex Johnson'],['handle','Username','@alexj'],['title','Title / role','AWS Solutions Architect'],['location','Location','City, Country'],['website','Website','yoursite.com']].map(([f,lbl,ph])=>(
              <div key={f}><div style={{fontSize:11,fontWeight:600,color:textMut,marginBottom:4,marginTop:12}}>{lbl}</div>{inp(f,ph)}</div>
            ))}
            <div><div style={{fontSize:11,fontWeight:600,color:textMut,marginBottom:4,marginTop:12}}>Bio</div>{inp('bio','Tell the world about yourself…',true)}</div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end',marginTop:18}}>
              <button onClick={()=>setEditing(false)} style={{padding:'6px 16px',borderRadius:7,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:13}}>Cancel</button>
              <button onClick={saveEdit} style={{padding:'6px 18px',borderRadius:7,border:'none',background:accent,color:'#fff',cursor:'pointer',fontSize:13,fontWeight:600}}>Save</button>
            </div>
          </div>
        </div>
      )}

      <div style={{maxWidth:860,margin:'0 auto',padding:'1.5rem 1rem 4rem'}}>
        {/* Cover */}
        <div style={{height:isMobile?80:120,borderRadius:'12px 12px 0 0',background:'linear-gradient(135deg,#2563eb 0%,#7c3aed 55%,#059669 100%)'}}/>
        {/* Profile card */}
        <div style={{background:cardBg,border:`1px solid ${borderC}`,borderTop:'none',borderRadius:'0 0 12px 12px',padding:'0 1.4rem 1.4rem',marginBottom:'1.4rem'}}>
          <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',marginBottom:10}}>
            <div onClick={()=>fileRef.current.click()} style={{marginTop:-36,cursor:'pointer',position:'relative'}}>
              <div style={{width:72,height:72,borderRadius:'50%',overflow:'hidden',border:`3px solid ${cardBg}`,background:accentBg,display:'flex',alignItems:'center',justifyContent:'center'}}>
                {profile.avatarUrl?<img src={profile.avatarUrl} alt="avatar" style={{width:'100%',height:'100%',objectFit:'cover'}}/>:<span style={{fontSize:24,fontWeight:700,color:accent}}>{initials}</span>}
              </div>
            </div>
            <button onClick={openEdit} style={{padding:'6px 16px',borderRadius:7,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontSize:12,fontWeight:600,display:'flex',alignItems:'center',gap:5}}>
              <Edit2 size={12}/> Edit profile
            </button>
          </div>
          <div style={{fontSize:isMobile?17:19,fontWeight:800,color:textC}}>{profile.name}</div>
          <div style={{fontSize:12,color:textMut,marginTop:2,marginBottom:10}}>{profile.handle} · {profile.title}</div>
          <p style={{fontSize:13,color:textC,lineHeight:1.65,maxWidth:520,marginBottom:12}}>{profile.bio}</p>
          <div style={{display:'flex',flexWrap:'wrap',gap:14,marginBottom:14}}>
            {[{icon:<MapPin size={13}/>,text:profile.location},{icon:<Link2 size={13}/>,text:profile.website,accent:true},{icon:<Calendar size={13}/>,text:'Joined March 2023'}].map((m,i)=>(
              <span key={i} style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:m.accent?accent:textMut}}>{m.icon}{m.text}</span>
            ))}
          </div>
          <div style={{display:'flex',gap:isMobile?16:24,paddingTop:12,borderTop:`1px solid ${borderC}`,flexWrap:'wrap'}}>
            {[{n:SAMPLE_DIAGRAMS.length,l:'diagrams'},{n:284,l:'followers'},{n:91,l:'following'},{n:totalViews.toLocaleString(),l:'views'}].map((s,i)=>(
              <div key={i} style={{textAlign:'center'}}>
                <div style={{fontSize:17,fontWeight:800,color:textC}}>{s.n}</div>
                <div style={{fontSize:10,color:textMut,marginTop:1}}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Diagrams section */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12,flexWrap:'wrap',gap:8}}>
          <span style={{fontSize:15,fontWeight:700,color:textC}}>Diagrams</span>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {FILTERS.map(f=>(
              <button key={f.id} onClick={()=>setFilterCat(f.id)} style={{padding:'4px 12px',borderRadius:999,border:`1px solid ${f.id===filterCat?accent:borderC}`,background:f.id===filterCat?'rgba(37,99,235,0.1)':'transparent',color:f.id===filterCat?accent:textMut,fontSize:11,fontWeight:600,cursor:'pointer'}}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:`repeat(auto-fill,minmax(${isMobile?'160px':'240px'},1fr))`,gap:isMobile?10:14}}>
          {shown.map(d=>(
            <div key={d.id} onClick={()=>onViewDiagram(d)}
              style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,overflow:'hidden',cursor:'pointer',transition:'border-color 0.15s'}}
              onMouseOver={e=>e.currentTarget.style.borderColor=accent} onMouseOut={e=>e.currentTarget.style.borderColor=borderC}>
              <div style={{height:isMobile?110:140,background:darkMode?'#0f172a':'#f0f4ff',overflow:'hidden'}}>
                <FeedDiagramPreview diagramId={d.id} darkMode={darkMode}/>
              </div>
              <div style={{padding:'10px 12px 12px'}}>
                <div style={{fontSize:isMobile?12:13,fontWeight:700,color:textC,marginBottom:6,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{d.title}</div>
                <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:8}}>
                  {d.tags.slice(0,isMobile?2:3).map(t=><span key={t} style={{fontSize:10,padding:'2px 7px',borderRadius:999,background:darkMode?'#374151':'#f1f5f9',color:textMut}}>{t}</span>)}
                </div>
                <div style={{display:'flex',alignItems:'center',gap:10,paddingTop:8,borderTop:`1px solid ${borderC}`}}>
                  <span style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:textMut}}><Eye size={12}/>{d.views}</span>
                  {!isMobile&&<span style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:textMut}}><Calendar size={12}/>{d.date}</span>}
                  <button onClick={e=>{e.stopPropagation();onViewDiagram(d);}} style={{marginLeft:'auto',padding:'3px 10px',fontSize:11,fontWeight:600,borderRadius:6,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer'}}>Open</button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {shown.length===0&&<div style={{textAlign:'center',padding:'3rem 1rem',color:textMut,fontSize:13}}>No diagrams in this category yet.</div>}
      </div>
    </div>
  );
}

// --- DiagramViewPage ----------------------------------------------------------

function DiagramViewPage({ diagram, darkMode, onBack, onEdit, library=[], setLibrary }) {
  const isMobile=useIsMobile();
  const bg=darkMode?'#111827':'#eff6ff';
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent=darkMode?'#67e8f9':'#2563eb';
  const accentBg=darkMode?'rgba(103,232,249,0.08)':'#eff6ff';

  const detail=(DIAGRAM_DETAILS[diagram.id]||FEED_DIAGRAM_DETAILS[diagram.id])||{description:'No description.',nodes:[],edges:[],comments:[]};
  const [liked,setLiked]=useState(false);
  const [bookmarked,setBookmarked]=useState(()=>library.some(d=>d.id===diagram.id));
  const [comment,setComment]=useState('');
  const [comments,setComments]=useState(detail.comments);
  const [zoom,setZoom]=useState(1);
  const [copied,setCopied]=useState(false);
  const [showShare,setShowShare]=useState(false);
  const [saveToast,setSaveToast]=useState('');
  const [showCompare,setShowCompare]=useState(false);

  const buildCompareArchA=()=>{
    const {elements,connections}=buildElementsFromDetail(detail);
    return {title:diagram.title, provider:'aws', elements, connections, borders:[], labels:[]};
  };
  const buildExtraPickables=()=>{
    const all={...DIAGRAM_DETAILS,...FEED_DIAGRAM_DETAILS};
    return FEED_POSTS.filter(p=>p.diagram.id!==diagram.id).map(p=>{
      const d=all[p.diagram.id];
      const {elements,connections}=buildElementsFromDetail(d);
      return {
        id:`feed_${p.diagram.id}`, title:p.diagram.title, provider:'aws',
        elements, connections, borders:[], labels:[],
        nodes:d?.nodes, edges:d?.edges, colors:p.diagram.colors,
        source:'feed', updatedAt:Date.now(),
      };
    });
  };

  const alreadyInLibrary=library.some(d=>d.id===diagram.id);

  const handleSaveToLibrary=()=>{
    if(!setLibrary) return;
    if(alreadyInLibrary){
      setSaveToast('Already in your library! 🔖');
      setBookmarked(true);
      setTimeout(()=>setSaveToast(''),3000);
      return;
    }
    // Get diagram nodes from DIAGRAM_DETAILS/FEED_DIAGRAM_DETAILS for feed posts
    const detail=DIAGRAM_DETAILS[diagram.id]||FEED_DIAGRAM_DETAILS[diagram.id];
    let els=diagram.elements||[];
    let conns=diagram.connections||[];
    const hasReal=els.length>0;
    if(!hasReal&&detail&&detail.nodes){
      const colorToSvc={'#FF9900':AWS_SERVICES.find(s=>s.id==='ec2'),'#527FFF':AWS_SERVICES.find(s=>s.id==='rds'),'#8C4FFF':AWS_SERVICES.find(s=>s.id==='cloudfront'),'#569A31':AWS_SERVICES.find(s=>s.id==='s3'),'#4B612C':AWS_SERVICES.find(s=>s.id==='codecommit'),'#DD344C':AWS_SERVICES.find(s=>s.id==='waf'),'#1e293b':AWS_SERVICES.find(s=>s.id==='codecommit')};
      els=detail.nodes.map((n,i)=>{const svc=colorToSvc[n.color]||AWS_SERVICES[0];return{id:'el_sv_'+i,service:svc,x:n.x+80,y:n.y+60,width:n.w||120,height:n.h||100,customName:n.label};});
      conns=(detail.edges||[]).map(([a,b],i)=>({id:'c_sv_'+i,from:els[a]?.id,to:els[b]?.id,type:'arrow',bent:false,color:'#3b82f6',strokeWidth:2,arrowSize:12})).filter(c=>c.from&&c.to);
    }
    // Store diagram nodes for SVG thumbnail rendering in library
    const entry={
      id:diagram.id||`saved_${Date.now()}`,
      title:diagram.title||'Untitled',
      provider:'aws',
      elements:els,
      connections:conns,
      borders:diagram.borders||[],
      labels:diagram.labels||[],
      icons:diagram.icons||[],
      bubbles:diagram.bubbles||[],
      texts:diagram.texts||[],
      thumbnail:diagram.thumbnail||null,
      colors:diagram.colors||[],
      nodes:detail?.nodes||null,
      edges:detail?.edges||null,
      isPublic:false,
      createdAt:Date.now(),
      updatedAt:Date.now(),
    };
    setLibrary(prev=>{
      const trimmed=[{...entry},...prev.filter(d=>d.id!==entry.id)].slice(0,50);
      _writeStorage(trimmed);
      return trimmed;
    });
    setBookmarked(true);
    setSaveToast('Saved to library! 💾');
    setTimeout(()=>setSaveToast(''),3000);
  };

  const handleCopyLink=()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);};
  const handleAddComment=()=>{if(!comment.trim())return;setComments(prev=>[{user:'You',time:'just now',text:comment.trim()},...prev]);setComment('');};

  const catColors={infra:{bg:darkMode?'rgba(37,99,235,0.18)':'#dbeafe',text:darkMode?'#93c5fd':'#1d4ed8'},cicd:{bg:darkMode?'rgba(22,163,74,0.18)':'#dcfce7',text:darkMode?'#86efac':'#15803d'},serverless:{bg:darkMode?'rgba(124,58,237,0.18)':'#ede9fe',text:darkMode?'#c4b5fd':'#6d28d9'}};
  const cat=catColors[diagram.category]||catColors.infra;
  const catLabel=diagram.category==='infra'?'Infrastructure':diagram.category==='cicd'?'CI/CD':'Serverless';

  const actionBtn=(onClick,active,icon,label,activeColor)=>(
    <button onClick={onClick} style={{display:'flex',alignItems:'center',gap:5,padding:'6px 13px',borderRadius:7,border:`1px solid ${active?accent:borderC}`,background:active?accentBg:'transparent',color:active?accent:textMut,cursor:'pointer',fontSize:12,fontWeight:600}}>
      <span style={{fontSize:14}}>{icon}</span>{!isMobile&&label}
    </button>
  );

  return (
    <div style={{flex:1,overflowY:'auto',background:bg}}>
      <div style={{maxWidth:900,margin:'0 auto',padding:'1.5rem 1rem 4rem'}}>
        {/* Breadcrumb */}
        <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:16,fontSize:12,color:textMut}}>
          <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:accent,fontWeight:600,fontSize:12,padding:0}}>← My Profile</button>
          <span>/</span><span style={{color:textC,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:isMobile?180:400}}>{diagram.title}</span>
        </div>

        {/* Title row */}
        <div style={{display:'flex',flexDirection:isMobile?'column':'row',alignItems:isMobile?'stretch':'flex-start',justifyContent:'space-between',gap:12,marginBottom:16}}>
          <div style={{flex:1,minWidth:0}}>
            <h1 style={{fontSize:isMobile?18:22,fontWeight:800,color:textC,marginBottom:6}}>{diagram.title}</h1>
            <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center'}}>
              <span style={{fontSize:11,padding:'3px 10px',borderRadius:999,fontWeight:700,background:cat.bg,color:cat.text}}>{catLabel}</span>
              {diagram.tags.map(t=><span key={t} style={{fontSize:11,padding:'3px 8px',borderRadius:999,background:darkMode?'#374151':'#f1f5f9',color:textMut}}>{t}</span>)}
            </div>
          </div>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {actionBtn(()=>setLiked(l=>!l),liked,liked?'❤️':'🤍','Like','#ef4444')}
            {actionBtn(handleSaveToLibrary,bookmarked,bookmarked?'🔖':'📄','Save',accent)}
            {actionBtn(()=>setShowShare(true),false,'🔗','Share',accent)}
            {actionBtn(()=>setShowCompare(true),false,'⚖️','Compare',accent)}
            <button onClick={onEdit} style={{display:'flex',alignItems:'center',gap:5,padding:'6px 16px',borderRadius:7,border:'none',background:accent,color:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>✏️ {!isMobile&&'Edit in '}Designer</button>
          </div>
        </div>
        {saveToast&&<div style={{position:'fixed',bottom:80,left:'50%',transform:'translateX(-50%)',background:'#d1fae5',border:'1px solid #6ee7b7',color:'#065f46',borderRadius:10,padding:'10px 20px',fontSize:13,fontWeight:600,zIndex:999,whiteSpace:'nowrap'}}>{saveToast}</div>}
        {showShare&&<DiagramShareModal diagram={diagram} darkMode={darkMode} onClose={()=>setShowShare(false)}/>}
        {showCompare&&(
          <ArchitectureCompareModal
            darkMode={darkMode}
            provider="aws"
            library={library}
            extraPickables={buildExtraPickables()}
            initialArchA={buildCompareArchA()}
            onClose={()=>setShowCompare(false)}
            callClaude={callClaudeWithRetry}
          />
        )}

        {/* Meta */}
        <div style={{display:'flex',gap:16,marginBottom:20,fontSize:12,color:textMut,flexWrap:'wrap'}}>
          <span style={{display:'flex',alignItems:'center',gap:4,cursor:'default'}}>👤 Alex Johnson</span><span>📅 {diagram.date}</span>
          <span>👁️ {diagram.views.toLocaleString()} views</span><span>💬 {comments.length} comment{comments.length!==1?'s':''}</span>
        </div>

        {/* Diagram canvas */}
        <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:14,overflow:'hidden',marginBottom:20,position:'relative'}}>
          <div style={{position:'absolute',top:12,right:12,zIndex:10,display:'flex',gap:4}}>
            {[{label:'−',action:()=>setZoom(z=>Math.max(0.5,+(z-0.2).toFixed(1)))},{label:`${Math.round(zoom*100)}%`,action:null},{label:'+',action:()=>setZoom(z=>Math.min(2,+(z+0.2).toFixed(1)))}].map((b,i)=>(
              <button key={i} onClick={b.action||undefined} style={{padding:'4px 10px',borderRadius:6,border:`1px solid ${borderC}`,background:cardBg,color:textC,cursor:b.action?'pointer':'default',fontSize:12,fontWeight:600,minWidth:36}}>{b.label}</button>
            ))}
          </div>
          <div style={{padding:'1.5rem',minHeight:isMobile?280:420,display:'flex',alignItems:'center',justifyContent:'center',overflow:'auto',background:darkMode?'#0f172a':'#f8fafc'}}>
            <div style={{transform:`scale(${zoom})`,transformOrigin:'center center',transition:'transform 0.2s',width:'100%',maxWidth:500,minHeight:isMobile?240:380}}>
              <FullDiagramSVG diagram={diagram} darkMode={darkMode}/>
            </div>
          </div>
          <div style={{padding:'10px 1.5rem',borderTop:`1px solid ${borderC}`,display:'flex',flexWrap:'wrap',gap:12,alignItems:'center'}}>
            <span style={{fontSize:11,color:textMut,fontWeight:600}}>LEGEND</span>
            {[['#FF9900','Compute'],['#527FFF','Database'],['#8C4FFF','Networking'],['#569A31','Storage'],['#4B612C','Developer'],['#DD344C','Security']].map(([col,lbl])=>(
              <span key={lbl} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:textMut}}>
                <span style={{width:10,height:10,borderRadius:3,background:col,display:'inline-block'}}/>{!isMobile&&lbl}
              </span>
            ))}
            <span style={{marginLeft:'auto',fontSize:11,color:textMut}}>{detail.nodes.length} services · {detail.edges.length} connections</span>
          </div>
        </div>

        {/* Description */}
        <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'1.2rem 1.4rem',marginBottom:20}}>
          <h2 style={{fontSize:14,fontWeight:700,color:textC,marginBottom:8}}>About this diagram</h2>
          <p style={{fontSize:13,color:textC,lineHeight:1.7,margin:0}}>{detail.description}</p>
        </div>

        {/* Architecture breakdown */}
        <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'1.2rem 1.4rem',marginBottom:20}}>
          <h2 style={{fontSize:14,fontWeight:700,color:textC,marginBottom:12}}>Architecture breakdown</h2>
          <div style={{display:'grid',gridTemplateColumns:`repeat(auto-fill,minmax(${isMobile?'130px':'155px'},1fr))`,gap:10}}>
            {detail.nodes.map((n,i)=>(
              <div key={i} style={{display:'flex',alignItems:'center',gap:9,padding:'8px 10px',borderRadius:8,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc'}}>
                <div style={{width:32,height:32,borderRadius:6,background:n.color,display:'flex',alignItems:'center',justifyContent:'center',fontSize:16,flexShrink:0}}>{n.icon}</div>
                <span style={{fontSize:12,fontWeight:600,color:textC,lineHeight:1.3}}>{n.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Comments */}
        <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'1.2rem 1.4rem'}}>
          <h2 style={{fontSize:14,fontWeight:700,color:textC,marginBottom:14}}>Comments <span style={{fontWeight:400,color:textMut}}>({comments.length})</span></h2>
          <div style={{display:'flex',gap:10,marginBottom:20,alignItems:'flex-start'}}>
            <div style={{width:32,height:32,borderRadius:'50%',background:accentBg,flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:13,fontWeight:700,color:accent}}>AJ</div>
            <div style={{flex:1}}>
              <textarea value={comment} onChange={e=>setComment(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&e.metaKey)handleAddComment();}} placeholder="Add a comment… (⌘↵ to post)" rows={2}
                style={{width:'100%',padding:'8px 12px',borderRadius:8,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:13,fontFamily:'Inter,Arial,sans-serif',resize:'vertical',outline:'none',boxSizing:'border-box',lineHeight:1.5}}/>
              <div style={{display:'flex',justifyContent:'flex-end',marginTop:6}}>
                <button onClick={handleAddComment} style={{padding:'5px 16px',borderRadius:7,border:'none',background:comment.trim()?accent:borderC,color:comment.trim()?'#fff':textMut,cursor:comment.trim()?'pointer':'default',fontSize:12,fontWeight:700}}>Post</button>
              </div>
            </div>
          </div>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            {comments.length===0&&<p style={{fontSize:13,color:textMut,textAlign:'center',padding:'1rem 0'}}>No comments yet. Be the first!</p>}
            {comments.map((c,i)=>(
              <div key={i} style={{display:'flex',gap:10}}>
                <div style={{width:32,height:32,borderRadius:'50%',background:darkMode?'#374151':'#e2e8f0',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:12,fontWeight:700,color:textMut}}>{c.user.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
                <div style={{flex:1}}>
                  <div style={{display:'flex',gap:8,alignItems:'baseline',marginBottom:3}}>
                    <span style={{fontSize:13,fontWeight:700,color:textC}}>{c.user}</span>
                    <span style={{fontSize:11,color:textMut}}>{c.time}</span>
                  </div>
                  <p style={{fontSize:13,color:textC,lineHeight:1.6,margin:0}}>{c.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Newsfeed data ------------------------------------------------------------
const FEED_USERS = [
  { handle:'@sarahk',  name:'Sarah Kim',     initials:'SK', color:'#7c3aed', title:'Cloud Architect @ Netflix' },
  { handle:'@miket',   name:'Mike Torres',   initials:'MT', color:'#0891b2', title:'DevOps Lead @ Stripe' },
  { handle:'@danarm',  name:'Dana Rahman',   initials:'DR', color:'#059669', title:'SRE @ Cloudflare' },
  { handle:'@priyas',  name:'Priya Sharma',  initials:'PS', color:'#db2777', title:'Solutions Architect @ AWS' },
  { handle:'@chrism',  name:'Chris Morales', initials:'CM', color:'#d97706', title:'Platform Engineer @ GitHub' },
  { handle:'@emmawei', name:'Emma Wei',      initials:'EW', color:'#dc2626', title:'Infrastructure Lead @ Datadog' },
];

const FEED_POSTS = [
  { id:'fp1',userId:0,timeAgo:'12 min ago',caption:'Just finished setting up a fully automated blue/green deploy pipeline for our ECS services using CodeDeploy. Zero-downtime deploys in under 3 minutes! Happy to share the CDK stack if anyone is interested.',diagram:{id:'fp1d',title:'ECS Blue/Green Pipeline',category:'cicd',tags:['ECS','CodeDeploy','CDK'],colors:['#4B612C','#FF9900','#569A31'],views:0},likes:47,comments:8,isLiked:false,isBookmarked:false },
  { id:'fp2',userId:1,timeAgo:'1 hr ago',caption:'Migrated our entire data platform from EC2-based Kafka to Amazon MSK. Reduced ops overhead by ~60% and finally got proper multi-AZ redundancy without the maintenance headache.',diagram:{id:'fp2d',title:'MSK Streaming Platform',category:'infra',tags:['MSK','Kafka','EC2'],colors:['#FF9900','#527FFF','#8C4FFF'],views:0},likes:93,comments:14,isLiked:false,isBookmarked:false },
  { id:'fp3',userId:2,timeAgo:'3 hrs ago',caption:"Quick tip: enable provisioned concurrency on your critical Lambda paths. Cut our cold-start p99 from 4s to 180ms. Here's the architecture we landed on after weeks of tuning.",diagram:{id:'fp3d',title:'Lambda Warm Concurrency Setup',category:'serverless',tags:['Lambda','API GW','CloudWatch'],colors:['#FF9900','#8C4FFF','#527FFF'],views:0},likes:182,comments:31,isLiked:false,isBookmarked:false },
  { id:'fp4',userId:3,timeAgo:'5 hrs ago',caption:'New diagram: multi-account AWS Organizations setup with Service Control Policies. This is the landing zone pattern we use for enterprise customers separating prod, staging, sandbox, and logging accounts.',diagram:{id:'fp4d',title:'AWS Organizations Landing Zone',category:'infra',tags:['Organizations','SCP','Control Tower'],colors:['#DD344C','#8C4FFF','#527FFF'],views:0},likes:124,comments:19,isLiked:false,isBookmarked:false },
  { id:'fp5',userId:4,timeAgo:'8 hrs ago',caption:'Finally documented our GitHub Actions -> ECR -> EKS GitOps workflow using ArgoCD. Took 3 months to get right but now every engineer can ship to prod with a single PR merge.',diagram:{id:'fp5d',title:'GitOps with ArgoCD on EKS',category:'cicd',tags:['EKS','ArgoCD','ECR'],colors:['#4B612C','#FF9900','#569A31'],views:0},likes:211,comments:43,isLiked:false,isBookmarked:false },
  { id:'fp6',userId:5,timeAgo:'Yesterday',caption:'Cost optimisation win: moved analytics workloads to Spot instances with a mixed instance policy. Monthly EC2 bill dropped 71%. The trick is using Spot Fleet with capacity-optimised allocation.',diagram:{id:'fp6d',title:'Spot Fleet Analytics Cluster',category:'infra',tags:['EC2 Spot','EMR','S3'],colors:['#FF9900','#569A31','#527FFF'],views:0},likes:308,comments:52,isLiked:false,isBookmarked:false },
  { id:'fp7',userId:0,timeAgo:'Yesterday',caption:"Sharing our WAF + Shield Advanced setup after we got hit by a 40Gbps DDoS last month. The managed rule groups saved us. Here's exactly what we configured.",diagram:{id:'fp7d',title:'WAF + Shield DDoS Protection',category:'infra',tags:['WAF','Shield','CloudFront'],colors:['#DD344C','#8C4FFF','#FF9900'],views:0},likes:89,comments:11,isLiked:false,isBookmarked:false },
  { id:'fp8',userId:2,timeAgo:'2 days ago',caption:'OpenSearch + Kinesis Firehose + Lambda for real-time log analytics. Replaced our self-managed ELK stack and cut infra costs by half.',diagram:{id:'fp8d',title:'Real-time Log Analytics Pipeline',category:'serverless',tags:['OpenSearch','Kinesis','Lambda'],colors:['#FF9900','#527FFF','#569A31'],views:0},likes:143,comments:22,isLiked:false,isBookmarked:false },
];

// --- UserProfilePage (public profile of a feed user) --------------------------
const USER_EXTRA_DATA = {
  '@sarahk':  { bio:'Senior cloud architect at Netflix. I design large-scale AWS infrastructure, streaming pipelines, and cost-optimised multi-region deployments. AWS Certified Solutions Architect - Professional.', location:'Los Gatos, CA', website:'sarahkim.dev', followers:1840, following:312, coverGradient:'linear-gradient(135deg,#7c3aed 0%,#4f46e5 60%,#0891b2 100%)' },
  '@miket':   { bio:'DevOps Lead at Stripe. Kubernetes, Terraform, and CI/CD are my bread and butter. I share production-grade diagrams from real systems we\'ve built and scaled.', location:'San Francisco, CA', website:'miketorres.io', followers:2310, following:188, coverGradient:'linear-gradient(135deg,#0891b2 0%,#0284c7 60%,#6366f1 100%)' },
  '@danarm':  { bio:'SRE at Cloudflare keeping the internet up 🌐. Obsessed with reliability, observability, and making on-call not miserable. Diagrams are my rubber ducks.', location:'Austin, TX', website:'danar.sh', followers:987, following:430, coverGradient:'linear-gradient(135deg,#059669 0%,#0d9488 60%,#0891b2 100%)' },
  '@priyas':  { bio:'Solutions Architect @ AWS helping enterprise customers design resilient, secure, and cost-effective cloud architectures. Speaker, blogger, and open-source contributor.', location:'Seattle, WA', website:'priyasharma.cloud', followers:5420, following:276, coverGradient:'linear-gradient(135deg,#db2777 0%,#9333ea 60%,#6366f1 100%)' },
  '@chrism':  { bio:'Platform Engineer at GitHub building the tools that developers use to build tools. Focused on GitOps, developer experience, and Kubernetes-native infrastructure.', location:'New York, NY', website:'chrismorales.dev', followers:1123, following:521, coverGradient:'linear-gradient(135deg,#d97706 0%,#dc2626 60%,#9333ea 100%)' },
  '@emmawei': { bio:'Infrastructure Lead at Datadog. I care deeply about observability, cost engineering, and the boring-but-critical parts of cloud infrastructure that keep things running.', location:'New York, NY', website:'emmawei.tech', followers:3280, following:194, coverGradient:'linear-gradient(135deg,#dc2626 0%,#db2777 60%,#7c3aed 100%)' },
};

function UserProfilePage({ feedUser, darkMode, onBack, onViewDiagram }) {
  const isMobile=useIsMobile();
  const bg=darkMode?'#111827':'#eff6ff';
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent=darkMode?'#67e8f9':'#2563eb';
  const accentBg=darkMode?'rgba(103,232,249,0.1)':'#eff6ff';

  const [following,setFollowing]=useState(false);
  const [filterCat,setFilterCat]=useState('all');

  const extra = USER_EXTRA_DATA[feedUser.handle] || {
    bio:'AWS cloud architect sharing diagrams and architecture patterns.',
    location:'Remote', website:'cloudforger.app', followers:500, following:200,
    coverGradient:'linear-gradient(135deg,#2563eb 0%,#7c3aed 100%)'
  };

  const allDiagrams = FEED_POSTS.filter(p => FEED_USERS[p.userId]?.handle === feedUser.handle).map(p=>p.diagram);
  const FILTERS=[{id:'all',label:'All'},{id:'infra',label:'Infrastructure'},{id:'cicd',label:'CI/CD'},{id:'serverless',label:'Serverless'}];
  const shown = filterCat==='all' ? allDiagrams : allDiagrams.filter(d=>d.category===filterCat);
  const totalViews = allDiagrams.reduce((a,d)=>a+(d.views||0),0);
  const initials = feedUser.initials || (feedUser.name||'U').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();

  return (
    <div style={{flex:1,overflowY:'auto',background:bg}}>
      <div style={{maxWidth:860,margin:'0 auto',padding:'1.5rem 1rem 4rem'}}>
        <button onClick={onBack} style={{background:'none',border:'none',color:accent,cursor:'pointer',fontSize:13,fontWeight:600,padding:'0 0 12px',display:'flex',alignItems:'center',gap:4}}>← Back</button>
        <div style={{height:isMobile?80:120,borderRadius:'12px 12px 0 0',background:extra.coverGradient}}/>
        <div style={{background:cardBg,border:`1px solid ${borderC}`,borderTop:'none',borderRadius:'0 0 12px 12px',padding:'0 1.4rem 1.4rem',marginBottom:'1.4rem'}}>
          <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',marginBottom:10}}>
            <div style={{marginTop:-36}}>
              <div style={{width:72,height:72,borderRadius:'50%',border:`3px solid ${cardBg}`,background:feedUser.color+'22',display:'flex',alignItems:'center',justifyContent:'center',fontSize:26,fontWeight:800,color:feedUser.color,userSelect:'none'}}>{initials}</div>
            </div>
            <button onClick={()=>setFollowing(f=>!f)} style={{padding:'6px 18px',borderRadius:7,border:`1px solid ${following?borderC:accent}`,background:following?'transparent':accent,color:following?textMut:'#fff',cursor:'pointer',fontSize:12,fontWeight:700}}>
              {following?'Following':'+ Follow'}
            </button>
          </div>
          <div style={{fontSize:isMobile?17:19,fontWeight:800,color:textC}}>{feedUser.name}</div>
          <div style={{fontSize:12,color:textMut,marginTop:2,marginBottom:10}}>{feedUser.handle} · {feedUser.title}</div>
          <p style={{fontSize:13,color:textC,lineHeight:1.65,maxWidth:520,marginBottom:12}}>{extra.bio}</p>
          <div style={{display:'flex',flexWrap:'wrap',gap:14,marginBottom:14}}>
            <span style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:textMut}}><MapPin size={13}/>{extra.location}</span>
            <span style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:accent}}><Link2 size={13}/>{extra.website}</span>
            <span style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:textMut}}><Calendar size={13}/>Joined Jan 2023</span>
          </div>
          <div style={{display:'flex',gap:isMobile?16:24,paddingTop:12,borderTop:`1px solid ${borderC}`,flexWrap:'wrap'}}>
            {[{n:allDiagrams.length,l:'diagrams'},{n:(extra.followers+(following?1:0)).toLocaleString(),l:'followers'},{n:extra.following,l:'following'},{n:totalViews||0,l:'views'}].map((s,i)=>(
              <div key={i} style={{textAlign:'center'}}>
                <div style={{fontSize:17,fontWeight:800,color:textC}}>{s.n}</div>
                <div style={{fontSize:10,color:textMut,marginTop:1}}>{s.l}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:12,flexWrap:'wrap',gap:8}}>
          <span style={{fontSize:15,fontWeight:700,color:textC}}>Diagrams</span>
          <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
            {FILTERS.map(f=>(
              <button key={f.id} onClick={()=>setFilterCat(f.id)} style={{padding:'4px 12px',borderRadius:999,border:`1px solid ${f.id===filterCat?accent:borderC}`,background:f.id===filterCat?accentBg:'transparent',color:f.id===filterCat?accent:textMut,fontSize:11,fontWeight:600,cursor:'pointer'}}>{f.label}</button>
            ))}
          </div>
        </div>
        {shown.length===0
          ? <div style={{textAlign:'center',padding:'3rem 1rem',color:textMut,fontSize:13,background:cardBg,border:`1px solid ${borderC}`,borderRadius:12}}>No diagrams in this category yet.</div>
          : <div style={{display:'grid',gridTemplateColumns:`repeat(auto-fill,minmax(${isMobile?'160px':'240px'},1fr))`,gap:isMobile?10:14}}>
              {shown.map((d,i)=>(
                <div key={i} onClick={()=>onViewDiagram(d)} style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,overflow:'hidden',cursor:'pointer',transition:'border-color 0.15s'}}
                  onMouseOver={e=>e.currentTarget.style.borderColor=accent} onMouseOut={e=>e.currentTarget.style.borderColor=borderC}>
                  <div style={{height:isMobile?110:140,background:darkMode?'#0f172a':'#f0f4ff',overflow:'hidden'}}>
                    <FeedDiagramPreview diagramId={d.id} darkMode={darkMode}/>
                  </div>
                  <div style={{padding:'10px 12px 12px'}}>
                    <div style={{fontSize:isMobile?12:13,fontWeight:700,color:textC,marginBottom:6,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{d.title}</div>
                    <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:8}}>
                      {(d.tags||[]).slice(0,isMobile?2:3).map(t=><span key={t} style={{fontSize:10,padding:'2px 7px',borderRadius:999,background:darkMode?'#374151':'#f1f5f9',color:textMut}}>{t}</span>)}
                    </div>
                    <div style={{display:'flex',alignItems:'center',gap:10,paddingTop:8,borderTop:`1px solid ${borderC}`}}>
                      <span style={{display:'flex',alignItems:'center',gap:4,fontSize:11,color:textMut}}><Eye size={12}/>{d.views||0}</span>
                      <button onClick={e=>{e.stopPropagation();onViewDiagram(d);}} style={{marginLeft:'auto',padding:'3px 10px',fontSize:11,fontWeight:600,borderRadius:6,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer'}}>Open</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
        }
      </div>
    </div>
  );
}

// --- FeedDiagramPreview - renders actual diagram nodes & edges ----------------
function FeedDiagramPreview({ diagramId, darkMode }) {
  // Merge DIAGRAM_DETAILS (profile diagrams) and FEED_DIAGRAM_DETAILS (feed posts)
  const all = { ...DIAGRAM_DETAILS, ...FEED_DIAGRAM_DETAILS };
  const detail = all[diagramId];

  if (!detail || !detail.nodes || !detail.nodes.length) {
    return (
      <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', opacity:0.3, fontSize:13, color: darkMode?'#94a3b8':'#64748b' }}>
        No preview
      </div>
    );
  }

  const { nodes, edges } = detail;
  const pad = 18;
  const minX = Math.min(...nodes.map(n => n.x)) - pad;
  const minY = Math.min(...nodes.map(n => n.y)) - pad;
  const maxX = Math.max(...nodes.map(n => n.x + n.w)) + pad;
  const maxY = Math.max(...nodes.map(n => n.y + n.h)) + pad;
  const vw = maxX - minX;
  const vh = maxY - minY;

  const cx = n => n.x + n.w / 2 - minX;
  const cy = n => n.y + n.h / 2 - minY;
  const nx = n => n.x - minX;
  const ny = n => n.y - minY;

  const gridColor = darkMode ? 'rgba(255,255,255,0.035)' : 'rgba(37,99,235,0.06)';

  return (
    <svg
      viewBox={`0 0 ${vw} ${vh}`}
      style={{ width:'100%', height:'100%', display:'block' }}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern id={`fg-${diagramId}`} x="0" y="0" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill={gridColor}/>
        </pattern>
        <marker id={`fa-${diagramId}`} markerWidth="7" markerHeight="7" refX="5.5" refY="2.8" orient="auto">
          <path d="M0,0 L0,5.6 L7,2.8 z" fill="#3b82f6" opacity="0.65"/>
        </marker>
        {nodes.map((n,i)=>(
          <filter key={i} id={`fs-${diagramId}-${i}`} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" floodColor={n.color} floodOpacity="0.22"/>
          </filter>
        ))}
      </defs>

      {/* Dot grid bg */}
      <rect width={vw} height={vh} fill={`url(#fg-${diagramId})`}/>

      {/* Edges */}
      {edges && edges.map(([a, b], i) => {
        const from = nodes[a], to = nodes[b];
        if (!from || !to) return null;
        const x1 = cx(from), y1 = from.y + from.h - minY;
        const x2 = cx(to),   y2 = to.y - minY;
        const my = (y1 + y2) / 2;
        return (
          <path key={i}
            d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`}
            stroke="#3b82f6" strokeWidth="1.5" fill="none"
            strokeDasharray="4 2.5" opacity="0.55"
            markerEnd={`url(#fa-${diagramId})`}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((n, i) => {
        const x = nx(n), y = ny(n);
        const iconFontSize = Math.round(n.h * 0.38);
        const labelFontSize = Math.max(7, Math.round(n.h * 0.175));
        return (
          <g key={i} filter={`url(#fs-${diagramId}-${i})`}>
            {/* Node box */}
            <rect x={x} y={y} width={n.w} height={n.h} rx="7"
              fill={n.color} opacity="0.93"
              stroke={darkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)'}
              strokeWidth="1"
            />
            {/* Gloss sheen */}
            <rect x={x+3} y={y+3} width={n.w-6} height={n.h*0.3} rx="4"
              fill="rgba(255,255,255,0.18)"
            />
            {/* Icon */}
            <text
              x={x + n.w / 2} y={y + n.h * 0.42}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={iconFontSize}
              style={{ userSelect:'none' }}
            >{n.icon}</text>
            {/* Label */}
            <text
              x={x + n.w / 2} y={y + n.h * 0.8}
              textAnchor="middle" dominantBaseline="middle"
              fontSize={labelFontSize} fontWeight="700" fill="#ffffff"
              style={{ userSelect:'none', fontFamily:'Inter,Arial,sans-serif' }}
            >{n.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// --- FeedAvatar ---------------------------------------------------------------
function FeedAvatar({ user, size=40, onClick }) {
  return (
    <div onClick={onClick} style={{width:size,height:size,borderRadius:'50%',flexShrink:0,background:user.color+'22',border:`2px solid ${user.color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:Math.round(size*0.34),fontWeight:700,color:user.color,userSelect:'none',cursor:onClick?'pointer':'default'}}>
      {user.initials}
    </div>
  );
}

// --- FeedCard -----------------------------------------------------------------
function FeedCard({ post, darkMode, onViewDiagram, onViewProfile, library=[], allPosts=[] }) {
  const isMobile=useIsMobile();
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent=darkMode?'#67e8f9':'#2563eb';
  const thumbBg=darkMode?'#0f172a':'#f8fafc';

  const user=FEED_USERS[post.userId];
  const [liked,setLiked]=useState(post.isLiked);
  const [likeCount,setLikeCount]=useState(post.likes);
  const [saved,setSaved]=useState(post.isBookmarked);
  const [expanded,setExpanded]=useState(false);
  const [showComment,setShowComment]=useState(false);
  const [commentText,setCommentText]=useState('');
  const [commentCount,setCommentCount]=useState(post.comments);
  const [following,setFollowing]=useState(true);

  const toggleLike=()=>{setLiked(l=>!l);setLikeCount(c=>liked?c-1:c+1);};
  const submitComment=()=>{if(!commentText.trim())return;setCommentCount(c=>c+1);setCommentText('');setShowComment(false);};
  const [showShare,setShowShare]=useState(false);

  const catColors={infra:{bg:darkMode?'rgba(37,99,235,0.15)':'#dbeafe',text:darkMode?'#93c5fd':'#1d4ed8'},cicd:{bg:darkMode?'rgba(22,163,74,0.15)':'#dcfce7',text:darkMode?'#86efac':'#15803d'},serverless:{bg:darkMode?'rgba(124,58,237,0.15)':'#ede9fe',text:darkMode?'#c4b5fd':'#6d28d9'}};
  const cat=catColors[post.diagram.category]||catColors.infra;
  const catLabel=post.diagram.category==='infra'?'Infrastructure':post.diagram.category==='cicd'?'CI/CD':'Serverless';
  const TRUNCATE=160;
  const isTruncatable=post.caption.length>TRUNCATE;
  const displayCaption=isTruncatable&&!expanded?post.caption.slice(0,TRUNCATE)+'…':post.caption;

  const aBtn=(onClick,active,icon,label,activeColor)=>(
    <button onClick={onClick} style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',borderRadius:7,border:'none',background:'transparent',color:active?activeColor:textMut,cursor:'pointer',fontSize:12,fontWeight:600}}>
      <span style={{fontSize:15}}>{icon}</span>{label}
    </button>
  );

  return (
    <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:14,overflow:'hidden',marginBottom:14}}>
      {/* Header */}
      <div style={{padding:'14px 16px 10px',display:'flex',alignItems:'flex-start',gap:12}}>
        <FeedAvatar user={user} size={isMobile?36:42} onClick={()=>onViewProfile&&onViewProfile(user)}/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
            <div>
              <span onClick={()=>onViewProfile&&onViewProfile(user)} style={{fontSize:14,fontWeight:700,color:textC,cursor:'pointer'}}>{user.name}</span>
              <span onClick={()=>onViewProfile&&onViewProfile(user)} style={{fontSize:12,color:textMut,marginLeft:6,cursor:'pointer'}}>{user.handle}</span>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:11,color:textMut,whiteSpace:'nowrap'}}>{post.timeAgo}</span>
              <button onClick={()=>setFollowing(f=>!f)} style={{fontSize:11,padding:'3px 10px',borderRadius:999,border:`1px solid ${following?borderC:accent}`,background:following?'transparent':accent,color:following?textMut:'#fff',cursor:'pointer',fontWeight:600,whiteSpace:'nowrap'}}>
                {following?'Following':'+ Follow'}
              </button>
            </div>
          </div>
          <div style={{fontSize:11,color:textMut,marginTop:1}}>{user.title}</div>
        </div>
      </div>

      {/* Caption */}
      <div style={{padding:'0 16px 12px'}}>
        <p style={{fontSize:13,color:textC,lineHeight:1.65,margin:0}}>{displayCaption}</p>
        {isTruncatable&&<button onClick={()=>setExpanded(e=>!e)} style={{background:'none',border:'none',color:accent,cursor:'pointer',fontSize:12,fontWeight:600,padding:'4px 0 0',display:'block'}}>{expanded?'Show less':'Read more'}</button>}
      </div>

      {/* Diagram card */}
      <div onClick={()=>onViewDiagram(post.diagram)} style={{margin:'0 16px 14px',border:`1px solid ${borderC}`,borderRadius:10,overflow:'hidden',cursor:'pointer',transition:'border-color 0.15s'}}
        onMouseOver={e=>e.currentTarget.style.borderColor=accent} onMouseOut={e=>e.currentTarget.style.borderColor=borderC}>
        <div style={{height:isMobile?160:200,background:darkMode?'#0f172a':'#f0f4ff',overflow:'hidden',position:'relative'}}>
          <FeedDiagramPreview diagramId={post.diagram.id} darkMode={darkMode}/>
        </div>
        <div style={{padding:'10px 12px',display:'flex',alignItems:'center',gap:8,borderTop:`1px solid ${borderC}`,background:cardBg}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:textC,marginBottom:4,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{post.diagram.title}</div>
            <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
              <span style={{fontSize:10,padding:'2px 8px',borderRadius:999,fontWeight:700,background:cat.bg,color:cat.text}}>{catLabel}</span>
              {post.diagram.tags.slice(0,isMobile?2:3).map(t=><span key={t} style={{fontSize:10,padding:'2px 7px',borderRadius:999,background:darkMode?'#374151':'#f1f5f9',color:textMut}}>{t}</span>)}
            </div>
          </div>
          <span style={{fontSize:11,color:accent,fontWeight:700,whiteSpace:'nowrap',flexShrink:0}}>View {'->'}</span>
        </div>
      </div>

      {/* Actions */}
      <div style={{padding:'2px 8px 6px',display:'flex',alignItems:'center',borderTop:`1px solid ${borderC}`,flexWrap:'wrap'}}>
        {aBtn(toggleLike,liked,liked?'❤️':'🤍',`${likeCount}`,'#ef4444')}
        {aBtn(()=>setShowComment(s=>!s),showComment,'💬',`${commentCount}`,accent)}
        {aBtn(()=>setSaved(s=>!s),saved,saved?'🔖':'📄',saved?'Saved':'Save',accent)}
        {aBtn(()=>setShowShare(true),false,'🔗','Share',accent)}
        <div style={{flex:1}}/>
        <button onClick={()=>onViewDiagram(post.diagram)} style={{fontSize:11,padding:'4px 12px',borderRadius:7,border:`1px solid ${borderC}`,background:'transparent',color:textC,cursor:'pointer',fontWeight:600}}>Open</button>
      </div>

      {showShare&&<DiagramShareModal diagram={post.diagram} darkMode={darkMode} onClose={()=>setShowShare(false)}/>}

      {/* Inline comment */}
      {showComment&&(
        <div style={{padding:'0 16px 14px',display:'flex',gap:10,alignItems:'flex-start'}}>
          <div style={{width:28,height:28,borderRadius:'50%',background:darkMode?'rgba(103,232,249,0.1)':'#eff6ff',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700,color:accent,flexShrink:0}}>AJ</div>
          <div style={{flex:1,display:'flex',gap:6}}>
            <input value={commentText} onChange={e=>setCommentText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')submitComment();}} placeholder="Write a comment…"
              style={{flex:1,padding:'6px 10px',borderRadius:7,border:`1px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,fontSize:12,fontFamily:'Inter,Arial,sans-serif',outline:'none'}}/>
            <button onClick={submitComment} style={{padding:'6px 12px',borderRadius:7,border:'none',background:commentText.trim()?accent:borderC,color:commentText.trim()?'#fff':textMut,cursor:commentText.trim()?'pointer':'default',fontSize:12,fontWeight:700}}>Post</button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- NewsfeedPage -------------------------------------------------------------
function NewsfeedPage({ darkMode, onViewDiagram, onViewProfile, library=[] }) {
  const isMobile=useIsMobile();
  const bg=darkMode?'#111827':'#eff6ff';
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent=darkMode?'#67e8f9':'#2563eb';
  const accentBg=darkMode?'rgba(103,232,249,0.08)':'#eff6ff';

  const [filter,setFilter]=useState('all');
  const [search,setSearch]=useState('');

  const FILTER_TABS=[{id:'all',label:'All'},{id:'infra',label:'Infrastructure'},{id:'cicd',label:'CI/CD'},{id:'serverless',label:'Serverless'}];

  const filtered=FEED_POSTS.filter(p=>{
    const matchCat=filter==='all'||p.diagram.category===filter;
    const q=search.toLowerCase();
    const matchSearch=!q||FEED_USERS[p.userId].name.toLowerCase().includes(q)||p.caption.toLowerCase().includes(q)||p.diagram.title.toLowerCase().includes(q)||p.diagram.tags.some(t=>t.toLowerCase().includes(q));
    return matchCat&&matchSearch;
  });

  return (
    <div style={{flex:1,overflowY:'auto',background:bg}}>
      <div style={{maxWidth:isMobile?'100%':680,margin:'0 auto',padding:isMobile?'1rem 0.75rem 4rem':'1.4rem 1rem 4rem'}}>

        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16,flexWrap:'wrap',gap:10}}>
          <div>
            <h1 style={{fontSize:isMobile?18:20,fontWeight:800,color:textC,margin:0}}>Feed</h1>
            <p style={{fontSize:12,color:textMut,margin:'3px 0 0'}}>Diagrams from {FEED_USERS.length} people you follow</p>
          </div>
          <div style={{position:'relative'}}>
            <span style={{position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',fontSize:13,color:textMut,pointerEvents:'none'}}>🔍</span>
            <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search posts…"
              style={{paddingLeft:28,paddingRight:10,paddingTop:6,paddingBottom:6,borderRadius:8,border:`1px solid ${borderC}`,background:cardBg,color:textC,fontSize:12,fontFamily:'Inter,Arial,sans-serif',outline:'none',width:isMobile?'100%':180}}/>
          </div>
        </div>

        {/* Two-col layout: feed + sidebar (sidebar hidden on mobile) */}
        <div style={{display:'grid',gridTemplateColumns:isMobile?'1fr':'1fr 220px',gap:16,alignItems:'start'}}>

          {/* Feed */}
          <div>
            {/* Filter pills */}
            <div style={{display:'flex',gap:5,marginBottom:14,flexWrap:'wrap'}}>
              {FILTER_TABS.map(f=>(
                <button key={f.id} onClick={()=>setFilter(f.id)} style={{padding:'5px 13px',borderRadius:999,fontSize:11,fontWeight:600,cursor:'pointer',border:`1px solid ${filter===f.id?accent:borderC}`,background:filter===f.id?accentBg:'transparent',color:filter===f.id?accent:textMut}}>
                  {f.label}
                </button>
              ))}
              <span style={{marginLeft:'auto',fontSize:11,color:textMut,alignSelf:'center'}}>{filtered.length} post{filtered.length!==1?'s':''}</span>
            </div>

            {filtered.length===0
              ?<div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:14,padding:'3rem 1rem',textAlign:'center',color:textMut,fontSize:13}}>No posts match your search.</div>
              :filtered.map(post=><FeedCard key={post.id} post={post} darkMode={darkMode} onViewDiagram={onViewDiagram} onViewProfile={onViewProfile} library={library} allPosts={FEED_POSTS}/>)
            }
          </div>

          {/* Sidebar - desktop only */}
          {!isMobile&&(
            <div style={{position:'sticky',top:0,display:'flex',flexDirection:'column',gap:12}}>
              {/* Following */}
              <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'12px 14px'}}>
                <div style={{fontSize:12,fontWeight:700,color:textC,marginBottom:10}}>Following</div>
                <div style={{display:'flex',flexDirection:'column',gap:10}}>
                  {FEED_USERS.map((u,i)=>(
                    <div key={i} onClick={()=>onViewProfile&&onViewProfile(u)} style={{display:'flex',alignItems:'center',gap:9,cursor:'pointer',borderRadius:7,padding:'2px 4px',transition:'background 0.15s'}}
                      onMouseOver={e=>e.currentTarget.style.background=darkMode?'#374151':'#f1f5f9'} onMouseOut={e=>e.currentTarget.style.background='transparent'}>
                      <FeedAvatar user={u} size={30}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:12,fontWeight:600,color:textC,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{u.name}</div>
                        <div style={{fontSize:10,color:textMut}}>{u.handle}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trending */}
              <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'12px 14px'}}>
                <div style={{fontSize:12,fontWeight:700,color:textC,marginBottom:10}}>Trending topics</div>
                <div style={{display:'flex',flexDirection:'column',gap:6}}>
                  {[{tag:'#EKS',count:14},{tag:'#Serverless',count:11},{tag:'#CostSavings',count:9},{tag:'#GitOps',count:7},{tag:'#BlueGreen',count:6},{tag:'#DataPlatform',count:5}].map(t=>(
                    <div key={t.tag} onClick={()=>setSearch(t.tag.replace('#',''))} style={{display:'flex',justifyContent:'space-between',cursor:'pointer',padding:'3px 0',borderBottom:`0.5px solid ${borderC}`}}
                      onMouseOver={e=>e.currentTarget.style.opacity='0.7'} onMouseOut={e=>e.currentTarget.style.opacity='1'}>
                      <span style={{fontSize:12,color:accent,fontWeight:600}}>{t.tag}</span>
                      <span style={{fontSize:11,color:textMut}}>{t.count} posts</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Suggested */}
              <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:12,padding:'12px 14px'}}>
                <div style={{fontSize:12,fontWeight:700,color:textC,marginBottom:10}}>Suggested</div>
                {[{initials:'JL',name:'James Lee',title:'Infra @ Shopify',color:'#0284c7'},{initials:'NP',name:'Nadia Petrov',title:'SRE @ Meta',color:'#7c3aed'},{initials:'BO',name:'Ben Okafor',title:'DevOps @ Spotify',color:'#059669'}].map((u,i)=>(
                  <div key={i} style={{display:'flex',alignItems:'center',gap:9,marginBottom:i<2?10:0}}>
                    <div style={{width:30,height:30,borderRadius:'50%',flexShrink:0,background:u.color+'22',border:`2px solid ${u.color}44`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,color:u.color}}>{u.initials}</div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600,color:textC,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{u.name}</div>
                      <div style={{fontSize:10,color:textMut}}>{u.title}</div>
                    </div>
                    <button style={{fontSize:10,padding:'3px 8px',borderRadius:999,border:`1px solid ${accent}`,background:'transparent',color:accent,cursor:'pointer',fontWeight:700,flexShrink:0}}>+ Follow</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- OAuth brand logos --------------------------------------------------------
const GoogleLogo=()=>(<svg width="18" height="18" viewBox="0 0 48 48" style={{flexShrink:0}}><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>);
const GitHubLogo=({dark})=>(<svg width="18" height="18" viewBox="0 0 24 24" style={{flexShrink:0}} fill={dark?'#fff':'#24292f'}><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>);
const SlackLogo=()=>(<svg width="18" height="18" viewBox="0 0 122.8 122.8" style={{flexShrink:0}}><path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A"/><path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A"/><path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0"/><path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0"/><path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D"/><path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D"/><path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E"/><path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E"/></svg>);
const FacebookLogo=()=>(<svg width="18" height="18" viewBox="0 0 24 24" style={{flexShrink:0}} fill="#1877F2"><path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.268h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/></svg>);

// --- ColorShiftOverlay --------------------------------------------------------
function ColorShiftOverlay({tick}) {
  const ph=(tick%60)/60;
  const hue=Math.round(ph*360);
  const sat=60+Math.sin(ph*Math.PI*2)*20;
  return <div style={{position:'absolute',inset:0,pointerEvents:'none',zIndex:91,
    background:`linear-gradient(135deg, hsla(${hue},${sat}%,50%,0.08), hsla(${(hue+120)%360},${sat}%,50%,0.05))`,
    transition:'background 0.3s'}}/>;
}

// --- PasswordStrength ---------------------------------------------------------
function PasswordStrength({password,borderC,textMut}) {
  const checks=[{ok:password.length>=8,label:'8+ characters'},{ok:/[A-Z]/.test(password),label:'Uppercase'},{ok:/[0-9]/.test(password),label:'Number'},{ok:/[^A-Za-z0-9]/.test(password),label:'Special char'}];
  const strength=checks.filter(c=>c.ok).length;
  const colors=['#ef4444','#f59e0b','#f59e0b','#10b981','#10b981'];
  return (
    <div style={{marginTop:2}}>
      <div style={{display:'flex',gap:4,marginBottom:6}}>{[0,1,2,3].map(i=><div key={i} style={{flex:1,height:3,borderRadius:2,background:i<strength?colors[strength]:borderC,transition:'background 0.2s'}}/>)}</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:'4px 10px'}}>{checks.map(c=><span key={c.label} style={{fontSize:10,color:c.ok?'#10b981':textMut}}>{c.ok?'✓':'○'} {c.label}</span>)}</div>
    </div>
  );
}

// --- AuthPage -----------------------------------------------------------------
function AuthPage({ onAuth, darkMode, setDarkMode }) {
  const isMobile=useIsMobile();
  const bg=darkMode?'#0f172a':'#eff6ff';
  const cardBg=darkMode?'#1e2433':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#2d3748':'#e2e8f0';
  const accent='#2563eb';

  const [mode,setMode]=useState('signin');
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [confirmPw,setConfirmPw]=useState('');
  const [name,setName]=useState('');
  const [code,setCode]=useState('');
  const [showPw,setShowPw]=useState(false);
  const [loading,setLoading]=useState(null);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');

  const REDIRECT_URI=encodeURIComponent(typeof window!=='undefined'?window.location.origin:'http://localhost:3000');
  const oauthURL=provider=>`https://${COGNITO_DOMAIN}/oauth2/authorize?client_id=${COGNITO_CLIENT_ID}&response_type=code&scope=openid+email+profile&redirect_uri=${REDIRECT_URI}&identity_provider=${provider}`;

  // Which social providers actually have credentials configured in Terraform
  // (see backend/cognito.tf) — empty until you've registered an app with a
  // provider and supplied its credentials via terraform.tfvars. Add a
  // provider's id here once it's genuinely wired up and its button appears
  // automatically; no other code changes needed. GitHub isn't an option at
  // all, in the list below or here — Cognito can't cleanly support it (see
  // the backend Terraform README for why), so it's left out entirely rather
  // than shipped half-working.
  const ENABLED_SOCIAL_PROVIDERS=[]; // e.g. ['google', 'slack'] once configured

  const validate=()=>{
    if(!email.includes('@'))return 'Please enter a valid email address.';
    if(mode==='signup'){
      if(!name.trim())return 'Please enter your full name.';
      if(password.length<8)return 'Password must be at least 8 characters.';
      if(!/[A-Z]/.test(password))return 'Password must include an uppercase letter.';
      if(!/[0-9]/.test(password))return 'Password must include a number.';
      if(password!==confirmPw)return 'Passwords do not match.';
    } else if(mode==='signin'&&!password)return 'Please enter your password.';
    return null;
  };

  const handleEmailAuth=async e=>{
    e.preventDefault();setError('');setSuccess('');
    const err=validate();if(err){setError(err);return;}
    setLoading('email');
    try{
      if(mode==='signup'){
        await apiRequest('/auth/signup',{method:'POST',auth:false,body:{email,password,displayName:name}});
        setMode('verify');
        setSuccess(`Verification code sent to ${email}`);
      } else {
        const data=await apiRequest('/auth/signin',{method:'POST',auth:false,body:{email,password}});
        tokenSet('accessToken',data.accessToken);
        tokenSet('idToken',data.idToken);
        tokenSet('refreshToken',data.refreshToken);
        const claims=decodeJwtPayload(data.idToken);
        onAuth({id:claims.sub,name:claims.name||email.split('@')[0],email:claims.email||email,provider:'email'});
      }
    }catch(err){
      setError(err.message||'Something went wrong. Please try again.');
    }finally{
      setLoading(null);
    }
  };

  const handleVerify=async e=>{
    e.preventDefault();setError('');setSuccess('');
    if(code.length<6){setError('Please enter the 6-digit code.');return;}
    setLoading('email');
    try{
      await apiRequest('/auth/confirm',{method:'POST',auth:false,body:{email,code}});
      // Confirming doesn't return tokens — sign in immediately after with the
      // same credentials the user already entered during signup.
      const data=await apiRequest('/auth/signin',{method:'POST',auth:false,body:{email,password}});
      tokenSet('accessToken',data.accessToken);
      tokenSet('idToken',data.idToken);
      tokenSet('refreshToken',data.refreshToken);
      const claims=decodeJwtPayload(data.idToken);
      onAuth({id:claims.sub,name:claims.name||name||email.split('@')[0],email:claims.email||email,provider:'email'});
    }catch(err){
      setError(err.message||'Incorrect or expired code. Please try again.');
    }finally{
      setLoading(null);
    }
  };

  const handleForgot=async e=>{
    e.preventDefault();setError('');setSuccess('');
    if(!email.includes('@')){setError('Please enter your email.');return;}
    setLoading('email');
    try{
      await apiRequest('/auth/forgot-password',{method:'POST',auth:false,body:{email}});
      setSuccess(`If an account exists for ${email}, a reset code has been sent.`);
    }catch(err){
      setError(err.message||'Something went wrong. Please try again.');
    }finally{
      setLoading(null);
    }
  };

  const handleOAuth=async provider=>{
    setLoading(provider);
    // Cognito's hosted OAuth flow is a full-page redirect, not an API call —
    // this only fires for providers actually present in ENABLED_SOCIAL_PROVIDERS,
    // since that's what controls whether their button renders at all.
    window.location.href=oauthURL(provider);
  };

  const field=(value,onChange,placeholder,type='text')=>(
    <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} type={type}
      style={{width:'100%',padding:'10px 14px',fontSize:13,borderRadius:9,border:`1.5px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,outline:'none',boxSizing:'border-box',fontFamily:'Inter,Arial,sans-serif',transition:'border-color 0.15s'}}
      onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=borderC}/>
  );

  const PROVIDERS=[
    {id:'google',   label:'Continue with Google',   Logo:GoogleLogo,           border:'#dadce0',                     bg:darkMode?'#1e293b':'#fff',   text:textC},
    {id:'slack',    label:'Continue with Slack',    Logo:SlackLogo,            border:'#611f69',                     bg:'#611f69',                   text:'#fff'},
    {id:'facebook', label:'Continue with Facebook', Logo:FacebookLogo,         border:'#1877F2',                     bg:'#1877F2',                   text:'#fff'},
  ].filter(p=>ENABLED_SOCIAL_PROVIDERS.includes(p.id));

  const isSignIn=mode==='signin',isSignUp=mode==='signup',isForgot=mode==='forgot',isVerify=mode==='verify';

  const Spinner=({color='#fff'})=><span style={{width:16,height:16,border:`2px solid ${color}40`,borderTopColor:color,borderRadius:'50%',display:'inline-block',animation:'spin 0.7s linear infinite'}}/>;

  return (
    <div style={{minHeight:'100vh',background:bg,display:'flex',flexDirection:'column',fontFamily:'Inter,Arial,sans-serif',color:textC}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'14px 24px',borderBottom:`1px solid ${borderC}`,background:cardBg}}>
        <span style={{fontSize:16,fontWeight:800,color:accent}}><CloudForgerWordmark size={26} dark={!darkMode}/></span>
        <button onClick={()=>setDarkMode(d=>!d)} style={{background:'none',border:`1px solid ${borderC}`,borderRadius:7,padding:'4px 10px',cursor:'pointer',color:textC,fontSize:14}}>
          {darkMode?'☀️':'🌙'}
        </button>
      </div>

      <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',padding:'2rem 1rem'}}>
        <div style={{width:'100%',maxWidth:420}}>
          <div style={{background:cardBg,border:`1px solid ${borderC}`,borderRadius:16,padding:isMobile?'1.5rem 1.25rem':'2rem 2rem 1.75rem',boxShadow:darkMode?'0 8px 32px rgba(0,0,0,0.4)':'0 4px 24px rgba(0,0,0,0.08)'}}>

            {/* Header */}
            <div style={{textAlign:'center',marginBottom:24}}>
              {/* Logo */}
              <div style={{display:'flex',justifyContent:'center',marginBottom:16}}>
                <CloudForgerLogo size={52}/>
              </div>
              <div style={{display:'inline-flex',alignItems:'center',gap:7,padding:'5px 12px',borderRadius:999,background:darkMode?'rgba(37,99,235,0.12)':'#dbeafe',border:`1px solid ${darkMode?'rgba(37,99,235,0.3)':'#93c5fd'}`,fontSize:11,fontWeight:700,color:darkMode?'#93c5fd':'#1d4ed8',marginBottom:14}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                Powered by AWS Cognito
              </div>
              <h1 style={{fontSize:22,fontWeight:800,color:textC,margin:'0 0 6px'}}>
                {isVerify?'Verify your email':isForgot?'Reset password':isSignUp?'Create your account':'Welcome back'}
              </h1>
              <p style={{fontSize:13,color:textMut,margin:0}}>
                {isVerify?`We sent a code to ${email}`:isForgot?'Enter your email to receive a reset link':isSignUp?'Start building AWS architecture diagrams':'Sign in to your CloudForger account'}
              </p>
            </div>

            {/* Banners */}
            {error&&<div style={{background:darkMode?'rgba(239,68,68,0.12)':'#fee2e2',border:`1px solid ${darkMode?'rgba(239,68,68,0.3)':'#fca5a5'}`,borderRadius:8,padding:'9px 12px',marginBottom:14,fontSize:12,color:darkMode?'#fca5a5':'#dc2626',display:'flex',alignItems:'flex-start',gap:7}}><span>⚠️</span>{error}</div>}
            {success&&<div style={{background:darkMode?'rgba(16,185,129,0.12)':'#d1fae5',border:`1px solid ${darkMode?'rgba(16,185,129,0.3)':'#6ee7b7'}`,borderRadius:8,padding:'9px 12px',marginBottom:14,fontSize:12,color:darkMode?'#6ee7b7':'#065f46',display:'flex',alignItems:'flex-start',gap:7}}><span>✅</span>{success}</div>}

            {/* OAuth — only rendered if at least one provider is actually configured */}
            {!isForgot&&!isVerify&&PROVIDERS.length>0&&(<>
              <div style={{display:'flex',flexDirection:'column',gap:9,marginBottom:18}}>
                {PROVIDERS.map(p=>(
                  <button key={p.id} onClick={()=>handleOAuth(p.id)} disabled={!!loading}
                    style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,padding:'10px 16px',borderRadius:9,border:`1.5px solid ${p.border}`,background:loading===p.id?(darkMode?'#374151':'#f3f4f6'):p.bg,color:p.text,cursor:loading?'not-allowed':'pointer',fontSize:13,fontWeight:600,opacity:loading&&loading!==p.id?0.5:1,transition:'opacity 0.15s'}}>
                    {loading===p.id?<Spinner color={p.text}/>:<p.Logo/>}
                    {loading===p.id?'Connecting…':p.label}
                  </button>
                ))}
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:18}}>
                <div style={{flex:1,height:1,background:borderC}}/><span style={{fontSize:11,color:textMut,whiteSpace:'nowrap'}}>or continue with email</span><div style={{flex:1,height:1,background:borderC}}/>
              </div>
            </>)}

            {/* Email form */}
            {!isVerify&&(
              <form onSubmit={isForgot?handleForgot:handleEmailAuth} style={{display:'flex',flexDirection:'column',gap:10}}>
                {isSignUp&&<div><label style={{fontSize:11,fontWeight:600,color:textMut,display:'block',marginBottom:4}}>Full name</label>{field(name,setName,'Alex Johnson')}</div>}
                <div><label style={{fontSize:11,fontWeight:600,color:textMut,display:'block',marginBottom:4}}>Email address</label>{field(email,setEmail,'you@company.com','email')}</div>
                {!isForgot&&(
                  <div>
                    <div style={{display:'flex',justifyContent:'space-between',marginBottom:4}}>
                      <label style={{fontSize:11,fontWeight:600,color:textMut}}>Password</label>
                      {isSignIn&&<button type="button" onClick={()=>{setMode('forgot');setError('');setSuccess('');}} style={{background:'none',border:'none',color:accent,cursor:'pointer',fontSize:11,fontWeight:600,padding:0}}>Forgot password?</button>}
                    </div>
                    <div style={{position:'relative'}}>
                      {field(password,setPassword,'••••••••',showPw?'text':'password')}
                      <button type="button" onClick={()=>setShowPw(s=>!s)} style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',cursor:'pointer',fontSize:12,color:textMut,padding:0}}>{showPw?'🙈':'👁️'}</button>
                    </div>
                  </div>
                )}
                {isSignUp&&<div><label style={{fontSize:11,fontWeight:600,color:textMut,display:'block',marginBottom:4}}>Confirm password</label>{field(confirmPw,setConfirmPw,'••••••••',showPw?'text':'password')}</div>}
                {isSignUp&&password.length>0&&<PasswordStrength password={password} borderC={borderC} textMut={textMut}/>}
                {isSignUp&&<p style={{fontSize:11,color:textMut,margin:'2px 0 0',lineHeight:1.5}}>By creating an account you agree to our <span style={{color:accent,cursor:'pointer'}}>Terms of Service</span> and <span style={{color:accent,cursor:'pointer'}}>Privacy Policy</span>.</p>}
                <button type="submit" disabled={!!loading} style={{marginTop:4,padding:'11px',borderRadius:9,border:'none',background:accent,color:'#fff',fontSize:14,fontWeight:700,cursor:loading?'not-allowed':'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8,opacity:loading&&loading!=='email'?0.6:1}}>
                  {loading==='email'?<><Spinner/> {isForgot?'Sending…':isSignUp?'Creating account…':'Signing in…'}</>:isForgot?'Send reset link':isSignUp?'Create account':'Sign in'}
                </button>
              </form>
            )}

            {/* Verify form */}
            {isVerify&&(
              <form onSubmit={handleVerify} style={{display:'flex',flexDirection:'column',gap:12}}>
                <div>
                  <label style={{fontSize:11,fontWeight:600,color:textMut,display:'block',marginBottom:4}}>Verification code</label>
                  <input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} placeholder="123456" maxLength={6} inputMode="numeric"
                    style={{width:'100%',padding:'12px 14px',fontSize:22,letterSpacing:8,textAlign:'center',borderRadius:9,border:`1.5px solid ${borderC}`,background:darkMode?'#0f172a':'#f8fafc',color:textC,outline:'none',boxSizing:'border-box',fontFamily:'monospace',fontWeight:700}}
                    onFocus={e=>e.target.style.borderColor=accent} onBlur={e=>e.target.style.borderColor=borderC}/>
                </div>
                <button type="submit" disabled={!!loading} style={{padding:'11px',borderRadius:9,border:'none',background:accent,color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',gap:8}}>
                  {loading==='email'?<><Spinner/> Verifying…</>:'Verify email'}
                </button>
                <button type="button" onClick={()=>{setSuccess('Resent! Check your inbox.');}} style={{background:'none',border:'none',color:accent,cursor:'pointer',fontSize:12,fontWeight:600}}>Resend code</button>
              </form>
            )}

            {/* Footer link */}
            <div style={{textAlign:'center',marginTop:18,fontSize:13,color:textMut}}>
              {isVerify||isForgot
                ?<button onClick={()=>{setMode('signin');setError('');setSuccess('');}} style={{background:'none',border:'none',color:accent,cursor:'pointer',fontSize:13,fontWeight:600}}>← Back to sign in</button>
                :isSignIn
                  ?<>Don't have an account? <button onClick={()=>{setMode('signup');setError('');setSuccess('');}} style={{background:'none',border:'none',color:accent,cursor:'pointer',fontSize:13,fontWeight:700,padding:0}}>Sign up free</button></>
                  :<>Already have an account? <button onClick={()=>{setMode('signin');setError('');setSuccess('');}} style={{background:'none',border:'none',color:accent,cursor:'pointer',fontSize:13,fontWeight:700,padding:0}}>Sign in</button></>
              }
            </div>
          </div>

          {/* Trust badges */}
          <div style={{textAlign:'center',marginTop:16,fontSize:11,color:textMut}}>
            <div style={{display:'flex',justifyContent:'center',gap:16,flexWrap:'wrap'}}>
              <span style={{display:'flex',alignItems:'center',gap:4}}>🔒 TLS encrypted</span>
              <span style={{display:'flex',alignItems:'center',gap:4}}>🛡️ SOC 2 compliant</span>
              <span style={{display:'flex',alignItems:'center',gap:4}}>☁️ AWS Cognito backed</span>
            </div>
          </div>
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// --- Root App -----------------------------------------------------------------
// --- On-screen error catcher (for testing on devices without dev tools) -------
class GlobalErrorBoundary extends React.Component {
  constructor(props){super(props);this.state={caught:null};}
  static getDerivedStateFromError(err){return{caught:err};}
  componentDidCatch(err,info){console.error('Render error caught:',err,info);}
  render(){
    if(this.state.caught){
      return(
        <div style={{position:'fixed',inset:0,background:'#7f1d1d',color:'#fff',padding:20,zIndex:99999,overflowY:'auto',fontFamily:'monospace'}}>
          <div style={{fontSize:18,fontWeight:900,marginBottom:12}}>⚠️ RENDER ERROR CAUGHT</div>
          <div style={{fontSize:13,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{String(this.state.caught?.message||this.state.caught)}</div>
          <div style={{fontSize:11,marginTop:12,opacity:0.7,whiteSpace:'pre-wrap'}}>{String(this.state.caught?.stack||'')}</div>
          <button onClick={()=>this.setState({caught:null})} style={{marginTop:16,padding:'8px 16px',background:'#fff',color:'#7f1d1d',border:'none',borderRadius:8,fontWeight:700}}>Dismiss</button>
        </div>
      );
    }
    return this.props.children;
  }
}
function GlobalRuntimeErrorBanner(){
  const [errs,setErrs]=useState([]);
  useEffect(()=>{
    const onErr=e=>setErrs(prev=>[...prev,'window.onerror: '+(e?.message||e)].slice(-5));
    const onRej=e=>setErrs(prev=>[...prev,'unhandledrejection: '+(e?.reason?.message||e?.reason||e)].slice(-5));
    window.addEventListener('error',onErr);
    window.addEventListener('unhandledrejection',onRej);
    return()=>{window.removeEventListener('error',onErr);window.removeEventListener('unhandledrejection',onRej);};
  },[]);
  if(!errs.length) return null;
  return(
    <div style={{position:'fixed',bottom:0,left:0,right:0,background:'#7f1d1d',color:'#fff',padding:12,zIndex:99999,fontFamily:'monospace',fontSize:11,maxHeight:'40vh',overflowY:'auto'}}>
      <div style={{fontWeight:900,marginBottom:6}}>⚠️ RUNTIME ERRORS CAUGHT (async/handlers)</div>
      {errs.map((e,i)=><div key={i} style={{marginBottom:4,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{e}</div>)}
      <button onClick={()=>setErrs([])} style={{marginTop:8,padding:'6px 12px',background:'#fff',color:'#7f1d1d',border:'none',borderRadius:6,fontWeight:700}}>Clear</button>
    </div>
  );
}

const App = () => {
  const isMobile=useIsMobile();
  const [darkMode,setDarkMode]=useState(false);
  const [user,setUser]=useState(null);
  const [page,setPage]=useState('feed');
  const [activeDiagram,setActiveDiagram]=useState(null);
  const [prevPage,setPrevPage]=useState('feed');
  const [activeUser,setActiveUser]=useState(null);
  const [appUserPlan,setAppUserPlan]=useState('free');
  // Library lives in App so it survives AwsDiagramBuilder unmount/remount on navigation
  const [library,setLibrary]=useState(()=>_readStorage());

  // Once a user is authenticated, fetch their real saved diagrams from the
  // backend and replace whatever was loaded from localStorage. Falls back to
  // leaving the local copy in place if the request fails (e.g. offline),
  // rather than wiping out what the user can already see.
  useEffect(()=>{
    if(!user?.id) return;
    let cancelled=false;
    apiRequest(`/users/${user.id}/diagrams`,{method:'GET',auth:false})
      .then(data=>{
        if(cancelled) return;
        const entries=(data.diagrams||[]).map(apiToLightEntry);
        setLibrary(entries);
      })
      .catch(err=>console.warn('Could not load diagrams from backend, keeping local copy:',err));
    return()=>{cancelled=true;};
  },[user?.id]);

  if(!user) return <AuthPage darkMode={darkMode} setDarkMode={setDarkMode} onAuth={u=>setUser(u)}/>;

  const bg=darkMode?'#111827':'#eff6ff';
  const cardBg=darkMode?'#1f2937':'#ffffff';
  const textC=darkMode?'#f1f5f9':'#1e293b';
  const textMut=darkMode?'#94a3b8':'#64748b';
  const borderC=darkMode?'#374151':'#e5e7eb';
  const accent=darkMode?'#67e8f9':'#2563eb';

  const goTo=p=>setPage(p);
  const goToDiagram=(diagram,fromPage)=>{setActiveDiagram(diagram);setPrevPage(fromPage||'feed');setPage('diagram');};
  const goBack=()=>goTo(prevPage);
  const goToBuilderWithDiagram=d=>{setActiveDiagram(d);goTo('builder');};
  const goToUserProfile=(feedUser)=>{setActiveUser(feedUser);setPrevPage(page);setPage('userprofile');};
  const activeNav=page==='diagram'?prevPage:page==='userprofile'?prevPage:page;

  const NAV=[
    {id:'builder',label:'Designer',action:()=>{setActiveDiagram(null);goTo('builder');}},
    {id:'feed',   label:'Feed',    action:()=>goTo('feed')},
    {id:'profile',label:isMobile?'Me':'My Profile',action:()=>goTo('profile')},
  ];

  const userInitials=(user.name||'U').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();

  return (
    <div style={{height:'100vh',display:'flex',flexDirection:'column',overflow:'hidden',background:bg,fontFamily:'Inter,Arial,sans-serif',color:textC}}>
      {/* Header */}
      <div style={{background:cardBg,borderBottom:`1px solid ${borderC}`,padding:`0 ${isMobile?'10px':'16px'}`,display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0,height:isMobile?48:46}}>
        <span onClick={()=>{setActiveDiagram(null);goTo('builder');}} style={{marginRight:isMobile?8:24,cursor:'pointer',display:'flex',alignItems:'center'}}>
          <CloudForgerWordmark size={isMobile?22:26} dark={!darkMode}/>
        </span>
        <nav style={{display:'flex',gap:2,flex:1}}>
          {NAV.map(n=>(
            <button key={n.id} onClick={n.action} style={{padding:`0 ${isMobile?'10px':'16px'}`,height:isMobile?48:46,border:'none',background:'transparent',cursor:'pointer',fontSize:isMobile?12:13,fontWeight:600,color:activeNav===n.id?accent:textMut,borderBottom:activeNav===n.id?`2px solid ${accent}`:'2px solid transparent',transition:'color 0.15s, border-color 0.15s'}}>
              {n.label}
            </button>
          ))}
          {page==='diagram'&&activeDiagram&&(
            <span style={{display:'flex',alignItems:'center',gap:6,marginLeft:6,fontSize:12,color:textMut}}>
              <span>/</span>
              <span style={{maxWidth:isMobile?100:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:textC,fontWeight:600}}>{activeDiagram.title}</span>
            </span>
          )}
        </nav>
        <div style={{display:'flex',alignItems:'center',gap:8,flexShrink:0}}>
          {!isMobile&&<button onClick={()=>setDarkMode(d=>!d)} style={{background:'none',border:`1px solid ${borderC}`,borderRadius:7,padding:'4px 10px',cursor:'pointer',color:textC,fontSize:14}}>{darkMode?'☀️':'🌙'}</button>}
          {/* User avatar + dropdown */}
          <div style={{position:'relative'}} className="umenu">
            <div style={{width:30,height:30,borderRadius:'50%',background:'rgba(37,99,235,0.15)',border:'2px solid rgba(37,99,235,0.3)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,color:accent,cursor:'pointer',userSelect:'none'}}>
              {userInitials}
            </div>
            <style>{`.umenu:hover .udrop{display:block!important}`}</style>
            <div className="udrop" style={{display:'none',position:'absolute',right:0,top:36,background:cardBg,border:`1px solid ${borderC}`,borderRadius:10,padding:8,minWidth:180,boxShadow:'0 4px 20px rgba(0,0,0,0.15)',zIndex:300}}>
              <div style={{padding:'6px 10px 10px',borderBottom:`1px solid ${borderC}`,marginBottom:6}}>
                <div style={{fontSize:13,fontWeight:700,color:textC}}>{user.name}</div>
                <div style={{fontSize:11,color:textMut}}>{user.email}</div>
                {user.provider!=='email'&&<div style={{fontSize:10,marginTop:3,color:accent,fontWeight:600}}>via {user.provider.charAt(0).toUpperCase()+user.provider.slice(1)}</div>}
              </div>
              {isMobile&&<button onClick={()=>setDarkMode(d=>!d)} style={{width:'100%',padding:'7px 10px',textAlign:'left',background:'none',border:'none',color:textC,cursor:'pointer',fontSize:12,fontWeight:600,borderRadius:6}}>
                {darkMode?'☀️ Light mode':'🌙 Dark mode'}
              </button>}
              <button onClick={()=>goTo('profile')} style={{width:'100%',padding:'7px 10px',textAlign:'left',background:'none',border:'none',color:textC,cursor:'pointer',fontSize:12,fontWeight:600,borderRadius:6}}
                onMouseOver={e=>e.currentTarget.style.background=darkMode?'#374151':'#f1f5f9'} onMouseOut={e=>e.currentTarget.style.background='none'}>
                👤 My Profile
              </button>
              <button onClick={()=>goTo('upgrade')} style={{width:'100%',padding:'7px 10px',textAlign:'left',background:'none',border:'none',cursor:'pointer',fontSize:12,fontWeight:700,borderRadius:6,color:'#6366f1'}}
                onMouseOver={e=>e.currentTarget.style.background=darkMode?'rgba(99,102,241,0.12)':'#ede9fe'} onMouseOut={e=>e.currentTarget.style.background='none'}>
                ⚡ Upgrade plan
              </button>
              <button onClick={()=>{
                  apiRequest('/auth/signout',{method:'POST'}).catch(()=>{}); // best-effort — token is invalidated server-side, but signing out locally shouldn't block on this
                  tokenClear();
                  setUser(null);
                }} style={{width:'100%',padding:'7px 10px',textAlign:'left',background:'none',border:'none',color:'#ef4444',cursor:'pointer',fontSize:12,fontWeight:600,borderRadius:6}}
                onMouseOver={e=>e.currentTarget.style.background=darkMode?'#374151':'#fee2e2'} onMouseOut={e=>e.currentTarget.style.background='none'}>
                🚪 Sign out
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Pages */}
      {page==='builder'&&<AwsDiagramBuilder darkMode={darkMode} setDarkMode={setDarkMode} initialDiagram={activeDiagram} userPlan={appUserPlan} library={library} setLibrary={setLibrary}/>}
      {page==='feed'&&<NewsfeedPage darkMode={darkMode} onViewDiagram={d=>goToDiagram(d,'feed')} onViewProfile={goToUserProfile} library={library}/>}
      {page==='profile'&&<ProfilePage darkMode={darkMode} onViewDiagram={d=>goToDiagram(d,'profile')} onUpgrade={()=>goTo('upgrade')} userPlan={appUserPlan}/>}
      {page==='upgrade'&&(
        <div style={{flex:1,overflowY:'auto',background:bg,display:'flex',alignItems:'flex-start',justifyContent:'center',padding:'24px 16px'}}>
          <div style={{width:'100%',maxWidth:680}}>
            <div style={{marginBottom:20}}>
              <button onClick={()=>goTo(prevPage)} style={{background:'none',border:`1px solid ${borderC}`,borderRadius:8,padding:'6px 14px',cursor:'pointer',color:textC,fontSize:12,fontWeight:600}}>← Back</button>
            </div>
            {/* Reuse UpgradeModal content inline */}
            <UpgradeModal darkMode={darkMode} userPlan={appUserPlan}
              onClose={()=>goTo(prevPage)}
              onUpgrade={(planId,billing)=>{
                alert('Redirecting to Stripe checkout for '+planId+' ('+billing+')…');
              }}
              inline/>
          </div>
        </div>
      )}
      {page==='userprofile'&&activeUser&&<UserProfilePage feedUser={activeUser} darkMode={darkMode} onBack={()=>goTo(prevPage)} onViewDiagram={d=>goToDiagram(d,'userprofile')} onViewProfile={goToUserProfile}/>}
      {page==='diagram'&&activeDiagram&&<DiagramViewPage diagram={activeDiagram} darkMode={darkMode} onBack={goBack} onEdit={()=>goToBuilderWithDiagram(activeDiagram)} library={library} setLibrary={setLibrary}/>}
    </div>
  );
};

function AppWithErrorCatching(){
  return(
    <GlobalErrorBoundary>
      <GlobalRuntimeErrorBanner/>
      <App/>
    </GlobalErrorBoundary>
  );
}
export default AppWithErrorCatching;
