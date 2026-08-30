import fs from 'node:fs/promises';
import path from 'node:path';
import * as YAML from 'js-yaml';
import { buildPdf, type PdfProduct } from './pdf-shared.ts';

const ROOT = process.cwd();
const CACHE_PATH = path.join(ROOT, 'product-cache.yaml');
const IMAGES_DIR = path.join(ROOT, 'images');
const OUTPUT_PATH = path.join(ROOT, 'in-the-box.pdf');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// GitHub hard-blocks pushes of files over 100 MiB. Stay a little under that;
// only downscale images (fetched fresh at a smaller width) if we'd exceed it.
const MAX_BYTES = 99 * 1024 * 1024;
const FALLBACK_WIDTHS = [2600, 2000, 1500, 1100, 800];

type CacheImage = { originUrl: string; width: number; height: number };

type CacheEntry = {
  model: string;
  productName: string;
  productTitle: string;
  productDescription: string;
  image?: CacheImage;
  noInTheBoxImage?: true;
};

type FullPdfProduct = PdfProduct & { originUrl: string };

function slugifyModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

async function loadLocalPng(model: string): Promise<Uint8Array> {
  return fs.readFile(path.join(IMAGES_DIR, `${slugifyModel(model)}.png`));
}

async function fetchResizedPng(originUrl: string, width: number): Promise<Uint8Array> {
  const url = `https://images.svc.ui.com/?u=${encodeURIComponent(originUrl)}&q=75&w=${width}&f=png`;
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'image/png,image/*,*/*;q=0.8' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function main(): Promise<void> {
  const content = await fs.readFile(CACHE_PATH, 'utf8');
  const parsed = YAML.load(content) as Record<string, CacheEntry>;

  const products: FullPdfProduct[] = Object.values(parsed)
    .filter((entry) => entry.image && !entry.noInTheBoxImage)
    .map((entry) => ({
      model: entry.model,
      name: entry.productTitle || entry.productName,
      description: entry.productDescription,
      originUrl: entry.image!.originUrl
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));

  console.log(`Building full PDF for ${products.length} product(s)...`);

  let bytes = await buildPdf(products, (product) => loadLocalPng(product.model));
  console.log(`Full-quality PDF: ${formatMiB(bytes.length)}`);

  for (const width of FALLBACK_WIDTHS) {
    if (bytes.length <= MAX_BYTES) break;

    console.warn(`  over the ${formatMiB(MAX_BYTES)} budget; retrying with images downscaled to w=${width}...`);
    bytes = await buildPdf(products, (product) => fetchResizedPng(product.originUrl, width));
    console.log(`  at w=${width}: ${formatMiB(bytes.length)}`);
  }

  if (bytes.length > MAX_BYTES) {
    console.warn(`  still over budget at ${formatMiB(bytes.length)} after exhausting fallback widths; writing anyway.`);
  }

  await fs.writeFile(OUTPUT_PATH, bytes);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)} (${products.length} products, ${formatMiB(bytes.length)})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
