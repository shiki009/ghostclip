/**
 * GhostClip SDK — Client-side background removal
 *
 * Usage (ES module):
 *   import { GhostClip } from './sdk.js';
 *   const gc = new GhostClip();
 *   const resultBlob = await gc.removeBackground(file, { backgroundColor: '#ffffff' });
 *
 * Usage (UMD / script tag):
 *   <script src="ghostclip-sdk.umd.js"></script>
 *   const gc = new GhostClip.GhostClip();
 *   const resultBlob = await gc.removeBackground(file);
 */

import { removeBackground } from '@imgly/background-removal';
import {
  autoCrop as _autoCropImpl,
  drawCover,
  applyStroke as _applyStrokeImpl,
} from './canvas-utils.js';

// ── WebGPU detection (cached) ────────────────────────────────────────

let _devicePromise = null;

/**
 * Detect best available inference device.
 * Probes navigator.gpu, caches result, returns 'gpu' or 'cpu'.
 */
export async function detectDevice() {
  if (_devicePromise) return _devicePromise;
  _devicePromise = (async () => {
    try {
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          console.log('GhostClip: WebGPU available, using GPU acceleration');
          return 'gpu';
        }
      }
    } catch { /* WebGPU not available */ }
    console.log('GhostClip: WebGPU not available, using CPU');
    return 'cpu';
  })();
  return _devicePromise;
}

// ── Shared canvas utilities (thin wrappers over canvas-utils.js) ─────

function makeDOMCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function autoCrop(canvas) {
  return _autoCropImpl(canvas, makeDOMCanvas);
}

export { drawCover };

export function applyStroke(canvas, width, color) {
  return _applyStrokeImpl(canvas, width, color, makeDOMCanvas);
}

export async function buildFinal(srcBlob, bgColor, cropMode, scene, sWidth, sColor) {
  const img = new Image();
  const url = URL.createObjectURL(srcBlob);
  img.src = url;
  await new Promise((resolve, reject) => {
    img.onload = () => { URL.revokeObjectURL(url); resolve(); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image for compositing')); };
  });

  let canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);

  if (cropMode === 'tight') {
    canvas = autoCrop(canvas);
  }

  if (sWidth > 0) {
    canvas = applyStroke(canvas, sWidth, sColor);
  }

  if (scene) {
    const final = document.createElement('canvas');
    final.width = canvas.width;
    final.height = canvas.height;
    const ctx = final.getContext('2d');
    drawCover(ctx, scene, final.width, final.height);
    ctx.drawImage(canvas, 0, 0);
    canvas = final;
  } else if (bgColor) {
    const final = document.createElement('canvas');
    final.width = canvas.width;
    final.height = canvas.height;
    const ctx = final.getContext('2d');
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, final.width, final.height);
    ctx.drawImage(canvas, 0, 0);
    canvas = final;
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// ── OffscreenCanvas worker management ────────────────────────────────

let _canvasWorker = null;
let _canvasMsgId = 0;

function getCanvasWorker() {
  if (_canvasWorker === null) {
    try {
      if (typeof OffscreenCanvas === 'undefined') throw new Error('unsupported');
      _canvasWorker = new Worker(
        new URL('./canvas-worker.js', import.meta.url),
        { type: 'module' }
      );
      _canvasWorker.onerror = () => { _canvasWorker = false; };
    } catch {
      _canvasWorker = false;
    }
  }
  return _canvasWorker || null;
}

/**
 * Build final image using OffscreenCanvas worker when available.
 * Falls back to main-thread buildFinal when unsupported.
 */
export async function buildFinalOffscreen(srcBlob, bgColor, cropMode, scene, sWidth, sColor) {
  const worker = getCanvasWorker();
  if (!worker) {
    return buildFinal(srcBlob, bgColor, cropMode, scene, sWidth, sColor);
  }

  try {
    const srcBitmap = await createImageBitmap(srcBlob);
    let sceneBitmap = null;
    if (scene) {
      sceneBitmap = await createImageBitmap(scene);
    }

    const id = _canvasMsgId++;
    return new Promise((resolve, reject) => {
      const handler = (e) => {
        if (e.data.id !== id) return;
        worker.removeEventListener('message', handler);
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          resolve(e.data.blob);
        }
      };
      worker.addEventListener('message', handler);
      // Transfer srcBitmap (single-use), copy sceneBitmap (may be reused)
      worker.postMessage(
        { id, srcBitmap, bgColor, cropMode, sceneBitmap, sWidth, sColor },
        [srcBitmap]
      );
    });
  } catch {
    // Worker failed, fall back to main thread
    return buildFinal(srcBlob, bgColor, cropMode, scene, sWidth, sColor);
  }
}

// ── GhostClip class (thin wrappers over standalone exports) ──────────

class GhostClip {
  constructor(options = {}) {
    this.model = options.model || 'isnet_fp16';
  }

  /**
   * Remove background from an image source.
   *
   * @param {File|Blob|HTMLImageElement|string} source - Image source (File, Blob, Image element, or data URL)
   * @param {Object} [options]
   * @param {string} [options.backgroundColor] - Hex color for background (e.g. '#ffffff'). Omit for transparent.
   * @param {HTMLImageElement} [options.backgroundImage] - Image to use as background scene (cover-fit).
   * @param {'full'|'tight'} [options.crop='full'] - Crop mode.
   * @param {{ width: number, color: string }} [options.stroke] - Outline stroke settings.
   * @param {'cpu'|'gpu'} [options.device] - Inference device. Auto-detected if omitted.
   * @returns {Promise<Blob>} - Result image as PNG Blob.
   */
  async removeBackground(source, options = {}) {
    const file = await this._toBlob(source);
    const device = options.device || await detectDevice();

    const transparentBlob = await removeBackground(file, {
      model: this.model,
      device,
    });

    const bgColor = options.backgroundColor || '';
    const crop = options.crop || 'full';
    const scene = options.backgroundImage || null;
    const strokeW = options.stroke?.width || 0;
    const strokeC = options.stroke?.color || '#ffffff';

    return buildFinal(transparentBlob, bgColor, crop, scene, strokeW, strokeC);
  }

  async _toBlob(source) {
    if (source instanceof Blob || source instanceof File) {
      return source;
    }
    if (source instanceof HTMLImageElement) {
      const canvas = document.createElement('canvas');
      canvas.width = source.naturalWidth;
      canvas.height = source.naturalHeight;
      canvas.getContext('2d').drawImage(source, 0, 0);
      return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    }
    if (typeof source === 'string') {
      const res = await fetch(source);
      return res.blob();
    }
    throw new Error('Unsupported source type. Provide a File, Blob, Image, or URL string.');
  }
}

export { GhostClip };
