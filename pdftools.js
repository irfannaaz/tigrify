/* Tiger — more PDF tools: organize, sign, watermark, crop, compress, unlock, repair, PDF → Word. */
(function () {
  'use strict';
  const { TOOLS, ToolError, base, is } = window.Tiger;
  const { encode } = window.Tiger.img;
  const { loadPdf, loadPdfJs, savePdf, parseRange } = window.Tiger.pdf;

  const MM = 72 / 25.4;
  const pdfOrImage = (f) => is.pdf(f) || is.image(f);

  // Renders text with the browser's fonts (so any language works) to a PNG for embedding.
  async function textImage(text, { font = 'bold 140px "Segoe UI", system-ui, sans-serif', color = '#000' } = {}) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = font;
    const m = ctx.measureText(text);
    const pad = 20;
    const h = Math.ceil((m.actualBoundingBoxAscent || 140) + (m.actualBoundingBoxDescent || 40));
    c.width = Math.ceil(m.width) + pad * 2;
    c.height = h + pad * 2;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, pad, pad + (m.actualBoundingBoxAscent || 140));
    return new Uint8Array(await (await encode(c, 'png')).arrayBuffer());
  }

  // Crops a drawing canvas to its inked area.
  function trimCanvas(src) {
    const { width: w, height: h } = src;
    const px = src.getContext('2d').getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const c = document.createElement('canvas');
    c.width = x1 - x0 + 9; c.height = y1 - y0 + 9;
    c.getContext('2d').drawImage(src, x0 - 4, y0 - 4, c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }

  // Redraws every page as a JPEG image — used to compress, unlock or rescue PDFs.
  async function rasterize(file, { dpi, quality, password }, ctx) {
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: password || undefined }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new ToolError(password ? 'That password is not correct.' : 'This PDF needs a password to open — type it in the Password box.');
      throw new ToolError('This PDF could not be read.');
    }
    if (pdf.numPages > 400) throw new ToolError('PDFs over 400 pages are not supported here.');
    const doc = await PDFLib.PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      if (ctx.signal.aborted) throw new ToolError('Cancelled.');
      ctx.fraction((i - 1) / pdf.numPages);
      const page = await pdf.getPage(i);
      const size = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      // 'print' intent renders without requestAnimationFrame, so it keeps going in background tabs.
      await page.render({ canvasContext: g, viewport: vp, intent: 'print' }).promise;
      const jpg = await doc.embedJpg(await (await encode(c, 'jpeg', quality)).arrayBuffer());
      doc.addPage([size.width, size.height]).drawImage(jpg, { x: 0, y: 0, width: size.width, height: size.height });
      page.cleanup();
    }
    await pdf.destroy();
    return doc;
  }

  const pagesToStamp = (doc, range) => {
    const pages = doc.getPages();
    return [...new Set(parseRange(range, pages.length))].map((i) => pages[i]);
  };

  const xmlText = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const PDF_TOOLS = [
    {
      id: 'organize-pdf', group: 'PDF', name: 'Organize PDF', icon: '⊞',
      desc: 'See every page: rotate, reorder, delete — and combine pages from several PDFs and images into one file.',
      accepts: pdfOrImage, mode: 'all', editor: true,
      options: [
        { key: 'page', label: 'Size for image pages', type: 'select', default: 'a4', choices: [['a4', 'A4'], ['letter', 'US Letter'], ['fit', 'Same as image']] },
        { key: 'name', label: 'File name', type: 'text', default: 'organized.pdf' },
      ],
      run: async (files, o, ctx) => {
        const { buildPdf, itemsFor, pdfName } = window.Tiger.editor;
        const items = o.__items || await itemsFor(files);
        return [await savePdf(await buildPdf(items, { ...o, orientation: 'auto', margin: 0 }, ctx), pdfName(o.name, 'organized'))];
      },
    },
    {
      id: 'sign-pdf', group: 'PDF', name: 'Sign PDF', icon: '✍',
      desc: 'Draw or type your signature and place it on the page.',
      accepts: is.pdf, mode: 'each',
      options: [
        { key: 'drawn', label: 'Draw your signature', type: 'signature' },
        { key: 'typed', label: 'Or type your name', type: 'text', default: '' },
        { key: 'where', label: 'Pages', type: 'select', default: 'last', choices: [['last', 'Last page'], ['first', 'First page'], ['all', 'Every page']] },
        { key: 'pos', label: 'Position', type: 'select', default: 'br', choices: [['br', 'Bottom right'], ['bl', 'Bottom left'], ['bc', 'Bottom centre'], ['tr', 'Top right']] },
        { key: 'size', label: 'Size', type: 'select', default: '160', choices: [['110', 'Small'], ['160', 'Medium'], ['220', 'Large']] },
        { key: 'date', label: 'Add today\'s date', type: 'checkbox', default: true },
      ],
      run: async (f, o) => {
        let png;
        if (o.drawn) png = o.drawn;
        else if (o.typed.trim()) png = await textImage(o.typed.trim(), { font: 'italic 120px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive', color: '#14286e' });
        else throw new ToolError('Draw a signature or type your name first.');
        const doc = await loadPdf(f);
        const sig = await doc.embedPng(png);
        const date = o.date ? await doc.embedPng(await textImage(new Date().toLocaleDateString(), { font: '60px "Segoe UI", system-ui, sans-serif', color: '#333' })) : null;
        const pages = doc.getPages();
        const targets = o.where === 'all' ? pages : [o.where === 'first' ? pages[0] : pages[pages.length - 1]];
        for (const p of targets) {
          const { width, height } = p.getSize();
          const w = Math.min(+o.size, width * 0.45);
          const h = (sig.height / sig.width) * w;
          const dh = date ? 11 : 0;
          const dw = date ? (date.width / date.height) * dh : 0;
          const x = o.pos === 'bl' ? 40 : o.pos === 'bc' ? (width - w) / 2 : width - w - 40;
          const y = o.pos === 'tr' ? height - h - 40 : 40 + (date ? dh + 4 : 0);
          p.drawImage(sig, { x, y, width: w, height: h });
          if (date) p.drawImage(date, { x: x + (w - dw) / 2, y: y - dh - 4, width: dw, height: dh });
        }
        return savePdf(doc, `${base(f.name)}-signed.pdf`, f);
      },
    },
    {
      id: 'watermark-pdf', group: 'PDF', name: 'Watermark', icon: '◈',
      desc: 'Stamp text like CONFIDENTIAL or DRAFT across your pages. Works in any language.',
      accepts: is.pdf, mode: 'each',
      options: [
        { key: 'text', label: 'Watermark text', type: 'text', default: 'CONFIDENTIAL' },
        { key: 'layout', label: 'Layout', type: 'select', default: 'diagonal', choices: [['diagonal', 'Big, diagonal'], ['tiled', 'Repeated pattern'], ['footer', 'Small, at the bottom']] },
        { key: 'color', label: 'Colour', type: 'select', default: '#7a7a7a', choices: [['#7a7a7a', 'Grey'], ['#d12f2f', 'Red'], ['#2557c4', 'Blue'], ['#000000', 'Black']] },
        { key: 'opacity', label: 'Opacity', type: 'range', min: 5, max: 100, step: 5, default: 25, unit: '%' },
        { key: 'range', label: 'Pages (blank = all)', type: 'text', default: '' },
      ],
      run: async (f, o) => {
        if (!o.text.trim()) throw new ToolError('Type the watermark text first.');
        const doc = await loadPdf(f);
        const img = await doc.embedPng(await textImage(o.text.trim(), { color: o.color }));
        const ratio = img.height / img.width;
        const opacity = +o.opacity / 100;
        for (const p of pagesToStamp(doc, o.range)) {
          const { width, height } = p.getSize();
          if (o.layout === 'footer') {
            const w = Math.min(width * 0.3, 200);
            p.drawImage(img, { x: (width - w) / 2, y: 18, width: w, height: w * ratio, opacity });
            continue;
          }
          const tiled = o.layout === 'tiled';
          const angle = tiled ? 30 : Math.atan2(height, width) * (180 / Math.PI);
          const w = tiled ? width * 0.32 : Math.hypot(width, height) * 0.6;
          const h = w * ratio;
          const t = (angle * Math.PI) / 180;
          // drawImage rotates around the bottom-left corner; offset so the image centre lands on (cx, cy).
          const place = (cx, cy) => p.drawImage(img, {
            x: cx - (w * Math.cos(t) - h * Math.sin(t)) / 2,
            y: cy - (w * Math.sin(t) + h * Math.cos(t)) / 2,
            width: w, height: h, rotate: PDFLib.degrees(angle), opacity,
          });
          if (!tiled) { place(width / 2, height / 2); continue; }
          for (let y = height * 0.12; y < height; y += height / 4) for (let x = width * 0.18; x < width; x += width / 2.2) place(x, y);
        }
        return savePdf(doc, `${base(f.name)}-watermarked.pdf`, f);
      },
    },
    {
      id: 'crop-pdf', group: 'PDF', name: 'Crop PDF', icon: '⌗',
      desc: 'Trim white margins or cut pages down to the part you need.',
      accepts: is.pdf, mode: 'each',
      options: [
        { key: 'top', label: 'Top (mm)', type: 'number', min: 0, max: 500, default: 10 },
        { key: 'bottom', label: 'Bottom (mm)', type: 'number', min: 0, max: 500, default: 10 },
        { key: 'left', label: 'Left (mm)', type: 'number', min: 0, max: 500, default: 10 },
        { key: 'right', label: 'Right (mm)', type: 'number', min: 0, max: 500, default: 10 },
        { key: 'range', label: 'Pages (blank = all)', type: 'text', default: '' },
      ],
      run: async (f, o) => {
        const doc = await loadPdf(f);
        for (const p of pagesToStamp(doc, o.range)) {
          const box = p.getMediaBox();
          const l = +o.left * MM, r = +o.right * MM, t = +o.top * MM, b = +o.bottom * MM;
          const w = box.width - l - r, h = box.height - t - b;
          if (w < 36 || h < 36) throw new ToolError('Those margins would crop away the whole page.');
          p.setMediaBox(box.x + l, box.y + b, w, h);
          p.setCropBox(box.x + l, box.y + b, w, h);
        }
        return savePdf(doc, `${base(f.name)}-cropped.pdf`, f);
      },
    },
    {
      id: 'compress-pdf', group: 'PDF', name: 'Compress PDF', icon: '◫',
      desc: 'Make scanned or image-heavy PDFs much smaller for email. Pages become images, so text can no longer be selected.',
      accepts: is.pdf, mode: 'each',
      options: [{
        key: 'level', label: 'Compression', type: 'select', default: 'recommended',
        choices: [['light', 'Light — best quality'], ['recommended', 'Recommended'], ['strong', 'Strong — smallest file']],
      }],
      run: async (f, o, ctx) => {
        const [dpi, quality] = { light: [150, 80], recommended: [110, 68], strong: [80, 52] }[o.level];
        const r = await savePdf(await rasterize(f, { dpi, quality }, ctx), `${base(f.name)}-compressed.pdf`, f);
        const pct = Math.round((1 - r.blob.size / f.size) * 100);
        if (pct < 5) throw new ToolError('This PDF is already compact — compressing it would not make it smaller.');
        r.note = `−${pct}% smaller`;
        return r;
      },
    },
    {
      id: 'unlock-pdf', group: 'PDF', name: 'Unlock PDF', icon: '🔓',
      desc: 'Remove the password from a PDF you are allowed to open. The copy is image-based.',
      accepts: is.pdf, mode: 'each',
      options: [{ key: 'password', label: 'Password', type: 'password', default: '' }],
      run: async (f, o, ctx) => savePdf(await rasterize(f, { dpi: 150, quality: 85, password: o.password }, ctx), `${base(f.name)}-unlocked.pdf`, f),
    },
    {
      id: 'repair-pdf', group: 'PDF', name: 'Repair PDF', icon: '✚',
      desc: 'Rescue a damaged PDF that will not open properly.',
      accepts: is.pdf, mode: 'each', options: [],
      run: async (f, o, ctx) => {
        try {
          const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
          const doc = await PDFLib.PDFDocument.create();
          (await doc.copyPages(src, src.getPageIndices())).forEach((p) => doc.addPage(p));
          if (!doc.getPageCount()) throw new Error('no pages');
          return savePdf(doc, `${base(f.name)}-repaired.pdf`, f);
        } catch (_) {
          const r = await savePdf(await rasterize(f, { dpi: 150, quality: 85 }, ctx), `${base(f.name)}-repaired.pdf`, f);
          r.note = 'rebuilt as images';
          return r;
        }
      },
    },
    {
      id: 'pdf-to-word', group: 'PDF', name: 'PDF → Word', icon: 'W',
      desc: 'Get the text of a PDF as an editable Word document (.docx). Layout and pictures are not kept.',
      accepts: is.pdf, mode: 'each', options: [],
      run: async (f, o, ctx) => {
        const pdf = await loadPdfJs(f);
        const body = [];
        let any = false;
        for (let i = 1; i <= pdf.numPages; i++) {
          ctx.fraction((i - 1) / pdf.numPages);
          const tc = await (await pdf.getPage(i)).getTextContent();
          const lines = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('').split('\n');
          if (i > 1) body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
          for (const line of lines) {
            if (line.trim()) any = true;
            body.push(`<w:p><w:r><w:t xml:space="preserve">${xmlText(line)}</w:t></w:r></w:p>`);
          }
        }
        await pdf.destroy();
        if (!any) throw new ToolError('No text found — this PDF is probably a scan.');
        const z = new JSZip();
        z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
        z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
        z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr/></w:body></w:document>`);
        const blob = await z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
        return { name: `${base(f.name)}.docx`, blob, from: f };
      },
    },
  ];

  // The new PDF tools go right after the existing PDF group.
  const after = TOOLS.findIndex((t) => t.group === 'Text & data');
  TOOLS.splice(after, 0, ...PDF_TOOLS);
  window.Tiger.trimCanvas = trimCanvas;
})();
