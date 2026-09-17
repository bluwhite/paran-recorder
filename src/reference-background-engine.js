const MAX_INPUT_WIDTH = 320;
const REFERENCE_DB_NAME = 'paran-recorder-backgrounds';
const REFERENCE_DB_VERSION = 1;
const REFERENCE_STORE = 'references';
const REFERENCE_ID = 'fast-reference';
const FALLBACK_REFERENCE_ID = 'default';

const STRONG_THRESHOLD = 0.072;
const EDGE_LOW = 0.035;
const EDGE_HIGH = 0.11;
const EDGE_RADIUS = 2;
const TEMPORAL_CURRENT = 0.97;

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
    this.delegate = '실시간 기준 배경 · 경계 개선';
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
    this.seed = null;
    this.expanded = null;
    this.closed = null;
    this.region = null;
    this.halo = null;
    this.labels = null;
    this.queue = null;
    this.diff = null;
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
    this.alpha = new Float32Array(size);
    this.encoded = new Float32Array(size);
    this.previousAlpha = null;
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
        version: 2,
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
    this.#updateStatus();
  }

  segment(imageSource) {
    if (!this.ready || !this.referenceReady || !this.reference) return this.latestMask;
    if (!imageSource || (imageSource.readyState !== undefined && imageSource.readyState < 2)) return this.latestMask;

    this.context.drawImage(imageSource, 0, 0, this.width, this.height);
    const current = this.context.getImageData(0, 0, this.width, this.height).data;
    const plane = this.width * this.height;

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
    for (let i = 0; i < plane; i += 1) {
      const p = i * 4;
      const dr = Math.abs((current[p] - offsetR) - this.reference[p]);
      const dg = Math.abs((current[p + 1] - offsetG) - this.reference[p + 1]);
      const db = Math.abs((current[p + 2] - offsetB) - this.reference[p + 2]);
      const difference = ((dr * 0.25) + (dg * 0.5) + (db * 0.25)) / 255;
      this.diff[i] = difference;
      diffSum += difference;
      if (difference > STRONG_THRESHOLD) this.seed[i] = 1;
    }

    // Close tiny holes without permanently expanding the subject boundary.
    dilate(this.seed, this.width, this.height, 1, this.expanded);
    erode(this.expanded, this.width, this.height, 1, this.closed);

    // Keep only the main connected subject. Detached speckles disappear here.
    largestRegion(this.closed, this.width, this.height, this.labels, this.queue, this.region);

    // Only a narrow band around the main subject may become a soft edge.
    dilate(this.region, this.width, this.height, EDGE_RADIUS, this.halo);

    const previous = this.previousAlpha?.length === plane ? this.previousAlpha : null;
    for (let i = 0; i < plane; i += 1) {
      let value = 0;
      if (this.region[i]) {
        value = Math.max(0.94, smoothstep(STRONG_THRESHOLD, 0.14, this.diff[i]));
      } else if (this.halo[i]) {
        const edge = smoothstep(EDGE_LOW, EDGE_HIGH, this.diff[i]);
        value = edge * 0.82;
      }

      const mixed = previous
        ? (value * TEMPORAL_CURRENT) + (previous[i] * (1 - TEMPORAL_CURRENT))
        : value;
      this.alpha[i] = mixed;
      this.encoded[i] = encodeAlphaForSharedRenderer(mixed);
    }

    this.previousAlpha = this.alpha.slice();
    this.latestMask = { width: this.width, height: this.height, data: this.encoded.slice() };

    const now = performance.now();
    if (now - this.lastStatusAt > 1000) {
      this.lastStatusAt = now;
      const meanDiff = diffSum / Math.max(1, plane);
      this.onStatus(`AI 준비 · ${this.delegate} · 차이 ${(meanDiff * 100).toFixed(1)}%`);
      const status = document.getElementById('backgroundReferenceStatus');
      if (status) {
        const source = this.referenceSource === 'saved' ? '저장 배경 재사용' : '다음 촬영까지 재사용';
        status.textContent = `빈 배경 ${this.width}×${this.height} · ${source} · 경계 개선 실시간 차분`;
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
    this.onStatus('AI 대기');
  }
}
