// api/fetch.js
// Simple CORS proxy for fetching remote files (CSS, JS, fonts, text).
// Usage:  GET /api/fetch?url=https%3A%2F%2Fexample.com%2Fstyle.css
//
// Node.js runtime (default on Vercel). Node 18+ required for global fetch.

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Hard cap to prevent abuse (bytes). Adjust as needed.
const MAX_BYTES = 12 * 1024 * 1024; // 12 MB (fonts can be chunky)

// Optional host allowlist. Leave empty to allow any http(s) host.
// Example: ["www.library.illinois.edu", "library.illinois.edu"]
const ALLOWED_HOSTS = [];

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing ?url= parameter" });
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return res.status(400).json({ error: "Only http:// and https:// are allowed" });
  }

  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(target.hostname)) {
    return res.status(403).json({ error: "Host not allowed" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_UA,
        // Permissive: works for CSS, JS, fonts, images…
        Accept: "*/*",
        "Accept-Encoding": "identity", // keep Content-Length accurate
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    const msg = err?.name === "AbortError" ? "Upstream timeout" : "Upstream fetch failed";
    return res.status(502).json({ error: msg, detail: String(err?.message || err) });
  }
  clearTimeout(timeout);

  if (!upstream.ok) {
    return res
      .status(upstream.status)
      .json({ error: `Upstream responded ${upstream.status} ${upstream.statusText}` });
  }

  const declared = Number(upstream.headers.get("content-length")) || 0;
  if (declared > MAX_BYTES) {
    return res.status(413).json({ error: "File too large" });
  }

  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    upstream.headers.get("content-type") || "application/octet-stream"
  );
  if (declared) res.setHeader("Content-Length", String(declared));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Proxy", "vercel-fetch");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  try {
    if (!upstream.body) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        res.statusCode = 413;
        return res.end(JSON.stringify({ error: "File too large" }));
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
  } catch {
    try { res.end(); } catch {}
  }
}
