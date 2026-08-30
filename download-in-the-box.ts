import fs from 'fs/promises';
import path from 'path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as YAML from 'js-yaml';

type Product = {
  id?: string;
  slug?: string;
  name?: string;
  title?: string;
  description?: string;
  shortDescription?: string;
  displaySku?: string;
  shortName?: string;
  shortname?: string;
  sku?: string;
  model?: string;
  variants?: Array<{
    slug?: string;
    title?: string;
    displaySku?: string;
    sku?: string;
    whatsInTheBoxMediaItemIds?: string[];
  }>;
  whatsInTheBoxMedia?: {
    items?: Array<{
      id?: string;
      data?: {
        url?: string;
        width?: number;
        height?: number;
        mimeType?: string;
      };
    }>;
  };
};

type CacheEntry = {
  sourceUrl: string;
  resolvedSourceUrl?: string;
  productSlug: string;
  productTitle: string;
  productName: string;
  productIdDisplay: string;
  productDescription: string;
  productId?: string;
  selectedVariantSlug?: string | null;
  inTheBoxOriginUrl: string;
  inTheBoxWidth: number;
  inTheBoxHeight: number;
  inTheBoxMimeType: string;
  updatedAt: string;
};

type CacheFile = {
  items: Record<string, CacheEntry>;
};

type PageProps = {
  currentProductId?: string;
  collection?: {
    products?: Product[];
  };
  data?: {
    product?: Product;
  };
};

type ProductMediaItem = {
  url: string;
  width: number;
  height: number;
  mimeType: string;
};

type ProcessResult =
  | {
      status: 'ok';
      sourceUrl: string;
      file: string;
      productName: string;
      productTitle: string;
      productIdDisplay: string;
      productDescription: string;
      productSlug: string;
      productId?: string;
      imageUrl: string;
      pdfImageBytes: Uint8Array;
      pdfImageMime: string;
    }
  | {
      status: 'skip';
      sourceUrl: string;
      reason: string;
      file?: string;
    }
  | {
      status: 'error';
      sourceUrl: string;
      error: string;
    };

const ROOT = process.cwd();
const SOURCES_PATH = path.join(ROOT, 'sources.yaml');
const OVERRIDES_PATH = path.join(ROOT, 'overrides.yaml');
const CACHE_PATH = path.join(ROOT, 'product-cache.yaml');
const IMAGES_DIR = path.join(ROOT, 'images');
const OUTPUT_PDF = path.join(IMAGES_DIR, 'in-the-box.pdf');
const FORCE = process.argv.includes('--force');

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

function parseSourcesYaml(yaml: string): string[] {
  const matches = yaml.match(/https:\/\/store\.ui\.com\/[^\s"']+/g) ?? [];
  const dedup = new Set<string>();

  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;]+$/g, '');
    if (!cleaned.includes('/products/')) continue;
    dedup.add(cleaned);
  }

  return Array.from(dedup);
}

function loadCacheFile(content: string): CacheFile {
  const parsed = YAML.load(content);
  if (!parsed || typeof parsed !== 'object') {
    return { items: {} };
  }

  const maybeItems = (parsed as { items?: unknown }).items;
  if (!maybeItems || typeof maybeItems !== 'object') {
    return { items: {} };
  }

  return { items: maybeItems as Record<string, CacheEntry> };
}

function serializeCacheFile(cache: CacheFile): string {
  return YAML.dump(cache, {
    noRefs: true,
    lineWidth: 120,
    sortKeys: false
  });
}

async function loadOverrides(): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(OVERRIDES_PATH, 'utf8');
    const parsed = YAML.load(content);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key.trim(), (value as string).trim()])
        .filter(([key, value]) => key && value)
    );
  } catch {
    return {};
  }
}

function resolveSourceUrl(sourceUrl: string, overrides: Record<string, string>): string {
  return overrides[sourceUrl] || sourceUrl;
}

async function loadCache(): Promise<CacheFile> {
  try {
    const content = await fs.readFile(CACHE_PATH, 'utf8');
    return loadCacheFile(content);
  } catch {
    return { items: {} };
  }
}

async function saveCache(cache: CacheFile): Promise<void> {
  await fs.writeFile(CACHE_PATH, serializeCacheFile(cache), 'utf8');
}

function parseNextData(html: string): { props?: { pageProps?: PageProps } } {
  const match = html.match(NEXT_DATA_RE);
  if (!match) {
    throw new Error('No __NEXT_DATA__ JSON found in page source');
  }
  return JSON.parse(match[1]) as { props?: { pageProps?: PageProps } };
}

function getVariantFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('variant');
  } catch {
    return null;
  }
}

function getFallbackSlugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'unknown-product';
  } catch {
    return 'unknown-product';
  }
}

function toDisplayIdFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((segment, index) => {
      if (index === 0 || /^[a-z]{1,4}$/.test(segment)) return segment.toUpperCase();
      if (/^[0-9]+$/.test(segment)) return segment;
      return segment.charAt(0).toUpperCase() + segment.slice(1);
    })
    .join('-');
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

function getProductTitle(product: Product, fallbackSlug: string): string {
  return (product.title || '').trim() || (product.name || '').trim() || fallbackSlug;
}

function getProductName(product: Product, fallbackSlug: string): string {
  return product.name?.trim() || fallbackSlug;
}

function getProductDisplayId(product: Product, fallbackSlug: string): string {
  const candidate =
    product.displaySku ||
    product.shortName ||
    product.shortname ||
    product.sku ||
    product.model ||
    product.name ||
    product.slug ||
    fallbackSlug;

  if (!candidate) return 'UNKNOWN-PRODUCT';
  if (candidate.includes('-') && candidate === candidate.toLowerCase()) {
    return toDisplayIdFromSlug(candidate);
  }
  return candidate;
}

function getProductDescription(product: Product): string {
  const shortDescription = (product.shortDescription || '').trim();
  if (shortDescription) return shortDescription;

  const fullDescription = (product.description || '').trim();
  if (fullDescription) return stripHtml(fullDescription);

  return '';
}

function buildServiceUrl(originUrl: string, format: 'avif' | 'png'): string {
  const encoded = encodeURIComponent(originUrl);
  return `https://images.svc.ui.com/?u=${encoded}&q=75&w=3840&f=${format}`;
}

function extFromMime(mime: string): string {
  if (!mime) return '.avif';
  if (mime.includes('avif')) return '.avif';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  return '.img';
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ubiquiti-in-the-box-downloader/2.0)'
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} when fetching page`);
  }
  return res.text();
}

async function downloadBinary(url: string, accept: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ubiquiti-in-the-box-downloader/2.0)',
      accept
    }
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} when downloading image`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, contentType: res.headers.get('content-type') || '' };
}

function collectProductUrlsFromUnknown(value: unknown, baseUrl: string, out: Set<string>): void {
  if (!value) return;
  if (typeof value === 'string') {
    try {
      const url = new URL(value, baseUrl);
      if (!/store\.ui\.com$/i.test(url.hostname)) return;
      if (!url.pathname.toLowerCase().includes('/products/')) return;
      const keepVariant = url.searchParams.get('variant');
      url.search = '';
      if (keepVariant) url.searchParams.set('variant', keepVariant);
      url.hash = '';
      out.add(url.toString());
    } catch {
      return;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProductUrlsFromUnknown(item, baseUrl, out);
    return;
  }
  if (typeof value !== 'object') return;

  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectProductUrlsFromUnknown(nested, baseUrl, out);
  }
}

function collectOrderUrlsFromUnknown(value: unknown, baseUrl: string, out: Set<string>): void {
  if (!value) return;
  if (typeof value === 'string') {
    try {
      const url = new URL(value, baseUrl);
      const href = url.toString().toLowerCase();
      if (href.includes('/order/') || href.includes('/orders/')) out.add(url.toString());
    } catch {
      return;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectOrderUrlsFromUnknown(item, baseUrl, out);
    return;
  }
  if (typeof value !== 'object') return;

  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectOrderUrlsFromUnknown(nested, baseUrl, out);
  }
}

function pickCurrentProduct(pageProps: PageProps | undefined, sourceUrl: string): Product | null {
  const products = pageProps?.collection?.products ?? [];
  const currentId = pageProps?.currentProductId;
  const requestedVariant = getVariantFromUrl(sourceUrl);

  if (products.length > 0) {
    if (requestedVariant) {
      const requested = requestedVariant.toLowerCase();
      const byVariant = products.find((product) => {
        if (product.slug?.toLowerCase() === requested) return true;
        if (product.displaySku?.toLowerCase() === requested) return true;
        if (product.sku?.toLowerCase() === requested) return true;
        return (product.variants ?? []).some((variant) => {
          const slug = variant.slug?.toLowerCase();
          const displaySku = variant.displaySku?.toLowerCase();
          const sku = variant.sku?.toLowerCase();
          return slug === requested || displaySku === requested || sku === requested;
        });
      });
      if (byVariant) return byVariant;
    }

    if (currentId) {
      const byId = products.find((product) => product.id === currentId);
      if (byId) return byId;
    }

    return products[0];
  }

  const single = pageProps?.data?.product;
  if (single && typeof single === 'object') return single;

  return null;
}

function pickSelectedVariant(product: Product, requestedVariant: string | null): { slug?: string; whatsInTheBoxMediaItemIds?: string[] } | null {
  if (!requestedVariant) return null;

  const requested = requestedVariant.toLowerCase();
  const variants = product.variants ?? [];
  return (
    variants.find((variant) => {
      const slug = variant.slug?.toLowerCase();
      const displaySku = variant.displaySku?.toLowerCase();
      const sku = variant.sku?.toLowerCase();
      return slug === requested || displaySku === requested || sku === requested;
    }) ?? null
  );
}

function pickBestInTheBoxItem(
  product: Product,
  selectedVariant: { whatsInTheBoxMediaItemIds?: string[] } | null
): ProductMediaItem | null {
  const items = product.whatsInTheBoxMedia?.items ?? [];
  if (items.length === 0) return null;

  const variantItemIds = selectedVariant?.whatsInTheBoxMediaItemIds ?? [];
  const sourceItems =
    variantItemIds.length > 0
      ? items.filter((item) => item.id && variantItemIds.includes(item.id))
      : items;

  const candidates = sourceItems
    .map((item) => item.data)
    .filter((data): data is ProductMediaItem => !!data?.url && typeof data.url === 'string' && (data.mimeType?.startsWith('image/') ?? true));

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));

  return {
    url: candidates[0].url,
    width: candidates[0].width ?? 0,
    height: candidates[0].height ?? 0,
    mimeType: candidates[0].mimeType ?? 'image/png'
  };
}

function makeCacheEntry(
  sourceUrl: string,
  resolvedSourceUrl: string,
  product: Product,
  selectedVariant: { slug?: string | null; whatsInTheBoxMediaItemIds?: string[] } | null,
  inTheBox: ProductMediaItem,
  fallbackSlug: string
): CacheEntry {
  const requestedVariant = getVariantFromUrl(sourceUrl);
  const productSlug = requestedVariant || product.slug || fallbackSlug;

  return {
    sourceUrl,
    resolvedSourceUrl,
    productSlug,
    productTitle: getProductTitle(product, fallbackSlug),
    productName: getProductName(product, fallbackSlug),
    productIdDisplay: getProductDisplayId(product, productSlug),
    productDescription: getProductDescription(product),
    productId: product.id,
    selectedVariantSlug: selectedVariant?.slug ?? requestedVariant,
    inTheBoxOriginUrl: inTheBox.url,
    inTheBoxWidth: inTheBox.width,
    inTheBoxHeight: inTheBox.height,
    inTheBoxMimeType: inTheBox.mimeType,
    updatedAt: new Date().toISOString()
  };
}

async function processSourceFromCache(sourceUrl: string, cached: CacheEntry): Promise<ProcessResult> {
  const avifUrl = buildServiceUrl(cached.inTheBoxOriginUrl, 'avif');
  const pngUrl = buildServiceUrl(cached.inTheBoxOriginUrl, 'png');

  const [{ bytes: avifBytes, contentType: avifType }, { bytes: pngBytes, contentType: pngType }] = await Promise.all([
    downloadBinary(avifUrl, 'image/avif,image/webp,image/*,*/*;q=0.8'),
    downloadBinary(pngUrl, 'image/png,image/*,*/*;q=0.8')
  ]);

  const extension = extFromMime(avifType || cached.inTheBoxMimeType);
  const outputPath = path.join(IMAGES_DIR, `${cached.productSlug}${extension}`);

  if (!FORCE) {
    try {
      await fs.access(outputPath);
    } catch {
      await fs.writeFile(outputPath, avifBytes);
    }
  } else {
    await fs.writeFile(outputPath, avifBytes);
  }

  return {
    status: 'ok',
    sourceUrl,
    file: outputPath,
    productName: cached.productName,
    productTitle: cached.productTitle,
    productIdDisplay: cached.productIdDisplay,
    productDescription: cached.productDescription,
    productSlug: cached.productSlug,
    productId: cached.productId,
    imageUrl: cached.inTheBoxOriginUrl,
    pdfImageBytes: pngBytes,
    pdfImageMime: pngType || cached.inTheBoxMimeType || 'image/png'
  };
}

async function processSource(sourceUrl: string, cache: CacheFile, overrides: Record<string, string>): Promise<ProcessResult> {
  const resolvedSourceUrl = resolveSourceUrl(sourceUrl, overrides);
  const cached = cache.items[resolvedSourceUrl];

  if (cached && !FORCE) {
    return processSourceFromCache(sourceUrl, cached);
  }

  if (!FORCE && !cached) {
    return {
      status: 'skip',
      sourceUrl,
      reason: 'No cache entry yet; rerun with --force to refresh from the store page'
    };
  }

  const html = await fetchText(resolvedSourceUrl);
  const nextData = parseNextData(html);
  const pageProps = nextData?.props?.pageProps;

  const product = pickCurrentProduct(pageProps, resolvedSourceUrl);
  if (!product) {
    return { status: 'skip', sourceUrl, reason: `No product found in page data for ${resolvedSourceUrl}` };
  }

  const requestedVariant = getVariantFromUrl(resolvedSourceUrl);
  const selectedVariant = pickSelectedVariant(product, requestedVariant);
  const inTheBox = pickBestInTheBoxItem(product, selectedVariant);
  if (!inTheBox) {
    return { status: 'skip', sourceUrl, reason: `No in-the-box image found for ${resolvedSourceUrl}` };
  }

  const fallbackSlug = getFallbackSlugFromUrl(resolvedSourceUrl);
  const cacheEntry = makeCacheEntry(sourceUrl, resolvedSourceUrl, product, selectedVariant, inTheBox, fallbackSlug);
  cache.items[resolvedSourceUrl] = cacheEntry;

  const avifUrl = buildServiceUrl(inTheBox.url, 'avif');
  const pngUrl = buildServiceUrl(inTheBox.url, 'png');

  const [{ bytes: avifBytes, contentType: avifType }, { bytes: pngBytes, contentType: pngType }] = await Promise.all([
    downloadBinary(avifUrl, 'image/avif,image/webp,image/*,*/*;q=0.8'),
    downloadBinary(pngUrl, 'image/png,image/*,*/*;q=0.8')
  ]);

  const extension = extFromMime(avifType || inTheBox.mimeType || cacheEntry.inTheBoxMimeType);
  const outputPath = path.join(IMAGES_DIR, `${cacheEntry.productSlug}${extension}`);

  if (!FORCE) {
    try {
      await fs.access(outputPath);
    } catch {
      await fs.writeFile(outputPath, avifBytes);
    }
  } else {
    await fs.writeFile(outputPath, avifBytes);
  }

  return {
    status: 'ok',
    sourceUrl,
    file: outputPath,
    productName: cacheEntry.productName,
    productTitle: cacheEntry.productTitle,
    productIdDisplay: cacheEntry.productIdDisplay,
    productDescription: cacheEntry.productDescription,
    productSlug: cacheEntry.productSlug,
    productId: cacheEntry.productId,
    imageUrl: cacheEntry.inTheBoxOriginUrl,
    pdfImageBytes: pngBytes,
    pdfImageMime: pngType || cacheEntry.inTheBoxMimeType || 'image/png'
  };
}

function splitWrappedLines(
  text: string,
  maxWidth: number,
  font: { widthOfTextAtSize: (text: string, size: number) => number },
  size: number
): string[] {
  if (!text.trim()) return [];

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, size);

    if (width <= maxWidth || !current) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

async function buildPdf(results: ProcessResult[]): Promise<void> {
  const successful = results.filter((r): r is Extract<ProcessResult, { status: 'ok' }> => r.status === 'ok');
  if (successful.length === 0) return;

  const pdf = await PDFDocument.create();
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 841.89;
  const pageHeight = 595.28;
  const margin = 18;

  for (const item of successful) {
    const page = pdf.addPage([pageWidth, pageHeight]);

    const titleSize = 24;
    const subtitleSize = 14;
    const descSize = 12;
    const lineGap = 6;
    const contentWidth = pageWidth - margin * 2;

    let currentY = pageHeight - margin;

    currentY -= titleSize;
    page.drawText(item.productTitle, {
      x: margin,
      y: currentY,
      size: titleSize,
      font: fontBold
    });

    currentY -= subtitleSize + lineGap;
    page.drawText(item.productIdDisplay, {
      x: margin,
      y: currentY,
      size: subtitleSize,
      font: fontRegular
    });

    if (item.productDescription) {
      currentY -= descSize + 4;
      const descLines = splitWrappedLines(item.productDescription, contentWidth, fontRegular, descSize);
      for (const line of descLines) {
        page.drawText(line, {
          x: margin,
          y: currentY,
          size: descSize,
          font: fontRegular
        });
        currentY -= descSize + 3;
      }
    }

    let image;
    if (item.pdfImageMime.includes('png')) {
      image = await pdf.embedPng(item.pdfImageBytes);
    } else {
      image = await pdf.embedJpg(item.pdfImageBytes);
    }

    const availableTop = currentY - 8;
    const availableBottom = margin;
    const availableHeight = availableTop - availableBottom;
    const availableWidth = contentWidth;

    const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;

    const imageX = margin + (availableWidth - drawWidth) / 2;
    const imageY = availableBottom + (availableHeight - drawHeight) / 2;

    page.drawImage(image, {
      x: imageX,
      y: imageY,
      width: drawWidth,
      height: drawHeight
    });
  }

  const bytes = await pdf.save();
  await fs.writeFile(OUTPUT_PDF, bytes);
}

async function main(): Promise<void> {
  await fs.mkdir(IMAGES_DIR, { recursive: true });

  const yaml = await fs.readFile(SOURCES_PATH, 'utf8');
  const sources = parseSourcesYaml(yaml);
  if (sources.length === 0) {
    console.log('No sources found in sources.yaml');
    return;
  }

  const overrides = await loadOverrides();
  const cache = await loadCache();
  let cacheDirty = false;

  const results: ProcessResult[] = [];
  for (const sourceUrl of sources) {
    const resolvedSourceUrl = resolveSourceUrl(sourceUrl, overrides);
    process.stdout.write(`${resolvedSourceUrl !== sourceUrl ? `Processing ${sourceUrl} -> ${resolvedSourceUrl}` : `Processing ${sourceUrl}`} ... `);
    try {
      const before = cache.items[resolvedSourceUrl];
      const result = await processSource(sourceUrl, cache, overrides);
      const after = cache.items[resolvedSourceUrl];
      if (before !== after) cacheDirty = true;
      results.push(result);

      if (result.status === 'ok') {
        console.log(`saved ${path.relative(ROOT, result.file)}`);
      } else if (result.status === 'skip') {
        console.log(`skipped (${result.reason})`);
      } else {
        console.log(`error (${result.error})`);
      }
    } catch (error) {
      const message = String((error as Error)?.message || error);
      results.push({ status: 'error', sourceUrl, error: message });
      console.log(`error (${message})`);
    }
  }

  if (cacheDirty) {
    await saveCache(cache);
  }

  await buildPdf(results);

  const ok = results.filter((r) => r.status === 'ok').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  const errors = results.filter((r) => r.status === 'error').length;

  console.log('');
  console.log(`Done. downloaded=${ok} skipped=${skipped} errors=${errors} pdf=${path.relative(ROOT, OUTPUT_PDF)}`);

  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
