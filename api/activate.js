const crypto = require("crypto");
const { clean, issueSession, verifyGumroadLicense } = require("./auth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  try {
    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const licenseKey = clean(body.licenseKey, 256);
    if (!licenseKey) return res.status(400).json({ ok: false, error: "Enter your Gumroad license key." });
    const purchase = await verifyGumroadLicense(licenseKey);
    if (!purchase) return res.status(401).json({ ok: false, error: "This license is not active." });
    const session = issueSession("paid", purchase.saleId, {
      email: purchase.email,
      lk: crypto.createHash("sha256").update(licenseKey).digest("hex").slice(0, 24)
    });
    return res.status(200).json({ ok: true, token: session, plan: "paid" });
  } catch (error) {
    console.error("Activation error:", error.message);
    return res.status(502).json({ ok: false, error: "Unable to verify the license right now." });
  }
};
