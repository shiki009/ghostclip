// GhostClip — OffscreenCanvas worker for post-processing pipeline

import {
  autoCrop as _autoCropImpl,
  drawCover,
  applyStroke as _applyStrokeImpl,
} from './canvas-utils.js';

const makeOffCanvas = (w, h) => new OffscreenCanvas(w, h);
const autoCrop = (canvas) => _autoCropImpl(canvas, makeOffCanvas);
const applyStroke = (canvas, width, color) => _applyStrokeImpl(canvas, width, color, makeOffCanvas);

self.onmessage = async (e) => {
  const { id, srcBitmap, bgColor, cropMode, sceneBitmap, sWidth, sColor } = e.data;

  try {
    let canvas = new OffscreenCanvas(srcBitmap.width, srcBitmap.height);
    canvas.getContext('2d').drawImage(srcBitmap, 0, 0);
    srcBitmap.close();

    if (cropMode === 'tight') {
      canvas = autoCrop(canvas);
    }

    if (sWidth > 0) {
      canvas = applyStroke(canvas, sWidth, sColor);
    }

    if (sceneBitmap) {
      const final = new OffscreenCanvas(canvas.width, canvas.height);
      const ctx = final.getContext('2d');
      drawCover(ctx, sceneBitmap, final.width, final.height);
      ctx.drawImage(canvas, 0, 0);
      sceneBitmap.close();
      canvas = final;
    } else if (bgColor) {
      const final = new OffscreenCanvas(canvas.width, canvas.height);
      const ctx = final.getContext('2d');
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, final.width, final.height);
      ctx.drawImage(canvas, 0, 0);
      canvas = final;
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
