import fs from 'fs/promises';
import path from 'path';
import { chromium, type Page } from 'playwright';

type OrderEntry = {
  orderUrl: string;
  itemUrls: string[];
};

const ROOT = process.cwd();
const ACCOUNT_URL = 'https://store.ui.com/us/en/account';
const LOGIN_URL_HINT = 'https://account.ui.com/login';
const SOURCES_PATH = path.join(ROOT, 'sources.yaml');
const PROFILE_DIR = path.join(ROOT, '.playwright-profile-ui-store');

const ORDER_URL_HINTS = ['/account/order', '/account/orders', '/orders/', '/order/'];
const PRODUCT_URL_PATH_HINT = '/products/';

function normalizeText(input: string | undefined | null): string {
  return (input ?? '').replace(/\s+/g, ' ').trim();
}

function toAbs(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function toNormalizedProductUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base);
    if (!/store\.ui\.com$/i.test(url.hostname)) return null;
    if (!url.pathname.toLowerCase().includes(PRODUCT_URL_PATH_HINT)) return null;

    const keepVariant = url.searchParams.get('variant');
    url.search = '';
    if (keepVariant) {
      url.searchParams.set('variant', keepVariant);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function parseNextDataFromHtml(html: string): unknown {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as unknown;
  } catch {
    return null;
  }
}

function collectProductUrlsFromUnknown(value: unknown, baseUrl: string, out: Set<string>): void {
  if (!value) return;
  if (typeof value === 'string') {
    const normalized = toNormalizedProductUrl(value, baseUrl);
    if (normalized) out.add(normalized);
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
    const abs = toAbs(baseUrl, value);
    if (ORDER_URL_HINTS.some((hint) => abs.toLowerCase().includes(hint))) {
      out.add(abs);
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

function serializeSourcesYaml(orders: OrderEntry[]): string {
  const lines: string[] = [];
  lines.push('orders:');

  for (const order of orders) {
    lines.push(`  - orderUrl: ${order.orderUrl}`);
    if (order.itemUrls.length === 0) {
      lines.push('    itemUrls: []');
      continue;
    }

    lines.push('    itemUrls:');
    for (const itemUrl of order.itemUrls) {
      lines.push(`      - ${itemUrl}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function openAccountOrders(page: Page): Promise<void> {
  await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded' });

  const clickMatchingControl = async (pattern: RegExp): Promise<boolean> => {
    const candidates = page.locator('button, a, [role="button"]');
    const count = await candidates.count().catch(() => 0);

    for (let i = 0; i < count; i += 1) {
      const el = candidates.nth(i);
      const text = normalizeText(await el.textContent().catch(() => ''));
      const aria = normalizeText(await el.getAttribute('aria-label').catch(() => ''));
      if (!pattern.test(text) && !pattern.test(aria)) continue;

      console.log(`Clicking control: ${text || aria || '(unnamed)'}`);
      await el.scrollIntoViewIfNeeded().catch(() => undefined);
      await el.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1200);
      return true;
    }

    return false;
  };

  const clicked = (await clickMatchingControl(/view full history/i)) || (await clickMatchingControl(/order history/i));
  if (!clicked) return;

  await page
    .waitForFunction(
      () => {
        const orderLinks = document.querySelectorAll('a[href*="/order/"]');
        const moreButtons = Array.from(document.querySelectorAll('button, a, [role="button"]')).some((el) => {
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
          return /view more|load more|show more|more/.test(text) || /view more|load more|show more|more/.test(aria);
        });
        return orderLinks.length > 0 || moreButtons;
      },
      { timeout: 15000 }
    )
    .catch(() => undefined);
}

async function waitForOrdersPageOrManualLogin(page: Page): Promise<void> {
  const isLoginPage = () => page.url().toLowerCase().startsWith(LOGIN_URL_HINT);
  const isOrdersPage = () => {
    const url = page.url().toLowerCase();
    return url.includes('/account') || url.includes('/order/');
  };

  if (isLoginPage()) {
    console.log(`Redirected to login: ${LOGIN_URL_HINT}`);
    console.log('Please sign in and navigate back to your account orders page. Waiting...');
  }

  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    if (isOrdersPage() && !isLoginPage()) return;
    await page.waitForTimeout(1000);
  }

  throw new Error('Timed out waiting for the account orders page after login.');
}

async function collectOrderUrls(page: Page): Promise<string[]> {
  const urls = new Set<string>();

  let noProgressIterations = 0;

  for (let i = 0; i < 80; i += 1) {
    const beforeCount = urls.size;

    // Collect order links visible in DOM.
    const hrefs = await page
      .$$eval('a[href]', (anchors) => anchors.map((a) => (a as HTMLAnchorElement).href).filter(Boolean))
      .catch(() => [] as string[]);

    for (const href of hrefs) {
      const abs = toAbs(page.url(), href);
      if (ORDER_URL_HINTS.some((hint) => abs.toLowerCase().includes(hint))) {
        urls.add(abs);
      }
    }

    // Also collect hidden/non-rendered order URLs from __NEXT_DATA__.
    const html = await page.content();
    const nextData = parseNextDataFromHtml(html);
    collectOrderUrlsFromUnknown(nextData, page.url(), urls);

    const afterCount = urls.size;
    if (afterCount > beforeCount) {
      noProgressIterations = 0;
      console.log(`Discovered ${afterCount} order urls so far...`);
    } else {
      noProgressIterations += 1;
    }

    // Try "view more" / "load more" controls first.
    const moreButton = page
      .getByRole('button', { name: /view more|load more|show more|more/i })
      .first();
    const moreLink = page
      .getByRole('link', { name: /view more|load more|show more|more/i })
      .first();

    if (await moreButton.isVisible().catch(() => false)) {
      const disabled = await moreButton.isDisabled().catch(() => false);
      if (!disabled) {
        await moreButton.click().catch(() => undefined);
        await page.waitForTimeout(1200);
        continue;
      }
    }

    if (await moreLink.isVisible().catch(() => false)) {
      await moreLink.click().catch(() => undefined);
      await page.waitForTimeout(1200);
      continue;
    }

    // Fallback to classic pagination "next" controls.
    const nextButton = page.getByRole('button', { name: /next/i }).first();
    const nextLink = page.getByRole('link', { name: /next/i }).first();

    if (await nextButton.isVisible().catch(() => false)) {
      const disabled = await nextButton.isDisabled().catch(() => true);
      if (!disabled) {
        await nextButton.click().catch(() => undefined);
        await page.waitForTimeout(1200);
        continue;
      }
    }

    if (await nextLink.isVisible().catch(() => false)) {
      await nextLink.click().catch(() => undefined);
      await page.waitForTimeout(1200);
      continue;
    }

    // Infinite lists can need a little scrolling to expose "more".
    await page.mouse.wheel(0, 2000).catch(() => undefined);
    await page.waitForTimeout(600);

    if (noProgressIterations >= 4) {
      break;
    }
  }

  return Array.from(urls);
}

async function collectOrderItemUrls(page: Page, orderUrl: string): Promise<string[]> {
  await page.goto(orderUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const itemUrls = new Set<string>();

  const domHrefs = await page
    .$$eval('main a[href], [role="main"] a[href], a[href]', (anchors) =>
      anchors.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
    )
    .catch(() => [] as string[]);

  for (const href of domHrefs) {
    const normalized = toNormalizedProductUrl(href, orderUrl);
    if (normalized) itemUrls.add(normalized);
  }

  const html = await page.content();
  const nextData = parseNextDataFromHtml(html);

  collectProductUrlsFromUnknown(nextData, orderUrl, itemUrls);

  return Array.from(itemUrls).sort((a, b) => a.localeCompare(b));
}

async function dumpCandidateControls(page: Page): Promise<void> {
  const controls = await page
    .$$eval('button, a, [role="button"]', (els) =>
      els
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
          href: (el as HTMLAnchorElement).href || '',
          aria: el.getAttribute('aria-label') || ''
        }))
        .filter((x) => /order|view|more|detail/i.test(`${x.text} ${x.href} ${x.aria}`))
    )
    .catch(() => [] as Array<{ tag: string; text: string; href: string; aria: string }>);

  console.log('Candidate controls:');
  for (const c of controls.slice(0, 40)) {
    console.log(`- [${c.tag}] ${c.text || '(no text)'} ${c.href ? `| ${c.href}` : ''} ${c.aria ? `| aria=${c.aria}` : ''}`.trim());
  }
}

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1400, height: 900 }
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    console.log('Opening account history. If needed, sign in in the browser window.');
    await openAccountOrders(page);
    await waitForOrdersPageOrManualLogin(page);

    console.log('Collecting order URLs from full history...');
    const orderUrls = await collectOrderUrls(page);
    console.log(`Found ${orderUrls.length} order page URLs.`);

    if (orderUrls.length === 0) {
      await dumpCandidateControls(page);
      console.log('No order URLs were found. Not writing sources.yaml.');
      process.exitCode = 1;
      return;
    }

    const orders: OrderEntry[] = [];
    const allUrls = new Set<string>();

    for (const [index, orderUrl] of orderUrls.entries()) {
      process.stdout.write(`Processing order ${index + 1}/${orderUrls.length} ... `);
      try {
        const itemUrls = await collectOrderItemUrls(page, orderUrl);
        for (const itemUrl of itemUrls) allUrls.add(itemUrl);
        orders.push({ orderUrl, itemUrls });
        console.log(`ok (${itemUrls.length} item urls)`);
      } catch (error) {
        console.log(`error (${String((error as Error)?.message || error)})`);
      }
    }

    if (orders.length === 0) {
      console.log('No orders were collected. Not writing sources.yaml.');
      process.exitCode = 1;
      return;
    }

    const yaml = serializeSourcesYaml(orders);
    await fs.writeFile(SOURCES_PATH, yaml, 'utf8');

    console.log('');
    console.log(`Done. orders=${orders.length} unique item urls=${allUrls.size}`);
    console.log(`Wrote ${path.relative(ROOT, SOURCES_PATH)}`);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exitCode = 1;
});
