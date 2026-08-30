const axios = require("axios");
const crypto = require("crypto");

const cache = global.__ghostSearchCache || (global.__ghostSearchCache = new Map());
const licenses = global.__ghostLicenses || (global.__ghostLicenses = new Map());

const MARKETPLACES = {
  us: "amazon.com",
  uk: "amazon.co.uk",
  ca: "amazon.ca",
  de: "amazon.de",
  fr: "amazon.fr",
  it: "amazon.it",
  es: "amazon.es",
  jp: "amazon.co.jp",
  in: "amazon.in",
  mx: "amazon.com.mx",
  au: "amazon.com.au"
};

function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

function jsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

function verifyToken(token) {
  if (!token || !process.env.LICENSE_SIGNING_SECRET) return null;
  try {
    const data = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!data.e || !data.s || !data.x || !data.h || Date.now() > Number(data.x)) return null;

    const licensesByKey = licenses;
    for (const [licenseKey, record] of licensesByKey.entries()) {
      if (!record.active || record.token !== token) continue;
      const payload = `${data.e}.${data.s}.${licenseKey}.${data.x}`;
      const expected = crypto.createHmac("sha256", process.env.LICENSE_SIGNING_SECRET)
        .update(payload).digest("hex");
      const a = Buffer.from(expected, "hex");
      const b = Buffer.from(data.h, "hex");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return data;
    }
  } catch {}
  return null;
}

function cacheKey(keyword, domain) {
  return `${domain}:${keyword.toLowerCase()}`;
}

function opportunity(searchVolume, productCount) {
  if (!Number.isFinite(searchVolume) || !Number.isFinite(productCount)) {
    return { score: null, label: "Unavailable" };
  }
  const supply = Math.log10(productCount + 1);
  const demand = Math.log10(searchVolume + 1);
  const raw = 100 * (demand / (demand + supply));
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return {
    score,
    label: score >= 80 ? "Excellent Opportunity" : score >= 50 ? "Good" : "Poor / Oversaturated"
  };
}

async function rainforestSearch(keyword, domain) {
  if (!process.env.RAINFOREST_API_KEY) throw new Error("RAINFOREST_API_KEY is not configured");

  const response = await axios.get("https://api.rainforestapi.com/request", {
    params: {
      api_key: process.env.RAINFOREST_API_KEY,
      type: "search",
      amazon_domain: domain,
      search_term: keyword,
      page: 1
    },
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 300
  });

  const data = response.data || {};
  const total = Number(
    data.search_results_total ??
    data.search_results?.total_results ??
    data.pagination?.total_results
  );

  if (!Number.isFinite(total)) throw new Error("Rainforest response did not contain total search results");

  return {
    totalResults: total,
    requestId: clean(data.request_info?.request_id, 256) || null
  };
}

async function searchVolumeEstimate(keyword, domain) {
  const url = process.env.SEARCH_VOLUME_API_URL;
  const key = process.env.SEARCH_VOLUME_API_KEY;

  if (!url || !key) {
    throw new Error("A real search-volume provider is required: set SEARCH_VOLUME_API_URL and SEARCH_VOLUME_API_KEY");
  }

  const response = await axios.post(url, {
    keyword,
    marketplace: domain
  }, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    timeout: 15000
  });

  const volume = Number(
    response.data?.search_volume ??
    response.data?.monthly_search_volume ??
    response.data?.volume
  );

  if (!Number.isFinite(volume) || volume < 0) {
    throw new Error("Search-volume provider returned no valid search volume");
  }

  return Math.round(volume);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const body = jsonBody(req);
    const token = clean(req.headers.authorization?.replace(/^Bearer\s+/i, ""), 4096);
    if (!verifyToken(token)) return res.status(401).json({ ok: false, error: "Valid premium access token required" });

    const keyword = clean(body.keyword, 160);
    const country = clean(body.country || "us", 8).toLowerCase();
    const domain = MARKETPLACES[country];

    if (!/^[a-zA-Z0-9][a-zA-Z0-9 .,'&()\/:+_-]{1,159}$/.test(keyword)) {
      return res.status(400).json({ ok: false, error: "Invalid keyword" });
    }
    if (!domain) return res.status(400).json({ ok: false, error: "Unsupported marketplace" });

    const key = cacheKey(keyword, domain);
    const ttl = Math.max(30, Number(process.env.CACHE_TTL_SECONDS || 900)) * 1000;
    const hit = cache.get(key);

    if (hit && Date.now() - hit.createdAt < ttl) {
      return res.status(200).json({ ok: true, cached: true, data: hit.data });
    }

    const [amazon, volume] = await Promise.all([
      rainforestSearch(keyword, domain),
      searchVolumeEstimate(keyword, domain)
    ]);

    const result = {
      keyword,
      marketplace: domain,
      searchVolume: volume,
      amazonProductCount: amazon.totalResults,
      ghostScore: opportunity(volume, amazon.totalResults),
      source: {
        amazonSupply: "Rainforest API",
        searchVolume: "Configured live search-volume provider"
      },
      fetchedAt: new Date().toISOString()
    };

    cache.set(key, { createdAt: Date.now(), data: result });

    return res.status(200).json({ ok: true, cached: false, data: result });
  } catch (error) {
    console.error("Search error:", error.response?.data || error.message);
    return res.status(502).json({ ok: false, error: clean(error.message, 300) || "Live provider request failed" });
  }
};
