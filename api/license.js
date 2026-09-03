const axios = require("axios");
const crypto = require("crypto");
const {
  clean,
  createSession,
  sessionCookie
} = require("./auth");
const { set } = require("./redis");

function jsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

function licenseHash(licenseKey) {
  const salt = process.env.LICENSE_HASH_SALT;
  if (!salt || salt.length < 32) {
    throw new Error("LICENSE_HASH_SALT is not configured");
  }

  return crypto
    .createHmac("sha256", salt)
    .update(licenseKey)
    .digest("hex");
}

function activePurchase(purchase) {
  if (!purchase || purchase.refunded || purchase.disputed) return false;

  return !(
    purchase.subscription_ended_at ||
    purchase.subscription_cancelled_at ||
    purchase.subscription_failed_at
  );
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    const body = jsonBody(req);
    const licenseKey = clean(body.license_key, 256);
    const productId = clean(
      process.env.GUMROAD_PRODUCT_ID,
      256
    );

    if (!licenseKey || !productId) {
      return res.status(400).json({
        ok: false,
        error: "License key is required"
      });
    }

    const response = await axios.post(
      "https://api.gumroad.com/v2/licenses/verify",
      new URLSearchParams({
        product_id: productId,
        license_key: licenseKey,
        increment_uses_count: "false"
      }),
      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        timeout: 10000,
        validateStatus: () => true
      }
    );

    if (
      response.status < 200 ||
      response.status >= 300 ||
      !response.data?.success
    ) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or inactive Premium license"
      });
    }

    const purchase = response.data.purchase;

    if (!activePurchase(purchase)) {
      return res.status(403).json({
        ok: false,
        error:
          "This Premium subscription is no longer active"
      });
    }

    const hash = licenseHash(licenseKey);

    /*
     * Keep only a server-side hashed license record.
     * The actual license key is never stored in Redis.
     */
    await set(
      `license:${hash}`,
      JSON.stringify({
        active: true,
        email: clean(purchase.email, 320).toLowerCase(),
        saleId: clean(purchase.sale_id, 256),
        updatedAt: Date.now()
      }),
      7200
    );

    const token = createSession("paid", {
      l: hash
    });

    res.setHeader(
      "Set-Cookie",
      sessionCookie(token, 60 * 60)
    );

    return res.status(200).json({
      ok: true,
      plan: "paid",
      message: "Premium activated"
    });
  } catch (error) {
    console.error(
      "License activation error:",
      error.message
    );

    return res.status(502).json({
      ok: false,
      error:
        "Premium activation service is temporarily unavailable"
    });
  }
};
