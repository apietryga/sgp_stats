/**
 * Local preview of the static site (Bun.serve, port 3000) — serves docs/ exactly
 * as GitHub Pages would. No API: the front-end reads prepared static JSON under
 * docs/data/. Run `bun run build:site` first.
 */
import { resolve, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";

const SITE_DIR = resolve(import.meta.dir, "../docs");
const PORT = Number(process.env.PORT ?? 3000);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".csv": "text/csv; charset=utf-8",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return TYPES[path.slice(dot)] ?? "application/octet-stream";
}

if (!existsSync(resolve(SITE_DIR, "index.html"))) {
  console.warn("docs/index.html not found — run `bun run build:site` first.");
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    let pathname = decodeURIComponent(new URL(req.url).pathname);
    if (pathname === "/" || pathname.endsWith("/")) pathname += "index.html";
    // confine to docs/ (no path traversal)
    const target = normalize(resolve(SITE_DIR, "." + pathname));
    if (!target.startsWith(SITE_DIR)) return new Response("Forbidden", { status: 403 });
    if (!existsSync(target) || !statSync(target).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(Bun.file(target), {
      headers: { "content-type": contentType(target) },
    });
  },
});

console.log(`sgp-stats static preview on http://localhost:${server.port}  (serving docs/)`);
