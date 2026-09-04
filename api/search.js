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
 *
 * ACCESS:
 * Free:
 *   - 2 single keywords/day
 *   - 5-day free trial
 *
 * Paid:
 *   - 20 single keywords/day
 *   - 50 bulk keywords/day
 *
 * Owner:
 *   - Unlimited
 *
 * CACHE:
 *   - Shared across ALL users
 *   - Same marketplace + keyword
 *   - 10 days
 *
 * DATA:
 *   - Rainforest API
 *   - Amazon live search/product count
 *
 * SEARCH VOLUME:
 *   - Not configured
 *   - No fake search volume
 */

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

/*
 * Daily limits
 */

const FREE_DAILY_LIMIT = 2;
const PAID_SINGLE_DAILY_LIMIT = 20;
const PAID_BULK_DAILY_LIMIT = 50;

/*
 * Free trial
 */

const FREE_TRIAL_DAYS = 5;
const FREE_TRIAL_SECONDS =
  FREE_TRIAL_DAYS * 86400;

/*
 * Shared Rainforest cache
 *
 * 10 days = 864000 seconds
 */

const SHARED_CACHE_SECONDS = 864000;

/*
 * Local fallback cache.
 *
 * This is only a performance optimization.
 * The real shared cache is Redis.
 */

const localCache =
  global.__ghostSearchLocalCache ||
  (global.__ghostSearchLocalCache = new Map());

/* --------------------------------
   Request body parser
-------------------------------- */

function jsonBody(req) {
  if (
    req.body &&
    typeof req.body === "object"
  ) {
    return req.body;
  }

  try {
    return JSON.parse(
      req.body || "{}"
    );
  } catch {
    return {};
  }
}

/* --------------------------------
   Keyword validation
-------------------------------- */

function isValidKeyword(keyword) {
  if (
    typeof keyword !== "string"
  ) {
    return false;
  }

  return /^[a-zA-Z0-9][a-zA-Z0-9 .,'&()\/:+_-]{1,159}$/.test(
    keyword
  );
}

/* --------------------------------
   Ghost Score
-------------------------------- */

function opportunity(productCount) {
  if (
    !Number.isFinite(productCount) ||
    productCount < 0
  ) {
    return {
      score: null,
      label: "Unavailable",
      basis:
        "Amazon competition data unavailable"
    };
  }

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
    basis:
      "Amazon product-count competition estimate"
  };
}

/* --------------------------------
   Redis configuration
-------------------------------- */

function redisConfigured() {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}

/* --------------------------------
   Redis pipeline
-------------------------------- */

async function redisPipeline(
  commands
) {
  const redisUrl =
    process.env.UPSTASH_REDIS_REST_URL;

  const redisToken =
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (
    !redisUrl ||
    !redisToken
  ) {
    throw new Error(
      "Upstash Redis is not configured"
    );
  }

  const response =
    await axios.post(
      `${redisUrl.replace(
        /\/+$/,
        ""
      )}/pipeline`,
      commands,
      {
        headers: {
          Authorization:
            `Bearer ${redisToken}`,

          "Content-Type":
            "application/json"
        },

        timeout: 5000
      }
    );

  return response.data;
}

/* --------------------------------
   Hash helper
-------------------------------- */

function hashValue(value) {
  const salt =
    process.env.RATE_LIMIT_SALT ||
    "change-me";

  return crypto
    .createHash("sha256")
    .update(
      `${salt}|${value}`
    )
    .digest("hex");
}

/* --------------------------------
   Current UTC day
-------------------------------- */

function currentDay() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

/* --------------------------------
   Free identity
-------------------------------- */

function freeIdentity(req) {
  return hashValue(
    `free|${getClientIp(req)}`
  );
}

/* --------------------------------
   Paid identity
-------------------------------- */

function paidIdentity(token) {
  return hashValue(
    `paid|${token}`
  );
}

/* --------------------------------
   Free trial
 *
 * Stores trial start timestamp.
 * It does NOT recreate a trial after
 * the 5-day period expires.
-------------------------------- */

async function checkFreeTrial(req) {
  if (!redisConfigured()) {
    /*
     * Without Redis we cannot securely
     * enforce a persistent 5-day trial.
     */
    return {
      active: true,
      persistent: false,
      trialDay: 1
    };
  }

  const identity =
    freeIdentity(req);

  const key =
    `gpf:trial:start:${identity}`;

  const now =
    Date.now();

  /*
   * First request:
   * create trial start timestamp only
   * if it doesn't already exist.
   */

  const result =
    await redisPipeline([
      [
        "SET",
        key,
        String(now),
        "NX",
        "EX",
        FREE_TRIAL_SECONDS
      ],

      [
        "GET",
        key
      ]
    ]);

  const stored =
    Number(
      result?.[1]?.result || 0
    );

  if (
    !stored ||
    !Number.isFinite(stored)
  ) {
    return {
      active: false,
      persistent: true,
      trialDay:
        FREE_TRIAL_DAYS + 1
    };
  }

  const elapsed =
    Math.max(
      0,
      now - stored
    );

  const trialDay =
    Math.floor(
      elapsed /
        86400000
    ) + 1;

  if (
    trialDay >
    FREE_TRIAL_DAYS
  ) {
    return {
      active: false,
      persistent: true,
      trialDay
    };
  }

  return {
    active: true,
    persistent: true,
    trialDay
  };
}

/* --------------------------------
   Daily counter
-------------------------------- */

async function consumeDailyLimit(
  key,
  limit
) {
  if (!redisConfigured()) {
    return {
      allowed: true,
      remaining: null,
      persistent: false,
      count: null
    };
  }

  const result =
    await redisPipeline([
      [
        "INCR",
        key
      ],

      /*
       * Keep the counter alive
       * long enough for the current day.
       */
      [
        "EXPIRE",
        key,
        172800
      ]
    ]);

  const count =
    Number(
      result?.[0]?.result || 0
    );

  return {
    allowed:
      count <= limit,

    remaining:
      Math.max(
        0,
        limit - count
      ),

    count,

    persistent: true
  };
}

/* --------------------------------
   Free daily limit
-------------------------------- */

async function consumeFreeLimit(req) {
  const trial =
    await checkFreeTrial(req);

  if (!trial.active) {
    return {
      allowed: false,
      reason: "trial_expired",
      remaining: 0,
      trialDay:
        trial.trialDay
    };
  }

  const identity =
    freeIdentity(req);

  const key =
    `gpf:free:daily:${identity}:${currentDay()}`;

  const daily =
    await consumeDailyLimit(
      key,
      FREE_DAILY_LIMIT
    );

  return {
    ...daily,

    trialDay:
      trial.trialDay
  };
}

/* --------------------------------
   Paid single limit
-------------------------------- */

async function consumePaidSingleLimit(
  token
) {
  const identity =
    paidIdentity(token);

  const key =
    `gpf:paid:single:${identity}:${currentDay()}`;

  return consumeDailyLimit(
    key,
    PAID_SINGLE_DAILY_LIMIT
  );
}

/* --------------------------------
   Paid bulk limit
-------------------------------- */

async function consumePaidBulkLimit(
  token
) {
  const identity =
    paidIdentity(token);

  const key =
    `gpf:paid:bulk:${identity}:${currentDay()}`;

  return consumeDailyLimit(
    key,
    PAID_BULK_DAILY_LIMIT
  );
}

/* --------------------------------
   Shared cache key
-------------------------------- */

function getSharedCacheKey(
  domain,
  keyword
) {
  const normalized =
    keyword
      .trim()
      .toLowerCase()
      .replace(
        /\s+/g,
        " "
      );

  return (
    `gpf:rainforest:cache:${domain}:${hashValue(
      normalized
    )}`
  );
}

/* --------------------------------
   Local cache
-------------------------------- */

function getLocalCache(
  key
) {
  const cached =
    localCache.get(key);

  if (!cached) {
    return null;
  }

  if (
    Date.now() >
    cached.expiresAt
  ) {
    localCache.delete(key);
    return null;
  }

  return cached.data;
}

function setLocalCache(
  key,
  data
) {
  localCache.set(
    key,
    {
      data,
      expiresAt:
        Date.now() +
        SHARED_CACHE_SECONDS *
          1000
    }
  );
}

/* --------------------------------
   Shared Redis cache GET
-------------------------------- */

async function getSharedCache(
  key
) {
  if (!redisConfigured()) {
    return null;
  }

  const result =
    await redisPipeline([
      [
        "GET",
        key
      ]
    ]);

  const value =
    result?.[0]?.result;

  if (
    !value ||
    typeof value !== "string"
  ) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/* --------------------------------
   Shared Redis cache SET
-------------------------------- */

async function setSharedCache(
  key,
  data
) {
  if (!redisConfigured()) {
    return false;
  }

  await redisPipeline([
    [
      "SET",
      key,
      JSON.stringify(data),
      "EX",
      SHARED_CACHE_SECONDS
    ]
  ]);

  return true;
}

/* --------------------------------
   Rainforest search
-------------------------------- */

async function rainforestSearch(
  keyword,
  domain
) {
  const apiKey =
    process.env.RAINFOREST_API_KEY;

  if (!apiKey) {
    throw new Error(
      "RAINFOREST_API_KEY is not configured"
    );
  }

  const baseUrl =
    process.env.RAINFOREST_API_URL ||
    "https://api.rainforestapi.com/request";

  const response =
    await axios.get(
      baseUrl,
      {
        params: {
          api_key: apiKey,
          type: "search",
          amazon_domain: domain,
          search_term: keyword,
          page: 1
        },

        timeout: 15000,

        validateStatus:
          (status) =>
            status >= 200 &&
            status < 300
      }
    );

  const data =
    response.data || {};

  /*
   * Current Rainforest response:
   *
   * search_information.total_results
   *
   * Example:
   * "1-16 of over 100,000 results"
   */

  const total =
    Number(
      data.search_results_total ??
      data.search_information
        ?.total_results ??
      data.search_results
        ?.total_results ??
      data.pagination
        ?.total_results ??
      data.pagination
        ?.total_results_count
    );

  if (
    !Number.isFinite(total)
  ) {
    const providerMessage =
      data.request_info?.message ||
      data.error ||
      data.message;

    if (
      providerMessage
    ) {
      throw new Error(
        `Rainforest API: ${clean(
          providerMessage,
          250
        )}`
      );
    }

    throw new Error(
      "Rainforest response did not contain total search results"
    );
  }

  return {
    totalResults:
      Math.max(
        0,
        Math.round(total)
      ),

    requestId:
      clean(
        data.request_info
          ?.request_id,
        256
      ) || null
  };
}

/* --------------------------------
   Main handler
-------------------------------- */

module.exports =
  async function handler(
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
     * POST only
     */

    if (
      req.method !== "POST"
    ) {
      return res.status(405).json({
        ok: false,
        error:
          "Method not allowed"
      });
    }

    try {
      const body =
        jsonBody(req);

      /*
       * Marketplace
       */

      const country =
        clean(
          body.country || "us",
          8
        ).toLowerCase();

      const domain =
        MARKETPLACES[country];

      if (!domain) {
        return res.status(400).json({
          ok: false,
          error:
            "Unsupported marketplace"
        });
      }

      /*
       * Authentication
       */

      const token =
        getBearer(req);

      let session = null;

      try {
        session =
          verifySession(token);
      } catch {
        session = null;
      }

      const isPaid =
        session?.t === "paid";

      const isOwner =
        session?.t === "owner";

      /*
       * Mode
       */

      const isBulk =
        body.mode === "bulk";

      /*
       * Free users cannot use Bulk.
       */

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
       * --------------------------------
       * LIMITS
       * --------------------------------
       */

      if (isOwner) {
        /*
         * Owner:
         * unlimited.
         */
      } else if (isPaid) {
        /*
         * Paid:
         *
         * Single = 20/day
         * Bulk = 50/day
         */

        const paidLimit =
          isBulk
            ? await consumePaidBulkLimit(
                token
              )
            : await consumePaidSingleLimit(
                token
              );

        if (
          !paidLimit.allowed
        ) {
          return res.status(429).json({
            ok: false,

            error:
              isBulk
                ? "Paid Bulk Finder daily limit reached: 50 keywords per day."
                : "Paid Single Analysis daily limit reached: 20 keywords per day.",

            remaining: 0,

            limit:
              isBulk
                ? PAID_BULK_DAILY_LIMIT
                : PAID_SINGLE_DAILY_LIMIT
          });
        }
      } else {
        /*
         * Free:
         *
         * 2/day
         * for 5 days.
         */

        const freeLimit =
          await consumeFreeLimit(
            req
          );

        if (
          !freeLimit.allowed
        ) {
          if (
            freeLimit.reason ===
            "trial_expired"
          ) {
            return res.status(403).json({
              ok: false,

              error:
                "Your 5-day free trial has ended. Upgrade to Premium to continue.",

              trialExpired:
                true
            });
          }

          return res.status(429).json({
            ok: false,

            error:
              "Free daily limit reached: 2 keywords per day during your 5-day free trial.",

            remaining: 0,

            limit:
              FREE_DAILY_LIMIT,

            trialDay:
              freeLimit.trialDay
          });
        }
      }

      /*
       * Keyword
       */

      const keyword =
        clean(
          body.keyword,
          160
        );

      if (
        !isValidKeyword(
          keyword
        )
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "Invalid keyword"
        });
      }

      /*
       * --------------------------------
       * 10-DAY SHARED CACHE
       * --------------------------------
       *
       * IMPORTANT:
       *
       * Cache is checked AFTER
       * authorization/limits.
       *
       * Therefore:
       * - Usage limits still apply.
       * - Rainforest request does NOT
       *   happen when cache exists.
       */

      const cacheKey =
        getSharedCacheKey(
          domain,
          keyword
        );

      /*
       * First check small local cache.
       */

      let cached =
        getLocalCache(
          cacheKey
        );

      if (cached) {
        return res.status(200).json({
          ok: true,

          cached: true,

          cacheDays:
            10,

          data: cached,

          plan: isOwner
            ? "owner"
            : isPaid
              ? "paid"
              : "free"
        });
      }

      /*
       * Then check shared Upstash Redis.
       */

      cached =
        await getSharedCache(
          cacheKey
        );

      if (cached) {
        /*
         * Save into local cache too.
         */

        setLocalCache(
          cacheKey,
          cached
        );

        return res.status(200).json({
          ok: true,

          cached: true,

          cacheDays:
            10,

          data: cached,

          plan: isOwner
            ? "owner"
            : isPaid
              ? "paid"
              : "free"
        });
      }

      /*
       * --------------------------------
       * CACHE MISS
       * --------------------------------
       *
       * Only now Rainforest is called.
       */

      const amazon =
        await rainforestSearch(
          keyword,
          domain
        );

      /*
       * Ghost Score
       */

      const ghostScore =
        opportunity(
          amazon.totalResults
        );

      /*
       * Final result
       */

      const result = {
        keyword,

        marketplace:
          domain,

        /*
         * Search volume is
         * intentionally unavailable.
         */

        searchVolume:
          null,

        searchVolumeStatus:
          "Not available",

        /*
         * Rainforest Amazon
         * result count.
         */

        amazonProductCount:
          amazon.totalResults,

        /*
         * Competition estimate.
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
       * --------------------------------
       * SAVE SHARED CACHE
       * --------------------------------
       *
       * 10 days.
       */

      try {
        await setSharedCache(
          cacheKey,
          result
        );
      } catch (cacheError) {
        /*
         * Cache failure must not make
         * the Rainforest result fail.
         *
         * Do not expose Redis details
         * to the user.
         */

        console.error(
          "Shared cache write failed:",
          cacheError.message
        );
      }

      /*
       * Save local cache too.
       */

      setLocalCache(
        cacheKey,
        result
      );

      /*
       * Success
       */

      return res.status(200).json({
        ok: true,

        cached: false,

        cacheDays:
          10,

        data:
          result,

        plan: isOwner
          ? "owner"
          : isPaid
            ? "paid"
            : "free"
      });

    } catch (error) {
      /*
       * Never expose secrets.
       */

      console.error(
        "Search error:",
        error.response?.data ||
        error.message
      );

      const message =
        error.response?.data
          ?.error ||
        error.response?.data
          ?.message ||
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
