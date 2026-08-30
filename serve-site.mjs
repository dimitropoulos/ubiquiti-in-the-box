import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 4173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  // The built site (site/dist) uses relative asset URLs resolved against "/",
  // so try the repo root first (covers /images/*) and fall back to site/dist
  // (covers /index.html, /assets/*, etc.) before giving up.
  const candidates = [path.join(ROOT, pathname), path.join(ROOT, 'site', 'dist', pathname)];

  for (const filePath of candidates) {
    if (!filePath.startsWith(ROOT)) continue;

    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
      return;
    } catch {
      continue;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Serving at http://localhost:${PORT}/`);
});
