import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function shiftMask(source, width, height, dx, dy) {
  const result = new Uint8Array(source.length);
  if (!dx && !dy) return result;

  for (let y = 0; y < height; y += 1) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!source[index]) continue;
      const xx = x + dx;
      if (xx >= 0 && xx < width) result[yy * width + xx] = 1;
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

function maskCentroid(binary, width) {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < binary.length; i += 1) {
    if (!binary[i]) continue;
    const y = Math.floor(i / width);
    const x = i - y * width;
    count += 1;
    sumX += x;
    sumY += y;
  }
  if (!count) return null;
  return { x: sumX / count, y: sumY / count, count };
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

function blurAlpha(source, width, height) {
  const blurred = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy <= y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) {
          sum += source[row + xx];
          count += 1;
        }
      }
      blurred[y * width + x] = sum / count;
    }
  }
  return blurred;
}

function buildForegroundMask(categories, width, height, previousState) {
  const size = categories.length;
  const core = new Uint8Array(size);
  const head = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    const category = categories[i];
    // 1 hair, 2 body-skin, 3 face-skin, 4 clothes
    if (category >= 1 && category <= 4) core[i] = 1;
    if (category === 1 || category === 3) head[i] = 1;
  }

  const mainPerson = largestConnectedRegion(core, width, height);
  const bodyHalo = dilateMask(mainPerson, width, height, 2);
  const headHalo = dilateMask(head, width, height, 8);
  const headInterior = enclosedHeadMask(head, width, height);
  const foreground = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    const category = categories[i];
    if (mainPerson[i]) {
      foreground[i] = 1;
      continue;
    }

    // class 5 = others. Glasses, earphones and accessories often land here.
    // Keep it only near the detected person, with a little more room around the head.
    if (category === 5 && (headHalo[i] || bodyHalo[i])) {
      foreground[i] = 1;
      continue;
    }

    // Glass lenses can be classified as background. Keep small enclosed gaps in the head.
    if (headInterior[i]) foreground[i] = 1;
  }

  const centroid = maskCentroid(foreground, width);
  const edgeGuard = dilateMask(foreground, width, height, 1);
  const baseAlpha = new Float32Array(size);

  // Predict a small amount of forward motion. This intentionally favors hiding a tiny
  // extra rim over flashing the real background during fast movement.
  let predicted = null;
  let moving = false;
  if (centroid && previousState?.centroid) {
    const dxRaw = centroid.x - previousState.centroid.x;
    const dyRaw = centroid.y - previousState.centroid.y;
    const distance = Math.hypot(dxRaw, dyRaw);
    if (distance >= 0.8) {
      moving = true;
      const dx = Math.round(clamp(dxRaw * 0.7, -7, 7));
      const dy = Math.round(clamp(dyRaw * 0.7, -7, 7));
      predicted = shiftMask(foreground, width, height, dx, dy);
    }
  }

  for (let i = 0; i < size; i += 1) {
    if (foreground[i]) baseAlpha[i] = 1;
    else if (predicted?.[i]) baseAlpha[i] = 0.72;
    else if (edgeGuard[i]) baseAlpha[i] = 0.46;
  }

  const blurred = blurAlpha(baseAlpha, width, height);
  const alpha = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    // Keep the interior solid while feathering only the outside edge.
    const spatial = foreground[i]
      ? Math.max(0.94, blurred[i])
      : Math.max(baseAlpha[i], blurred[i] * 0.72);

    // Almost no temporal smoothing while moving, so the matte does not visibly trail.
    const previous = previousState?.alpha?.length === size ? previousState.alpha[i] : spatial;
    const previousWeight = moving ? 0.01 : 0.04;
    alpha[i] = clamp((spatial * (1 - previousWeight)) + (previous * previousWeight), 0, 1);
  }

  return { alpha, centroid };
}

export class PersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.segmenter = null;
    this.initializing = null;
    this.latestMask = null;
    this.previousState = null;
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

    this.onStatus(`AI 준비 · 움직임 보정 ${this.delegate}`);
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
        const processed = buildForegroundMask(categories, width, height, this.previousState);
        this.previousState = { alpha: processed.alpha, centroid: processed.centroid };
        copiedMask = { width, height, data: processed.alpha };
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
    this.previousState = null;
    this.onStatus('AI 대기');
  }
}
