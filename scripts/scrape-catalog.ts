import fs from 'node:fs/promises';
import path from 'node:path';
import * as YAML from 'js-yaml';
import { chromium, type Browser } from 'playwright';

const ROOT = process.cwd();
const BASE_URL = 'https://store.ui.com/us/en';
const CACHE_PATH = path.join(ROOT, 'product-cache.yaml');
const MANUAL_PATH = path.join(ROOT, 'manual.yaml');
const IMAGES_DIR = path.join(ROOT, 'images');
const SITE_PRODUCTS_PATH = path.join(ROOT, 'site', 'public', 'products.json');
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 6;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Top-level nav categories on store.ui.com. Each one exposes a `subCategories`
// list whose products cover every leaf category beneath it.
const TOP_LEVEL_CATEGORIES = [
  'all-cloud-gateways',
  'all-switching',
  'all-wifi',
  'all-physical-security',
  'all-door-access',
  'all-integrations',
  'accessories-cables-dacs'
];

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

type ApiVariant = {
  slug?: string;
  sku?: string;
  displaySku?: string;
  whatsInTheBoxMediaItemIds?: string[];
};

type ApiMediaItem = {
  id?: string;
  data?: {
    url?: string;
    width?: number;
    height?: number;
    mimeType?: string;
  };
};

type ApiProduct = {
  id?: string;
  slug?: string;
  title?: string;
  shortTitle?: string;
  name?: string;
  displaySku?: string;
  description?: string;
  shortDescription?: string;
  variants?: ApiVariant[];
  whatsInTheBoxMedia?: { items?: ApiMediaItem[] };
};

type InTheBoxImage = {
  url: string;
  width: number;
  height: number;
};

type CacheImage = {
  originUrl: string;
  width: number;
  height: number;
};

type CacheEntry = {
  model: string;
  productName: string;
  productTitle: string;
  productDescription: string;
  productId?: string;
  image?: CacheImage;
  // Set when the store page has no whats-in-the-box image at all, so re-runs
  // don't keep re-checking (and re-requesting) the same dead end.
  noInTheBoxImage?: true;
  urls: string[];
  updatedAt: string;
};

type CacheFile = Record<string, CacheEntry>;

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CacheEntry>;
  if (typeof entry.model !== 'string' || !Array.isArray(entry.urls)) return false;
  return entry.noInTheBoxImage === true || (typeof entry.image === 'object' && entry.image !== null);
}

async function loadCache(): Promise<CacheFile> {
  try {
    const content = await fs.readFile(CACHE_PATH, 'utf8');
    const parsed = YAML.load(content);
    if (!parsed || typeof parsed !== 'object') return {};

    const cache: CacheFile = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isCacheEntry(value)) continue;
      // Drop any stale fields from older cache schemas (e.g. avifFile/pngFile/mimeType).
      const rawImage = value.image as Partial<CacheImage> | undefined;
      cache[key] = {
        ...value,
        image: rawImage ? { originUrl: rawImage.originUrl ?? '', width: rawImage.width ?? 0, height: rawImage.height ?? 0 } : undefined
      };
    }
    return cache;
  } catch {
    return {};
  }
}

async function saveCache(cache: CacheFile): Promise<void> {
  const sorted: CacheFile = {};
  for (const key of Object.keys(cache).sort((a, b) => a.localeCompare(b))) {
    const entry = { ...cache[key], urls: [...cache[key].urls].sort() };
    if (!entry.image) delete entry.image;
    if (!entry.noInTheBoxImage) delete entry.noInTheBoxImage;
    sorted[key] = entry;
  }

  const yaml = YAML.dump(sorted, { noRefs: true, lineWidth: 120, sortKeys: false });
  await fs.writeFile(CACHE_PATH, yaml, 'utf8');
}

async function loadManualUrls(): Promise<string[]> {
  try {
    const content = await fs.readFile(MANUAL_PATH, 'utf8');
    const parsed = YAML.load(content);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
  } catch {
    return [];
  }
}

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  await browser.close();
}

// store.ui.com occasionally blocks plain fetch() requests (403) behind bot
// protection. Fall back to a real headless browser for those cases.
async function fetchTextViaBrowser(url: string): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return await page.content();
  } finally {
    await context.close();
  }
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } catch (error) {
    console.warn(`  fetch blocked (${(error as Error).message}), retrying with browser: ${url}`);
    return fetchTextViaBrowser(url);
  }
}

async function downloadBinary(url: string, accept: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') || '' };
}

function parseNextData(html: string): { props?: { pageProps?: Record<string, unknown> } } {
  const match = html.match(NEXT_DATA_RE);
  if (!match) throw new Error('No __NEXT_DATA__ JSON found in page source');
  return JSON.parse(match[1]) as { props?: { pageProps?: Record<string, unknown> } };
}

function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();
}

function getProductDescription(product: ApiProduct): string {
  const shortDescription = (product.shortDescription || '').trim();
  if (shortDescription) return shortDescription;
  const fullDescription = (product.description || '').trim();
  if (fullDescription) return stripHtml(fullDescription);
  return '';
}

// store.ui.com titles often lead with a generic category word (e.g. "Camera G6
// PTZ"); shortTitle is the condensed form ("G6 PTZ") without it.
function getProductTitle(product: ApiProduct, fallback: string): string {
  const shortTitle = (product.shortTitle || '').trim();
  if (shortTitle) return shortTitle;
  return (product.title || product.name || fallback).trim();
}

// pdf-lib's Helvetica (WinAnsi/CP1252) can't encode some typographic unicode
// characters scraped from the store (e.g. U+2011 non-breaking hyphen, U+200E
// left-to-right mark).
const TEXT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-'],
  [/[\u2018\u2019\u201A\u201B]/g, "'"],
  [/[\u201C\u201D\u201E\u201F]/g, '"'],
  [/\u2026/g, '...'],
  [/\u00A0/g, ' '],
  [/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '']
];

function sanitizeText(input: string): string {
  return TEXT_REPLACEMENTS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

function buildServiceUrl(originUrl: string): string {
  const encoded = encodeURIComponent(originUrl);
  // Full quality: generate-full-pdf.ts is responsible for downscaling on the
  // fly if the assembled PDF ever gets too large to commit.
  return `https://images.svc.ui.com/?u=${encoded}&q=75&w=3840&f=png`;
}

function slugifyModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

// The image for a model always lives at images/<slugified-model>.png.
function pngPathFor(modelKey: string): string {
  return path.join(IMAGES_DIR, `${slugifyModel(modelKey)}.png`);
}

function buildVariantUrl(subcategoryId: string, productSlug: string, variantSlug: string): string {
  return `${BASE_URL}/category/${subcategoryId}/products/${productSlug}?variant=${variantSlug}`;
}

// Multi-pack SKUs (e.g. "-3"/"-5" packs) that ship the same in-the-box
// contents as another SKU. Fold them into the canonical model instead of
// listing them separately.
const MODEL_ALIASES: Record<string, string> = {
  'UAP-AC-M-5-US': 'UAP-AC-M-US',
  'UVC-AI-DSLR-LD': 'UVC-AI-DSLR',
  'USW-Flex-3': 'USW-Flex',
  'USW-Flex-Mini-3': 'USW-Flex-Mini',
  'USW-Flex-Mini-5': 'USW-Flex-Mini',
  'UVC-G5-Bullet-3': 'UVC-G5-Bullet',
  'UVC-G5-Dome-3': 'UVC-G5-Dome'
};

function getModelKey(product: ApiProduct, variant: ApiVariant, fallbackSlug: string): string {
  const candidate = variant.sku || variant.displaySku || product.displaySku || product.slug || fallbackSlug;
  const trimmed = candidate.trim();
  return MODEL_ALIASES[trimmed] ?? trimmed;
}

function pickInTheBoxItem(product: ApiProduct, variant: ApiVariant): InTheBoxImage | null {
  const items = product.whatsInTheBoxMedia?.items ?? [];
  if (items.length === 0) return null;

  const variantItemIds = variant.whatsInTheBoxMediaItemIds ?? [];
  const sourceItems = variantItemIds.length > 0 ? items.filter((item) => item.id && variantItemIds.includes(item.id)) : items;

  const candidates = sourceItems
    .map((item) => item.data)
    .filter((data): data is NonNullable<ApiMediaItem['data']> => !!data?.url);

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  const best = candidates[0];

  return {
    url: best.url as string,
    width: best.width ?? 0,
    height: best.height ?? 0
  };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;

  async function next(): Promise<void> {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    await worker(items[index]);
    return next();
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
}

type Tally = { new: number; updated: number; skipped: number; error: number };

async function upsertModel(
  modelKey: string,
  url: string,
  product: ApiProduct,
  variant: ApiVariant,
  cache: CacheFile,
  tally: Tally
): Promise<void> {
  const existing = cache[modelKey];

  const productName = sanitizeText(product.name?.trim() || modelKey);
  const productTitle = sanitizeText(getProductTitle(product, modelKey));
  const productDescription = sanitizeText(getProductDescription(product));
  const mergedUrls = Array.from(new Set([...(existing?.urls ?? []), url]));

  if (existing) {
    existing.urls = mergedUrls;
    existing.productName = productName;
    existing.productTitle = productTitle;
    existing.productDescription = productDescription;
    existing.productId = product.id ?? existing.productId;

    if (!FORCE) {
      if (existing.noInTheBoxImage) {
        tally.skipped += 1;
        return;
      }
      if (existing.image && (await fileExists(pngPathFor(modelKey)))) {
        tally.skipped += 1;
        return;
      }
    }
  }

  const inTheBox = pickInTheBoxItem(product, variant);
  if (!inTheBox) {
    if (!existing?.noInTheBoxImage) console.warn(`  no in-the-box image for ${modelKey} (${url})`);
    cache[modelKey] = {
      model: modelKey,
      productName,
      productTitle,
      productDescription,
      productId: product.id ?? existing?.productId,
      noInTheBoxImage: true,
      urls: mergedUrls,
      updatedAt: new Date().toISOString()
    };
    tally.error += 1;
    return;
  }

  const pngPath = pngPathFor(modelKey);
  const png = await downloadBinary(buildServiceUrl(inTheBox.url), 'image/png,image/*,*/*;q=0.8');
  await fs.writeFile(pngPath, png.bytes);

  const wasNew = !existing;
  cache[modelKey] = {
    model: modelKey,
    productName,
    productTitle,
    productDescription,
    productId: product.id,
    image: {
      originUrl: inTheBox.url,
      width: inTheBox.width,
      height: inTheBox.height
    },
    urls: mergedUrls,
    updatedAt: new Date().toISOString()
  };

  if (wasNew) tally.new += 1;
  else tally.updated += 1;
}

async function discoverProductRefs(): Promise<Map<string, string>> {
  const refs = new Map<string, string>();

  for (const categorySlug of TOP_LEVEL_CATEGORIES) {
    try {
      const html = await fetchText(`${BASE_URL}/category/${categorySlug}`);
      const data = parseNextData(html);
      const subCategories = (data.props?.pageProps?.subCategories as Array<{ id?: string; products?: ApiProduct[] }>) ?? [];

      let count = 0;
      for (const sub of subCategories) {
        if (!sub.id) continue;
        for (const product of sub.products ?? []) {
          if (product.slug && !refs.has(product.slug)) {
            refs.set(product.slug, sub.id);
            count += 1;
          }
        }
      }
      console.log(`${categorySlug}: ${subCategories.length} subcategories, ${count} new product slugs`);
    } catch (error) {
      console.warn(`Failed to load category ${categorySlug}: ${(error as Error).message}`);
    }
  }

  return refs;
}

async function fetchCollectionProducts(subcategoryId: string, slug: string): Promise<ApiProduct[]> {
  const html = await fetchText(`${BASE_URL}/category/${subcategoryId}/products/${slug}`);
  const data = parseNextData(html);
  const pageProps = data.props?.pageProps as
    | { collection?: { products?: ApiProduct[] }; data?: { product?: ApiProduct } }
    | undefined;

  const collectionProducts = pageProps?.collection?.products;
  if (Array.isArray(collectionProducts) && collectionProducts.length > 0) return collectionProducts;

  const single = pageProps?.data?.product;
  if (single) return [single];

  return [];
}

async function processProductPage(subcategoryId: string, slug: string, cache: CacheFile, tally: Tally): Promise<void> {
  let products: ApiProduct[];
  try {
    products = await fetchCollectionProducts(subcategoryId, slug);
  } catch (error) {
    console.warn(`Failed to load product page ${slug}: ${(error as Error).message}`);
    tally.error += 1;
    return;
  }

  for (const product of products) {
    const productSlug = product.slug || slug;
    const variants = product.variants && product.variants.length > 0 ? product.variants : [{ slug: productSlug }];

    for (const variant of variants) {
      const variantSlug = variant.slug || productSlug;
      const url = buildVariantUrl(subcategoryId, productSlug, variantSlug);
      const modelKey = getModelKey(product, variant, productSlug);
      await upsertModel(modelKey, url, product, variant, cache, tally);
    }
  }
}

type ManualRef = { subcategoryId: string; slug: string; variant: string | null };

function parseProductUrl(url: string): ManualRef | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const productsIdx = parts.lastIndexOf('products');
    if (productsIdx === -1 || productsIdx + 1 >= parts.length) return null;

    const slug = parts[productsIdx + 1];
    const categoryIdx = parts.indexOf('category');
    const subcategoryId = categoryIdx !== -1 && categoryIdx + 1 < parts.length ? parts[categoryIdx + 1] : slug;

    return { subcategoryId, slug, variant: parsed.searchParams.get('variant') };
  } catch {
    return null;
  }
}

async function processManualUrls(cache: CacheFile, tally: Tally): Promise<void> {
  const manualUrls = await loadManualUrls();
  if (manualUrls.length === 0) return;

  console.log(`Processing ${manualUrls.length} manual.yaml url(s)...`);

  for (const url of manualUrls) {
    const alreadyKnown = Object.values(cache).some((entry) => entry.urls.includes(url));
    if (alreadyKnown && !FORCE) {
      const entry = Object.values(cache).find((candidate) => candidate.urls.includes(url));
      if (entry && (entry.noInTheBoxImage || (entry.image && (await fileExists(pngPathFor(entry.model)))))) {
        console.log(`  skip (already cached): ${url}`);
        continue;
      }
    }

    const ref = parseProductUrl(url);
    if (!ref) {
      console.warn(`  could not parse manual url: ${url}`);
      tally.error += 1;
      continue;
    }

    let products: ApiProduct[];
    try {
      products = await fetchCollectionProducts(ref.subcategoryId, ref.slug);
    } catch (error) {
      console.warn(`  failed to fetch manual url ${url}: ${(error as Error).message}`);
      tally.error += 1;
      continue;
    }

    for (const product of products) {
      const productSlug = product.slug || ref.slug;
      if (products.length > 1 && productSlug !== ref.slug) continue;

      const variants = product.variants && product.variants.length > 0 ? product.variants : [{ slug: productSlug }];
      const matching = ref.variant ? variants.filter((v) => v.slug === ref.variant) : variants;
      const targets = matching.length > 0 ? matching : variants;

      for (const variant of targets) {
        const variantSlug = variant.slug || productSlug;
        const canonicalUrl = ref.variant ? url : buildVariantUrl(ref.subcategoryId, productSlug, variantSlug);
        const modelKey = getModelKey(product, variant, productSlug);
        await upsertModel(modelKey, canonicalUrl, product, variant, cache, tally);
      }
    }
  }
}

async function writeSiteProducts(cache: CacheFile): Promise<void> {
  await fs.mkdir(path.dirname(SITE_PRODUCTS_PATH), { recursive: true });

  const list = Object.values(cache)
    .map((entry) => {
      const imagePath = entry.image ? `/images/${slugifyModel(entry.model)}.png` : null;
      return {
        model: entry.model,
        name: entry.productTitle || entry.productName,
        description: entry.productDescription,
        image: imagePath,
        pdfImage: imagePath,
        width: entry.image?.width ?? 0,
        height: entry.image?.height ?? 0,
        noImage: !entry.image,
        url: [...entry.urls].sort((a, b) => a.length - b.length)[0]
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));

  await fs.writeFile(SITE_PRODUCTS_PATH, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
}

async function main(): Promise<void> {
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const cache = await loadCache();
  const tally: Tally = { new: 0, updated: 0, skipped: 0, error: 0 };

  console.log('Discovering products from category pages...');
  const refs = await discoverProductRefs();
  console.log(`Discovered ${refs.size} unique product page slugs.`);

  const entries = Array.from(refs.entries());
  let processed = 0;

  await runWithConcurrency(entries, CONCURRENCY, async ([slug, subcategoryId]) => {
    await processProductPage(subcategoryId, slug, cache, tally);
    processed += 1;
    if (processed % 25 === 0 || processed === entries.length) {
      console.log(`  processed ${processed}/${entries.length} product pages...`);
    }
  });

  await processManualUrls(cache, tally);

  await saveCache(cache);
  await writeSiteProducts(cache);
  await closeBrowser();

  console.log('');
  console.log(
    `Done. new=${tally.new} updated=${tally.updated} skipped=${tally.skipped} errors=${tally.error} totalModels=${
      Object.keys(cache).length
    }`
  );
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
