// GhostClip — Shared canvas utilities
// Used by both sdk.js (DOM canvas) and canvas-worker.js (OffscreenCanvas)
// Functions that create canvases accept a `makeCanvas(w, h)` factory.

/**
 * Trim transparent pixels, returning a cropped canvas.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {(w: number, h: number) => HTMLCanvasElement|OffscreenCanvas} makeCanvas
 */
export function autoCrop(canvas, makeCanvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;

  let top = height, bottom = 0, left = width, right = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  if (top > bottom || left > right) return canvas;

  const padX = Math.round((right - left) * 0.02);
  const padY = Math.round((bottom - top) * 0.02);
  top = Math.max(0, top - padY);
  bottom = Math.min(height - 1, bottom + padY);
  left = Math.max(0, left - padX);
  right = Math.min(width - 1, right + padX);

  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  const cropped = ctx.getImageData(left, top, cropW, cropH);

  const out = makeCanvas(cropW, cropH);
  out.getContext('2d').putImageData(cropped, 0, 0);
  return out;
}

/**
 * Draw an image cover-fitted into a region (like CSS object-fit: cover).
 * Pure — no canvas creation, works in any environment.
 */
export function drawCover(ctx, img, w, h) {
  const imgRatio = img.width / img.height;
  const canvasRatio = w / h;
  let sx, sy, sw, sh;
  if (imgRatio > canvasRatio) {
    sh = img.height;
    sw = img.height * canvasRatio;
    sx = (img.width - sw) / 2;
    sy = 0;
  } else {
    sw = img.width;
    sh = img.width / canvasRatio;
    sx = 0;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
}

/**
 * Draw an outline (stroke) around opaque pixels.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {number} width  Stroke width in pixels
 * @param {string} color  CSS color string
 * @param {(w: number, h: number) => HTMLCanvasElement|OffscreenCanvas} makeCanvas
 */
export function applyStroke(canvas, width, color, makeCanvas) {
  if (width <= 0) return canvas;
  const pad = width * 2;
  const out = makeCanvas(canvas.width + pad * 2, canvas.height + pad * 2);
  const ctx = out.getContext('2d');

  const steps = Math.max(24, width * 4);
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < steps; i++) {
    const angle = (2 * Math.PI * i) / steps;
    const dx = Math.cos(angle) * width;
    const dy = Math.sin(angle) * width;
    ctx.drawImage(canvas, pad + dx, pad + dy);
  }

  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, out.width, out.height);

  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(canvas, pad, pad);

  return out;
}
