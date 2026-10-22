# 🐯 Tiger — private file converter & PDF toolbox

Tiger does what iLovePDF-style websites do, but **everything happens on your own device**. Your files are never uploaded. There's no account, no daily limit and no watermark, and it keeps working offline.

**Use it:** open the GitHub Pages link of this repository, or run it locally (see below). It works in Edge or Chrome on Windows, Mac, Linux, Android and iPhone.

## 36 tools

| Group | Tools |
|---|---|
| **PDF** | Merge, Split, Pick pages, Rotate, Add page numbers, PDF → images, Extract text, **Organize PDF** (visual: rotate, reorder, delete, mix PDFs and images), **Sign**, **Watermark**, **Crop**, **Compress**, **Unlock**, **Repair**, **PDF → Word** |
| **Images** | Convert (PNG/JPEG/WebP/BMP from PNG, JPEG, WebP, GIF, BMP, AVIF, SVG, ICO), Resize, Rotate & flip, Compress, **Images → PDF** (visual page editor) |
| **Video & audio** | Convert video (MP4/WebM/MOV/MKV), Convert audio (MP3/WAV/M4A/OGG/Opus/FLAC; can pull the sound out of a video), Trim, Compress video, Video → GIF, Remove audio, Fix volume, Grab a frame |
| **Text & data** | SRT ↔ VTT, Shift subtitles, CSV ↔ JSON |
| **Any file** | Make ZIP, Unzip, Checksum (SHA-256/1/512) |

## How to use

1. Add files: drop them on the page, tap the box to choose them, or use **📷 Scan with camera** on a phone.
2. Pick a tool. Tiger shows only the tools that fit your files, and the search box finds the rest.
3. For PDFs and images, a **page editor** shows every page as a thumbnail. Rotate ⟲ ⟳, move ◀ ▶ (or drag), delete ✕, Rotate all, Reverse, Sort A→Z.
4. Click **Run** and download the results, one at a time or as a ZIP. Your originals are never changed.

The **quick wheel** pops up after a drop. It offers one-click presets such as PDF, JPG, MP4, MP3 and Merge.

## Run it

| Where | How |
|---|---|
| **Any phone or computer** | Open the GitHub Pages URL. To install it as an app: on Android/Chrome use ⋮ → *Install app* / *Add to Home screen*. On iPhone/Safari use Share → *Add to Home Screen*. On Edge/Chrome desktop, use the install icon in the address bar. |
| **Windows, offline** | Download this repository as a ZIP, unzip it and double-click `Start Tiger.cmd`. |
| **Mac/Linux, offline** | In the folder, run `python3 -m http.server 8000` and open http://localhost:8000. |

Opening `index.html` directly from disk works for everything except video and audio. Browsers block the video engine on pages opened from disk.

### Put it on GitHub Pages (free hosting)

In this repository, go to Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)` → Save. After about a minute, Tiger is live at `https://<your-username>.github.io/<repo-name>/`.

## Good to know

- **Video re-encoding is slow.** It runs on one CPU core, so 720p takes about 5× the video's length. Audio, fast trims, Remove audio and "Fast: change container only" take seconds.
- **Phones** handle PDFs and images well. Large videos can run out of memory on phones.
- **Compress PDF** and **Unlock PDF** rebuild pages as images, so text in the result can't be selected anymore.
- **PDF → Word** gives you the text, but not the layout or pictures.
- Limits: 50-megapixel images, PDFs up to 400 pages in the editor, media files up to 2 GB.

## Project layout

- `index.html` and `styles.css`: the page layout and theme (light and dark)
- `app.js`: the file list, tool picker, quick wheel, progress, results and signature pad
- `tools.js`: image, PDF basics, text and file tools
- `editor.js`: the visual page editor and the PDF builder
- `pdftools.js`: Organize, Sign, Watermark, Crop, Compress, Unlock, Repair, PDF → Word
- `media.js`: the video and audio tools (FFmpeg.wasm)
- `sw.js` and `manifest.json`: offline cache and app install
- `Start Tiger.cmd` and `server.ps1`: the Windows launcher, a read-only server on localhost only
- `vendor/`: pdf-lib (MIT), pdf.js (Apache-2.0), JSZip (MIT), FFmpeg.wasm (MIT wrapper, GPL core)

To add a tool, push an entry with `accepts`, `mode` (`each`/`all`), `options` and `run(file, options, ctx)` into `Tiger.TOOLS`.

## Licence

GPL-3.0. Tiger ships FFmpeg.wasm, which includes GPL components (x264). GPL-3.0 lets anyone use, share and modify Tiger, as long as copies they share stay open source. The libraries in `vendor/` keep their own licences.
