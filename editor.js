/* Tigrify — visual page editor: thumbnails you can rotate, reorder (drag or arrows) and delete. */
(function () {
  'use strict';
  const { is, ext, ToolError } = window.Tigrify;
  const { decodeImage, render, encode } = window.Tigrify.img;
  const { loadPdf, loadPdfJs, savePdf } = window.Tigrify.pdf;
  const MAX_PAGES = 400;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Stable keys per File object so edits survive when other files are added or removed.
  const fileIds = new WeakMap();
  let nextFileId = 1;
  const fileId = (f) => { if (!fileIds.has(f)) fileIds.set(f, nextFileId++); return fileIds.get(f); };

  // Page thumbnails are cached per file+page; rendering a PDF is the slow part.
  const thumbCache = new Map();

  async function pdfPageCount(file) {
    const key = `${fileId(file)}:count`;
    if (!thumbCache.has(key)) thumbCache.set(key, loadPdfJs(file).then(async (doc) => { const n = doc.numPages; await doc.destroy(); return n; }));
    return thumbCache.get(key);
  }

  function pdfThumb(file, page) {
    const key = `${fileId(file)}:${page}`;
    if (!thumbCache.has(key)) {
      thumbCache.set(key, (async () => {
        const doc = await loadPdfJs(file);
        try {
          const p = await doc.getPage(page + 1);
          const base = p.getViewport({ scale: 1 });
          const vp = p.getViewport({ scale: 220 / Math.max(base.width, base.height) });
          const c = el('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          await p.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
          return URL.createObjectURL(await encode(c, 'jpeg', 80));
        } finally { await doc.destroy(); }
      })());
    }
    return thumbCache.get(key);
  }

  function imageThumb(file) {
    const key = `${fileId(file)}:img`;
    if (!thumbCache.has(key)) thumbCache.set(key, is.heic(file) ? window.Tigrify.img.thumbUrl(file) : Promise.resolve(URL.createObjectURL(file)));
    return thumbCache.get(key);
  }

  // Expands files into one item per page (PDF) or per image.
  async function itemsFor(files) {
    const items = [];
    for (const file of files) {
      if (is.pdf(file)) {
        const n = await pdfPageCount(file);
        for (let i = 0; i < n; i++) items.push({ key: `${fileId(file)}:${i}`, file, kind: 'pdf', page: i, pages: n, rotation: 0 });
      } else if (is.image(file)) {
        items.push({ key: `${fileId(file)}:img`, file, kind: 'image', page: 0, pages: 1, rotation: 0 });
      }
      if (items.length > MAX_PAGES) throw new ToolError(`The editor shows up to ${MAX_PAGES} pages.`);
    }
    return items;
  }

  /* ---------- the editor widget ---------- */

  function mount(host) {
    let items = [];
    let removed = [];
    let dragKey = null;
    let token = 0;

    host.replaceChildren();
    const bar = el('div', 'pe-bar');
    const grid = el('div', 'pe-grid');
    const status = el('p', 'hint pe-status');
    host.append(bar, status, grid);

    const button = (label, title, fn) => {
      const b = el('button', 'ghost', label);
      b.type = 'button'; b.title = title; b.onclick = fn;
      return b;
    };
    const restoreBtn = button('↺ Restore deleted', 'Bring back removed pages', () => { items = items.concat(removed); removed = []; draw(); });
    bar.append(
      button('⟳ Rotate all', 'Rotate every page 90° clockwise', () => { items.forEach((it) => { it.rotation = (it.rotation + 90) % 360; }); draw(); }),
      button('⇅ Reverse', 'Reverse the page order', () => { items.reverse(); draw(); }),
      button('A→Z', 'Sort by file name', () => { items.sort((a, b) => a.file.name.localeCompare(b.file.name, undefined, { numeric: true }) || a.page - b.page); draw(); }),
      restoreBtn,
    );

    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= items.length) return;
      [items[i], items[j]] = [items[j], items[i]];
      draw();
      const card = grid.children[j];
      if (card) card.querySelector(d < 0 ? '[data-act="left"]' : '[data-act="right"]')?.focus();
    }

    function draw() {
      grid.replaceChildren();
      items.forEach((it, i) => {
        const card = el('div', 'pe-card');
        card.draggable = true;
        card.dataset.key = it.key;
        const box = el('div', 'pe-thumb');
        const img = el('img');
        img.alt = '';
        img.style.transform = `rotate(${it.rotation}deg)`;
        box.append(img);
        (it.kind === 'pdf' ? pdfThumb(it.file, it.page) : imageThumb(it.file)).then((url) => { img.src = url; }).catch(() => { box.textContent = ext(it.file.name).toUpperCase(); });
        const num = el('span', 'pe-num', String(i + 1));
        const label = el('div', 'pe-label', it.kind === 'pdf' && it.pages > 1 ? `${it.file.name} · p${it.page + 1}` : it.file.name);
        label.title = label.textContent;
        const acts = el('div', 'pe-acts');
        const act = (sym, name, title, fn, disabled) => {
          const b = el('button', null, sym);
          b.type = 'button'; b.title = title; b.dataset.act = name; b.disabled = !!disabled;
          b.setAttribute('aria-label', `${title} (page ${i + 1})`);
          b.onclick = fn;
          acts.append(b);
        };
        act('⟲', 'ccw', 'Rotate left', () => { it.rotation = (it.rotation + 270) % 360; draw(); });
        act('⟳', 'cw', 'Rotate right', () => { it.rotation = (it.rotation + 90) % 360; draw(); });
        act('◀', 'left', 'Move earlier', () => move(i, -1), i === 0);
        act('▶', 'right', 'Move later', () => move(i, 1), i === items.length - 1);
        act('✕', 'del', 'Delete page', () => { removed.push(...items.splice(i, 1)); draw(); });
        card.append(box, num, label, acts);

        card.addEventListener('dragstart', (e) => { dragKey = it.key; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.key); });
        card.addEventListener('dragend', () => { dragKey = null; card.classList.remove('dragging'); });
        card.addEventListener('dragover', (e) => { if (dragKey) { e.preventDefault(); card.classList.add('over'); } });
        card.addEventListener('dragleave', () => card.classList.remove('over'));
        card.addEventListener('drop', (e) => {
          if (!dragKey) return;
          e.preventDefault();
          e.stopPropagation();
          const from = items.findIndex((x) => x.key === dragKey);
          const to = items.findIndex((x) => x.key === it.key);
          if (from >= 0 && to >= 0 && from !== to) { const [m] = items.splice(from, 1); items.splice(to, 0, m); }
          draw();
        });
        grid.append(card);
      });
      restoreBtn.hidden = !removed.length;
      status.textContent = items.length
        ? `${items.length} page${items.length > 1 ? 's' : ''} · drag to reorder, or use the buttons${removed.length ? ` · ${removed.length} deleted` : ''}`
        : 'All pages deleted — use "Restore deleted" or add files.';
    }

    return {
      // Syncs with the current file list, keeping order and edits for pages that are still there.
      async update(files) {
        const my = ++token;
        status.textContent = 'Loading pages…';
        let fresh;
        try { fresh = await itemsFor(files); } catch (e) { if (my === token) status.textContent = e.message || 'Could not read one of the files.'; return; }
        if (my !== token) return;
        const known = new Map(items.concat(removed).map((it) => [it.key, it]));
        const wanted = new Set(fresh.map((it) => it.key));
        items = items.filter((it) => wanted.has(it.key));
        removed = removed.filter((it) => wanted.has(it.key));
        for (const it of fresh) if (!known.has(it.key)) items.push(it);
        draw();
      },
      items: () => items.map(({ file, kind, page, rotation }) => ({ file, kind, page, rotation })),
    };
  }

  /* ---------- building the PDF ---------- */

  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

  async function embedImage(doc, file, rotation) {
    const e = ext(file.name);
    if (!rotation) {
      const bytes = await file.arrayBuffer();
      if (e === 'jpg' || e === 'jpeg') { const r = await doc.embedJpg(bytes).catch(() => null); if (r) return r; }
      if (e === 'png') { const r = await doc.embedPng(bytes).catch(() => null); if (r) return r; }
    }
    const src = await decodeImage(file);
    const photo = e === 'jpg' || e === 'jpeg' || is.heic(file);
    const blob = await encode(render(src, { rotate: rotation, background: photo ? '#fff' : null }), photo ? 'jpeg' : 'png', 92);
    if (src.close) src.close();
    const bytes = await blob.arrayBuffer();
    return photo ? doc.embedJpg(bytes) : doc.embedPng(bytes);
  }

  // items: [{ file, kind: 'pdf'|'image', page, rotation }]; o: { page, orientation, margin } for image pages.
  async function buildPdf(items, o, ctx) {
    if (!items.length) throw new ToolError('There are no pages to save.');
    const doc = await PDFLib.PDFDocument.create();
    const sources = new Map();
    const m = ((+o.margin || 0) * 72) / 25.4;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (ctx && ctx.signal.aborted) throw new ToolError('Cancelled.');
      if (ctx) ctx.fraction(i / items.length);
      if (it.kind === 'pdf') {
        if (!sources.has(it.file)) sources.set(it.file, await loadPdf(it.file));
        const [p] = await doc.copyPages(sources.get(it.file), [it.page]);
        if (it.rotation) p.setRotation(PDFLib.degrees((p.getRotation().angle + it.rotation) % 360));
        doc.addPage(p);
        continue;
      }
      const img = await embedImage(doc, it.file, it.rotation);
      const iw = img.width, ih = img.height;
      let pw, ph;
      if (!o.page || o.page === 'fit') { pw = iw + 2 * m; ph = ih + 2 * m; } else {
        [pw, ph] = SIZES[o.page];
        const landscape = o.orientation === 'landscape' || (o.orientation !== 'portrait' && iw > ih);
        if (landscape) [pw, ph] = [ph, pw];
      }
      const k = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih, !o.page || o.page === 'fit' ? 1 : Infinity);
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - iw * k) / 2, y: (ph - ih * k) / 2, width: iw * k, height: ih * k });
    }
    return doc;
  }

  const pdfName = (name, fallback) => {
    const n = String(name || '').trim() || fallback;
    return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
  };

  window.Tigrify.editor = { mount, itemsFor, buildPdf, pdfName, savePdf };
})();
