// Serves the RyftTiers Public API (src/public-api.mjs) from the bot's
// existing HTTP server, at /api/*. The bot is kept awake by an uptime
// monitor, so this is always available. Docs: API.md in the website repo.
const CACHE_TTL_MS = 5 * 60 * 1000;

let apiPromise = null;
const loadApi = () => (apiPromise ||= import("./public-api.mjs"));

// Same interface as Cloudflare's caches.default ({ match, put }), in memory.
const store = new Map(); // url -> { res, expires }
const cache = {
  async match(req) {
    const hit = store.get(req.url);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      store.delete(req.url);
      return undefined;
    }
    return hit.res.clone();
  },
  async put(req, res) {
    if (store.size > 2000) {
      const now = Date.now();
      for (const [k, v] of store) if (v.expires < now) store.delete(k);
      if (store.size > 2000) store.clear();
    }
    store.set(req.url, { res, expires: Date.now() + CACHE_TTL_MS });
  },
};

function isApiRequest(req) {
  return req.url === "/api" || req.url.startsWith("/api/") || req.url.startsWith("/api?");
}

async function handleApiRequest(req, res) {
  try {
    const { handleRequest } = await loadApi();
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = forwarded || req.socket.remoteAddress || "unknown";
    const request = new Request(`https://${req.headers.host || "localhost"}${req.url}`, {
      method: req.method,
      headers: { "CF-Connecting-IP": ip },
    });
    // Only the public anon key is used (the defaults in public-api.mjs),
    // never the bot's service-role credentials.
    const response = await handleRequest(request, {}, { cache });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("[public-api] request failed:", err.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify({ error: { status: 500, message: "Internal error" } }));
  }
}

module.exports = { isApiRequest, handleApiRequest };
