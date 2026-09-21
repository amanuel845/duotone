// api/list-js.js
// Lists .js files inside the deployment's /public folder.
// Usage: GET /api/list-js?dir=assets/js

import fs from "fs/promises";
import path from "path";

// Vercel puts static assets from your repo's /public folder at the
// deployment root. This function reads that folder from disk.
const PUBLIC_ROOT = path.join(process.cwd(), "public");

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawDir = (req.query && req.query.dir) || "/";
  const clean = String(rawDir)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");        // strip leading/trailing slashes

  // Path-traversal guard
  if (clean.split("/").some((seg) => seg === ".." || seg === "")) {
    return res.status(400).json({ error: "Invalid path" });
  }

  const absDir = path.resolve(PUBLIC_ROOT, clean);
  if (absDir !== PUBLIC_ROOT && !absDir.startsWith(PUBLIC_ROOT + path.sep)) {
    return res.status(400).json({ error: "Path outside public root" });
  }

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (err) {
    return res
      .status(404)
      .json({ error: "Directory not found", detail: err.message });
  }

  // Non-recursive: only direct children that are .js files
  const jsEntries = entries.filter(
    (e) => e.isFile() && /\.js$/i.test(e.name)
  );

  const files = await Promise.all(
    jsEntries.map(async (e) => {
      const stat = await fs.stat(path.join(absDir, e.name));
      const rel = path.posix.join(clean, e.name);
      return {
        name: e.name,
        path: "/" + rel,               // root-relative URL
        size: stat.size,
      };
    })
  );

  files.sort((a, b) => a.name.localeCompare(b.name));

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json({
    dir: "/" + clean,
    count: files.length,
    files,
  });
}
