# GhostClip -- Project Instructions

> Browser-based AI background removal tool. Vite + Vanilla JS + HuggingFace Transformers.js + imgly background-removal.

## Tech Stack

- **Build**: Vite 5 (ES modules, dev server, production build)
- **Language**: Vanilla JavaScript (ES modules, no framework)
- **AI / ML**: `@imgly/background-removal` (background removal with ONNX/WebGPU), `@huggingface/transformers` (HF inference)
- **Canvas**: OffscreenCanvas + Web Workers for post-processing pipeline
- **Compression**: JSZip (batch ZIP downloads)
- **Deployment**: Vercel (static + serverless functions in `api/`)
- **Fonts**: Inter (Google Fonts)
- **Icons**: Inline SVG (no icon library)

## Directory Structure

```
ghostclip/
  index.html              -- Single-page entry point
  main.js                 -- Application logic (UI, events, processing)
  sdk.js                  -- SDK module (GhostClip class, buildFinal, detectDevice)
  canvas-utils.js         -- Shared canvas utilities (autoCrop, drawCover, applyStroke)
  canvas-worker.js        -- OffscreenCanvas Web Worker for post-processing
  style.css               -- All styles (CSS custom properties, responsive)
  package.json            -- Dependencies and scripts
  vite.sdk.config.js      -- Vite config for SDK build (UMD + ESM)
  vercel.json             -- Vercel deployment config
  api/
    log.js                -- Serverless logging endpoint
  public/
    favicon.svg           -- App favicon
  dist/                   -- Production build output (gitignored)
  dist-sdk/               -- SDK build output (gitignored)
```

## Naming Conventions

- **Files**: `kebab-case.js` / `kebab-case.css`
- **Functions**: `camelCase` -- `processFile`, `buildFinalOffscreen`, `detectDevice`
- **Classes**: `PascalCase` -- `GhostClip`
- **Constants / config objects**: `camelCase` -- `sceneGradients`, `devicePromise`
- **DOM references**: `camelCase` matching element IDs -- `const dropzone = document.getElementById('dropzone')`
- **Private/internal vars**: Prefixed with `_` -- `_previewGen`, `_canvasWorker`, `_sliderDragging`
- **CSS custom properties**: `--kebab-case` -- `--bg`, `--accent`, `--surface-hover`
- **CSS classes**: `kebab-case` -- `.dropzone`, `.batch-item`, `.comparison-slider`

## Architecture Patterns

### Module Structure

The app uses four JS modules with clear responsibilities:

| Module | Role | Environment |
|--------|------|-------------|
| `main.js` | App entry -- DOM events, UI state, orchestration | Main thread (browser) |
| `sdk.js` | Reusable SDK -- `GhostClip` class, canvas compositing, device detection | Main thread (browser + importable) |
| `canvas-utils.js` | Pure canvas functions -- `autoCrop`, `drawCover`, `applyStroke` | Any (main thread or worker) |
| `canvas-worker.js` | Web Worker -- offloads canvas compositing off main thread | Worker thread |

### Canvas Factory Pattern

Canvas utilities accept a `makeCanvas(w, h)` factory function so they work in both DOM (main thread) and Worker (OffscreenCanvas) environments:

```javascript
// In sdk.js (main thread):
function makeDOMCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
export function autoCrop(canvas) {
  return _autoCropImpl(canvas, makeDOMCanvas);
}

// In canvas-worker.js (worker thread):
const makeOffCanvas = (w, h) => new OffscreenCanvas(w, h);
const autoCrop = (canvas) => _autoCropImpl(canvas, makeOffCanvas);
```

### Generation Counter Pattern

Stale async results are discarded using generation counters:

```javascript
let _previewGen = 0;

async function updatePreview() {
  const gen = ++_previewGen;
  const blob = await buildFinalOffscreen(...);
  if (gen !== _previewGen) return; // newer call superseded this one
  resultImg.src = URL.createObjectURL(blob);
}
```

### Worker Fallback Pattern

OffscreenCanvas worker is attempted first, falls back to main-thread compositing:

```javascript
export async function buildFinalOffscreen(srcBlob, bgColor, cropMode, scene, sWidth, sColor) {
  const worker = getCanvasWorker();
  if (!worker) {
    return buildFinal(srcBlob, bgColor, cropMode, scene, sWidth, sColor);
  }
  try {
    // ... worker path ...
  } catch {
    return buildFinal(srcBlob, bgColor, cropMode, scene, sWidth, sColor);
  }
}
```

### Blob URL Lifecycle

All Blob URLs are tracked and revoked to prevent memory leaks:

```javascript
let _originalImgUrl = null;
let _resultImgUrl = null;
let _batchUrls = [];

// Before creating a new URL, revoke the old one:
if (_resultImgUrl) URL.revokeObjectURL(_resultImgUrl);
_resultImgUrl = URL.createObjectURL(blob);

// On reset, revoke everything:
function resetUI() {
  if (_originalImgUrl) { URL.revokeObjectURL(_originalImgUrl); _originalImgUrl = null; }
  if (_resultImgUrl) { URL.revokeObjectURL(_resultImgUrl); _resultImgUrl = null; }
  _batchUrls.forEach((u) => URL.revokeObjectURL(u));
  _batchUrls = [];
}
```

### Remote Logging Pattern

Client-side errors are sent to a Vercel serverless function for server-side log visibility:

```javascript
function rlog(level, message, context = {}) {
  console[level === 'error' ? 'error' : 'log'](`[GhostClip] ${message}`, context);
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, message, context }),
  }).catch(() => {}); // fire-and-forget
}
```

### Embed Mode

The app supports being embedded as an iframe with postMessage communication:

```javascript
const isEmbed = urlParams.has('embed');
const embedOrigin = urlParams.get('origin') || '*';

// Receive images from parent:
window.addEventListener('message', async (e) => {
  if (e.data.type !== 'ghostclip:process') return;
  // ... process and return result via postMessage ...
});
```

## Build & Dev Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Production build to `dist/` |
| `npm run build:sdk` | SDK library build to `dist-sdk/` (ESM + UMD) |
| `npm run preview` | Preview production build locally |

## Feature / Domain Areas

| Domain | Description | Key Files |
|--------|-------------|-----------|
| **Background Removal** | Core AI processing (single + batch) | `main.js`, `sdk.js` |
| **Canvas Compositing** | Crop, stroke, background fill, scene overlay | `canvas-utils.js`, `canvas-worker.js`, `sdk.js` |
| **UI Controls** | Dropzone, color picker, crop toggle, stroke, scene picker | `main.js`, `index.html`, `style.css` |
| **Comparison Slider** | Before/after image comparison with drag handle | `main.js`, `style.css` |
| **Batch Processing** | Multi-image processing with progress + ZIP download | `main.js` |
| **Sticker Export** | 512x512 tight-crop + stroke sticker generation | `main.js` |
| **SDK** | Embeddable `GhostClip` class for third-party use | `sdk.js`, `vite.sdk.config.js` |
| **Embed Mode** | iframe embedding with postMessage API | `main.js` |
| **Remote Logging** | Client error reporting to serverless function | `main.js`, `api/log.js` |
| **Device Detection** | WebGPU availability + mobile fallback to CPU | `sdk.js` |

## Key Utilities

- `detectDevice()` -- Probes WebGPU, returns `'gpu'` or `'cpu'`, forces CPU on mobile
- `buildFinalOffscreen()` -- Composites final image (worker path with main-thread fallback)
- `buildFinal()` -- Main-thread canvas compositing (crop + stroke + bg/scene)
- `autoCrop(canvas, makeCanvas)` -- Trims transparent pixels with 2% padding
- `applyStroke(canvas, width, color, makeCanvas)` -- Draws outline around opaque pixels
- `drawCover(ctx, img, w, h)` -- CSS `object-fit: cover` for canvas
- `rlog(level, message, context)` -- Remote logger (fire-and-forget to `/api/log`)
- `resetUI()` -- Resets all state and revokes Blob URLs

## Styling

All styles are in `style.css` using CSS custom properties:

```css
:root {
  --bg: #0a0a0f;
  --surface: #13131a;
  --surface-hover: #1a1a24;
  --border: #2a2a3a;
  --text: #e8e8f0;
  --text-muted: #8888a0;
  --accent: #7c5cff;
  --accent-glow: rgba(124, 92, 255, 0.3);
  --accent-hover: #9178ff;
  --success: #34d399;
  --radius: 16px;
}
```

Dark theme only. Responsive breakpoint at 600px. Font: Inter.

## Agent Pipelines

4 pipelines, 13 agent files. Full documentation in `.claude/agents/README.md`.

### Quick Reference

| Pipeline | Command | When | Stages |
|----------|---------|------|--------|
| **Feature** | `@clip-orchestrator` | New feature (2+ modules) | planner -> architect -> implementor -> tester -> reviewer |
| **Bugfix** | `@clip-bug-orchestrator` | Bug, unknown root cause | triager -> fixer -> tester -> reviewer |
| **Hotfix** | `@clip-hotfix-orchestrator` | Bug, known root cause | fixer -> reviewer |
| **Refactor** | `@clip-refactor-orchestrator` | Restructure code | analyzer -> executor -> tester -> reviewer |

### Choosing the Right Pipeline

```
"I need a new feature"                    -> @clip-orchestrator
"Something is broken, not sure why"       -> @clip-bug-orchestrator
"Something is broken, I know the cause"   -> @clip-hotfix-orchestrator
"I want to restructure this code"         -> @clip-refactor-orchestrator
"Single-file fix, trivial change"         -> just do it directly
```

### Artifact Directories

Each pipeline writes to its own directory under `.planning/` (gitignored):

```
.planning/
  features/{slug}/      -- feature pipeline
  bugs/{slug}/          -- bugfix pipeline
  hotfixes/{slug}/      -- hotfix pipeline
  refactors/{slug}/     -- refactor pipeline
```

### Running Individual Agents

Any agent can run standalone without a pipeline:

```
@clip-bug-triager Investigate why batch processing hangs on the 3rd image
@clip-reviewer Review sdk.js against project conventions
@clip-refactor-analyzer Map all dependencies of canvas-utils.js
@clip-implementor Add WebP export support to the sticker builder
```
