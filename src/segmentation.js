import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { ModNetEngine } from './modnet-engine.js';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // Fall through.
  }
  return String(error ?? '알 수 없는 오류');
}

function dilateMask(source, width, height, radius) {
  const result = new Uint8Array(source.length);
  const points = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if ((dx * dx) + (dy * dy) <= radius * radius) points.push([dx, dy]);
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!source[index]) continue;
      for (const [dx, dy] of points) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height) {
          result[yy * width + xx] = 1;
        }
      }
    }
  }
  return result;
}

function largestConnectedRegion(binary, width, height) {
  const size = binary.length;
  const labels = new Int32Array(size);
  const queue = new Int32Array(size);
  let label = 0;
  let bestLabel = 0;
  let bestCount = 0;

  for (let start = 0; start < size; start += 1) {
    if (!binary[start] || labels[start]) continue;
    label += 1;
    let head = 0;
    let tail = 0;
    let count = 0;
    queue[tail++] = start;
    labels[start] = label;

    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / width);
      const x = index - y * width;
      count += 1;

      if (x > 0 && binary[index - 1] && !labels[index - 1]) {
        labels[index - 1] = label;
        queue[tail++] = index - 1;
      }
      if (x + 1 < width && binary[index + 1] && !labels[index + 1]) {
        labels[index + 1] = label;
        queue[tail++] = index + 1;
      }
      if (y > 0 && binary[index - width] && !labels[index - width]) {
        labels[index - width] = label;
        queue[tail++] = index - width;
      }
      if (y + 1 < height && binary[index + width] && !labels[index + width]) {
        labels[index + width] = label;
        queue[tail++] = index + width;
      }
    }

    if (count > bestCount) {
      bestCount = count;
      bestLabel = label;
    }
  }

  if (!bestLabel) return binary;
  const kept = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    if (labels[i] === bestLabel) kept[i] = 1;
  }
  return kept;
}

function enclosedHeadMask(head, width, height) {
  const rowMin = new Int32Array(height).fill(width);
  const rowMax = new Int32Array(height).fill(-1);
  const colMin = new Int32Array(width).fill(height);
  const colMax = new Int32Array(width).fill(-1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!head[y * width + x]) continue;
      rowMin[y] = Math.min(rowMin[y], x);
      rowMax[y] = Math.max(rowMax[y], x);
      colMin[x] = Math.min(colMin[x], y);
      colMax[x] = Math.max(colMax[x], y);
    }
  }

  const enclosed = new Uint8Array(head.length);
  for (let y = 0; y < height; y += 1) {
    if (rowMax[y] < 0) continue;
    for (let x = rowMin[y]; x <= rowMax[y]; x += 1) {
      if (colMax[x] >= 0 && y >= colMin[x] && y <= colMax[x]) {
        enclosed[y * width + x] = 1;
      }
    }
  }
  return enclosed;
}

function softenMask(binary, width, height, previous) {
  const alpha = new Float32Array(binary.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let count = 0;
      let total = 0;
      for (let yy = y0; yy <= y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) {
          total += 1;
          count += binary[row + xx];
        }
      }
      const index = y * width + x;
      const neighborhood = count / total;
      const current = binary[index]
        ? Math.max(0.72, neighborhood)
        : (neighborhood >= 0.45 ? neighborhood * 0.48 : 0);
      alpha[index] = previous?.length === binary.length
        ? (current * 0.92) + (previous[index] * 0.08)
        : current;
    }
  }
  return alpha;
}

function buildForegroundMask(categories, width, height, previous) {
  const size = categories.length;
  const core = new Uint8Array(size);
  const head = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    const category = categories[i];
    if (category >= 1 && category <= 4) core[i] = 1;
    if (category === 1 || category === 3) head[i] = 1;
  }

  const mainPerson = largestConnectedRegion(core, width, height);
  const bodyHalo = dilateMask(mainPerson, width, height, 2);
  const headHalo = dilateMask(head, width, height, 7);
  const headInterior = enclosedHeadMask(head, width, height);
  const foreground = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    const category = categories[i];
    if (mainPerson[i]) {
      foreground[i] = 1;
      continue;
    }

    if (category === 5 && (headHalo[i] || bodyHalo[i])) {
      foreground[i] = 1;
      continue;
    }

    if (headInterior[i]) foreground[i] = 1;
  }

  return softenMask(foreground, width, height, previous);
}

class MediaPipePersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.segmenter = null;
    this.initializing = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.delegate = '';
  }

  async ensureReady() {
    if (this.segmenter) return this.segmenter;
    if (this.initializing) return this.initializing;

    this.initializing = this.#initialize()
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(errorText(error));
        this.onStatus('AI 로드 실패');
        throw normalized;
      })
      .finally(() => {
        this.initializing = null;
      });

    return this.initializing;
  }

  async #initialize() {
    this.onStatus('AI 고품질 모델 불러오는 중');
    const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
    const makeOptions = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });

    try {
      this.segmenter = await ImageSegmenter.createFromOptions(vision, makeOptions('GPU'));
      this.delegate = 'GPU';
    } catch (gpuError) {
      console.warn('Multiclass GPU segmentation unavailable. Falling back to CPU.', gpuError);
      this.segmenter = await ImageSegmenter.createFromOptions(vision, makeOptions('CPU'));
      this.delegate = 'CPU';
    }

    this.onStatus(`AI 준비 · 빠른 멀티클래스 ${this.delegate}`);
    return this.segmenter;
  }

  segment(imageSource, timestampMs = performance.now()) {
    if (!this.segmenter) return this.latestMask;
    let copiedMask = null;

    this.segmenter.segmentForVideo(imageSource, timestampMs, (result) => {
      try {
        const mask = result.categoryMask;
        if (!mask) return;
        const categories = mask.getAsUint8Array();
        const width = mask.width;
        const height = mask.height;
        const alpha = buildForegroundMask(categories, width, height, this.previousAlpha);
        this.previousAlpha = alpha;
        copiedMask = { width, height, data: alpha };
        this.latestMask = copiedMask;
      } finally {
        result.close();
      }
    });

    return copiedMask || this.latestMask;
  }

  close() {
    try { this.segmenter?.close(); } catch { /* best effort */ }
    this.segmenter = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.onStatus('AI 대기');
  }
}

export class PersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.engine = null;
    this.engineMode = '';
  }

  #selectedMode() {
    return document.getElementById('aiEngineSelect')?.value === 'modnet' ? 'modnet' : 'mediapipe';
  }

  #getEngine() {
    const selectedMode = this.#selectedMode();
    if (this.engine && this.engineMode === selectedMode) return this.engine;

    this.engine?.close?.();
    this.engineMode = selectedMode;
    this.engine = selectedMode === 'modnet'
      ? new ModNetEngine(this.onStatus)
      : new MediaPipePersonSegmenter(this.onStatus);
    return this.engine;
  }

  async ensureReady() {
    return this.#getEngine().ensureReady();
  }

  segment(imageSource, timestampMs = performance.now()) {
    const engine = this.#getEngine();
    if (this.engineMode === 'modnet') {
      const cameraVideo = document.getElementById('cameraVideo');
      const originalSource = cameraVideo?.readyState >= 2 ? cameraVideo : imageSource;
      return engine.segment(originalSource, timestampMs);
    }
    return engine.segment(imageSource, timestampMs);
  }

  close() {
    this.engine?.close?.();
    this.engine = null;
    this.engineMode = '';
  }
}
