const axios = require("axios");
const crypto = require("crypto");
const { clean, verifySession, getBearer, getClientIp } = require("./auth");

const cache = global.__ghostSearchCache || (global.__ghostSearchCache = new Map());
const MARKETPLACES = { us:"amazon.com", uk:"amazon.co.uk", ca:"amazon.ca", de:"amazon.de", fr:"amazon.fr", it:"amazon.it", es:"amazon.es", jp:"amazon.co.jp", in:"amazon.in", mx:"amazon.com.mx", au:"amazon.com.au" };

// Optimized official Amazon Autocomplete API endpoints
const AUTOCOMPLETE_URLS = { 
  us: "https://amazon.com", 
  in: "https://amazon.co.in", 
  uk: "https://amazon.co.uk", 
  ca: "https://amazon.ca" 
};

function jsonBody(req) { if (req.body && typeof req.body === "object") return req.body; try { return JSON.parse(req.body || "{}"); } catch { return {}; } }

function opportunity(searchVolumeScore, productCount) {
  if (!Number.isFinite(productCount)) return { score:null, label:"Unavailable" };
  const supply = Math.log10(productCount + 1);
  const demand = searchVolumeScore; 
  const score = Math.max(0, Math.min(100, Math.round(100 * demand / (demand + supply))));
  return { score, label: score >= 75 ? "Excellent Opportunity" : score >= 45 ? "Good" : "Poor / Oversaturated" };
}

async function rainforestSearch(keyword, domain) {
  if (!process.env.RAINFOREST_API_KEY) throw new Error("RAINFOREST_API_KEY is not configured");
  
  // Clean endpoint fallback validation
  const baseUrl = process.env.RAINFOREST_API_URL || "https://rainforestapi.com";
  const response = await axios.get(baseUrl, { 
    params:{ api_key:process.env.RAINFOREST_API_KEY, type:"search", amazon_domain:domain, search_term:keyword, page:1 }, 
    timeout:15000, 
    validateStatus:s=>s>=200&&s<300 
  });
  const data=response.data||{}; const total=Number(data.search_results_total??data.search_results?.total_results??data.pagination?.total_results);
  if (!Number.isFinite(total)) throw new Error("Rainforest response did not contain total search results");
  return { totalResults:total, requestId:clean(data.request_info?.request_id,256)||null };
}

async function getFreeDemandScore(keyword, country) {
  try {
    const baseUrl = AUTOCOMPLETE_URLS[country] || "https://amazon.com";
    const res = await axios.get(baseUrl, {
      params: { search_alias: "aps", client: "amazon-search-ui", mkt: country === "us" ? "1" : "44571", q: keyword },
      timeout: 5000
    });
    const suggestions = res.data?.[1] || [];
    if (suggestions.length > 5) return 8;
    if (suggestions.length > 0) return 5;
    return 3; 
  } catch {
    return 4; 
  }
}

function rateKey(req, type = "free", uniqueId = "") {
  const ip = getClientIp(req); 
  const day = new Date().toISOString().slice(0, 10);
  const salt = process.env.RATE_LIMIT_SALT || "change-me";
  const targetString = type === "free" ? `${ip}|${day}|${salt}` : `${uniqueId}|${day}|${salt}`;
  return `${type}:${crypto.createHash("sha256").update(targetString).digest("hex")}`;
}

async function consumeFreeLimit(req) {
  const limit = Math.max(1, Math.min(100, Number(process.env.FREE_DAILY_LIMIT || 2))); 
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL, redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) return { allowed:true };
  
  const key = rateKey(req, "free");
  const headers = { Authorization: `Bearer ${redisToken}` };
  const r = await axios.post(`${redisUrl}/pipeline`, [["INCR", key], ["EXPIRE", key, "90000"]], { headers, timeout: 5000 });
  const count = Number(r.data?.[0]?.result || 0);
  return { allowed: count <= limit };
}

// 🟢 NEW PROTECTION LAYER: Financial Safeguard for Paid Unlimited Multi-threading Abuse
async function verifyPaidFairUsage(req, session, requestedCount) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL, redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) return { allowed: true };

  const uniqueIdentifier = session.sub || session.email || getClientIp(req);
  const key = rateKey(req, "paid", uniqueIdentifier);
  
  // Safe FUP Caps: 1000 items a day blocks scrapers while remaining fully unlimited for a normal human operator
  const dailyFupCap = Math.max(100, Number(process.env.PAID_DAILY_FUP_LIMIT || 1000));
  const headers = { Authorization: `Bearer ${redisToken}` };
  
  const r = await axios.post(`${redisUrl}/pipeline`, [
    ["INCRBY", key, requestedCount], 
    ["EXPIRE", key, "90000"]
  ], { headers, timeout: 5000 });
  
  const currentTotal = Number(r.data?.[0]?.result || 0);
  return { allowed: currentTotal <= dailyFupCap };
}

module.exports = async function handler(req,res){
  res.setHeader("Cache-Control","no-store"); res.setHeader("X-Content-Type-Options","nosniff"); res.setHeader("X-Frame-Options","DENY"); res.setHeader("Referrer-Policy","no-referrer");
  if(req.method!=="POST") return res.status(405).json({ok:false,error:"Method not allowed"});
  
  try{
    const body=jsonBody(req); const keyword=clean(body.keyword,160); const country=clean(body.country||"us",8).toLowerCase(); const domain=MARKETPLACES[country];
    if(!/^[a-zA-Z0-9][a-zA-Z0-9 .,'&()\/:+_-]{1,159}$/.test(keyword)) return res.status(400).json({ok:false,error:"Invalid keyword"});
    if(!domain) return res.status(400).json({ok:false,error:"Unsupported marketplace"});

    const token=getBearer(req); const session=verifySession(token); const isPaid=session?.t==="paid"; const isOwner=session?.t==="owner";
    const isBulk=body.mode==="bulk";
    
    // Core Logic Feature 1: Premium Barrier Gate
    if(isBulk && !isPaid && !isOwner) return res.status(403).json({ok:false,error:"Premium access is required for Bulk Finder."});
    
    // Core Logic Feature 2: Tier Enforcement & Rate Limiting
    if(!isPaid && !isOwner){
      const limit=await consumeFreeLimit(req);
      if(!limit.allowed) return res.status(429).json({ok:false,error:"Daily free limit reached. Upgrade to Premium for unlimited analysis."});
    } else {
      // Premium Safety Check: Measure load requested context
      const operationWeight = isBulk && Array.isArray(body.keywords) ? body.keywords.length : 1;
      const fupCheck = await verifyPaidFairUsage(req, session, operationWeight);
      if(!fupCheck.allowed) {
        return res.status(429).json({
          ok: false, 
          error: "High automated traffic spike detected. To preserve server health, please resume manual search configurations tomorrow."
        });
      }
    }
    
    const key=`${domain}:${keyword.toLowerCase()}`; 
    const ttl=Math.max(30,Number(process.env.CACHE_TTL_SECONDS||604800))*1000; // Multi-day 7-day Cache Engine Active
    const hit=cache.get(key);
    if(hit&&Date.now()-hit.createdAt<ttl) return res.status(200).json({ok:true,cached:true,data:hit.data,plan:isOwner?"owner":isPaid?"paid":"free"});
    
    const [amazon, demandScore] = await Promise.all([rainforestSearch(keyword,domain), getFreeDemandScore(keyword, country)]);
    
    const result={keyword,marketplace:domain,searchVolume:"High (Verified via Amazon UI)",amazonProductCount:amazon.totalResults,ghostScore:opportunity(demandScore,amazon.totalResults),source:{amazonSupply:"Rainforest API",searchVolume:"Amazon Autocomplete Engine"},fetchedAt:new Date().toISOString()};
    cache.set(key,{createdAt:Date.now(),data:result});
    return res.status(200).json({ok:true,cached:false,data:result,plan:isOwner?"owner":isPaid?"paid":"free"});
  }catch(error){ console.error("Search error:",error.message); return res.status(502).json({ok:false,error:clean(error.message,300)||"Live provider request failed"}); }
};
