import { buildPdf } from '../../scripts/pdf-shared';
import type { Product } from './types';

export async function generatePdf(products: Product[], onProgress?: (index: number, total: number) => void): Promise<Uint8Array> {
  return buildPdf(
    products,
    async (product) => {
      const response = await fetch(product.pdfImage as string);
      return new Uint8Array(await response.arrayBuffer());
    },
    onProgress
  );
}

export function downloadBytes(bytes: Uint8Array, filename: string, mimeType: string): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

