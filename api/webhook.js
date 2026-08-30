const crypto = require("crypto");
const querystring = require("querystring");

const memoryLicenses = global.__ghostLicenses || (global.__ghostLicenses = new Map());

function clean(value, max = 512) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max);
}

function secret() {
  if (!process.env.LICENSE_SIGNING_SECRET || process.env.LICENSE_SIGNING_SECRET.length < 32) {
    throw new Error("LICENSE_SIGNING_SECRET is not configured");
  }
  return process.env.LICENSE_SIGNING_SECRET;
}

function signLicense(email, saleId, licenseKey, expiresAt) {
  const payload = `${email}.${saleId}.${licenseKey}.${expiresAt}`;
  return crypto.createHmac("sha256", secret()).update(payload).digest("hex");
}

function issueToken(email, saleId, licenseKey) {
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const signature = signLicense(email, saleId, licenseKey, expiresAt);
  return Buffer.from(JSON.stringify({ e: email, s: saleId, x: expiresAt, h: signature })).toString("base64url");
}

function timingSafeEqualHex(a, b) {
  const aa = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const raw = typeof req.body === "string"
      ? req.body
      : Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : "";

    let body = raw ? querystring.parse(raw) : (req.body || {});
    const email = clean(body.email, 320).toLowerCase();
    const licenseKey = clean(body.license_key, 256);
    const saleId = clean(body.sale_id || body.sale_id, 256);
    const refunded = String(body.refunded ?? "").toLowerCase() === "true";
    const test = String(body.test ?? "").toLowerCase() === "true";

    if (!email || !licenseKey || !saleId) {
      return res.status(400).json({ ok: false, error: "Missing required Gumroad fields" });
    }

    if (refunded) {
      memoryLicenses.delete(licenseKey);
      return res.status(200).json({ ok: true, status: "revoked" });
    }

    if (test) {
      return res.status(200).json({ ok: true, status: "test_received" });
    }

    const token = issueToken(email, saleId, licenseKey);
    memoryLicenses.set(licenseKey, {
      email,
      saleId,
      token,
      active: true,
      createdAt: Date.now()
    });

    return res.status(200).json({
      ok: true,
      status: "validated",
      message: "Gumroad sale accepted"
    });
  } catch (error) {
    console.error("Webhook error:", error.message);
    return res.status(500).json({ ok: false, error: "Webhook processing failed" });
  }
};