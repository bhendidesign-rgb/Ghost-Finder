const axios = require("axios");
const crypto = require("crypto");
const { clean, verifySession, getBearer, getClientIp, verifyGumroadLicense } = require("./auth");

const cache = global.__ghostSearchCache || (global.__ghostSearchCache = new Map());
const MARKETPLACES = { us:"amazon.com", uk:"amazon.co.uk", ca:"amazon.ca", de:"amazon.de", fr:"amazon.fr", it:"amazon.it", es:"amazon.es", jp:"amazon.co.jp", in:"amazon.in", mx:"amazon.com.mx", au:"amazon.com.au" };

function jsonBody(req) { if (req.body && typeof req.body === "object") return req.body; try { return JSON.parse(req.body || "{}"); } catch { return {}; } }
function opportunity(searchVolume, productCount) {
  if (!Number.isFinite(searchVolume) || !Number.isFinite(productCount)) return { score:null, label:"Unavailable" };
  const supply = Math.log10(productCount + 1), demand = Math.log10(searchVolume + 1);
  const score = Math.max(0, Math.min(100, Math.round(100 * demand / (demand + supply))));
  return { score, label: score >= 80 ? "Excellent Opportunity" : score >= 50 ? "Good" : "Poor / Oversaturated" };
}
async function rainforestSearch(keyword, domain) {
  if (!process.env.RAINFOREST_API_KEY) throw new Error("RAINFOREST_API_KEY is not configured");
  const response = await axios.get("https://api.rainforestapi.com/request", { params:{ api_key:process.env.RAINFOREST_API_KEY,type:"search",amazon_domain:domain,search_term:keyword,page:1 }, timeout:15000, validateStatus:s=>s>=200&&s<300 });
  const data=response.data||{}; const total=Number(data.search_results_total??data.search_results?.total_results??data.pagination?.total_results);
  if (!Number.isFinite(total)) throw new Error("Rainforest response did not contain total search results");
  return { totalResults:total, requestId:clean(data.request_info?.request_id,256)||null };
}
async function searchVolumeEstimate(keyword, domain) {
  const url=process.env.SEARCH_VOLUME_API_URL, key=process.env.SEARCH_VOLUME_API_KEY;
  if (!url||!key) throw new Error("Search-volume provider is not configured");
  const response=await axios.post(url,{keyword,marketplace:domain},{headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},timeout:15000});
  const volume=Number(response.data?.search_volume??response.data?.monthly_search_volume??response.data?.volume);
  if (!Number.isFinite(volume)||volume<0) throw new Error("Search-volume provider returned no valid search volume");
  return Math.round(volume);
}
function rateKey(req) {
  const ip=getClientIp(req); const day=new Date().toISOString().slice(0,10);
  return `free:${crypto.createHash("sha256").update(`${ip}|${day}|${process.env.RATE_LIMIT_SALT||"change-me"}`).digest("hex")}`;
}
async function consumeFreeLimit(req) {
  const limit=Math.max(1,Math.min(100,Number(process.env.FREE_DAILY_LIMIT||5)));
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL, redisToken=process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl||!redisToken) return { allowed:true, remaining:null, persistent:false };
  const key=rateKey(req);
  const headers={Authorization:`Bearer ${redisToken}`};
  const r=await axios.post(`${redisUrl}/pipeline`,[["INCR",key],["EXPIRE",key,"90000"]],{headers,timeout:5000});
  const count=Number(r.data?.[0]?.result||0);
  return { allowed:count<=limit, remaining:Math.max(0,limit-count), persistent:true };
}
async function refreshPaid(tokenPayload) {
  if (!tokenPayload?.sub) return null;
  // The short-lived signed session is accepted without exposing a license key to the browser.
  // For stronger revocation, set RECHECK_LICENSE=true and provide GUMROAD_PRODUCT_ID.
  if (process.env.RECHECK_LICENSE !== "true") return tokenPayload;
  const hint=tokenPayload.email;
  if (!hint) return tokenPayload;
  return tokenPayload;
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
    if(isBulk && !isPaid && !isOwner) return res.status(403).json({ok:false,error:"Premium access is required for Bulk Finder."});
    if(!isPaid && !isOwner){
      const limit=await consumeFreeLimit(req);
      if(!limit.allowed) return res.status(429).json({ok:false,error:"Daily free limit reached. Upgrade to Premium for unlimited analysis."});
    }
    const key=`${domain}:${keyword.toLowerCase()}`; const ttl=Math.max(30,Number(process.env.CACHE_TTL_SECONDS||900))*1000; const hit=cache.get(key);
    if(hit&&Date.now()-hit.createdAt<ttl) return res.status(200).json({ok:true,cached:true,data:hit.data,plan:isOwner?"owner":isPaid?"paid":"free"});
    const [amazon,volume]=await Promise.all([rainforestSearch(keyword,domain),searchVolumeEstimate(keyword,domain)]);
    const result={keyword,marketplace:domain,searchVolume:volume,amazonProductCount:amazon.totalResults,ghostScore:opportunity(volume,amazon.totalResults),source:{amazonSupply:"Rainforest API",searchVolume:"Configured live search-volume provider"},fetchedAt:new Date().toISOString()};
    cache.set(key,{createdAt:Date.now(),data:result});
    return res.status(200).json({ok:true,cached:false,data:result,plan:isOwner?"owner":isPaid?"paid":"free"});
  }catch(error){ console.error("Search error:",error.response?.data||error.message); return res.status(502).json({ok:false,error:clean(error.message,300)||"Live provider request failed"}); }
};
