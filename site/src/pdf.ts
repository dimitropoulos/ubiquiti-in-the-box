import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Product } from './types';

// pdf-lib's Helvetica (WinAnsi/CP1252) can't encode some typographic unicode
// characters (e.g. U+2011 non-breaking hyphen, U+200E left-to-right mark), so
// normalize before drawing.
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

function splitWrappedLines(text: string, maxWidth: number, font: PDFFont, size: number): string[] {
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

const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 36;

function drawIndexPages(pdf: PDFDocument, products: Product[], fontRegular: PDFFont, fontBold: PDFFont): void {
  const contentWidth = PAGE_WIDTH - MARGIN * 2;
  const columnGap = 28;
  const columnWidth = (contentWidth - columnGap) / 2;
  const bulletIndent = 14;
  const titleSize = 20;
  const nameSize = 10.5;
  const lineHeight = nameSize + 3;
  const entryGap = 4;

  let page: PDFPage;
  let columnY: [number, number];

  function startPage(withTitle: boolean): void {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let top = PAGE_HEIGHT - MARGIN;
    if (withTitle) {
      page.drawText('Contents', { x: MARGIN, y: top - titleSize, size: titleSize, font: fontBold });
      top -= titleSize + 16;
    }
    columnY = [top, top];
  }

  startPage(true);

  for (const product of products) {
    const lines = splitWrappedLines(`${product.name} (${product.model})`, columnWidth - bulletIndent, fontRegular, nameSize);
    const blockHeight = lines.length * lineHeight + entryGap;

    let column: 0 | 1 = columnY[0] >= columnY[1] ? 0 : 1;
    if (columnY[column] - blockHeight < MARGIN) {
      column = column === 0 ? 1 : 0;
      if (columnY[column] - blockHeight < MARGIN) {
        startPage(false);
        column = 0;
      }
    }

    const x = MARGIN + column * (columnWidth + columnGap);
    let y = columnY[column];

    page.drawText('\u2022', { x, y: y - nameSize, size: nameSize, font: fontBold });
    for (const line of lines) {
      page.drawText(line, { x: x + bulletIndent, y: y - nameSize, size: nameSize, font: fontRegular });
      y -= lineHeight;
    }

    columnY[column] = y - entryGap;
  }
}

export async function generatePdf(products: Product[], onProgress?: (index: number, total: number) => void): Promise<Uint8Array> {
  const sanitized = products.map((product) => ({
    ...product,
    name: sanitizeText(product.name),
    model: sanitizeText(product.model),
    description: sanitizeText(product.description)
  }));

  const pdf = await PDFDocument.create();
  const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  drawIndexPages(pdf, sanitized, fontRegular, fontBold);

  const pageWidth = PAGE_WIDTH;
  const pageHeight = PAGE_HEIGHT;
  const margin = 18;

  for (const [index, product] of sanitized.entries()) {
    onProgress?.(index + 1, sanitized.length);

    if (!product.pdfImage) continue;

    const page = pdf.addPage([pageWidth, pageHeight]);

    const titleSize = 24;
    const subtitleSize = 14;
    const descSize = 12;
    const lineGap = 6;
    const contentWidth = pageWidth - margin * 2;

    let currentY = pageHeight - margin;

    currentY -= titleSize;
    page.drawText(product.name, { x: margin, y: currentY, size: titleSize, font: fontBold });

    currentY -= subtitleSize + lineGap;
    page.drawText(product.model, { x: margin, y: currentY, size: subtitleSize, font: fontRegular });

    if (product.description) {
      currentY -= descSize + 4;
      const descLines = splitWrappedLines(product.description, contentWidth, fontRegular, descSize);
      for (const line of descLines) {
        page.drawText(line, { x: margin, y: currentY, size: descSize, font: fontRegular });
        currentY -= descSize + 3;
      }
    }

    const response = await fetch(product.pdfImage);
    const bytes = await response.arrayBuffer();
    const image = await pdf.embedPng(bytes);

    const availableTop = currentY - 8;
    const availableBottom = margin;
    const availableHeight = availableTop - availableBottom;
    const availableWidth = contentWidth;

    const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;

    const imageX = margin + (availableWidth - drawWidth) / 2;
    const imageY = availableBottom + (availableHeight - drawHeight) / 2;

    page.drawImage(image, { x: imageX, y: imageY, width: drawWidth, height: drawHeight });
  }

  return pdf.save();
}

export function downloadBytes(bytes: Uint8Array, filename: string, mimeType: string): void {
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
