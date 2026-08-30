import { useEffect, useMemo, useState } from 'react';
import { Checkbox } from '@base-ui/react/checkbox';
import type { Product } from './types';
import { downloadBytes, generatePdf } from './pdf';

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('theme');
    if (stored) return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  return [theme, () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))];
}

export function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [theme, toggleTheme] = useTheme();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'select' | 'review'>('select');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    fetch('products.json')
      .then((res) => res.json())
      .then(setProducts)
      .catch((error) => setStatus(`Failed to load products: ${error.message}`));
  }, []);

  const sorted = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model)),
    [products]
  );

  const visible = useMemo(() => (showAll ? sorted : sorted.filter((product) => !product.noImage)), [sorted, showAll]);

  const selectedProducts = useMemo(
    () => sorted.filter((product) => selected.has(product.model) && !product.noImage),
    [sorted, selected]
  );

  function toggle(model: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  }

  function showToast(message: string) {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? null : current));
    }, 3000);
  }

  function selectAll() {
    setSelected(new Set(products.filter((product) => !product.noImage).map((product) => product.model)));
  }

  function clearAll() {
    setSelected(new Set());
  }

  function toggleShowAll() {
    setShowAll((current) => {
      const next = !current;
      showToast(
        next
          ? 'Listing all items, even those without an "in the box" image.'
          : 'Only showing items with an "in the box" image.'
      );
      return next;
    });
  }

  async function handleGeneratePdf() {
    if (selectedProducts.length === 0) return;

    setBusy(true);
    setStatus(`Building PDF for ${selectedProducts.length} product(s)...`);

    try {
      const bytes = await generatePdf(selectedProducts, (index, total) => {
        setStatus(`Rendering ${index}/${total}: ${selectedProducts[index - 1]?.name ?? ''}`);
      });
      downloadBytes(bytes, 'in-the-box.pdf', 'application/pdf');
      setStatus(`Done. Downloaded PDF with ${selectedProducts.length} product(s).`);
    } catch (error) {
      setStatus(`Error: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="layout" data-view={view}>
      <div className="mobile-tabs">
        <button type="button" className={view === 'select' ? 'is-active' : ''} onClick={() => setView('select')}>
          Select ({selected.size})
        </button>
        <button type="button" className={view === 'review' ? 'is-active' : ''} onClick={() => setView('review')}>
          Review &amp; export
        </button>
      </div>

      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>In The Box</h1>
          <label className="show-all-toggle">
            <Checkbox.Root className="checkbox-root" checked={showAll} onCheckedChange={toggleShowAll}>
              <Checkbox.Indicator className="checkbox-indicator">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 5L4 8L9 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Checkbox.Indicator>
            </Checkbox.Root>
            Show all
          </label>
          <div className="sidebar-actions">
            <button type="button" onClick={selectAll}>
              Select all
            </button>
            <button type="button" onClick={clearAll}>
              Clear
            </button>
          </div>
        </div>

        <ul className="product-list">
          {visible.map((product) => (
            <li key={product.model}>
              <label
                className={`product-row ${selected.has(product.model) ? 'is-selected' : ''} ${
                  product.noImage ? 'is-disabled' : ''
                }`}
                onClick={(event) => {
                  if (!product.noImage) return;
                  event.preventDefault();
                  showToast('This item does not have an in-the-box image.');
                }}
              >
                <Checkbox.Root
                  className="checkbox-root"
                  checked={selected.has(product.model)}
                  disabled={product.noImage}
                  onCheckedChange={() => toggle(product.model)}
                >
                  <Checkbox.Indicator className="checkbox-indicator">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M1 5L4 8L9 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span className="product-text">
                  <span className="product-name">{product.name}</span>
                  <span className="product-model">{product.model}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </aside>

      <main className="content">
        <header className="toolbar">
          <span className="count">{selected.size} selected</span>
          <div className="toolbar-actions">
            <button type="button" onClick={toggleTheme} aria-label="Toggle dark mode">
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
            <button type="button" className="primary" disabled={selected.size === 0 || busy} onClick={handleGeneratePdf}>
              Generate PDF
            </button>
          </div>
        </header>

        <div className="preview">
          {selectedProducts.length === 0 ? (
            <p className="empty-hint">Select products from the sidebar to add them to the PDF.</p>
          ) : (
            <div className="preview-grid">
              {selectedProducts.map((product) => (
                <figure key={product.model} className="preview-card">
                  <a href={product.url} target="_blank" rel="noopener noreferrer" title={`Open ${product.name} on store.ui.com`}>
                    {product.image && <img src={product.image} alt={product.name} loading="lazy" />}
                    <figcaption>
                      <div className="product-name">{product.name}</div>
                      <div className="product-model">{product.model}</div>
                    </figcaption>
                  </a>
                </figure>
              ))}
            </div>
          )}
        </div>
      </main>

      {status && <div className="status">{status}</div>}
    </div>
  );
}
