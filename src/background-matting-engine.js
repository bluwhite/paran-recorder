const MAX_INPUT_WIDTH = 320;
const MIN_IDLE_AFTER_INFERENCE_MS = 80;
const REFERENCE_DB_NAME = 'paran-recorder-backgrounds';
const REFERENCE_DB_VERSION = 1;
const REFERENCE_STORE = 'references';
const REFERENCE_ID = 'default';
const LEGACY_STORAGE_KEY = 'paran-recorder-background-reference-v1';

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

function targetSize(imageSource) {
  const sourceWidth = imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || 1280;
  const sourceHeight = imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || 720;
  const scale = Math.min(1, MAX_INPUT_WIDTH / sourceWidth);
  return {
    width: Math.max(64, Math.round(sourceWidth * scale)),
    height: Math.max(64, Math.round(sourceHeight * scale)),
  };
}

function snapshotCanvas(imageSource, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(imageSource, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('기준 배경 이미지를 저장할 수 없습니다.'));
    }, type);
  });
}

async function makeBitmap(imageSource, width, height) {
  const sourceWidth = imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || width;
  const sourceHeight = imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || height;

  try {
    return await createImageBitmap(
      imageSource,
      0,
      0,
      sourceWidth,
      sourceHeight,
      { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' },
    );
  } catch {
    return createImageBitmap(snapshotCanvas(imageSource, width, height));
  }
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

async function loadStoredReference() {
  try {
    const db = await openReferenceDb();
    const record = await new Promise((resolve, reject) => {
      const transaction = db.transaction(REFERENCE_STORE, 'readonly');
      const request = transaction.objectStore(REFERENCE_STORE).get(REFERENCE_ID);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('저장된 기준 배경을 읽을 수 없습니다.'));
    });
    db.close();
    return record;
  } catch (error) {
    console.warn('Saved background reference could not be read.', error);
    return null;
  }
}

async function saveStoredReference(referenceBuffer, width, height, imageBlob) {
  try {
    const db = await openReferenceDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(REFERENCE_STORE, 'readwrite');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('기준 배경을 저장할 수 없습니다.'));
      transaction.objectStore(REFERENCE_STORE).put({
        id: REFERENCE_ID,
        version: 2,
        width,
        height,
        referenceBuffer,
        imageBlob,
        savedAt: new Date().toISOString(),
      });
    });
    db.close();
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* best effort */ }
    return true;
  } catch (error) {
    console.warn('Background reference could not be persisted.', error);
    return false;
  }
}

export class BackgroundMattingV2Engine {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.worker = null;
    this.initializing = null;
    this.ready = false;
    this.delegate = '';
    this.latestMask = null;
    this.busy = false;
    this.pendingError = null;
    this.referenceReady = false;
    this.referenceSource = '';
    this.width = 0;
    this.height = 0;
    this.lastRunFinishedAt = 0;
    this.lastDiagnosticsAt = 0;
    this.requestId = 0;
    this.pending = new Map();
  }

  #ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./background-matting-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => {
      const payload = event.data || {};
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.ok === false) pending.reject(new Error(payload.error || 'BackgroundMattingV2 worker 오류'));
      else pending.resolve(payload);
    });
    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'BackgroundMattingV2 worker를 시작하지 못했습니다.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.pendingError = error;
      this.onStatus('AI 오류');
    });
    this.worker = worker;
    return worker;
  }

  #request(type, payload = {}, transfer = []) {
    const worker = this.#ensureWorker();
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, type, ...payload }, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async ensureReady() {
    if (this.ready) return true;
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
    this.onStatus('배경 기준 AI Worker 모델 불러오는 중');
    await this.#request('init');
    this.ready = true;
    this.delegate = 'WASM Worker · 균형';
    await this.#restoreStoredReference();
    this.#updateStatus();
    return true;
  }

  async #restoreStoredReference() {
    const saved = await loadStoredReference();
    if (!saved?.referenceBuffer || !saved?.width || !saved?.height) return false;

    try {
      const width = Number(saved.width);
      const height = Number(saved.height);
      const referenceBuffer = saved.referenceBuffer.slice(0);
      await this.#request('restore', { referenceBuffer, width, height }, [referenceBuffer]);
      this.width = width;
      this.height = height;
      this.referenceReady = true;
      this.referenceSource = 'saved';
      this.latestMask = null;
      this.lastRunFinishedAt = 0;
      return true;
    } catch (error) {
      console.warn('Saved background reference could not be restored.', error);
      return false;
    }
  }

  #updateStatus() {
    if (!this.ready) return;
    const referenceStatus = document.getElementById('backgroundReferenceStatus');

    if (!this.referenceReady) {
      this.onStatus(`AI 준비 · 배경 기준 ${this.delegate} · 배경 촬영 필요`);
      return;
    }

    const sourceText = this.referenceSource === 'saved' ? '저장 배경 재사용' : '배경 저장 완료';
    this.onStatus(`AI 준비 · 배경 기준 ${this.delegate} · ${sourceText}`);
    if (referenceStatus) {
      referenceStatus.textContent = this.referenceSource === 'saved'
        ? `저장된 빈 배경 재사용 중 · ${this.width}×${this.height}`
        : `빈 배경 저장 완료 · ${this.width}×${this.height} · 다음 촬영까지 재사용`;
    }
  }

  async captureBackground(imageSource) {
    if (!imageSource || (imageSource.readyState !== undefined && imageSource.readyState < 2)) {
      throw new Error('카메라 화면이 준비되지 않았습니다.');
    }

    await this.ensureReady();
    const { width, height } = targetSize(imageSource);

    // Keep the model reference on the exact same bitmap/resize path as live frames.
    const modelBitmap = await makeBitmap(imageSource, width, height);
    const captureResult = await this.#request('capture', { bitmap: modelBitmap, width, height }, [modelBitmap]);
    if (!captureResult.referenceBuffer) {
      throw new Error('기준 배경 데이터를 Worker에서 받지 못했습니다.');
    }

    // Store a human-viewable lossless image separately from the exact tensor used by the model.
    const snapshot = snapshotCanvas(imageSource, width, height);
    const imageBlob = await canvasToBlob(snapshot, 'image/png');
    const persisted = await saveStoredReference(captureResult.referenceBuffer, width, height, imageBlob);

    this.width = width;
    this.height = height;
    this.referenceReady = true;
    this.referenceSource = persisted ? 'captured' : 'session';
    this.latestMask = null;
    this.lastRunFinishedAt = 0;
    this.#updateStatus();
    return { width, height, persisted };
  }

  clearBackground() {
    this.referenceReady = false;
    this.referenceSource = '';
    this.latestMask = null;
    this.lastRunFinishedAt = 0;
    if (this.worker && this.ready) {
      this.#request('clear').catch(() => {});
    }
    this.#updateStatus();
  }

  hasBackground() {
    return this.referenceReady;
  }

  #reportDiagnostics(payload) {
    const now = performance.now();
    if (now - this.lastDiagnosticsAt < 1000) return;
    this.lastDiagnosticsAt = now;

    const min = Number(payload.minAlpha || 0).toFixed(2);
    const max = Number(payload.maxAlpha || 0).toFixed(2);
    const mean = Number(payload.meanAlpha || 0).toFixed(2);
    const ms = Math.round(Number(payload.inferenceMs || 0));
    this.onStatus(`AI 준비 · 배경 기준 ${this.delegate} · α ${min}~${max} · ${ms}ms`);

    const status = document.getElementById('backgroundReferenceStatus');
    if (status) {
      const reuse = this.referenceSource === 'saved'
        ? '저장 배경 재사용'
        : (this.referenceSource === 'session' ? '현재 세션만 사용' : '다음 촬영까지 재사용');
      status.textContent = `빈 배경 ${this.width}×${this.height} · ${reuse} · α ${min}~${max} 평균 ${mean} · ${ms}ms`;
    }
  }

  async #run(imageSource) {
    const bitmap = await makeBitmap(imageSource, this.width, this.height);
    const payload = await this.#request('run', { bitmap }, [bitmap]);
    this.latestMask = {
      width: payload.width,
      height: payload.height,
      data: new Float32Array(payload.buffer),
    };
    this.#reportDiagnostics(payload);
  }

  segment(imageSource) {
    if (!this.ready || !this.referenceReady) return this.latestMask;

    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = null;
      throw error;
    }

    const now = performance.now();
    if (!this.busy && (this.lastRunFinishedAt === 0 || now - this.lastRunFinishedAt >= MIN_IDLE_AFTER_INFERENCE_MS)) {
      this.busy = true;
      this.#run(imageSource)
        .catch((error) => {
          this.pendingError = new Error(`배경 기준 AI 처리 실패: ${errorText(error)}`);
          this.onStatus('AI 오류');
        })
        .finally(() => {
          this.busy = false;
          this.lastRunFinishedAt = performance.now();
        });
    }

    return this.latestMask;
  }

  close() {
    for (const pending of this.pending.values()) {
      pending.reject(new Error('BackgroundMattingV2 worker가 종료되었습니다.'));
    }
    this.pending.clear();
    try { this.worker?.terminate(); } catch { /* best effort */ }
    this.worker = null;
    this.initializing = null;
    this.ready = false;
    this.latestMask = null;
    this.pendingError = null;
    this.busy = false;
    this.referenceReady = false;
    this.referenceSource = '';
    this.width = 0;
    this.height = 0;
    this.lastRunFinishedAt = 0;
    this.onStatus('AI 대기');
  }
}
