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

function smoothStep(edge0, edge1, value) {
  const x = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function closeBinaryMask(source, width, height) {
  const dilated = new Uint8Array(source.length);
  const closed = new Uint8Array(source.length);

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let on = 0;
      for (let yy = y0; yy <= y1 && !on; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) {
          if (source[row + xx]) {
            on = 1;
            break;
          }
        }
      }
      dilated[y * width + x] = on;
    }
  }

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let on = 1;
      for (let yy = y0; yy <= y1 && on; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) {
          if (!dilated[row + xx]) {
            on = 0;
            break;
          }
        }
      }
      closed[y * width + x] = on;
    }
  }

  return closed;
}

function largestConnectedRegion(binary, width, height) {
  const size = binary.length;
  const labels = new Int32Array(size);
  const queue = new Int32Array(size);
  let label = 0;
  let bestLabel = 0;
  let bestScore = 0;

  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  const maxDistance = Math.hypot(centerX, centerY) || 1;

  for (let start = 0; start < size; start += 1) {
    if (!binary[start] || labels[start]) continue;

    label += 1;
    let head = 0;
    let tail = 0;
    let count = 0;
    let sumX = 0;
    let sumY = 0;

    queue[tail++] = start;
    labels[start] = label;

    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / width);
      const x = index - y * width;
      count += 1;
      sumX += x;
      sumY += y;

      const left = index - 1;
      const right = index + 1;
      const up = index - width;
      const down = index + width;

      if (x > 0 && binary[left] && !labels[left]) {
        labels[left] = label;
        queue[tail++] = left;
      }
      if (x + 1 < width && binary[right] && !labels[right]) {
        labels[right] = label;
        queue[tail++] = right;
      }
      if (y > 0 && binary[up] && !labels[up]) {
        labels[up] = label;
        queue[tail++] = up;
      }
      if (y + 1 < height && binary[down] && !labels[down]) {
        labels[down] = label;
        queue[tail++] = down;
      }
    }

    const componentX = sumX / count;
    const componentY = sumY / count;
    const distance = Math.hypot(componentX - centerX, componentY - centerY) / maxDistance;
    const centerBonus = 1 + Math.max(0, 0.4 - distance) * 0.8;
    const score = count * centerBonus;

    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }

  const kept = new Uint8Array(size);
  if (!bestLabel) return kept;
  for (let i = 0; i < size; i += 1) {
    if (labels[i] === bestLabel) kept[i] = 1;
  }
  return kept;
}

function dilateMask(source, width, height, radius = 2) {
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
        if (xx >= 0 && xx < width && yy >= 0 && yy < height) result[yy * width + xx] = 1;
      }
    }
  }
  return result;
}

function cleanPersonMask(raw, previous, width, height) {
  const size = raw.length;
  const temporal = new Float32Array(size);
  const core = new Uint8Array(size);
  const previousWeight = previous?.length === size ? 0.38 : 0;
  const currentWeight = 1 - previousWeight;

  for (let i = 0; i < size; i += 1) {
    const value = previousWeight
      ? previous[i] * previousWeight + raw[i] * currentWeight
      : raw[i];
    temporal[i] = value;
    core[i] = value >= 0.50 ? 1 : 0;
  }

  const closed = closeBinaryMask(core, width, height);
  const mainPerson = largestConnectedRegion(closed, width, height);
  const allowed = dilateMask(mainPerson, width, height, 2);
  const cleaned = new Float32Array(size);

  for (let i = 0; i < size; i += 1) {
    if (!allowed[i]) {
      cleaned[i] = 0;
      continue;
    }

    let alpha = smoothStep(0.24, 0.72, temporal[i]);
    if (mainPerson[i] && temporal[i] > 0.50) alpha = Math.max(alpha, 0.9);
    cleaned[i] = alpha;
  }

  return { temporal, cleaned };
}

export class PersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.segmenter = null;
    this.initializing = null;
    this.latestMask = null;
    this.temporalMask = null;
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
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate,
      },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });

    try {
      this.segmenter = await ImageSegmenter.createFromOptions(vision, makeOptions('GPU'));
      this.delegate = 'GPU';
    } catch (gpuError) {
      console.warn('Multiclass GPU segmentation unavailable. Falling back to CPU.', gpuError);
      this.segmenter = await ImageSegmenter.createFromOptions(vision, makeOptions('CPU'));
      this.delegate = 'CPU';
    }

    const labels = this.segmenter.getLabels?.() || [];
    console.info('Multiclass segmentation labels:', labels);
    this.onStatus(`AI 준비 · 멀티클래스 ${this.delegate}`);
    return this.segmenter;
  }

  segment(imageSource, timestampMs = performance.now()) {
    if (!this.segmenter) return this.latestMask;

    // renderer.js가 낮은 해상도의 보조 캔버스를 넘겨도, 실제 모델에는
    // 가능하면 카메라 원본 프레임을 직접 전달해 경계 정보를 보존한다.
    const cameraVideo = document.getElementById('cameraVideo');
    const source = cameraVideo?.readyState >= 2 ? cameraVideo : imageSource;

    let copiedMask = null;

    this.segmenter.segmentForVideo(source, timestampMs, (result) => {
      try {
        const masks = result.confidenceMasks;
        if (!masks || masks.length < 5) return;

        const width = masks[0].width;
        const height = masks[0].height;
        const hair = masks[1].getAsFloat32Array();
        const body = masks[2].getAsFloat32Array();
        const face = masks[3].getAsFloat32Array();
        const clothes = masks[4].getAsFloat32Array();
        const raw = new Float32Array(width * height);

        // class 5(others)는 배경 물체까지 끌고 들어오는 경우가 있어 제외한다.
        for (let i = 0; i < raw.length; i += 1) {
          raw[i] = Math.max(hair[i], body[i], face[i], clothes[i]);
        }

        const processed = cleanPersonMask(raw, this.temporalMask, width, height);
        this.temporalMask = processed.temporal;
        copiedMask = { width, height, data: processed.cleaned };
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
    this.temporalMask = null;
    this.onStatus('AI 대기');
  }
}
