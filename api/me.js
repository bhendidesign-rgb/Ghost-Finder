const { verifySession, getBearer } = require("./auth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  let cookieToken = "";

  const cookieHeader = req.headers.cookie || "";

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name === "gpf_session") {
      cookieToken = rest.join("=");
      break;
    }
  }

  const token = cookieToken || getBearer(req);
  const session = verifySession(token);

  return res.status(200).json({
    ok: true,
    authenticated: !!session,
    plan: session?.t || "free"
  });
};
