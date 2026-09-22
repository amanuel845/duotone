// api/list-remote.js
//
// Recursively walks a remote Apache/nginx directory index and returns a
// flat list of every file under it, in one HTTP response.
//
//   GET /api/list-remote?url=https%3A%2F%2Fexample.com%2Fassets%2F
//
// Response:
//   {
//     root: "https://example.com/assets/",
//     files: [ { url, relPath, name }, ... ],
//     stats: { files, dirs, scanned, aborted }
//   }
//
// Safety:
//   - Same-origin only (never follows links off the root host)
//   - Only URLs that start with the root path are kept
//   - Hard cap on total upstream requests (MAX_REQUESTS)
//   - Per-request timeout

const MAX_REQUESTS = 500;
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;
const UA = "Mozilla/5.0 (compatible; AssetFetcherProxy/1.0)";

function extractHrefs(html) {
  const out = [];
  const re = /<a\s+[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href) continue;
    if (href.charAt(0) === "#" || href.charAt(0) === "?") continue;
    if (href === "/" || href === "./" || href === "../") continue;
    out.push(href);
  }
  return out;
}

async function fetchIndex(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.1",
        "Accept-Encoding": "identity"
      }
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!/<a\s/i.test(text)) return null;
    return text;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string") {
    return res.status(400).json({ error: "Missing ?url= parameter" });
  }

  let root;
  try { root = new URL(rawUrl); }
  catch { return res.status(400).json({ error: "Invalid URL" }); }
  if (root.protocol !== "http:" && root.protocol !== "https:") {
    return res.status(400).json({ error: "Only http:// and https:// are allowed" });
  }
  if (!root.pathname.endsWith("/")) root.pathname += "/";

  const origin = root.origin;
  const rootPath = root.pathname;

  const visited = new Set([root.href]);
  const queue = [root.href];
  const files = [];
  let dirs = 0;
  let scanned = 0;

  while (queue.length && scanned < MAX_REQUESTS) {
    const batch = queue.splice(0, CONCURRENCY);
    scanned += batch.length;

    const results = await Promise.all(batch.map(fetchIndex));

    for (let i = 0; i < results.length; i++) {
      const html = results[i];
      if (!html) continue;
      const baseUrl = batch[i];
      const hrefs = extractHrefs(html);

      for (const href of hrefs) {
        let u;
        try { u = new URL(href, baseUrl); } catch { continue; }
        if (u.origin !== origin) continue;
        if (!u.pathname.startsWith(rootPath)) continue;

        const isDir = u.pathname.endsWith("/");
        const clean = u.origin + u.pathname;
        if (visited.has(clean)) continue;
        visited.add(clean);

        if (isDir) {
          dirs++;
          queue.push(clean);
        } else {
          let rel = u.pathname.slice(rootPath.length);
          try { rel = decodeURIComponent(rel); } catch { /* keep */ }
          if (!rel) continue;
          let name = "";
          const parts = u.pathname.split("/");
          try { name = decodeURIComponent(parts[parts.length - 1] || ""); }
          catch { name = parts[parts.length - 1] || ""; }
          if (!name) continue;
          files.push({ url: clean, relPath: rel, name });
        }
      }
    }
  }

  const aborted = scanned >= MAX_REQUESTS && queue.length > 0;
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    root: root.href,
    files,
    stats: {
      files: files.length,
      dirs,
      scanned,
      aborted
    }
  });
}
