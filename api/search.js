const axios = require("axios");
const crypto = require("crypto");
const {
  clean,
  verifySession,
  getBearer,
  getClientIp
} = require("./auth");

/*
 * Ghost Product Finder
 * --------------------
 * Search Volume API removed.
 *
 * Data source:
 * - Rainforest API -> Amazon live search/product count
 *
 * Ghost Score:
 * - Supply/competition based estimate
 * - It is NOT monthly search volume
 */

const cache =
  global.__ghostSearchCache ||
  (global.__ghostSearchCache = new Map());

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

/* -----------------------------
   Request body parser
----------------------------- */

function jsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

/* -----------------------------
   Keyword validation
----------------------------- */

function isValidKeyword(keyword) {
  if (typeof keyword !== "string") {
    return false;
  }

  return /^[a-zA-Z0-9][a-zA-Z0-9 .,'&()\/:+_-]{1,159}$/.test(
    keyword
  );
}

/* -----------------------------
   Ghost Score
   Supply/competition based
----------------------------- */

function opportunity(productCount) {
  if (!Number.isFinite(productCount) || productCount < 0) {
    return {
      score: null,
      label: "Unavailable",
      basis: "Amazon competition data unavailable"
    };
  }

  /*
   * Lower product count = less competition = higher opportunity.
   *
   * This is intentionally NOT called search volume.
   * It is only a supply/competition estimate.
   */

  let score;

  if (productCount <= 100) {
    score = 95;
  } else if (productCount <= 500) {
    score = 90;
  } else if (productCount <= 1000) {
    score = 85;
  } else if (productCount <= 2500) {
    score = 78;
  } else if (productCount <= 5000) {
    score = 70;
  } else if (productCount <= 10000) {
    score = 60;
  } else if (productCount <= 25000) {
    score = 50;
  } else if (productCount <= 50000) {
    score = 40;
  } else if (productCount <= 100000) {
    score = 30;
  } else {
    score = 20;
  }

  let label;

  if (score >= 80) {
    label = "Low Competition";
  } else if (score >= 60) {
    label = "Moderate Competition";
  } else if (score >= 40) {
    label = "High Competition";
  } else {
    label = "Very High Competition";
  }

  return {
    score,
    label,
    basis: "Amazon product-count competition estimate"
  };
}

/* -----------------------------
   Rainforest Amazon Search
----------------------------- */

async function rainforestSearch(keyword, domain) {
  const apiKey = process.env.RAINFOREST_API_KEY;

  if (!apiKey) {
    throw new Error(
      "RAINFOREST_API_KEY is not configured"
    );
  }

  const baseUrl =
    process.env.RAINFOREST_API_URL ||
    "https://api.rainforestapi.com/request";

  const response = await axios.get(baseUrl, {
    params: {
      api_key: apiKey,
      type: "search",
      amazon_domain: domain,
      search_term: keyword,
      page: 1
    },

    timeout: 15000,

    validateStatus: (status) =>
      status >= 200 && status < 300
  });

  const data = response.data || {};

  /*
   * Rainforest responses can expose the total in
   * different locations depending on response/version.
   */

  const total = Number(
  data.search_results_total ??
  data.search_information?.total_results ??
  data.search_results?.total_results ??
  data.pagination?.total_results ??
  data.pagination?.total_results_count
);

  if (!Number.isFinite(total)) {
    const providerMessage =
      data.request_info?.message ||
      data.error ||
      data.message;

    if (providerMessage) {
      throw new Error(
        `Rainforest API: ${clean(providerMessage, 250)}`
      );
    }

    throw new Error(
      "Rainforest response did not contain total search results"
    );
  }

  return {
    totalResults: Math.max(0, Math.round(total)),
    requestId:
      clean(
        data.request_info?.request_id,
        256
      ) || null
  };
}

/* -----------------------------
   Rate-limit key
----------------------------- */

function rateKey(req) {
  const ip = getClientIp(req);

  const day = new Date()
    .toISOString()
    .slice(0, 10);

  const salt =
    process.env.RATE_LIMIT_SALT ||
    "change-me";

  const value =
    `${ip}|${day}|${salt}`;

  return (
    "free:" +
    crypto
      .createHash("sha256")
      .update(value)
      .digest("hex")
  );
}

/* -----------------------------
   Free daily limit
----------------------------- */

async function consumeFreeLimit(req) {
  const configuredLimit = Number(
    process.env.FREE_DAILY_LIMIT || 5
  );

  const limit = Math.max(
    1,
    Math.min(100, configuredLimit)
  );

  const redisUrl =
    process.env.UPSTASH_REDIS_REST_URL;

  const redisToken =
    process.env.UPSTASH_REDIS_REST_TOKEN;

  /*
   * If Redis is not configured,
   * the API remains functional.
   *
   * Persistent daily limiting requires
   * Upstash Redis environment variables.
   */

  if (!redisUrl || !redisToken) {
    return {
      allowed: true,
      remaining: null,
      persistent: false
    };
  }

  const key = rateKey(req);

  const headers = {
    Authorization: `Bearer ${redisToken}`,
    "Content-Type": "application/json"
  };

  const response = await axios.post(
    `${redisUrl}/pipeline`,
    [
      ["INCR", key],
      ["EXPIRE", key, 90000]
    ],
    {
      headers,
      timeout: 5000
    }
  );

  const count = Number(
    response.data?.[0]?.result || 0
  );

  return {
    allowed: count <= limit,
    remaining: Math.max(
      0,
      limit - count
    ),
    persistent: true
  };
}

/* -----------------------------
   Cache helpers
----------------------------- */

function getCacheTTL() {
  const configured =
    Number(
      process.env.CACHE_TTL_SECONDS || 900
    );

  return (
    Math.max(30, configured) * 1000
  );
}

function getCacheKey(domain, keyword) {
  return (
    `${domain}:${keyword.toLowerCase()}`
  );
}

/* -----------------------------
   Main API handler
----------------------------- */

module.exports = async function handler(
  req,
  res
) {
  /*
   * Security headers
   */

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );

  res.setHeader(
    "X-Frame-Options",
    "DENY"
  );

  res.setHeader(
    "Referrer-Policy",
    "no-referrer"
  );

  /*
   * Only POST allowed
   */

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = jsonBody(req);

    /*
     * Country / marketplace
     */

    const country = clean(
      body.country || "us",
      8
    ).toLowerCase();

    const domain =
      MARKETPLACES[country];

    if (!domain) {
      return res.status(400).json({
        ok: false,
        error: "Unsupported marketplace"
      });
    }

    /*
     * Authentication
     */

    const token = getBearer(req);

    let session = null;

    try {
      session = verifySession(token);
    } catch {
      session = null;
    }

    const isPaid =
      session?.t === "paid";

    const isOwner =
      session?.t === "owner";

    /*
     * Bulk mode
     *
     * Premium-only gate.
     */

    const isBulk =
      body.mode === "bulk";

    if (
      isBulk &&
      !isPaid &&
      !isOwner
    ) {
      return res.status(403).json({
        ok: false,
        error:
          "Premium access is required for Bulk Finder."
      });
    }

    /*
     * Free user rate limit
     */

    if (!isPaid && !isOwner) {
      const limit =
        await consumeFreeLimit(req);

      if (!limit.allowed) {
        return res.status(429).json({
          ok: false,
          error:
            "Daily free limit reached. Upgrade to Premium for more analysis."
        });
      }
    }

    /*
     * This endpoint performs one live
     * keyword search per request.
     */

    const keyword = clean(
      body.keyword,
      160
    );

    if (!isValidKeyword(keyword)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid keyword"
      });
    }

    /*
     * Cache
     */

    const cacheKey =
      getCacheKey(
        domain,
        keyword
      );

    const ttl = getCacheTTL();

    const cached =
      cache.get(cacheKey);

    if (
      cached &&
      Date.now() - cached.createdAt < ttl
    ) {
      return res.status(200).json({
        ok: true,
        cached: true,
        data: cached.data,
        plan: isOwner
          ? "owner"
          : isPaid
            ? "paid"
            : "free"
      });
    }

    /*
     * Live Amazon search through Rainforest
     */

    const amazon =
      await rainforestSearch(
        keyword,
        domain
      );

    /*
     * Competition-based Ghost Score
     */

    const ghostScore =
      opportunity(
        amazon.totalResults
      );

    /*
     * IMPORTANT:
     * There is deliberately NO fake
     * monthly search volume here.
     */

    const result = {
      keyword,

      marketplace: domain,

      /*
       * Search volume is unavailable because
       * Search Volume API has been removed.
       */
      searchVolume: null,

      searchVolumeStatus:
        "Not available",

      /*
       * Actual Rainforest Amazon result count.
       */
      amazonProductCount:
        amazon.totalResults,

      /*
       * Competition/opportunity estimate.
       */
      ghostScore,

      source: {
        amazonSupply:
          "Rainforest API",
        searchVolume:
          "Not configured"
      },

      fetchedAt:
        new Date().toISOString()
    };

    /*
     * Save cache
     */

    cache.set(
      cacheKey,
      {
        createdAt: Date.now(),
        data: result
      }
    );

    /*
     * Successful response
     */

    return res.status(200).json({
      ok: true,
      cached: false,
      data: result,

      plan: isOwner
        ? "owner"
        : isPaid
          ? "paid"
          : "free"
    });

  } catch (error) {
    /*
     * Never expose API keys/secrets.
     */

    console.error(
      "Search error:",
      error.response?.data ||
      error.message
    );

    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      error.message ||
      "Live provider request failed";

    return res.status(502).json({
      ok: false,
      error: clean(
        String(message),
        300
      )
    });
  }
};
