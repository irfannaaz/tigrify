/* Tigrify — tool registry. Every tool runs entirely in the browser; files never leave the device. */
(function () {
  'use strict';

  const ext = (name) => (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
  const base = (name) => name.replace(/\.[^.]+$/, '') || name;
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico', 'heic', 'heif'];
  const MAX_PIXELS = 50e6;

  const is = {
    image: (f) => f.type.startsWith('image/') || IMAGE_EXTS.includes(ext(f.name)),
    heic: (f) => ['heic', 'heif'].includes(ext(f.name)) || /^image\/hei[cf]/.test(f.type),
    pdf: (f) => f.type === 'application/pdf' || ext(f.name) === 'pdf',
    srt: (f) => ext(f.name) === 'srt',
    vtt: (f) => ext(f.name) === 'vtt',
    subs: (f) => ['srt', 'vtt'].includes(ext(f.name)),
    csv: (f) => ['csv', 'tsv'].includes(ext(f.name)),
    json: (f) => ext(f.name) === 'json',
    zip: (f) => ext(f.name) === 'zip',
    any: () => true,
  };

  class ToolError extends Error {}

  /* ---------- image helpers ---------- */

  // The HEIC decoder (3 MB) is only downloaded when the first HEIC file shows up.
  let heicLoader = null;
  function loadHeic() {
    if (window.HeicTo) return Promise.resolve(window.HeicTo);
    if (!heicLoader) {
      heicLoader = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/heic-to.js';
        s.onload = () => (window.HeicTo ? resolve(window.HeicTo) : reject(new Error('missing')));
        s.onerror = reject;
        document.head.append(s);
      }).catch(() => {
        heicLoader = null;
        throw new ToolError('The HEIC decoder could not be loaded — check your connection and try again.');
      });
    }
    return heicLoader;
  }

  async function decodeImage(file) {
    if (is.heic(file)) {
      // Safari decodes HEIC natively; everywhere else uses the bundled decoder.
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* not native */ }
      const heicTo = await loadHeic();
      try {
        return await heicTo({ blob: file, type: 'bitmap', options: { imageOrientation: 'from-image' } });
      } catch (_) {
        throw new ToolError('This HEIC photo could not be decoded (it may be damaged or a format variant that isn\'t supported).');
      }
    }
    if (!(ext(file.name) === 'svg' || file.type === 'image/svg+xml')) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (_) { /* fall back to <img> below */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!img.naturalWidth) { img.width = 1024; img.height = 1024; }
      const w = img.naturalWidth || 1024, h = img.naturalHeight || 1024;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      return c;
    } catch (_) {
      throw new ToolError('This image could not be decoded by your browser.');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Draws a source image onto a new canvas, applying resize, rotation, flips and an optional background.
  function render(src, { width, height, rotate = 0, flipH = false, flipV = false, background = null } = {}) {
    const sw = src.width, sh = src.height;
    const w = Math.max(1, Math.round(width || sw)), h = Math.max(1, Math.round(height || sh));
    if (w * h > MAX_PIXELS) throw new ToolError(`Output would be ${(w * h / 1e6).toFixed(0)} MP; the limit is ${MAX_PIXELS / 1e6} MP.`);
    const quarter = rotate % 180 !== 0;
    const c = document.createElement('canvas');
    c.width = quarter ? h : w;
    c.height = quarter ? w : h;
    const ctx = c.getContext('2d');
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(src, -w / 2, -h / 2, w, h);
    return c;
  }

  function encodeBMP(canvas) {
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const row = Math.ceil((w * 3) / 4) * 4;
    const size = 54 + row * h;
    const dv = new DataView(new ArrayBuffer(size));
    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);
    dv.setUint32(2, size, true); dv.setUint32(10, 54, true); dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true); dv.setInt32(22, h, true);
    dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
    dv.setUint32(34, row * h, true); dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);
    for (let y = 0; y < h; y++) {
      let o = 54 + (h - 1 - y) * row;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        dv.setUint8(o++, px[i + 2]); dv.setUint8(o++, px[i + 1]); dv.setUint8(o++, px[i]);
      }
    }
    return new Blob([dv.buffer], { type: 'image/bmp' });
  }

  const FORMATS = {
    png: { mime: 'image/png', ext: 'png', alpha: true },
    jpeg: { mime: 'image/jpeg', ext: 'jpg', alpha: false, lossy: true },
    webp: { mime: 'image/webp', ext: 'webp', alpha: true, lossy: true },
    bmp: { mime: 'image/bmp', ext: 'bmp', alpha: false },
  };

  function sameFormat(file) {
    const e = ext(file.name);
    if (e === 'jpg' || e === 'jpeg') return 'jpeg';
    if (e === 'webp' || e === 'bmp' || e === 'png') return e;
    if (is.heic(file)) return 'jpeg';
    return 'png';
  }

  // Small preview for images the browser can't show directly in an <img> (HEIC outside Safari).
  async function thumbUrl(file, size = 220) {
    const src = await decodeImage(file);
    const k = Math.min(1, size / Math.max(src.width, src.height));
    const c = render(src, { width: src.width * k, height: src.height * k, background: '#fff' });
    if (src.close) src.close();
    return URL.createObjectURL(await encode(c, 'jpeg', 80));
  }

  async function encode(canvas, format, quality = 90) {
    if (format === 'bmp') return encodeBMP(canvas);
    const f = FORMATS[format];
    const blob = await new Promise((res) => canvas.toBlob(res, f.mime, quality / 100));
    if (!blob || (blob.type && blob.type !== f.mime)) throw new ToolError(`Your browser cannot write ${f.ext.toUpperCase()} images.`);
    return blob;
  }

  // Shared pipeline for every single-image tool.
  async function imageJob(file, format, quality, geometry, suffix) {
    const fmt = format === 'same' ? sameFormat(file) : format;
    const src = await decodeImage(file);
    const canvas = render(src, { ...geometry(src), background: FORMATS[fmt].alpha ? null : '#ffffff' });
    if (src.close) src.close();
    const blob = await encode(canvas, fmt, quality);
    return { name: `${base(file.name)}${suffix}.${FORMATS[fmt].ext}`, blob, from: file };
  }

  function fitMaxSide(src, max) {
    if (!max || Math.max(src.width, src.height) <= max) return {};
    const k = max / Math.max(src.width, src.height);
    return { width: src.width * k, height: src.height * k };
  }

  /* ---------- PDF helpers ---------- */

  async function loadPdf(file) {
    try {
      return await PDFLib.PDFDocument.load(await file.arrayBuffer());
    } catch (e) {
      if (/encrypt/i.test(String(e))) throw new ToolError('This PDF is password-protected.');
      throw new ToolError('This PDF could not be read.');
    }
  }

  async function savePdf(doc, name, from) {
    const bytes = await doc.save();
    return { name, blob: new Blob([bytes], { type: 'application/pdf' }), from };
  }

  // Parses "1-3, 5, 8-" into zero-based page indices.
  function parseRange(text, count) {
    const t = String(text || '').trim();
    if (!t) return [...Array(count).keys()];
    const out = [];
    for (const part of t.split(',')) {
      const m = part.trim().match(/^(\d*)\s*(-?)\s*(\d*)$/);
      if (!m || (!m[1] && !m[3])) throw new ToolError(`"${part.trim()}" is not a valid page range.`);
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? (m[3] ? +m[3] : count) : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (i < 1 || i > count) throw new ToolError(`Page ${i} does not exist (this PDF has ${count} page${count === 1 ? '' : 's'}).`);
        out.push(i - 1);
      }
    }
    return out;
  }

  async function loadPdfJs(file) {
    try {
      return await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    } catch (e) {
      throw new ToolError(/password/i.test(String(e)) ? 'This PDF is password-protected.' : 'This PDF could not be read.');
    }
  }

  /* ---------- subtitle helpers ---------- */

  const STAMP = /(?:(\d{1,2}):)?(\d{2}):(\d{2})([,.])(\d{3})/g;
  const toMs = (h, m, s, ms) => ((+h || 0) * 3600 + +m * 60 + +s) * 1000 + +ms;
  function fromMs(t, sep) {
    t = Math.max(0, Math.round(t));
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(Math.floor(t / 3600000))}:${p(Math.floor(t / 60000) % 60)}:${p(Math.floor(t / 1000) % 60)}${sep}${p(t % 1000, 3)}`;
  }
  const readText = async (file) => (await file.text()).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const textBlob = (s, type = 'text/plain') => new Blob([s], { type: `${type};charset=utf-8` });

  /* ---------- CSV helpers ---------- */

  function parseCSV(text, delim) {
    const rows = []; let row = []; let field = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0] !== '');
  }

  function detectDelimiter(text) {
    const first = text.split('\n', 1)[0];
    return [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  }

  const csvCell = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  /* ---------- the tools ---------- */

  const imageFormatOption = (withSame) => ({
    key: 'format', label: 'Output format', type: 'select', default: withSame ? 'same' : 'png',
    choices: [...(withSame ? [['same', 'Same as original']] : []), ['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'], ['bmp', 'BMP']],
  });
  const qualityOption = (def = 90) => ({
    key: 'quality', label: 'Quality', type: 'range', min: 10, max: 100, step: 1, default: def, unit: '%',
    show: (o) => o.format === 'jpeg' || o.format === 'webp' || o.format === 'same',
  });

  const TOOLS = [
    // Images
    {
      id: 'heic-to-jpg', group: 'Images', name: 'HEIC → JPG', icon: '📱',
      desc: 'Turn iPhone photos (HEIC/HEIF) into JPGs that open everywhere. Keeps full resolution and the right orientation.',
      accepts: is.heic, mode: 'each',
      options: [
        { key: 'format', label: 'Output format', type: 'select', default: 'jpeg', choices: [['jpeg', 'JPG (works everywhere)'], ['png', 'PNG (lossless, bigger)'], ['webp', 'WebP (smallest)']] },
        { ...qualityOption(92), show: (o) => o.format !== 'png' },
      ],
      run: (f, o) => imageJob(f, o.format, o.quality, () => ({}), ''),
    },
    {
      id: 'convert-image', group: 'Images', name: 'Convert image', icon: '⇄',
      desc: 'PNG, JPEG, WebP or BMP from PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ICO or HEIC.',
      accepts: is.image, mode: 'each',
      options: [imageFormatOption(false), qualityOption(), { key: 'maxSide', label: 'Max side (px, 0 = keep)', type: 'number', min: 0, max: 20000, default: 0 }],
      run: (f, o) => imageJob(f, o.format, o.quality, (s) => fitMaxSide(s, +o.maxSide), ''),
    },
    {
      id: 'resize-image', group: 'Images', name: 'Resize image', icon: '⤢',
      desc: 'Scale by longest side, exact width or a percentage.',
      accepts: is.image, mode: 'each',
      options: [
        { key: 'by', label: 'Resize by', type: 'select', default: 'max', choices: [['max', 'Longest side'], ['width', 'Width'], ['percent', 'Percent']] },
        { key: 'value', label: 'Value', type: 'number', min: 1, max: 20000, default: 1600 },
        imageFormatOption(true), qualityOption(),
      ],
      run: (f, o) => imageJob(f, o.format, o.quality, (s) => {
        const v = +o.value;
        if (o.by === 'percent') return { width: (s.width * v) / 100, height: (s.height * v) / 100 };
        if (o.by === 'width') return { width: v, height: (s.height * v) / s.width };
        return { width: (s.width * v) / Math.max(s.width, s.height), height: (s.height * v) / Math.max(s.width, s.height) };
      }, '-resized'),
    },
    {
      id: 'rotate-image', group: 'Images', name: 'Rotate & flip', icon: '↻',
      desc: 'Turn by 90°, 180° or 270° and mirror horizontally or vertically.',
      accepts: is.image, mode: 'each',
      options: [
        { key: 'rotate', label: 'Rotate', type: 'select', default: '90', choices: [['0', 'None'], ['90', '90° clockwise'], ['180', '180°'], ['270', '90° counter-clockwise']] },
        { key: 'flipH', label: 'Mirror horizontally', type: 'checkbox', default: false },
        { key: 'flipV', label: 'Mirror vertically', type: 'checkbox', default: false },
        imageFormatOption(true), qualityOption(),
      ],
      run: (f, o) => imageJob(f, o.format, o.quality, () => ({ rotate: +o.rotate, flipH: o.flipH, flipV: o.flipV }), '-rotated'),
    },
    {
      id: 'compress-image', group: 'Images', name: 'Compress image', icon: '◫',
      desc: 'Smaller JPEG or WebP files. Also strips EXIF/location metadata.',
      accepts: is.image, mode: 'each',
      options: [
        { key: 'format', label: 'Output format', type: 'select', default: 'webp', choices: [['webp', 'WebP (smallest)'], ['jpeg', 'JPEG (most compatible)']] },
        { key: 'quality', label: 'Quality', type: 'range', min: 10, max: 100, step: 1, default: 72, unit: '%' },
        { key: 'maxSide', label: 'Max side (px, 0 = keep)', type: 'number', min: 0, max: 20000, default: 2560 },
      ],
      run: async (f, o) => {
        const r = await imageJob(f, o.format, o.quality, (s) => fitMaxSide(s, +o.maxSide), '-small');
        const pct = Math.round((1 - r.blob.size / f.size) * 100);
        r.note = pct > 0 ? `−${pct}% smaller` : `${-pct}% larger — try a lower quality`;
        return r;
      },
    },
    {
      id: 'images-to-pdf', group: 'Images', name: 'Images → PDF', icon: '▤',
      desc: 'Turn photos or scans into one PDF. Rotate, reorder or delete pages below before saving.',
      accepts: is.image, mode: 'all', editor: true,
      options: [
        { key: 'page', label: 'Page size', type: 'select', default: 'a4', choices: [['fit', 'Same as image'], ['a4', 'A4'], ['letter', 'US Letter']] },
        { key: 'orientation', label: 'Orientation', type: 'select', default: 'auto', choices: [['auto', 'Automatic'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], show: (o) => o.page !== 'fit' },
        { key: 'margin', label: 'Margin', type: 'select', default: '0', choices: [['0', 'No margin'], ['8', 'Small (8 mm)'], ['20', 'Big (20 mm)']] },
        { key: 'name', label: 'File name', type: 'text', default: 'images.pdf' },
      ],
      run: async (files, o, ctx) => {
        const { buildPdf, pdfName } = window.Tigrify.editor;
        const items = o.__items || files.map((file) => ({ file, kind: 'image', page: 0, rotation: 0 }));
        return [await savePdf(await buildPdf(items, o, ctx), pdfName(o.name, 'images'))];
      },
    },

    // PDF
    {
      id: 'merge-pdf', group: 'PDF', name: 'Merge PDFs', icon: '⊕',
      desc: 'Join every PDF into one, in list order. Use ↑ ↓ to reorder.',
      accepts: is.pdf, mode: 'all',
      options: [{ key: 'name', label: 'File name', type: 'text', default: 'merged.pdf' }],
      run: async (files, o) => {
        if (files.length < 2) throw new ToolError('Add at least two PDFs to merge.');
        const out = await PDFLib.PDFDocument.create();
        for (const f of files) {
          const src = await loadPdf(f);
          (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
        }
        return [await savePdf(out, /\.pdf$/i.test(o.name) ? o.name : `${o.name || 'merged'}.pdf`)];
      },
    },
    {
      id: 'split-pdf', group: 'PDF', name: 'Split PDF', icon: '✂',
      desc: 'One PDF per page.',
      accepts: is.pdf, mode: 'each', options: [],
      run: async (f) => {
        const src = await loadPdf(f);
        const n = src.getPageCount();
        const out = [];
        for (let i = 0; i < n; i++) {
          const d = await PDFLib.PDFDocument.create();
          d.addPage((await d.copyPages(src, [i]))[0]);
          out.push(await savePdf(d, `${base(f.name)}-page-${String(i + 1).padStart(String(n).length, '0')}.pdf`, f));
        }
        return out;
      },
    },
    {
      id: 'extract-pages', group: 'PDF', name: 'Pick pages', icon: '☰',
      desc: 'Keep only the pages you list, in that order — also reorders or removes pages.',
      accepts: is.pdf, mode: 'each',
      options: [{ key: 'range', label: 'Pages (e.g. 1-3, 5, 9-)', type: 'text', default: '1' }],
      run: async (f, o) => {
        const src = await loadPdf(f);
        const d = await PDFLib.PDFDocument.create();
        (await d.copyPages(src, parseRange(o.range, src.getPageCount()))).forEach((p) => d.addPage(p));
        return savePdf(d, `${base(f.name)}-pages.pdf`, f);
      },
    },
    {
      id: 'rotate-pdf', group: 'PDF', name: 'Rotate PDF', icon: '⟳',
      desc: 'Rotate all pages, or just the ones you list.',
      accepts: is.pdf, mode: 'each',
      options: [
        { key: 'deg', label: 'Rotate', type: 'select', default: '90', choices: [['90', '90° clockwise'], ['180', '180°'], ['270', '90° counter-clockwise']] },
        { key: 'range', label: 'Pages (blank = all)', type: 'text', default: '' },
      ],
      run: async (f, o) => {
        const doc = await loadPdf(f);
        const pages = doc.getPages();
        for (const i of new Set(parseRange(o.range, pages.length))) {
          pages[i].setRotation(PDFLib.degrees((pages[i].getRotation().angle + +o.deg) % 360));
        }
        return savePdf(doc, `${base(f.name)}-rotated.pdf`, f);
      },
    },
    {
      id: 'page-numbers', group: 'PDF', name: 'Add page numbers', icon: '#',
      desc: 'Stamp page numbers on every page.',
      accepts: is.pdf, mode: 'each',
      options: [
        { key: 'pos', label: 'Position', type: 'select', default: 'bc', choices: [['bc', 'Bottom centre'], ['br', 'Bottom right'], ['tr', 'Top right']] },
        { key: 'format', label: 'Format', type: 'select', default: 'n', choices: [['n', '1'], ['nofm', '1 of 12'], ['page', 'Page 1']] },
        { key: 'size', label: 'Font size', type: 'number', min: 6, max: 48, default: 11 },
      ],
      run: async (f, o) => {
        const doc = await loadPdf(f);
        const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const pages = doc.getPages();
        const size = +o.size;
        pages.forEach((p, i) => {
          const label = o.format === 'nofm' ? `${i + 1} of ${pages.length}` : o.format === 'page' ? `Page ${i + 1}` : `${i + 1}`;
          const { width, height } = p.getSize();
          const tw = font.widthOfTextAtSize(label, size);
          const pad = 24;
          const x = o.pos === 'bc' ? (width - tw) / 2 : width - tw - pad;
          const y = o.pos === 'tr' ? height - pad - size : pad;
          p.drawText(label, { x, y, size, font, color: PDFLib.rgb(0.2, 0.2, 0.2) });
        });
        return savePdf(doc, `${base(f.name)}-numbered.pdf`, f);
      },
    },
    {
      id: 'pdf-to-images', group: 'PDF', name: 'PDF → images', icon: '▦',
      desc: 'Render every page as a PNG or JPEG.',
      accepts: is.pdf, mode: 'each',
      options: [
        { key: 'format', label: 'Format', type: 'select', default: 'png', choices: [['png', 'PNG'], ['jpeg', 'JPEG']] },
        { key: 'dpi', label: 'Resolution (DPI)', type: 'select', default: '150', choices: [['72', '72 — screen'], ['150', '150 — standard'], ['300', '300 — print']] },
      ],
      run: async (f, o) => {
        const pdf = await loadPdfJs(f);
        if (pdf.numPages > 300) throw new ToolError('PDFs over 300 pages are not supported here.');
        const out = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: +o.dpi / 72 });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          if (c.width * c.height > MAX_PIXELS) throw new ToolError('Page is too large at this resolution; pick a lower DPI.');
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          // 'print' intent renders without requestAnimationFrame, so it keeps going in background tabs.
          await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
          const blob = await encode(c, o.format, 92);
          out.push({ name: `${base(f.name)}-page-${String(i).padStart(String(pdf.numPages).length, '0')}.${FORMATS[o.format].ext}`, blob, from: f });
          page.cleanup();
        }
        await pdf.destroy();
        return out;
      },
    },
    {
      id: 'pdf-text', group: 'PDF', name: 'Extract text', icon: '¶',
      desc: 'Pull the existing text layer out as a .txt file (no OCR for scans).',
      accepts: is.pdf, mode: 'each', options: [],
      run: async (f) => {
        const pdf = await loadPdfJs(f);
        const parts = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const tc = await (await pdf.getPage(i)).getTextContent();
          parts.push(tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').trim());
        }
        await pdf.destroy();
        const text = parts.join('\n\n\f\n\n');
        if (!text.replace(/\f/g, '').trim()) throw new ToolError('No text layer found — this PDF is probably a scan.');
        return { name: `${base(f.name)}.txt`, blob: textBlob(text), from: f };
      },
    },

    // Subtitles
    {
      id: 'srt-to-vtt', group: 'Text & data', name: 'SRT → VTT', icon: '⌨',
      desc: 'SubRip subtitles to WebVTT for the web.',
      accepts: is.srt, mode: 'each', options: [],
      run: async (f) => {
        const s = await readText(f);
        if (!s.includes('-->')) throw new ToolError('No subtitle timestamps found.');
        const body = s.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').trim();
        return { name: `${base(f.name)}.vtt`, blob: textBlob(`WEBVTT\n\n${body}\n`, 'text/vtt'), from: f };
      },
    },
    {
      id: 'vtt-to-srt', group: 'Text & data', name: 'VTT → SRT', icon: '⌨',
      desc: 'WebVTT to SubRip. Positioning settings and styles are dropped.',
      accepts: is.vtt, mode: 'each', options: [],
      run: async (f) => {
        const s = await readText(f);
        if (!/^WEBVTT/.test(s)) throw new ToolError('Not a WebVTT file (missing WEBVTT header).');
        const cues = [];
        for (const block of s.split(/\n{2,}/).slice(1)) {
          const lines = block.trim().split('\n');
          const at = lines.findIndex((l) => l.includes('-->'));
          if (at < 0 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
          const stamps = [...lines[at].matchAll(STAMP)].slice(0, 2).map((m) => fromMs(toMs(m[1], m[2], m[3], m[5]), ','));
          if (stamps.length < 2) continue;
          const text = lines.slice(at + 1).join('\n').replace(/<\/?(c|v|lang|ruby|rt)[^>]*>/g, '');
          cues.push(`${cues.length + 1}\n${stamps[0]} --> ${stamps[1]}\n${text}`);
        }
        if (!cues.length) throw new ToolError('No subtitle cues found.');
        return { name: `${base(f.name)}.srt`, blob: textBlob(cues.join('\n\n') + '\n'), from: f };
      },
    },
    {
      id: 'shift-subs', group: 'Text & data', name: 'Shift subtitles', icon: '⏱',
      desc: 'Fix out-of-sync subtitles by moving every cue earlier or later.',
      accepts: is.subs, mode: 'each',
      options: [{ key: 'ms', label: 'Shift (ms, negative = earlier)', type: 'number', min: -3600000, max: 3600000, default: 1000 }],
      run: async (f, o) => {
        const s = await readText(f);
        const shifted = s.split('\n').map((line) => (line.includes('-->')
          ? line.replace(STAMP, (_, h, m, sec, sep, ms) => fromMs(toMs(h, m, sec, ms) + +o.ms, sep))
          : line)).join('\n');
        return { name: `${base(f.name)}-shifted.${ext(f.name)}`, blob: textBlob(shifted), from: f };
      },
    },
    {
      id: 'csv-to-json', group: 'Text & data', name: 'CSV → JSON', icon: '{}',
      desc: 'Spreadsheet rows to a JSON array of objects. Delimiter is detected.',
      accepts: is.csv, mode: 'each',
      options: [{ key: 'numbers', label: 'Convert numbers', type: 'checkbox', default: true }],
      run: async (f, o) => {
        const s = await readText(f);
        const rows = parseCSV(s, ext(f.name) === 'tsv' ? '\t' : detectDelimiter(s));
        if (rows.length < 1) throw new ToolError('The file is empty.');
        const head = rows[0].map((h, i) => h.trim() || `column${i + 1}`);
        const data = rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => {
          const v = r[i] ?? '';
          return [h, o.numbers && v.trim() !== '' && !isNaN(v) && !/^0\d/.test(v.trim()) ? Number(v) : v];
        })));
        return { name: `${base(f.name)}.json`, blob: textBlob(JSON.stringify(data, null, 2), 'application/json'), from: f };
      },
    },
    {
      id: 'json-to-csv', group: 'Text & data', name: 'JSON → CSV', icon: '▥',
      desc: 'A JSON array of objects to a CSV that opens in Excel.',
      accepts: is.json, mode: 'each', options: [],
      run: async (f) => {
        let data;
        try { data = JSON.parse(await readText(f)); } catch (_) { throw new ToolError('This is not valid JSON.'); }
        if (!Array.isArray(data)) data = Object.values(data).find(Array.isArray) || [data];
        const keys = [...new Set(data.flatMap((r) => (r && typeof r === 'object' ? Object.keys(r) : ['value'])))];
        const lines = [keys.map(csvCell).join(',')].concat(data.map((r) => keys.map((k) => csvCell(r && typeof r === 'object' ? r[k] : r)).join(',')));
        return { name: `${base(f.name)}.csv`, blob: textBlob('﻿' + lines.join('\r\n') + '\r\n', 'text/csv'), from: f };
      },
    },

    // Any file
    {
      id: 'zip', group: 'Any file', name: 'Make ZIP', icon: '🗜',
      desc: 'Pack all files into one compressed archive.',
      accepts: is.any, mode: 'all',
      options: [{ key: 'name', label: 'Archive name', type: 'text', default: 'archive.zip' }],
      run: async (files, o) => {
        const z = new JSZip();
        const used = new Set();
        for (const f of files) {
          let n = f.name, i = 2;
          while (used.has(n.toLowerCase())) n = `${base(f.name)} (${i++})${f.name.includes('.') ? '.' + ext(f.name) : ''}`;
          used.add(n.toLowerCase());
          z.file(n, f, { date: new Date(f.lastModified) });
        }
        const blob = await z.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        return [{ name: /\.zip$/i.test(o.name) ? o.name : `${o.name || 'archive'}.zip`, blob }];
      },
    },
    {
      id: 'unzip', group: 'Any file', name: 'Unzip', icon: '📂',
      desc: 'Extract every file from a ZIP archive.',
      accepts: is.zip, mode: 'each', options: [],
      run: async (f) => {
        let z;
        try { z = await JSZip.loadAsync(f); } catch (_) { throw new ToolError('Not a readable ZIP (encrypted ZIPs are unsupported).'); }
        const entries = Object.values(z.files).filter((e) => !e.dir);
        if (entries.length > 2000) throw new ToolError('Archive has more than 2000 files.');
        const out = [];
        for (const e of entries) out.push({ name: e.name.split('/').pop(), path: e.name, blob: await e.async('blob'), from: f });
        if (!out.length) throw new ToolError('The archive is empty.');
        return out;
      },
    },
    {
      id: 'checksum', group: 'Any file', name: 'Checksum', icon: '✓',
      desc: 'SHA-256 (or SHA-1/512) fingerprints to verify downloads.',
      accepts: is.any, mode: 'all',
      options: [{ key: 'algo', label: 'Algorithm', type: 'select', default: 'SHA-256', choices: [['SHA-256', 'SHA-256'], ['SHA-1', 'SHA-1'], ['SHA-512', 'SHA-512']] }],
      run: async (files, o) => {
        if (!crypto.subtle) throw new ToolError('Hashing needs a secure context (open the page from your disk or https).');
        const lines = [];
        for (const f of files) {
          if (f.size > 1024 ** 3) throw new ToolError(`${f.name} is over 1 GB.`);
          const h = await crypto.subtle.digest(o.algo, await f.arrayBuffer());
          lines.push(`${[...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')}  ${f.name}`);
        }
        const tag = o.algo.toLowerCase().replace('-', '');
        return [{ name: files.length === 1 ? `${files[0].name}.${tag}` : `checksums.${tag}`, blob: textBlob(lines.join('\n') + '\n'), preview: lines.join('\n') }];
      },
    },
  ];

  // Quick-wheel presets: one-click actions that run a tool with fixed options.
  const WHEEL = [
    { label: 'JPG', tool: 'heic-to-jpg', opts: { format: 'jpeg' } },
    { label: 'PNG', tool: 'convert-image', opts: { format: 'png' } },
    { label: 'JPG', tool: 'convert-image', opts: { format: 'jpeg' } },
    { label: 'WebP', tool: 'convert-image', opts: { format: 'webp' } },
    { label: 'PDF', tool: 'images-to-pdf' },
    { label: 'Shrink', tool: 'compress-image' },
    { label: 'Rotate', tool: 'rotate-image' },
    { label: 'Merge', tool: 'merge-pdf', min: 2 },
    { label: 'Split', tool: 'split-pdf' },
    { label: 'Images', tool: 'pdf-to-images' },
    { label: 'Text', tool: 'pdf-text' },
    { label: 'VTT', tool: 'srt-to-vtt' },
    { label: 'SRT', tool: 'vtt-to-srt' },
    { label: 'JSON', tool: 'csv-to-json' },
    { label: 'CSV', tool: 'json-to-csv' },
    { label: 'Unzip', tool: 'unzip' },
    { label: 'ZIP', tool: 'zip', min: 2 },
    { label: 'SHA-256', tool: 'checksum' },
  ];

  window.Tigrify = {
    TOOLS, WHEEL, ToolError, ext, base, is,
    // Shared helpers for tools defined in other files.
    img: { decodeImage, render, encode, thumbUrl, loadHeic, MAX_PIXELS },
    pdf: { loadPdf, loadPdfJs, savePdf, parseRange },
    textBlob,
  };
})();
