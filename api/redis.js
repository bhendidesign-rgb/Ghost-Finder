const axios = require("axios");

function config() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required"
    );
  }

  return {
    url: url.replace(/\/+$/, ""),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  };
}

async function command(commands) {
  const c = config();
  const response = await axios.post(
    `${c.url}/pipeline`,
    commands,
    {
      headers: c.headers,
      timeout: 5000
    }
  );

  return response.data;
}

async function get(key) {
  const result = await command([["GET", key]]);
  return result?.[0]?.result ?? null;
}

async function set(key, value, seconds) {
  const result = await command([
    ["SET", key, String(value), "EX", String(seconds)]
  ]);

  return result?.[0]?.result === "OK";
}

async function del(key) {
  const result = await command([["DEL", key]]);
  return Number(result?.[0]?.result || 0);
}

async function consumeDailyLimit(key, limit, ttlSeconds) {
  const script = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
if current <= tonumber(ARGV[2]) then
  return {1, current}
end
return {0, current}
`;

  const result = await command([
    [
      "EVAL",
      script,
      "1",
      key,
      String(ttlSeconds),
      String(limit)
    ]
  ]);

  const value = result?.[0]?.result;

  if (!Array.isArray(value)) {
    throw new Error("Redis rate-limit response was invalid");
  }

  return {
    allowed: Number(value[0]) === 1,
    count: Number(value[1] || 0)
  };
}

module.exports = {
  get,
  set,
  del,
  consumeDailyLimit
};
