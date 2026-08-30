import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = process.cwd();
const IMAGES_DIR = path.join(ROOT, 'images');

const MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.png': 'image/png'
};

// The scraped product images live in /images at the repo root, one level above
// the Vite project root. Serve them at /images/* in dev the same way the
// production static server does.
function serveRepoImages(): Plugin {
  return {
    name: 'serve-repo-images',
    configureServer(server) {
      server.middlewares.use('/images', (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const filePath = path.join(IMAGES_DIR, decodeURIComponent(url.pathname));
        if (!filePath.startsWith(IMAGES_DIR)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        fs.readFile(filePath, (error, data) => {
          if (error) {
            next();
            return;
          }
          res.setHeader('content-type', MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream');
          res.end(data);
        });
      });
    }
  };
}

// Static hosts (e.g. Cloudflare Pages) serve only the build output directory,
// so copy the repo-root images/ into dist/images at build time.
function copyImagesOnBuild(): Plugin {
  return {
    name: 'copy-images-on-build',
    apply: 'build',
    async closeBundle() {
      const outDir = path.join(ROOT, 'site', 'dist', 'images');
      await fsp.mkdir(outDir, { recursive: true });
      const files = await fsp.readdir(IMAGES_DIR);
      await Promise.all(files.map((file) => fsp.copyFile(path.join(IMAGES_DIR, file), path.join(outDir, file))));
    }
  };
}

export default defineConfig({
  root: 'site',
  base: './',
  plugins: [react(), serveRepoImages(), copyImagesOnBuild()],
  server: {
    // pdf.ts imports shared PDF logic from ../../scripts/pdf-shared.ts (repo root),
    // outside the "site" project root.
    fs: { allow: [ROOT] }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
