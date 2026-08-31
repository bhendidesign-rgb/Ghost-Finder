const crypto = require("crypto");
const axios = require("axios");

function clean(value, max = 4096) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function secret() {
  const value = process.env.AUTH_SIGNING_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SIGNING_SECRET is not configured");
  return value;
}

function b64(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(input) {
  return crypto.createHmac("sha256", secret()).update(input).digest("base64url");
}

function issueSession(type, subject, extra = {}) {
  const payload = { t: type, sub: subject, iat: Date.now(), exp: Date.now() + 15 * 60 * 1000, ...extra };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function verifySession(token) {
  try {
    const [body, sig] = clean(token).split(".");
    if (!body || !sig) return null;
    const expected = sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function getBearer(req) {
  return clean(req.headers.authorization?.replace(/^Bearer\s+/i, ""), 4096);
}

function getClientIp(req) {
  const forwarded = clean(req.headers["x-forwarded-for"], 512);
  if (forwarded) return forwarded.split(",")[0].trim();
  return clean(req.headers["x-real-ip"], 128) || "unknown";
}

async function verifyGumroadLicense(licenseKey) {
  const productId = clean(process.env.GUMROAD_PRODUCT_ID, 256);
  if (!productId) throw new Error("GUMROAD_PRODUCT_ID is not configured");
  const response = await axios.post("https://api.gumroad.com/v2/licenses/verify", new URLSearchParams({
    product_id: productId,
    license_key: licenseKey,
    increment_uses_count: "false"
  }).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 10000,
    validateStatus: () => true
  });
  if (response.status !== 200 || !response.data?.success) return null;
  const purchase = response.data.purchase || {};
  if (purchase.refunded || purchase.disputed || purchase.chargebacked || purchase.subscription_ended_at || purchase.subscription_cancelled_at || purchase.subscription_failed_at) return null;
  return {
    licenseKey,
    email: clean(purchase.email, 320).toLowerCase(),
    saleId: clean(purchase.sale_id || purchase.id, 256),
    productId,
    recurrence: clean(purchase.recurrence, 64)
  };
}

async function ownerSession(password) {
  const configured = process.env.OWNER_ACCESS_PASSWORD;
  if (!configured || configured.length < 24) return null;
  const supplied = Buffer.from(String(password || ""));
  const expected = Buffer.from(configured);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  return issueSession("owner", "owner");
}

module.exports = { clean, issueSession, verifySession, getBearer, getClientIp, verifyGumroadLicense, ownerSession };
