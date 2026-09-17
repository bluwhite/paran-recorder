const ASSET_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747';

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // Fall through to a readable generic message.
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
    const centerBonus = 1 + Math.max(0, 0.35 - distance) * 0.55;
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

function dilateMask(source, width, height, radius = 3) {
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

function cleanPersonMask(raw, previous, width, height) {
  const size = raw.length;
  const temporal = new Float32Array(size);
  const core = new Uint8Array(size);

  // 시간축 안정화: 배경의 작은 깜빡임은 줄이되 빠른 움직임은 따라간다.
  const previousWeight = previous?.length === size ? 0.58 : 0;
  const currentWeight = 1 - previousWeight;

  for (let i = 0; i < size; i += 1) {
    const value = previousWeight
      ? previous[i] * previousWeight + raw[i] * currentWeight
      : raw[i];
    temporal[i] = value;
    core[i] = value >= 0.52 ? 1 : 0;
  }

  // 몸 안의 작은 빈틈을 먼저 메운 뒤, 사람과 떨어진 잡영을 제거한다.
  const closed = closeBinaryMask(core, width, height);
  const mainPerson = largestConnectedRegion(closed, width, height);
  const allowed = dilateMask(mainPerson, width, height, 4);
  const cleaned = new Float32Array(size);

  for (let i = 0; i < size; i += 1) {
    if (!allowed[i]) {
      cleaned[i] = 0;
      continue;
    }

    // 내부는 확실히 살리고 경계만 부드럽게 남긴다.
    let alpha = smoothStep(0.30, 0.70, temporal[i]);
    if (mainPerson[i] && temporal[i] > 0.46) alpha = Math.max(alpha, 0.82);
    cleaned[i] = alpha;
  }

  return { temporal, cleaned };
}

export class PersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.solution = null;
    this.initializing = null;
    this.latestMask = null;
    this.temporalMask = null;
    this.busy = false;
    this.pendingError = null;
    this.maskWidth = 320;
    this.maskHeight = 180;
    this.maskCanvas = document.createElement('canvas');
    this.maskContext = this.maskCanvas.getContext('2d', { willReadFrequently: true });
  }

  async ensureReady() {
    if (this.solution) return this.solution;
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
    this.onStatus('AI 모델 불러오는 중');

    const SelfieSegmentation = globalThis.SelfieSegmentation;
    if (typeof SelfieSegmentation !== 'function') {
      throw new Error('Selfie Segmentation 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
    }

    const solution = new SelfieSegmentation({
      locateFile: (file) => `${ASSET_ROOT}/${file}`,
    });

    solution.setOptions({
      modelSelection: 0,
      selfieMode: false,
    });

    solution.onResults((results) => {
      try {
        if (!results?.segmentationMask) return;

        const width = this.maskWidth;
        const height = this.maskHeight;
        if (this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
          this.maskCanvas.width = width;
          this.maskCanvas.height = height;
        }

        this.maskContext.clearRect(0, 0, width, height);
        this.maskContext.drawImage(results.segmentationMask, 0, 0, width, height);
        const pixels = this.maskContext.getImageData(0, 0, width, height).data;
        const raw = new Float32Array(width * height);

        for (let i = 0, pixel = 0; i < pixels.length; i += 4, pixel += 1) {
          raw[pixel] = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) / 255;
        }

        const processed = cleanPersonMask(raw, this.temporalMask, width, height);
        this.temporalMask = processed.temporal;
        this.latestMask = { width, height, data: processed.cleaned };
        this.pendingError = null;
      } catch (error) {
        this.pendingError = error instanceof Error ? error : new Error(errorText(error));
      }
    });

    try {
      await solution.initialize();
    } catch (error) {
      try { await solution.close(); } catch { /* best effort */ }
      throw new Error(`셀피 분할 모델 초기화 실패: ${errorText(error)}`);
    }

    this.solution = solution;
    this.onStatus('AI 준비 · 정밀 분할');
    return solution;
  }

  segment(imageSource) {
    if (!this.solution) return this.latestMask;

    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = null;
      throw error;
    }

    if (!this.busy) {
      this.busy = true;
      this.solution.send({ image: imageSource })
        .catch((error) => {
          this.pendingError = new Error(`셀피 분할 처리 실패: ${errorText(error)}`);
          this.onStatus('AI 오류');
        })
        .finally(() => {
          this.busy = false;
        });
    }

    return this.latestMask;
  }

  close() {
    const solution = this.solution;
    this.solution = null;
    this.latestMask = null;
    this.temporalMask = null;
    this.busy = false;
    this.pendingError = null;
    if (solution) {
      Promise.resolve(solution.close()).catch(() => {});
    }
    this.onStatus('AI 대기');
  }
}
