// Zero-dependency static file server for the built Storybook (storybook-static/).
//
// Playwright's `webServer` boots this to serve the pre-built catalog on a fixed
// port. We avoid `serve`/`http-server` deps so the visual-regression job pulls in
// nothing beyond @playwright/test — keeping the setup $0 and hermetic (works the
// same on macOS locally and inside the Playwright Docker image in CI).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "storybook-static");
const PORT = Number(process.env.SB_PORT ?? 6007);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // Strip query string, prevent path traversal, default to index.html.
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const filePath = normalize(join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(500).end("server error");
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[visual] serving ${ROOT} on http://localhost:${PORT}`);
});
