/* Tiger — interface: file list, tool picker, quick wheel and results. */
(function () {
  'use strict';
  const { TOOLS, WHEEL, ToolError, ext } = window.Tiger;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('tiger.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set: (k, v) => { try { localStorage.setItem('tiger.' + k, JSON.stringify(v)); } catch (_) { /* storage unavailable */ } },
  };

  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const state = { files: [], tool: null, editor: null, results: [], busy: false, abort: null };
  let nextId = 1;

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ---------- files ---------- */
  function addFiles(list) {
    const incoming = [...list].filter((f) => f.size > 0 || f.type);
    if (!incoming.length) return false;
    const room = 500 - state.files.length;
    if (incoming.length > room) toast(`Only the first ${room} files were added (limit 500).`);
    for (const file of incoming.slice(0, room)) {
      const isImg = window.Tiger.is.image(file);
      state.files.push({ id: nextId++, file, url: isImg ? URL.createObjectURL(file) : null });
    }
    renderFiles();
    renderTools();
    return true;
  }

  function removeFile(id) {
    const i = state.files.findIndex((x) => x.id === id);
    if (i < 0) return;
    if (state.files[i].url) URL.revokeObjectURL(state.files[i].url);
    state.files.splice(i, 1);
    renderFiles();
    renderTools();
  }

  function moveFile(id, d) {
    const i = state.files.findIndex((x) => x.id === id);
    const j = i + d;
    if (j < 0 || j >= state.files.length) return;
    [state.files[i], state.files[j]] = [state.files[j], state.files[i]];
    renderFiles();
  }

  function thumb(name, url) {
    const t = el('div', 'thumb');
    if (url) {
      const img = el('img');
      img.src = url; img.alt = ''; img.loading = 'lazy';
      img.onerror = () => { img.remove(); t.textContent = ext(name).slice(0, 4) || 'file'; };
      t.append(img);
    } else t.textContent = ext(name).slice(0, 4) || 'file';
    return t;
  }

  function renderFiles() {
    const list = $('fileList');
    list.replaceChildren();
    state.files.forEach((entry, i) => {
      const li = el('li', 'item');
      const meta = el('div', 'meta');
      meta.append(el('div', 'name', entry.file.name), el('div', 'sub', fmtSize(entry.file.size)));
      meta.firstChild.title = entry.file.name;
      const acts = el('div', 'acts');
      const up = el('button', null, '↑'); up.title = 'Move up'; up.disabled = i === 0; up.onclick = () => moveFile(entry.id, -1);
      const down = el('button', null, '↓'); down.title = 'Move down'; down.disabled = i === state.files.length - 1; down.onclick = () => moveFile(entry.id, 1);
      const rm = el('button', null, '✕'); rm.title = 'Remove'; rm.onclick = () => removeFile(entry.id);
      acts.append(up, down, rm);
      li.append(thumb(entry.file.name, entry.url), meta, acts);
      list.append(li);
    });
    const n = state.files.length;
    $('fileCount').textContent = n;
    $('clearBtn').disabled = !n || state.busy;
    $('wheelBtn').disabled = !wheelItems().length || state.busy;
    document.querySelector('.files').classList.toggle('has-files', n > 0);
  }

  /* ---------- tools ---------- */
  const compatible = (tool) => state.files.filter((x) => tool.accepts(x.file)).map((x) => x.file);

  function renderTools() {
    const root = $('toolGroups');
    root.replaceChildren();
    const groups = [...new Set(TOOLS.map((t) => t.group))];
    const any = state.files.length > 0;
    for (const g of groups) {
      const sec = el('div', 'group');
      sec.append(el('h3', null, g));
      const grid = el('div', 'tool-grid');
      for (const tool of TOOLS.filter((t) => t.group === g)) {
        const n = compatible(tool).length;
        const b = el('button', 'tool');
        b.type = 'button';
        if (any && !n) b.classList.add('dim');
        if (state.tool === tool) b.classList.add('active');
        b.title = tool.desc;
        const ic = el('span', 'ic', tool.icon);
        const tx = el('span');
        tx.append(el('div', 'tn', tool.name), el('div', 'tc', any ? (n ? `${n} file${n > 1 ? 's' : ''}` : 'no matching files') : tool.desc.split(/[.—]/)[0]));
        b.append(ic, tx);
        b.onclick = () => selectTool(tool);
        grid.append(b);
      }
      sec.append(grid);
      root.append(sec);
    }
    const fits = TOOLS.filter((t) => compatible(t).length).length;
    $('toolHint').textContent = any ? `${fits} tool${fits === 1 ? '' : 's'} fit your files` : 'Add files to see what fits';
    if (state.tool) updateRunHint();
    if (state.editor) state.editor.update(compatible(state.tool));
    filterTools();
  }

  // With files added, only tools that fit them are shown (unless "Show all" or a search is active).
  function filterTools() {
    const q = $('toolSearch').value.trim().toLowerCase();
    const onlyFitting = state.files.length > 0 && !state.showAll && !q;
    let hiddenCount = 0;
    for (const b of document.querySelectorAll('.tool')) {
      const t = TOOLS.find((x) => x.name === b.querySelector('.tn').textContent);
      const misfit = onlyFitting && b.classList.contains('dim');
      b.hidden = misfit || (!!q && !`${t.name} ${t.desc} ${t.group}`.toLowerCase().includes(q));
      if (misfit) hiddenCount++;
    }
    for (const g of document.querySelectorAll('.group')) g.hidden = ![...g.querySelectorAll('.tool')].some((b) => !b.hidden);
    const toggle = $('showAll');
    toggle.hidden = !state.files.length || !!q || (!hiddenCount && !state.showAll);
    toggle.textContent = state.showAll ? 'Show only tools for my files' : `Show all tools (${hiddenCount} more)`;
  }

  function selectTool(tool) {
    state.tool = tool;
    $('optTitle').textContent = `${tool.icon}  ${tool.name}`;
    $('optDesc').textContent = tool.desc;
    const fields = $('fields');
    fields.replaceChildren();
    const saved = store.get('opts.' + tool.id, {});
    for (const o of tool.options) {
      if (o.type === 'signature') { fields.append(signaturePad(o)); continue; }
      const value = saved[o.key] ?? o.default;
      const wrap = el('label', o.type === 'checkbox' ? 'field check' : 'field');
      wrap.dataset.key = o.key;
      let input;
      if (o.type === 'select') {
        input = el('select');
        for (const [v, l] of o.choices) { const op = el('option', null, l); op.value = v; input.append(op); }
        input.value = value;
      } else {
        input = el('input');
        input.type = o.type;
        if (o.type === 'checkbox') input.checked = !!value;
        else input.value = value;
        if (o.min != null) input.min = o.min;
        if (o.max != null) input.max = o.max;
        if (o.step != null) input.step = o.step;
      }
      input.name = o.key;
      const caption = el('span', null, o.label);
      if (o.type === 'range') {
        const out = el('b', null, ` ${value}${o.unit || ''}`);
        caption.append(out);
        input.addEventListener('input', () => { out.textContent = ` ${input.value}${o.unit || ''}`; });
      }
      input.addEventListener('input', refreshVisibility);
      input.addEventListener('change', refreshVisibility);
      if (o.type === 'checkbox') wrap.append(input, caption); else wrap.append(caption, input);
      fields.append(wrap);
    }
    if (!tool.options.length) fields.append(el('p', 'hint', 'No settings needed — just run it.'));
    const host = $('editorHost');
    host.hidden = !tool.editor;
    state.editor = tool.editor ? window.Tiger.editor.mount(host) : null;
    if (!tool.editor) host.replaceChildren();
    $('options').hidden = false;
    refreshVisibility();
    renderTools();
    $('options').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // A drawing pad for signatures (mouse, pen or finger).
  function signaturePad(o) {
    const wrap = el('div', 'field wide');
    wrap.dataset.key = o.key;
    const pad = el('canvas', 'sig-pad');
    pad.width = 600; pad.height = 200;
    const g = pad.getContext('2d');
    g.lineWidth = 4; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#14286e';
    let drawing = false;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
    pad.addEventListener('pointerdown', (e) => { drawing = true; pad.setPointerCapture(e.pointerId); g.beginPath(); g.moveTo(...pos(e)); wrap.dataset.dirty = '1'; });
    pad.addEventListener('pointermove', (e) => { if (!drawing) return; g.lineTo(...pos(e)); g.stroke(); });
    pad.addEventListener('pointerup', () => { drawing = false; });
    const clear = el('button', 'ghost', 'Clear');
    clear.type = 'button';
    clear.onclick = () => { g.clearRect(0, 0, pad.width, pad.height); delete wrap.dataset.dirty; };
    const head = el('div', 'sig-head');
    head.append(el('span', null, o.label), clear);
    wrap.append(head, pad);
    wrap.read = () => {
      if (!wrap.dataset.dirty) return '';
      const trimmed = window.Tiger.trimCanvas(pad);
      return trimmed ? trimmed.toDataURL('image/png') : '';
    };
    return wrap;
  }

  function readOptions(tool) {
    const form = $('options');
    const o = {};
    for (const opt of tool.options) {
      if (opt.type === 'signature') { o[opt.key] = $('fields').querySelector(`[data-key="${opt.key}"]`).read(); continue; }
      const input = form.elements[opt.key];
      o[opt.key] = opt.type === 'checkbox' ? input.checked : opt.type === 'number' || opt.type === 'range' ? Number(input.value) : input.value;
    }
    return o;
  }

  function refreshVisibility() {
    const tool = state.tool;
    if (!tool) return;
    const o = readOptions(tool);
    for (const opt of tool.options) {
      const wrap = $('fields').querySelector(`[data-key="${opt.key}"]`);
      if (wrap) wrap.hidden = opt.show ? !opt.show(o) : false;
    }
    updateRunHint();
  }

  function updateRunHint() {
    const tool = state.tool;
    const n = compatible(tool).length;
    const skipped = state.files.length - n;
    $('runBtn').disabled = !n || state.busy;
    $('runHint').textContent = !state.files.length ? 'Add some files first.'
      : !n ? 'None of your files work with this tool.'
      : `Runs on ${n} file${n > 1 ? 's' : ''}${skipped ? ` · ${skipped} skipped` : ''}`;
  }

  /* ---------- running ---------- */
  function defaultsFor(tool) {
    return Object.fromEntries(tool.options.map((o) => [o.key, o.default]));
  }

  async function run(tool, opts) {
    if (state.busy) return;
    const files = compatible(tool);
    if (!files.length) { toast(`No files work with ${tool.name}.`); return; }
    state.busy = true;
    state.abort = new AbortController();
    const { signal } = state.abort;
    setBusy(true);
    const before = state.results.length;
    const jobs = tool.mode === 'all' ? [files] : files.map((f) => [f]);
    for (let i = 0; i < jobs.length && !signal.aborted; i++) {
      const label = `${tool.name} · ${tool.mode === 'all' ? `${files.length} files` : jobs[i][0].name}`;
      progress(i, jobs.length, label);
      // Lets long-running tools (video) report status and progress within the current file.
      const ctx = {
        signal,
        status: (s) => progress(i, jobs.length, `${label} · ${s}`),
        fraction: (p) => progress(i + p, jobs.length, `${label} · ${Math.round(p * 100)}%`),
      };
      await new Promise((r) => setTimeout(r, 0));
      try {
        const out = await tool.run(tool.mode === 'all' ? jobs[i] : jobs[i][0], opts, ctx);
        [].concat(out).forEach(addResult);
      } catch (e) {
        console.error(e);
        const msg = signal.aborted ? 'Cancelled.' : e instanceof ToolError ? e.message : `Failed: ${e && e.message ? e.message : e}`;
        addResult({ name: tool.mode === 'all' ? tool.name : jobs[i][0].name, error: msg });
      }
    }
    progress(jobs.length, jobs.length, signal.aborted ? 'Cancelled' : 'Done');
    state.busy = false;
    state.abort = null;
    setBusy(false);
    setTimeout(() => { if (!state.busy) $('progress').hidden = true; }, 900);
    const made = state.results.slice(before);
    const ok = made.filter((r) => !r.error).length;
    const bad = made.length - ok;
    toast(bad ? `${ok} done, ${bad} failed` : `${ok} file${ok === 1 ? '' : 's'} ready`);
    document.querySelector('.results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function setBusy(b) {
    $('runBtn').textContent = b ? 'Working…' : 'Run';
    $('cancelBtn').disabled = !b;
    renderFiles();
    if (state.tool) updateRunHint();
  }

  function progress(done, total, text) {
    $('progress').hidden = false;
    $('bar').style.width = `${(done / total) * 100}%`;
    $('progressText').textContent = total > 1 ? `${Math.min(Math.floor(done) + 1, total)}/${total} · ${text}` : text;
  }

  function uniqueName(name) {
    const taken = new Set(state.results.filter((r) => !r.error).map((r) => r.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const [stem, tail] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    let i = 2;
    while (taken.has(`${stem} (${i})${tail}`.toLowerCase())) i++;
    return `${stem} (${i})${tail}`;
  }

  function addResult(r) {
    if (!r.error) {
      r.name = uniqueName(r.name);
      r.url = URL.createObjectURL(r.blob);
    }
    state.results.push(r);
    renderResults();
  }

  function renderResults() {
    const list = $('resultList');
    list.replaceChildren();
    for (const r of state.results.slice().reverse()) {
      const li = el('li', r.error ? 'item error' : 'item');
      const meta = el('div', 'meta');
      meta.append(el('div', 'name', r.name));
      meta.firstChild.title = r.name;
      if (r.error) {
        li.append(el('div', 'thumb', '!'), meta);
        meta.append(el('div', 'sub bad', r.error));
      } else {
        const isImg = r.blob.type.startsWith('image/');
        li.append(thumb(r.name, isImg ? r.url : null), meta);
        meta.append(el('div', r.note && r.note.startsWith('−') ? 'sub good' : 'sub', [fmtSize(r.blob.size), r.note].filter(Boolean).join(' · ')));
        if (r.preview) meta.append(el('pre', null, r.preview));
        const acts = el('div', 'acts');
        if (/^(image|text|audio|video)\/|pdf$/.test(r.blob.type)) {
          const open = el('a', null, 'Open');
          open.href = r.url; open.target = '_blank'; open.rel = 'noopener';
          acts.append(open);
        }
        const dl = el('a', 'dl', 'Download');
        dl.href = r.url; dl.download = r.name;
        acts.append(dl);
        li.append(acts);
      }
      list.append(li);
    }
    const good = state.results.filter((r) => !r.error);
    $('resultCount').textContent = state.results.length;
    $('resultsEmpty').hidden = state.results.length > 0;
    $('zipAllBtn').hidden = good.length < 2;
    $('clearResultsBtn').hidden = !state.results.length;
  }

  async function zipAll() {
    const good = state.results.filter((r) => !r.error);
    const z = new JSZip();
    good.forEach((r) => z.file(r.name, r.blob));
    toast('Packing…');
    const blob = await z.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tiger-results.zip';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  /* ---------- quick wheel ---------- */
  function wheelItems() {
    return WHEEL.map((w) => ({ ...w, t: TOOLS.find((t) => t.id === w.tool) }))
      .map((w) => ({ ...w, n: compatible(w.t).length }))
      .filter((w) => w.n >= (w.min || 1))
      .slice(0, 8);
  }

  function openWheel() {
    const items = wheelItems();
    if (!items.length || state.busy) return;
    const wheel = $('wheel');
    wheel.querySelectorAll('.wheel-item').forEach((n) => n.remove());
    const n = state.files.length;
    const center = $('wheelCenter');
    center.replaceChildren(el('strong', null, n), el('span', null, `file${n > 1 ? 's' : ''}`), el('span', null, 'Esc to close'));
    const R = 125;
    items.forEach((w, i) => {
      const a = -Math.PI / 2 + (i / items.length) * Math.PI * 2;
      const b = el('button', 'wheel-item');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.style.left = `${170 + R * Math.cos(a)}px`;
      b.style.top = `${170 + R * Math.sin(a)}px`;
      b.append(document.createTextNode(w.label), el('small', null, w.n < n ? `${w.n} of ${n}` : w.t.group === 'Any file' ? 'all' : w.t.name.split(' ')[0]));
      b.title = w.t.name;
      b.onclick = () => {
        closeWheel();
        run(w.t, { ...defaultsFor(w.t), ...store.get('opts.' + w.t.id, {}), ...(w.opts || {}) });
      };
      wheel.append(b);
    });
    $('wheelWrap').hidden = false;
    wheel.querySelector('.wheel-item').focus();
  }

  function closeWheel() { $('wheelWrap').hidden = true; }

  /* ---------- wiring ---------- */
  $('picker').addEventListener('change', (e) => {
    if (addFiles(e.target.files) && $('wheelPref').checked) openWheel();
    e.target.value = '';
  });
  $('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('picker').click(); } });

  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('veil').hidden = false; $('drop').classList.add('over'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('veil').hidden = true; $('drop').classList.remove('over'); } });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; $('veil').hidden = true; $('drop').classList.remove('over');
    if (addFiles(e.dataTransfer.files) && $('wheelPref').checked) openWheel();
  });

  $('clearBtn').onclick = () => {
    state.files.forEach((x) => x.url && URL.revokeObjectURL(x.url));
    state.files = [];
    renderFiles();
    renderTools();
  };
  $('wheelBtn').onclick = openWheel;
  $('wheelWrap').addEventListener('click', (e) => { if (e.target === $('wheelWrap')) closeWheel(); });
  $('optClose').onclick = () => { state.tool = null; state.editor = null; $('options').hidden = true; renderTools(); };
  $('options').addEventListener('submit', (e) => {
    e.preventDefault();
    const tool = state.tool;
    const o = readOptions(tool);
    // Signatures and passwords are never remembered.
    store.set('opts.' + tool.id, Object.fromEntries(tool.options.filter((x) => x.type !== 'signature' && x.type !== 'password').map((x) => [x.key, o[x.key]])));
    if (state.editor) {
      o.__items = state.editor.items();
      if (!o.__items.length) { toast('All pages are deleted — restore some first.'); return; }
    }
    run(tool, o);
  });
  $('toolSearch').addEventListener('input', filterTools);
  $('showAll').onclick = () => { state.showAll = !state.showAll; filterTools(); };
  $('cameraBtn').onclick = (e) => { e.preventDefault(); e.stopPropagation(); $('camera').click(); };
  $('camera').addEventListener('change', (e) => { if (addFiles(e.target.files)) toast('Photo added — pick "Images → PDF" to make a scan.'); e.target.value = ''; });
  $('zipAllBtn').onclick = zipAll;
  $('cancelBtn').onclick = () => { if (state.abort) state.abort.abort(); };

  if (location.protocol.startsWith('http')) {
    // Installable app + offline use (GitHub Pages, or localhost via Start Tiger.cmd).
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    // Keeps the local server (Start Tiger.cmd) alive while a Tiger tab is open.
    if (location.hostname === 'localhost') setInterval(() => fetch('__ping', { cache: 'no-store' }).catch(() => {}), 30000);
  }
  $('clearResultsBtn').onclick = () => {
    state.results.forEach((r) => r.url && URL.revokeObjectURL(r.url));
    state.results = [];
    renderResults();
  };

  $('wheelPref').checked = store.get('wheel', true);
  $('wheelPref').onchange = (e) => store.set('wheel', e.target.checked);

  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(store.get('theme', null));
  $('themeBtn').onclick = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    store.set('theme', next);
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('wheelWrap').hidden) closeWheel();
    else if (e.key === ' ' && e.target === document.body && state.files.length) { e.preventDefault(); openWheel(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('picker').click(); }
  });

  window.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length && addFiles(files)) toast(`Pasted ${files.length} file${files.length > 1 ? 's' : ''}`);
  });

  if (location.protocol === 'file:') {
    toast('Tip: open Tiger with "Start Tiger.cmd" to enable the video & audio tools.');
  }

  renderFiles();
  renderTools();
  renderResults();
})();
