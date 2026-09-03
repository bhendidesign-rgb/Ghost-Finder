const { getSession } = require("./auth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const session = getSession(req);

  return res.status(200).json({
    ok: true,
    authenticated: !!session,
    plan: session?.t || "free"
  });
};
