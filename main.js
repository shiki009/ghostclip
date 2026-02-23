import { removeBackground } from '@imgly/background-removal';
import { detectDevice, buildFinalOffscreen, autoCrop, applyStroke } from './sdk.js';

// ── State (declared early for embed param parsing) ──────────────────
let transparentBlob = null;
let selectedBg = '';
let selectedCrop = 'full';
let selectedScene = null;
let strokeWidth = 0;
let strokeColor = '#ffffff';
let batchItems = [];

// Blob URL tracking for leak prevention
let _originalImgUrl = null;
let _resultImgUrl = null;
let _batchUrls = [];

// Generation counters for discarding stale async results
let _previewGen = 0;
let _processGen = 0;

// WebGPU device (resolved once, reused for all removeBackground calls)
const devicePromise = detectDevice();

// ── Embed mode ──────────────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const isEmbed = urlParams.has('embed');
const embedOrigin = urlParams.get('origin') || '*';

if (isEmbed) {
  document.body.classList.add('embed-mode');
  const paramBg = urlParams.get('bg');
  if (paramBg) selectedBg = paramBg.startsWith('#') ? paramBg : '#' + paramBg;
  const paramCrop = urlParams.get('crop');
  if (paramCrop === 'tight') selectedCrop = 'tight';
  if (embedOrigin === '*') {
    console.warn(
      'GhostClip: embed mode without explicit ?origin= param. ' +
      'Using wildcard "*" for postMessage. For better security, add ?embed&origin=https://your-domain.com'
    );
  }
}

// ── DOM refs ────────────────────────────────────────────────────────
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const cameraBtn = document.getElementById('cameraBtn');
const cameraInput = document.getElementById('cameraInput');
const processing = document.getElementById('processing');
const processingText = document.querySelector('.processing-text');
const result = document.getElementById('result');
const originalImg = document.getElementById('originalImg');
const resultImg = document.getElementById('resultImg');
const downloadBtn = document.getElementById('downloadBtn');
const stickerBtn = document.getElementById('stickerBtn');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');
const customColor = document.getElementById('customColor');
const swatches = document.querySelectorAll('.swatch');
const cropToggles = document.querySelectorAll('.crop-toggle');
const strokeToggles = document.querySelectorAll('.stroke-toggle');
const strokeColorPicker = document.getElementById('strokeColorPicker');
const bgColorRow = document.getElementById('bgColorRow');
const sceneUpload = document.getElementById('sceneUpload');
const sceneBtns = document.querySelectorAll('.scene-btn');

// Batch DOM
const batchSection = document.getElementById('batchSection');
const batchGrid = document.getElementById('batchGrid');
const batchProgressEl = document.getElementById('batchProgress');
const batchProgressFill = document.getElementById('batchProgressFill');
const downloadZipBtn = document.getElementById('downloadZipBtn');
const batchResetBtn = document.getElementById('batchResetBtn');

// Slider DOM
const comparisonSlider = document.getElementById('comparisonSlider');
const comparisonReveal = document.getElementById('comparisonReveal');
const comparisonHandle = document.getElementById('comparisonHandle');

// ── Scene presets (canvas gradients) ────────────────────────────────
const sceneGradients = {
  studio: (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
    g.addColorStop(0, '#e0e0e0');
    g.addColorStop(1, '#808080');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },
  nature: (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#87ceeb');
    g.addColorStop(0.5, '#90ee90');
    g.addColorStop(1, '#228b22');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },
  office: (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#2c3e50');
    g.addColorStop(0.5, '#34495e');
    g.addColorStop(1, '#1a252f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },
  gradient: (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#7c5cff');
    g.addColorStop(0.5, '#c084fc');
    g.addColorStop(1, '#f472b6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  },
};

// Paint scene preview thumbnails
document.querySelectorAll('.scene-btn[data-scene]').forEach((btn) => {
  const key = btn.dataset.scene;
  if (key === 'none') return;
  const canvas = btn.querySelector('canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (sceneGradients[key]) sceneGradients[key](ctx, 48, 48);
});

// ── Crop toggle ─────────────────────────────────────────────────────
cropToggles.forEach((btn) => {
  btn.addEventListener('click', () => {
    cropToggles.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedCrop = btn.dataset.crop;
    updatePreview();
  });
});

// ── Background color picker ─────────────────────────────────────────
swatches.forEach((swatch) => {
  swatch.addEventListener('click', () => {
    if (swatch.classList.contains('swatch-custom')) return;
    swatches.forEach((s) => s.classList.remove('active'));
    swatch.classList.add('active');
    selectedBg = swatch.dataset.bg;
    updatePreview();
  });
});

customColor.addEventListener('input', (e) => {
  swatches.forEach((s) => s.classList.remove('active'));
  customColor.closest('.swatch').classList.add('active');
  selectedBg = e.target.value;
  updatePreview();
});

// ── Scene picker ────────────────────────────────────────────────────
sceneBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('scene-upload-btn')) return;
    sceneBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const key = btn.dataset.scene;
    if (key === 'none') {
      selectedScene = null;
      bgColorRow.classList.remove('dimmed');
    } else {
      // Generate full-size gradient image
      const c = document.createElement('canvas');
      c.width = 1920;
      c.height = 1080;
      sceneGradients[key](c.getContext('2d'), 1920, 1080);
      const img = new Image();
      img.src = c.toDataURL();
      img.onload = () => {
        selectedScene = img;
        bgColorRow.classList.add('dimmed');
        updatePreview();
      };
      img.onerror = () => console.error('Failed to load scene gradient');
      return;
    }
    updatePreview();
  });
});

sceneUpload.addEventListener('change', () => {
  const file = sceneUpload.files[0];
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.src = url;
  img.onload = () => {
    URL.revokeObjectURL(url);
    selectedScene = img;
    sceneBtns.forEach((b) => b.classList.remove('active'));
    bgColorRow.classList.add('dimmed');
    updatePreview();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    console.error('Failed to load uploaded scene image');
  };
});

// ── Stroke controls ─────────────────────────────────────────────────
strokeToggles.forEach((btn) => {
  btn.addEventListener('click', () => {
    strokeToggles.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    strokeWidth = parseInt(btn.dataset.stroke, 10);
    updatePreview();
  });
});

strokeColorPicker.addEventListener('input', (e) => {
  strokeColor = e.target.value;
  if (strokeWidth > 0) updatePreview();
});

// ── Preview update (stale results discarded via generation counter) ──
async function updatePreview() {
  if (!transparentBlob) return;
  const gen = ++_previewGen;
  const blob = await buildFinalOffscreen(transparentBlob, selectedBg, selectedCrop, selectedScene, strokeWidth, strokeColor);
  if (gen !== _previewGen) return; // newer call superseded this one
  if (_resultImgUrl) URL.revokeObjectURL(_resultImgUrl);
  _resultImgUrl = URL.createObjectURL(blob);
  resultImg.src = _resultImgUrl;
  resultImg.style.width = `${comparisonSlider.offsetWidth}px`;
}

// ── Build sticker (512x512, tight crop, stroke, WebP) ───────────────
async function buildSticker(srcBlob) {
  const img = new Image();
  const url = URL.createObjectURL(srcBlob);
  img.src = url;
  await new Promise((resolve, reject) => {
    img.onload = () => { URL.revokeObjectURL(url); resolve(); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image for sticker')); };
  });

  let canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);

  // Always tight crop for sticker
  canvas = autoCrop(canvas);

  // Apply stroke (use current settings, default to white/medium if none set)
  const sw = strokeWidth > 0 ? strokeWidth : 5;
  const sc = strokeColor || '#ffffff';
  canvas = applyStroke(canvas, sw, sc);

  // Resize to fit within 512x512
  const maxSize = 512;
  const scale = Math.min(maxSize / canvas.width, maxSize / canvas.height, 1);
  const outW = Math.round(canvas.width * scale);
  const outH = Math.round(canvas.height * scale);

  const final = document.createElement('canvas');
  final.width = maxSize;
  final.height = maxSize;
  const ctx = final.getContext('2d');
  // Center the sticker
  const offsetX = Math.round((maxSize - outW) / 2);
  const offsetY = Math.round((maxSize - outH) / 2);
  ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, offsetX, offsetY, outW, outH);

  // Try WebP, fallback to PNG
  return new Promise((resolve) => {
    final.toBlob(
      (blob) => {
        if (blob && blob.type === 'image/webp') {
          resolve(blob);
        } else {
          // Fallback to PNG
          final.toBlob((pngBlob) => resolve(pngBlob), 'image/png');
        }
      },
      'image/webp',
      0.9
    );
  });
}

// ── Before/after comparison slider ──────────────────────────────────
let _sliderDragging = false;

function setSliderPosition(clientX) {
  const rect = comparisonSlider.getBoundingClientRect();
  const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  applySliderPos(pos * 100);
}

function applySliderPos(pct) {
  pct = Math.max(0, Math.min(100, pct));
  comparisonReveal.style.width = `${100 - pct}%`;
  comparisonHandle.style.left = `${pct}%`;
  comparisonSlider.setAttribute('aria-valuenow', Math.round(pct));
}

comparisonSlider.addEventListener('mousedown', (e) => {
  _sliderDragging = true;
  setSliderPosition(e.clientX);
});

window.addEventListener('mousemove', (e) => {
  if (!_sliderDragging) return;
  e.preventDefault();
  setSliderPosition(e.clientX);
});

window.addEventListener('mouseup', () => {
  _sliderDragging = false;
});

comparisonSlider.addEventListener('touchstart', (e) => {
  _sliderDragging = true;
  setSliderPosition(e.touches[0].clientX);
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (!_sliderDragging) return;
  setSliderPosition(e.touches[0].clientX);
}, { passive: true });

window.addEventListener('touchend', () => {
  _sliderDragging = false;
});

// Keyboard support for accessibility
comparisonSlider.addEventListener('keydown', (e) => {
  const current = parseFloat(comparisonHandle.style.left) || 50;
  const step = e.shiftKey ? 10 : 2;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    e.preventDefault();
    applySliderPos(current - step);
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    e.preventDefault();
    applySliderPos(current + step);
  } else if (e.key === 'Home') {
    e.preventDefault();
    applySliderPos(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    applySliderPos(100);
  }
});

// Sync result image width with container on resize
const _sliderResizeObserver = new ResizeObserver(() => {
  resultImg.style.width = `${comparisonSlider.offsetWidth}px`;
});
_sliderResizeObserver.observe(comparisonSlider);

// ── Drag & Drop ─────────────────────────────────────────────────────
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag-over');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
  if (files.length === 0) return;
  if (files.length === 1) {
    processFile(files[0]);
  } else {
    processBatch(files);
  }
});

dropzone.addEventListener('click', (e) => {
  if (e.target.tagName !== 'LABEL') {
    fileInput.click();
  }
});

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files);
  if (files.length === 0) return;
  if (files.length === 1) {
    processFile(files[0]);
  } else {
    processBatch(files);
  }
});

// ── Camera ──────────────────────────────────────────────────────────
cameraBtn.addEventListener('click', () => {
  cameraInput.click();
});

cameraInput.addEventListener('change', () => {
  if (cameraInput.files[0]) {
    processFile(cameraInput.files[0]);
  }
});

// ── Process single file (generation counter discards stale results) ──
async function processFile(file) {
  if (file.size > 10 * 1024 * 1024) {
    alert('File too large. Max 10MB.');
    return;
  }

  const gen = ++_processGen;

  if (_originalImgUrl) URL.revokeObjectURL(_originalImgUrl);
  _originalImgUrl = URL.createObjectURL(file);
  originalImg.src = _originalImgUrl;

  dropzone.classList.add('hidden');
  cameraBtn.classList.add('hidden');
  result.classList.add('hidden');
  batchSection.classList.add('hidden');
  processing.classList.remove('hidden');
  processingText.innerHTML = 'Removing background<span class="dots"></span>';

  try {
    const device = await devicePromise;
    const blob = await removeBackground(file, {
      model: 'isnet_fp16',
      device,
      progress: (key, current, total) => {
        if (gen !== _processGen) return; // stale — don't update UI
        if (key === 'compute:inference') {
          processingText.innerHTML = 'Removing background<span class="dots"></span>';
        } else if (key.startsWith('fetch:')) {
          if (typeof current === 'number' && typeof total === 'number' && total > 0) {
            const pct = Math.round((current / total) * 100);
            processingText.innerHTML = `Loading AI model (first time only) <strong>${pct}%</strong>`;
          } else {
            processingText.innerHTML = 'Loading AI model (first time only)<span class="dots"></span>';
          }
        }
      },
    });

    if (gen !== _processGen) return; // user started a new image, discard

    transparentBlob = blob;

    const displayBlob = await buildFinalOffscreen(blob, selectedBg, selectedCrop, selectedScene, strokeWidth, strokeColor);
    if (gen !== _processGen) return;
    if (_resultImgUrl) URL.revokeObjectURL(_resultImgUrl);
    _resultImgUrl = URL.createObjectURL(displayBlob);
    resultImg.src = _resultImgUrl;
    resultImg.style.width = `${comparisonSlider.offsetWidth}px`;

    processing.classList.add('hidden');
    result.classList.remove('hidden');

    // Notify parent if in embed mode
    if (isEmbed) {
      window.parent.postMessage({ type: 'ghostclip:result', status: 'done' }, embedOrigin);
    }
  } catch (err) {
    if (gen !== _processGen) return;
    console.error('Background removal failed:', err);
    alert('Something went wrong. Check the browser console for details.');
    resetUI();
  }
}

// ── Batch processing ────────────────────────────────────────────────
async function processBatch(files) {
  if (files.length > 50) {
    alert('Maximum 50 images per batch. Only the first 50 will be processed.');
    files = files.slice(0, 50);
  }

  batchItems = files.map((f) => ({ file: f, status: 'pending', transparentBlob: null, error: null }));

  dropzone.classList.add('hidden');
  cameraBtn.classList.add('hidden');
  result.classList.add('hidden');
  processing.classList.add('hidden');
  batchSection.classList.remove('hidden');
  downloadZipBtn.disabled = true;

  renderBatchGrid();

  const device = await devicePromise;
  let completed = 0;
  for (let i = 0; i < batchItems.length; i++) {
    batchItems[i].status = 'processing';
    renderBatchGrid();
    updateBatchProgress(completed, batchItems.length);

    try {
      if (batchItems[i].file.size > 10 * 1024 * 1024) {
        throw new Error('File too large');
      }
      const blob = await removeBackground(batchItems[i].file, { model: 'isnet_fp16', device });
      batchItems[i].transparentBlob = blob;
      batchItems[i].status = 'done';
    } catch (err) {
      console.error(`Batch item ${i} failed:`, err);
      batchItems[i].status = 'error';
      batchItems[i].error = err.message;
    }

    completed++;
    renderBatchGrid();
    updateBatchProgress(completed, batchItems.length);
  }

  downloadZipBtn.disabled = false;
}

function renderBatchGrid() {
  // Revoke previous batch blob URLs
  _batchUrls.forEach((u) => URL.revokeObjectURL(u));
  _batchUrls = [];

  batchGrid.innerHTML = '';
  batchItems.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'batch-item';

    const img = document.createElement('img');
    const url = URL.createObjectURL(
      item.status === 'done' && item.transparentBlob ? item.transparentBlob : item.file
    );
    _batchUrls.push(url);
    img.src = url;
    img.alt = `Image ${i + 1}`;
    div.appendChild(img);

    if (item.status === 'processing') {
      const overlay = document.createElement('div');
      overlay.className = 'batch-overlay';
      overlay.innerHTML = '<div class="spinner"></div>';
      div.appendChild(overlay);
    } else if (item.status === 'done') {
      const overlay = document.createElement('div');
      overlay.className = 'batch-overlay done';
      overlay.innerHTML = '<span class="batch-check">&#10003;</span>';
      div.appendChild(overlay);
    } else if (item.status === 'error') {
      const overlay = document.createElement('div');
      overlay.className = 'batch-overlay error';
      overlay.innerHTML = '<span class="batch-error-icon">&#10007;</span>';
      div.appendChild(overlay);
    }

    batchGrid.appendChild(div);
  });
}

function updateBatchProgress(done, total) {
  batchProgressEl.textContent = `${done} / ${total}`;
  batchProgressFill.style.width = `${(done / total) * 100}%`;
}

// ── ZIP download ────────────────────────────────────────────────────
downloadZipBtn.addEventListener('click', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  const doneItems = batchItems.filter((item) => item.status === 'done');
  if (doneItems.length === 0) {
    alert('No successfully processed images to download.');
    return;
  }

  downloadZipBtn.disabled = true;
  downloadZipBtn.textContent = 'Generating ZIP...';

  for (let i = 0; i < doneItems.length; i++) {
    const finalBlob = await buildFinalOffscreen(
      doneItems[i].transparentBlob,
      selectedBg,
      selectedCrop,
      selectedScene,
      strokeWidth,
      strokeColor
    );
    const arrayBuf = await finalBlob.arrayBuffer();
    zip.file(`ghostclip-${i + 1}.png`, arrayBuf);
  }

  const zipBlob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(zipBlob);
  a.href = url;
  a.download = 'ghostclip-batch.zip';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  downloadZipBtn.disabled = false;
  downloadZipBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    Download All as ZIP
  `;
});

batchResetBtn.addEventListener('click', () => {
  batchItems = [];
  resetUI();
});

// ── Download PNG ────────────────────────────────────────────────────
downloadBtn.addEventListener('click', async () => {
  if (!transparentBlob) return;
  const blob = await buildFinalOffscreen(transparentBlob, selectedBg, selectedCrop, selectedScene, strokeWidth, strokeColor);
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'ghostclip-cutout.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ── Download Sticker ────────────────────────────────────────────────
stickerBtn.addEventListener('click', async () => {
  if (!transparentBlob) return;
  const blob = await buildSticker(transparentBlob);
  const ext = blob.type === 'image/webp' ? 'webp' : 'png';
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = `ghostclip-sticker.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ── Copy to Clipboard ───────────────────────────────────────────────
copyBtn.addEventListener('click', async () => {
  if (!transparentBlob) return;
  try {
    const blob = await buildFinalOffscreen(transparentBlob, selectedBg, selectedCrop, selectedScene, strokeWidth, strokeColor);
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('btn-primary', 'copied');
    copyBtn.classList.remove('btn-secondary');
    setTimeout(() => {
      copyBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy to Clipboard
      `;
      copyBtn.classList.remove('btn-primary', 'copied');
      copyBtn.classList.add('btn-secondary');
    }, 2000);
  } catch {
    alert('Copy failed. Try downloading instead.');
  }
});

// ── Reset ───────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  resetUI();
});

function resetUI() {
  // Revoke all tracked blob URLs
  if (_originalImgUrl) { URL.revokeObjectURL(_originalImgUrl); _originalImgUrl = null; }
  if (_resultImgUrl) { URL.revokeObjectURL(_resultImgUrl); _resultImgUrl = null; }
  _batchUrls.forEach((u) => URL.revokeObjectURL(u));
  _batchUrls = [];

  processing.classList.add('hidden');
  result.classList.add('hidden');
  batchSection.classList.add('hidden');
  dropzone.classList.remove('hidden');
  cameraBtn.classList.remove('hidden');
  fileInput.value = '';
  cameraInput.value = '';
  transparentBlob = null;
  batchItems = [];
}

// ── PostMessage API (embed mode) ────────────────────────────────────
if (isEmbed) {
  window.addEventListener('message', async (e) => {
    // Validate origin when explicit origin is configured
    if (embedOrigin !== '*' && e.origin !== embedOrigin) return;
    if (!e.data || e.data.type !== 'ghostclip:process') return;

    try {
      let file;
      if (e.data.blob instanceof Blob) {
        file = e.data.blob;
      } else if (e.data.dataUrl) {
        const res = await fetch(e.data.dataUrl);
        file = await res.blob();
      } else {
        return;
      }

      const device = await devicePromise;
      const blob = await removeBackground(file, { model: 'isnet_fp16', device });
      const bg = e.data.backgroundColor || selectedBg;
      const crop = e.data.crop || selectedCrop;
      const finalBlob = await buildFinalOffscreen(blob, bg, crop, selectedScene, strokeWidth, strokeColor);

      // Convert to data URL for cross-origin messaging
      const reader = new FileReader();
      reader.onload = () => {
        window.parent.postMessage({
          type: 'ghostclip:result',
          status: 'done',
          dataUrl: reader.result,
        }, embedOrigin);
      };
      reader.readAsDataURL(finalBlob);
    } catch (err) {
      window.parent.postMessage({
        type: 'ghostclip:result',
        status: 'error',
        error: err.message,
      }, embedOrigin);
    }
  });
}
