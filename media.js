/* Tigrify — video & audio tools, powered by FFmpeg compiled to WebAssembly (runs locally in a worker). */
(function () {
  'use strict';
  const { TOOLS, WHEEL, ToolError, ext, base } = window.Tigrify;

  const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'ts', 'mts', 'm2ts', 'ogv'];
  const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'amr', 'weba'];
  const isVideo = (f) => VIDEO_EXTS.includes(ext(f.name)) || (f.type.startsWith('video/') && !AUDIO_EXTS.includes(ext(f.name)));
  const isAudio = (f) => AUDIO_EXTS.includes(ext(f.name)) || (f.type.startsWith('audio/') && !VIDEO_EXTS.includes(ext(f.name)));
  const isMedia = (f) => isVideo(f) || isAudio(f);
  Object.assign(window.Tigrify.is, { video: isVideo, audio: isAudio, media: isMedia });

  const MAX_INPUT = 2 * 1024 ** 3;
  const MIME = {
    mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', gif: 'image/gif',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
    png: 'image/png', jpg: 'image/jpeg', avi: 'video/x-msvideo',
  };

  /* ---------- engine ---------- */

  let engine = null;
  let loading = null;

  function getEngine(ctx) {
    if (engine) return Promise.resolve(engine);
    if (location.protocol === 'file:') {
      return Promise.reject(new ToolError('Video & audio tools need Tigrify opened with "Start Tigrify.cmd" (browsers block them on pages opened straight from disk).'));
    }
    if (!window.FFmpegWASM) return Promise.reject(new ToolError('The video engine files are missing from the vendor folder.'));
    if (!loading) {
      ctx.status('Loading video engine (first time only)…');
      const ff = new FFmpegWASM.FFmpeg();
      const dir = new URL('vendor/ffmpeg/', location.href).href;
      loading = ff.load({ coreURL: dir + 'ffmpeg-core.js', wasmURL: dir + 'ffmpeg-core.wasm' })
        .then(() => (engine = ff))
        .catch(() => { throw new ToolError('The video engine could not start. Try a recent Edge or Chrome.'); })
        .finally(() => { loading = null; });
    }
    return loading;
  }

  // Stops a running job by killing the worker; the next job starts a fresh engine.
  function killEngine() {
    if (engine) { try { engine.terminate(); } catch (_) { /* already gone */ } }
    engine = null;
  }

  const LOG_NOISE = /^(\s|Aborted\(|frame=|size=|video:|  |Stream|Input|Output|Duration|Metadata|encoder|major_brand|minor_version|compatible_brands|creation_time|handler_name|vendor_id|Press|built with|configuration|lib\w+\s+\d)/;

  async function ffmpegJob(file, ctx, { args, out, mime, inputArgs = [] }) {
    if (file.size > MAX_INPUT) throw new ToolError('Files over 2 GB are too large for in-browser processing.');
    const ff = await getEngine(ctx);
    const dir = '/in';
    const input = `${dir}/${file.name}`;
    const logs = [];
    const onLog = ({ message }) => { logs.push(message); if (logs.length > 60) logs.shift(); };
    // Files without a known duration report no fraction; fall back to showing how much has been processed.
    const onProgress = ({ progress, time }) => {
      if (progress > 0 && progress <= 1) ctx.fraction(progress);
      else if (time > 0) ctx.status(`Converting… ${Math.round(time / 1e6)} s processed`);
    };
    const onAbort = () => killEngine();
    ff.on('log', onLog);
    ff.on('progress', onProgress);
    ctx.signal.addEventListener('abort', onAbort);
    let mounted = false;
    try {
      await ff.createDir(dir).catch(() => {});
      try {
        await ff.mount('WORKERFS', { files: [file] }, dir);
        mounted = true;
      } catch (_) {
        await ff.writeFile(input, new Uint8Array(await file.arrayBuffer()));
      }
      ctx.status('Converting…');
      let code;
      try {
        code = await ff.exec(['-hide_banner', '-nostdin', '-y', ...inputArgs, '-i', input, ...args, out]);
      } catch (e) {
        if (ctx.signal.aborted) throw new ToolError('Cancelled.');
        killEngine();
        throw new ToolError('The video engine crashed on this file; it will restart for the next one.');
      }
      if (code !== 0) {
        const why = logs.filter((l) => l.trim() && !LOG_NOISE.test(l)).slice(-2).join(' · ');
        throw new ToolError(why ? `FFmpeg could not convert this file: ${why}` : 'FFmpeg could not convert this file.');
      }
      const data = await ff.readFile(out).catch(() => null);
      if (!data || !data.length) throw new ToolError('The conversion produced an empty file.');
      return new Blob([data], { type: mime || MIME[ext(out)] || 'application/octet-stream' });
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (engine === ff) {
        ff.off('log', onLog);
        ff.off('progress', onProgress);
        await ff.deleteFile(out).catch(() => {});
        if (mounted) await ff.unmount(dir).catch(() => {});
        else await ff.deleteFile(input).catch(() => {});
        await ff.deleteDir(dir).catch(() => {});
      }
    }
  }

  /* ---------- argument helpers ---------- */

  // Accepts "90", "1:30", "01:02:03.5"; returns seconds.
  function parseTime(text, label) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) throw new ToolError(`${label} "${t}" is not a time — use seconds or m:ss.`);
    return t.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
  }

  const downscale = (h) => (h && h !== 'keep' ? ['-vf', `scale=-2:'min(${h},ih)'`] : []);

  const X264 = { high: 20, balanced: 23, small: 28 };
  const VP8 = { high: ['8', '5M'], balanced: ['10', '2M'], small: ['20', '900k'] };

  // The WebAssembly engine is single-threaded, so x264 runs at its fastest preset; quality comes from CRF.
  // (libopus crashes in this FFmpeg build, so WebM uses Vorbis audio.)
  function videoCodecArgs(format, quality) {
    if (format === 'webm') {
      const [crf, rate] = VP8[quality];
      return ['-c:v', 'libvpx', '-crf', crf, '-b:v', rate, '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libvorbis', '-b:a', '128k'];
    }
    const a = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(X264[quality]), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k'];
    return format === 'mkv' ? a : [...a, '-movflags', '+faststart'];
  }

  const AUDIO = {
    mp3: (br) => ['-c:a', 'libmp3lame', '-b:a', br],
    m4a: (br) => ['-c:a', 'aac', '-b:a', br],
    ogg: (br) => ['-c:a', 'libvorbis', '-b:a', br],
    opus: (br) => ['-c:a', 'opus', '-strict', '-2', '-ar', '48000', '-ac', '2', '-b:a', br],
    wav: () => ['-c:a', 'pcm_s16le'],
    flac: () => ['-c:a', 'flac'],
  };
  const LOSSY = ['mp3', 'm4a', 'ogg', 'opus'];

  // Keeps the container of the original where FFmpeg can write it; otherwise falls back to MP4 / M4A.
  function sameContainer(file) {
    const e = ext(file.name);
    if (isAudio(file)) return AUDIO[e] ? e : 'm4a';
    return ['mp4', 'mov', 'mkv', 'webm'].includes(e) ? e : 'mp4';
  }

  const media = (f, blob, outExt, suffix, extra) => ({ name: `${base(f.name)}${suffix}.${outExt}`, blob, from: f, ...extra });
  const savings = (f, blob) => {
    const pct = Math.round((1 - blob.size / f.size) * 100);
    return pct > 0 ? `−${pct}% smaller` : `${-pct}% larger`;
  };

  /* ---------- tools ---------- */

  const qualityOption = {
    key: 'quality', label: 'Quality', type: 'select', default: 'balanced',
    choices: [['high', 'High (bigger file)'], ['balanced', 'Balanced'], ['small', 'Small file']],
  };

  const MEDIA_TOOLS = [
    {
      id: 'convert-video', group: 'Video & audio', name: 'Convert video', icon: '▶',
      desc: 'MP4, WebM, MOV or MKV from almost any video. Re-encoding HD takes several times the video length; "Fast" mode is instant when the codec fits.',
      accepts: isVideo, mode: 'each',
      options: [
        { key: 'format', label: 'Output format', type: 'select', default: 'mp4', choices: [['mp4', 'MP4 (H.264)'], ['webm', 'WebM (VP8)'], ['mov', 'MOV (H.264)'], ['mkv', 'MKV (H.264)']] },
        { key: 'copy', label: 'Fast: change container only (no re-encode)', type: 'checkbox', default: false, show: (o) => o.format !== 'webm' },
        { ...qualityOption, show: (o) => !o.copy || o.format === 'webm' },
        { key: 'height', label: 'Max resolution', type: 'select', default: 'keep', choices: [['keep', 'Keep original'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']], show: (o) => !o.copy || o.format === 'webm' },
      ],
      run: async (f, o, ctx) => {
        const fast = o.copy && o.format !== 'webm';
        const args = fast ? ['-map', '0', '-c', 'copy'] : [...downscale(o.height), ...videoCodecArgs(o.format, o.quality)];
        const blob = await ffmpegJob(f, ctx, { args, out: `out.${o.format}` }).catch((e) => {
          if (fast && !ctx.signal.aborted) throw new ToolError(`This video's codecs don't fit ${o.format.toUpperCase()} as-is — untick "Fast" to re-encode.`);
          throw e;
        });
        return media(f, blob, o.format, '');
      },
    },
    {
      id: 'convert-audio', group: 'Video & audio', name: 'Convert audio', icon: '♫',
      desc: 'MP3, WAV, M4A, OGG, Opus or FLAC — from audio files, or extract the soundtrack from a video.',
      accepts: isMedia, mode: 'each',
      options: [
        { key: 'format', label: 'Output format', type: 'select', default: 'mp3', choices: [['mp3', 'MP3'], ['wav', 'WAV (uncompressed)'], ['m4a', 'M4A (AAC)'], ['ogg', 'OGG (Vorbis)'], ['opus', 'Opus'], ['flac', 'FLAC (lossless)']] },
        { key: 'bitrate', label: 'Bitrate', type: 'select', default: '192k', choices: [['128k', '128 kbps'], ['192k', '192 kbps'], ['256k', '256 kbps'], ['320k', '320 kbps']], show: (o) => LOSSY.includes(o.format) },
      ],
      run: async (f, o, ctx) => {
        const br = o.format === 'opus' && o.bitrate === '320k' ? '256k' : o.bitrate;
        const blob = await ffmpegJob(f, ctx, { args: ['-vn', '-map', '0:a:0', ...AUDIO[o.format](br)], out: `out.${o.format}` })
          .catch((e) => { throw /matches no streams/i.test(e.message) ? new ToolError('This file has no audio track.') : e; });
        return media(f, blob, o.format, '');
      },
    },
    {
      id: 'trim-media', group: 'Video & audio', name: 'Trim', icon: '✂',
      desc: 'Cut a clip from a video or audio file. Fast mode cuts at the nearest keyframe.',
      accepts: isMedia, mode: 'each',
      options: [
        { key: 'start', label: 'Start (e.g. 0:30)', type: 'text', default: '0:00' },
        { key: 'end', label: 'End (blank = to the end)', type: 'text', default: '' },
        { key: 'precise', label: 'Frame-accurate (re-encode, slower)', type: 'checkbox', default: false },
      ],
      run: async (f, o, ctx) => {
        const start = parseTime(o.start, 'Start') || 0;
        const end = parseTime(o.end, 'End');
        if (end != null && end <= start) throw new ToolError('End must be after start.');
        const out = sameContainer(f);
        const length = end != null ? ['-t', String(end - start)] : [];
        const blob = o.precise
          ? await ffmpegJob(f, ctx, {
            args: ['-ss', String(start), ...length, ...(isVideo(f) ? videoCodecArgs(out, 'high') : AUDIO[out]('192k'))],
            out: `out.${out}`,
          })
          : await ffmpegJob(f, ctx, {
            inputArgs: ['-ss', String(start)],
            args: [...length, '-map', '0', '-c', 'copy', '-avoid_negative_ts', 'make_zero'],
            out: `out.${out}`,
          });
        return media(f, blob, out, '-trimmed');
      },
    },
    {
      id: 'compress-video', group: 'Video & audio', name: 'Compress video', icon: '◫',
      desc: 'Shrink videos for sharing (MP4 H.264). Slow: expect several minutes per minute of video.',
      accepts: isVideo, mode: 'each',
      options: [{
        key: 'level', label: 'Compression', type: 'select', default: 'medium',
        choices: [['light', 'Light — 1080p, good quality'], ['medium', 'Medium — 720p'], ['strong', 'Strong — 480p, smallest']],
      }],
      run: async (f, o, ctx) => {
        const [h, crf, ab] = { light: ['1080', '26', '128k'], medium: ['720', '28', '112k'], strong: ['480', '31', '96k'] }[o.level];
        const args = [...downscale(h), '-c:v', 'libx264', '-preset', 'superfast', '-crf', crf, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', ab, '-movflags', '+faststart'];
        const blob = await ffmpegJob(f, ctx, { args, out: 'out.mp4' });
        return media(f, blob, 'mp4', '-small', { note: savings(f, blob) });
      },
    },
    {
      id: 'video-to-gif', group: 'Video & audio', name: 'Video → GIF', icon: '◉',
      desc: 'Turn a short clip into an animated GIF (up to 60 seconds).',
      accepts: isVideo, mode: 'each',
      options: [
        { key: 'start', label: 'Start (e.g. 0:05)', type: 'text', default: '0:00' },
        { key: 'length', label: 'Length (seconds)', type: 'number', min: 1, max: 60, default: 5 },
        { key: 'width', label: 'Width', type: 'select', default: '480', choices: [['320', '320 px'], ['480', '480 px'], ['640', '640 px'], ['800', '800 px']] },
        { key: 'fps', label: 'Frames per second', type: 'select', default: '12', choices: [['8', '8'], ['12', '12'], ['15', '15'], ['24', '24']] },
      ],
      run: async (f, o, ctx) => {
        const start = parseTime(o.start, 'Start') || 0;
        const len = Math.min(60, Math.max(1, +o.length || 5));
        const graph = `fps=${o.fps},scale=${o.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
        const blob = await ffmpegJob(f, ctx, { inputArgs: ['-ss', String(start), '-t', String(len)], args: ['-filter_complex', graph, '-loop', '0'], out: 'out.gif' });
        return media(f, blob, 'gif', '');
      },
    },
    {
      id: 'mute-video', group: 'Video & audio', name: 'Remove audio', icon: '🔇',
      desc: 'Strip the sound from a video without re-encoding — instant.',
      accepts: isVideo, mode: 'each', options: [],
      run: async (f, o, ctx) => {
        const out = sameContainer(f);
        const blob = await ffmpegJob(f, ctx, { args: ['-map', '0:v', '-c', 'copy', '-an'], out: `out.${out}` });
        return media(f, blob, out, '-muted');
      },
    },
    {
      id: 'normalize-audio', group: 'Video & audio', name: 'Fix volume', icon: '🔊',
      desc: 'Even out loudness to a standard level (EBU R128). Video is copied untouched.',
      accepts: isMedia, mode: 'each',
      options: [{ key: 'target', label: 'Loudness', type: 'select', default: '-16', choices: [['-23', 'Broadcast (−23 LUFS)'], ['-16', 'Podcasts & web (−16 LUFS)'], ['-14', 'Music streaming (−14 LUFS)']] }],
      run: async (f, o, ctx) => {
        const out = sameContainer(f);
        const audio = isVideo(f) ? (out === 'webm' ? ['-c:a', 'libvorbis', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k']) : AUDIO[out]('192k');
        const args = [...(isVideo(f) ? ['-map', '0:v?', '-map', '0:a:0', '-c:v', 'copy'] : ['-vn']), '-af', `loudnorm=I=${o.target}:TP=-1.5:LRA=11`, '-ar', '48000', ...audio];
        const blob = await ffmpegJob(f, ctx, { args, out: `out.${out}` });
        return media(f, blob, out, '-normalized');
      },
    },
    {
      id: 'video-frame', group: 'Video & audio', name: 'Grab a frame', icon: '▣',
      desc: 'Save a still image from any moment of a video.',
      accepts: isVideo, mode: 'each',
      options: [
        { key: 'at', label: 'Time (e.g. 0:12)', type: 'text', default: '0:01' },
        { key: 'format', label: 'Format', type: 'select', default: 'png', choices: [['png', 'PNG'], ['jpg', 'JPEG']] },
      ],
      run: async (f, o, ctx) => {
        const at = parseTime(o.at, 'Time') || 0;
        const blob = await ffmpegJob(f, ctx, { inputArgs: ['-ss', String(at)], args: ['-frames:v', '1', ...(o.format === 'jpg' ? ['-q:v', '2'] : [])], out: `out.${o.format}` })
          .catch((e) => { throw /empty/i.test(e.message) ? new ToolError('That time is past the end of the video.') : e; });
        return media(f, blob, o.format, `-${String(o.at).replace(/[:.]/g, '-')}`);
      },
    },
  ];

  // Media tools sit before the "Any file" group, and their wheel presets before the generic ones.
  TOOLS.splice(TOOLS.findIndex((t) => t.group === 'Any file'), 0, ...MEDIA_TOOLS);
  WHEEL.splice(WHEEL.findIndex((w) => w.tool === 'unzip'), 0,
    { label: 'MP4', tool: 'convert-video', opts: { format: 'mp4', copy: false } },
    { label: 'MP3', tool: 'convert-audio', opts: { format: 'mp3' } },
    { label: 'WAV', tool: 'convert-audio', opts: { format: 'wav' } },
    { label: 'M4A', tool: 'convert-audio', opts: { format: 'm4a' } },
    { label: 'GIF', tool: 'video-to-gif' },
    { label: 'Shrink', tool: 'compress-video' },
    { label: 'WebM', tool: 'convert-video', opts: { format: 'webm' } },
    { label: 'Volume', tool: 'normalize-audio' });

  window.Tigrify.media = { killEngine };
})();
