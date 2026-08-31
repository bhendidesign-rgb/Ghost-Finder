const { clean, ownerSession } = require("./auth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });
  try {
    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const token = await ownerSession(clean(body.password, 512));
    if (!token) return res.status(401).json({ ok: false, error: "Invalid owner credentials." });
    return res.status(200).json({ ok: true, token, plan: "owner" });
  } catch (error) {
    console.error("Owner login error:", error.message);
    return res.status(500).json({ ok: false, error: "Owner authentication failed." });
  }
};
