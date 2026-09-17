const MAX_INPUT_WIDTH = 320;
const REFERENCE_DB_NAME = 'paran-recorder-backgrounds';
const REFERENCE_DB_VERSION = 1;
const REFERENCE_STORE = 'references';
const REFERENCE_ID = 'fast-reference';
const FALLBACK_REFERENCE_ID = 'default';

const STRONG_THRESHOLD = 0.072;
const MOTION_KEEP_THRESHOLD = 0.028;
const MOTION_DIFF_THRESHOLD = 0.026;
const RELEASE_DIFF_THRESHOLD = 0.018;
const EDGE_LOW = 0.035;
const EDGE_HIGH = 0.11;
const EDGE_RADIUS = 2;
const MAX_INTERIOR_HOLE_RATIO = 0.006;

function targetSize(imageSource) {
  const sourceWidth = imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || 1280;
  const sourceHeight = imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || 720;
  const scale = Math.min(1, MAX_INPUT_WIDTH / sourceWidth);
  return {
    width: Math.max(64, Math.round(sourceWidth * scale)),
    height: Math.max(64, Math.round(sourceHeight * scale)),
  };
}

function openReferenceDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REFERENCE_DB_NAME, REFERENCE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REFERENCE_STORE)) {
        db.createObjectStore(REFERENCE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('기준 배경 저장소를 열 수 없습니다.'));
  });
}

async function loadRecord(id) {
  const db = await openReferenceDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(REFERENCE_STORE, 'readonly');
      const request = tx.objectStore(REFERENCE_STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('저장된 기준 배경을 읽을 수 없습니다.'));
    });
  } finally {
    db.close();
  }
}

async function saveRecord(record) {
  const db = await openReferenceDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(REFERENCE_STORE, 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('기준 배경을 저장할 수 없습니다.'));
      tx.objectStore(REFERENCE_STORE).put(record);
    });
  } finally {
    db.close();
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function encodeAlphaForSharedRenderer(alpha) {
  const y = Math.max(0, Math.min(1, alpha));
  const x = 0.5 - Math.sin(Math.asin(1 - (2 * y)) / 3);
  return 0.12 + (0.76 * x);
}

function dilate(source, width, height, radius, target) {
  target.fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!source[index]) continue;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let yy = y0; yy <= y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) target[row + xx] = 1;
      }
    }
  }
}

function erode(source, width, height, radius, target) {
  target.fill(0);
  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      let keep = 1;
      for (let yy = y - radius; yy <= y + radius && keep; yy += 1) {
        const row = yy * width;
        for (let xx = x - radius; xx <= x + radius; xx += 1) {
          if (!source[row + xx]) {
            keep = 0;
            break;
          }
        }
      }
      if (keep) target[y * width + x] = 1;
    }
  }
}

function fillSmallInteriorHoles(source, width, height, labels, queue, target) {
  target.set(source);
  labels.fill(0);
  const maxArea = Math.max(48, Math.round(source.length * MAX_INTERIOR_HOLE_RATIO));

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] || labels[start]) continue;

    let head = 0;
    let tail = 0;
    let touchesEdge = false;
    labels[start] = 1;
    queue[tail++] = start;

    while (head < tail) {
      const index = queue[head++];
      const y = Math.floor(index / width);
      const x = index - y * width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

      if (x > 0 && !source[index - 1] && !labels[index - 1]) {
        labels[index - 1] = 1;
        queue[tail++] = index - 1;
      }
      if (x + 1 < width && !source[index + 1] && !labels[index + 1]) {
        labels[index + 1] = 1;
        queue[tail++] = index + 1;
      }
      if (y > 0 && !source[index - width] && !labels[index - width]) {
        labels[index - width] = 1;
        queue[tail++] = index - width;
      }
      if (y + 1 < height && !source[index + width] && !labels[index + width]) {
        labels[index + width] = 1;
        queue[tail++] = index + width;
      }
    }

    if (!touchesEdge && tail <= maxArea) {
      for (let i = 0; i < tail; i += 1) target[queue[i]] = 1;
    }
  }
}

function largestRegion(binary, width, height, labels, queue, output) {
  labels.fill(0);
  output.fill(0);
  let label = 0;
  let bestLabel = 0;
  let bestCount = 0;

  for (let start = 0; start < binary.length; start += 1) {
    if (!binary[start] || labels[start]) continue;
    label += 1;
    let head = 0;
    let tail = 0;
    let count = 0;
    labels[start] = label;
    queue[tail++] = start;

    while (head < tail) {
      const index = queue[head++];
      count += 1;
      const y = Math.floor(index / width);
      const x = index - y * width;

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

  if (!bestLabel || bestCount < Math.max(80, Math.round(binary.length * 0.003))) return 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] === bestLabel) output[i] = 1;
  }
  return bestCount;
}

export class ReferenceBackgroundEngine {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.delegate = '실시간 기준 배경 · 움직임 보정';
    this.ready = false;
    this.initializing = null;
    this.referenceReady = false;
    this.referenceSource = '';
    this.width = 0;
    this.height = 0;
    this.canvas = null;
    this.context = null;
    this.reference = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.previousLuma = null;
    this.seed = null;
    this.expanded = null;
    this.closed = null;
    this.region = null;
    this.halo = null;
    this.labels = null;
    this.queue = null;
    this.diff = null;
    this.motion = null;
    this.alpha = null;
    this.encoded = null;
    this.lastStatusAt = 0;
  }

  async ensureReady() {
    if (this.ready) return true;
    if (this.initializing) return this.initializing;
    this.initializing = this.#initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async #initialize() {
    this.onStatus('실시간 배경 기준 준비 중');
    await this.#restoreReference();
    this.ready = true;
    this.#updateStatus();
    return true;
  }

  #prepare(width, height) {
    this.width = width;
    this.height = height;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.context = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    }
    this.canvas.width = width;
    this.canvas.height = height;
    const size = width * height;
    this.seed = new Uint8Array(size);
    this.expanded = new Uint8Array(size);
    this.closed = new Uint8Array(size);
    this.region = new Uint8Array(size);
    this.halo = new Uint8Array(size);
    this.labels = new Int32Array(size);
    this.queue = new Int32Array(size);
    this.diff = new Float32Array(size);
    this.motion = new Float32Array(size);
    this.alpha = new Float32Array(size);
    this.encoded = new Float32Array(size);
    this.previousAlpha = null;
    this.previousLuma = null;
    this.latestMask = null;
  }

  async #restoreReference() {
    try {
      let record = await loadRecord(REFERENCE_ID);
      if (!record) record = await loadRecord(FALLBACK_REFERENCE_ID);
      if (!record) return false;

      const width = Number(record.width || 0);
      const height = Number(record.height || 0);
      if (!width || !height) return false;

      if (record.pixelBuffer) {
        const pixels = new Uint8ClampedArray(record.pixelBuffer.slice(0));
        if (pixels.length !== width * height * 4) return false;
        this.#prepare(width, height);
        this.reference = pixels;
      } else if (record.imageBlob) {
        const bitmap = await createImageBitmap(record.imageBlob);
        this.#prepare(width, height);
        this.context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        this.reference = new Uint8ClampedArray(this.context.getImageData(0, 0, width, height).data);
      } else {
        return false;
      }

      this.referenceReady = true;
      this.referenceSource = 'saved';
      return true;
    } catch (error) {
      console.warn('Fast reference background restore failed.', error);
      return false;
    }
  }

  #updateStatus() {
    if (!this.referenceReady) {
      this.onStatus(`AI 준비 · ${this.delegate} · 배경 촬영 필요`);
      return;
    }
    const source = this.referenceSource === 'saved' ? '저장 배경 재사용' : '배경 저장 완료';
    this.onStatus(`AI 준비 · ${this.delegate} · ${source}`);
    const status = document.getElementById('backgroundReferenceStatus');
    if (status) status.textContent = `${source} · ${this.width}×${this.height}`;
  }

  async captureBackground(imageSource) {
    await this.ensureReady();
    const { width, height } = targetSize(imageSource);
    this.#prepare(width, height);
    this.context.drawImage(imageSource, 0, 0, width, height);
    const imageData = this.context.getImageData(0, 0, width, height);
    this.reference = new Uint8ClampedArray(imageData.data);
    this.referenceReady = true;
    this.referenceSource = 'captured';

    const imageBlob = await canvasToBlob(this.canvas);
    try {
      await saveRecord({
        id: REFERENCE_ID,
        version: 4,
        width,
        height,
        pixelBuffer: this.reference.buffer.slice(0),
        imageBlob,
        savedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn('Fast reference background persistence failed.', error);
      this.referenceSource = 'session';
    }

    this.#updateStatus();
    return { width, height, persisted: this.referenceSource !== 'session' };
  }

  hasBackground() {
    return this.referenceReady;
  }

  clearBackground() {
    this.referenceReady = false;
    this.referenceSource = '';
    this.reference = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.previousLuma = null;
    this.#updateStatus();
  }

  segment(imageSource) {
    if (!this.ready || !this.referenceReady || !this.reference) return this.latestMask;
    if (!imageSource || (imageSource.readyState !== undefined && imageSource.readyState < 2)) return this.latestMask;

    this.context.drawImage(imageSource, 0, 0, this.width, this.height);
    const current = this.context.getImageData(0, 0, this.width, this.height).data;
    const plane = this.width * this.height;
    const previous = this.previousAlpha?.length === plane ? this.previousAlpha : null;
    const previousLuma = this.previousLuma?.length === plane ? this.previousLuma : null;
    const nextLuma = previousLuma || new Uint8Array(plane);

    let offsetR = 0;
    let offsetG = 0;
    let offsetB = 0;
    let offsetCount = 0;
    const leftLimit = Math.floor(this.width * 0.18);
    const rightStart = Math.ceil(this.width * 0.82);
    const topLimit = Math.floor(this.height * 0.18);

    for (let y = 0; y < this.height; y += 4) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x += 4) {
        if (!(x < leftLimit || x >= rightStart || y < topLimit)) continue;
        const p = (row + x) * 4;
        offsetR += current[p] - this.reference[p];
        offsetG += current[p + 1] - this.reference[p + 1];
        offsetB += current[p + 2] - this.reference[p + 2];
        offsetCount += 1;
      }
    }

    if (offsetCount) {
      offsetR /= offsetCount;
      offsetG /= offsetCount;
      offsetB /= offsetCount;
    }

    this.seed.fill(0);
    let diffSum = 0;
    let motionSum = 0;

    for (let i = 0; i < plane; i += 1) {
      const p = i * 4;
      const r = Math.max(0, Math.min(255, current[p] - offsetR));
      const g = Math.max(0, Math.min(255, current[p + 1] - offsetG));
      const b = Math.max(0, Math.min(255, current[p + 2] - offsetB));
      const dr = Math.abs(r - this.reference[p]);
      const dg = Math.abs(g - this.reference[p + 1]);
      const db = Math.abs(b - this.reference[p + 2]);
      const difference = ((dr * 0.25) + (dg * 0.5) + (db * 0.25)) / 255;
      const luma = Math.round((r * 0.25) + (g * 0.5) + (b * 0.25));
      const motion = previousLuma ? Math.abs(luma - previousLuma[i]) / 255 : 0;

      this.diff[i] = difference;
      this.motion[i] = motion;
      nextLuma[i] = luma;
      diffSum += difference;
      motionSum += motion;

      const motionCarry = previous
        && previous[i] > 0.55
        && motion > MOTION_KEEP_THRESHOLD
        && difference > MOTION_DIFF_THRESHOLD;
      if (difference > STRONG_THRESHOLD || motionCarry) this.seed[i] = 1;
    }

    this.previousLuma = nextLuma;

    // Close tiny cracks, then fill only enclosed holes. This preserves open gaps
    // such as the space between an arm and torso.
    dilate(this.seed, this.width, this.height, 1, this.expanded);
    erode(this.expanded, this.width, this.height, 1, this.closed);
    fillSmallInteriorHoles(this.closed, this.width, this.height, this.labels, this.queue, this.expanded);

    // Keep the main subject only, removing detached compression/noise speckles.
    largestRegion(this.expanded, this.width, this.height, this.labels, this.queue, this.region);
    dilate(this.region, this.width, this.height, EDGE_RADIUS, this.halo);

    for (let i = 0; i < plane; i += 1) {
      let value = 0;
      if (this.region[i]) {
        value = Math.max(0.95, smoothstep(STRONG_THRESHOLD, 0.14, this.diff[i]));
      } else if (this.halo[i]) {
        value = smoothstep(EDGE_LOW, EDGE_HIGH, this.diff[i]) * 0.82;
      }

      // During movement, a pixel that was foreground in the previous frame may
      // temporarily become weak because of motion blur/compression. Keep it only
      // while the current frame still differs from the captured background.
      if (previous && previous[i] > value) {
        if (this.diff[i] <= RELEASE_DIFF_THRESHOLD) {
          // The captured background is back: release immediately to avoid trails.
          value = 0;
        } else if (this.motion[i] > MOTION_KEEP_THRESHOLD && this.diff[i] > MOTION_DIFF_THRESHOLD) {
          value = Math.max(value, previous[i] * 0.82);
        } else {
          value = Math.max(value, previous[i] * 0.16);
        }
      } else if (previous && value > previous[i]) {
        value = (value * 0.98) + (previous[i] * 0.02);
      }

      this.alpha[i] = value;
      this.encoded[i] = encodeAlphaForSharedRenderer(value);
    }

    this.previousAlpha = this.alpha.slice();
    this.latestMask = { width: this.width, height: this.height, data: this.encoded.slice() };

    const now = performance.now();
    if (now - this.lastStatusAt > 1000) {
      this.lastStatusAt = now;
      const meanDiff = diffSum / Math.max(1, plane);
      const meanMotion = motionSum / Math.max(1, plane);
      this.onStatus(`AI 준비 · ${this.delegate} · 차이 ${(meanDiff * 100).toFixed(1)}% · 움직임 ${(meanMotion * 100).toFixed(1)}%`);
      const status = document.getElementById('backgroundReferenceStatus');
      if (status) {
        const source = this.referenceSource === 'saved' ? '저장 배경 재사용' : '다음 촬영까지 재사용';
        status.textContent = `빈 배경 ${this.width}×${this.height} · ${source} · 움직임 대응 실시간 차분`;
      }
    }

    return this.latestMask;
  }

  close() {
    this.ready = false;
    this.referenceReady = false;
    this.reference = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.previousLuma = null;
    this.onStatus('AI 대기');
  }
}
