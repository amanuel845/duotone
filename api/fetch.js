// api/fetch.js
// CORS-friendly proxy for fetching remote files (CSS, JS, fonts, text).
// Usage:  GET /api/fetch?url=https%3A%2F%2Fexample.com%2Fstyle.css

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED_HOSTS = [];

// Set CORS on EVERY response, success or error, so the browser
// can always read the body instead of reporting status 0.
function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendError(res, status, message, extra) {
  applyCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const body = { error: message };
  if (extra) body.detail = extra;
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  // Preflight
  if (req.method === "OPTIONS") {
    applyCors(res);
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return sendError(res, 405, "Method not allowed");
  }

  const url = req.query && req.query.url;
  if (!url || typeof url !== "string") {
    return sendError(res, 400, "Missing ?url= parameter");
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return sendError(res, 400, "Invalid URL");
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return sendError(res, 400, "Only http:// and https:// are allowed");
  }

  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(target.hostname)) {
    return sendError(res, 403, "Host not allowed");
  }

  // Abort at 8s so we always respond before Vercel's 10s kill.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_UA,
        // Font Awesome / Cloudflare in particular wants these exact headers.
        Accept: "text/css,text/plain,application/javascript,application/font-woff2,font/woff2,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "style",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err && err.name === "AbortError";
    return sendError(
      res,
      isAbort ? 504 : 502,
      isAbort ? "Upstream timeout (8s)" : "Upstream fetch failed",
      String((err && err.message) || err)
    );
  }
  clearTimeout(timer);

  // Forward upstream errors verbatim (still with CORS headers).
  if (!upstream.ok) {
    let body = "";
    try {
      body = await upstream.text();
      if (body.length > 500) body = body.slice(0, 500) + "...";
    } catch {
      body = "(unreadable)";
    }
    return sendError(
      res,
      upstream.status,
      `Upstream responded ${upstream.status} ${upstream.statusText}`,
      body
    );
  }

  const declared = Number(upstream.headers.get("content-length")) || 0;
  if (declared > MAX_BYTES) {
    return sendError(res, 413, `File too large (${declared} bytes > ${MAX_BYTES})`);
  }

  // Success path
  applyCors(res);
  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    upstream.headers.get("content-type") || "application/octet-stream"
  );
  if (declared) res.setHeader("Content-Length", String(declared));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Proxy", "vercel-fetch");

  if (req.method === "HEAD") {
    return res.end();
  }

  try {
    if (!upstream.body) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        return sendError(res, 413, "File too large");
      }
      return res.end(buf);
    }

    const reader = upstream.body.getReader();
    let sent = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sent += value.byteLength;
      if (sent > MAX_BYTES) {
        try { await reader.cancel(); } catch {}
        return res.end();
      }
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (err) {
    try { res.end(); } catch {}
  }
}
