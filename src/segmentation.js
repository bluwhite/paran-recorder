import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { NativeOnnxSegmenter, isNativeOnnxAvailable, probeNativeOnnx } from './native-onnx-engine.js';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const MEDIAPIPE_INPUT_WIDTH = 256;
const MEDIAPIPE_INPUT_HEIGHT = 144;
const SETTINGS_KEY = 'paran-recorder-mediapipe-settings-v1';

const PRESETS = {
  balanced: { tracking: 70, cleanup: 55, preserve: 60 },
  motion: { tracking: 90, cleanup: 45, preserve: 65 },
  edge: { tracking: 65, cleanup: 80, preserve: 45 },
};

const PRESET_LABELS = {
  balanced: '균형',
  motion: '빠른 움직임',
  edge: '경계 우선',
  custom: '사용자 설정',
};

let currentSettings = loadSettings();
let settingsUiBound = false;

function clampSetting(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizedSettings(value = {}) {
  return {
    tracking: clampSetting(value.tracking, PRESETS.balanced.tracking),
    cleanup: clampSetting(value.cleanup, PRESETS.balanced.cleanup),
    preserve: clampSetting(value.preserve, PRESETS.balanced.preserve),
  };
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    return normalizedSettings(saved || PRESETS.balanced);
  } catch {
    return { ...PRESETS.balanced };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
  } catch {
    // The recorder still works when storage is unavailable.
  }
}

function sameSettings(a, b) {
  return a.tracking === b.tracking
    && a.cleanup === b.cleanup
    && a.preserve === b.preserve;
}

function currentPresetName() {
  for (const [name, values] of Object.entries(PRESETS)) {
    if (sameSettings(currentSettings, values)) return name;
  }
  return 'custom';
}

function updateSettingsUi() {
  const tracking = document.getElementById('aiTracking');
  const cleanup = document.getElementById('aiCleanup');
  const preserve = document.getElementById('aiPreserve');
  const trackingValue = document.getElementById('aiTrackingValue');
  const cleanupValue = document.getElementById('aiCleanupValue');
  const preserveValue = document.getElementById('aiPreserveValue');
  const presetLabel = document.getElementById('aiPresetLabel');
  const presetName = currentPresetName();

  if (tracking) tracking.value = String(currentSettings.tracking);
  if (cleanup) cleanup.value = String(currentSettings.cleanup);
  if (preserve) preserve.value = String(currentSettings.preserve);
  if (trackingValue) trackingValue.textContent = String(currentSettings.tracking);
  if (cleanupValue) cleanupValue.textContent = String(currentSettings.cleanup);
  if (preserveValue) preserveValue.textContent = String(currentSettings.preserve);
  if (presetLabel) presetLabel.textContent = PRESET_LABELS[presetName];

  document.querySelectorAll('[data-ai-preset]').forEach((button) => {
    button.classList.toggle('active', button.dataset.aiPreset === presetName);
  });
}

function applySettings(next) {
  currentSettings = normalizedSettings(next);
  saveSettings();
  updateSettingsUi();
}

function bindSettingsUi() {
  if (settingsUiBound) return;
  settingsUiBound = true;

  const controls = {
    tracking: document.getElementById('aiTracking'),
    cleanup: document.getElementById('aiCleanup'),
    preserve: document.getElementById('aiPreserve'),
  };

  for (const [key, control] of Object.entries(controls)) {
    control?.addEventListener('input', () => {
      applySettings({ ...currentSettings, [key]: Number(control.value) });
    });
  }

  document.querySelectorAll('[data-ai-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS[button.dataset.aiPreset];
      if (preset) applySettings(preset);
    });
  });

  document.getElementById('aiResetButton')?.addEventListener('click', () => {
    applySettings(PRESETS.balanced);
  });

  updateSettingsUi();
}

function runtimeTuning() {
  const { tracking, cleanup, preserve } = currentSettings;
  return {
    intervalMs: Math.round(80 - (tracking * 0.5)),
    previousWeight: Math.max(0, Math.min(0.10, 0.10 * (1 - (tracking / 90)))),
    edgeNeighborThreshold: 0.50 + (cleanup * 0.0018),
    edgeGain: 0.80 - (cleanup * 0.0045),
    sparseNeighborMinimum: cleanup >= 75 ? 3 : (cleanup >= 45 ? 2 : 1),
    headHaloRadius: Math.max(2, Math.min(8, Math.round(2.5 + (preserve * 0.05) - (cleanup * 0.01)))),
  };
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

function trimSparseBoundary(binary, width, height, minimumNeighbors) {
  if (minimumNeighbors <= 1) return binary;
  const output = binary.slice();

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!binary[index]) continue;
      let neighbors = 0;
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      for (let yy = y0; yy <= y1; yy += 1) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx += 1) {
          if (xx === x && yy === y) continue;
          neighbors += binary[row + xx];
        }
      }
      if (neighbors < minimumNeighbors) output[index] = 0;
    }
  }

  return output;
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

function softenMask(binary, width, height, previous, tuning) {
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
        ? Math.max(0.78, neighborhood)
        : (neighborhood >= tuning.edgeNeighborThreshold
          ? Math.max(0, (neighborhood - 0.50) * tuning.edgeGain)
          : 0);
      const previousWeight = previous?.length === binary.length ? tuning.previousWeight : 0;
      alpha[index] = (current * (1 - previousWeight)) + ((previous?.[index] || 0) * previousWeight);
    }
  }
  return alpha;
}

function buildForegroundMask(categories, width, height, previous) {
  const tuning = runtimeTuning();
  const size = categories.length;
  const core = new Uint8Array(size);
  const head = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    const category = categories[i];
    if (category >= 1 && category <= 4) core[i] = 1;
    if (category === 1 || category === 3) head[i] = 1;
  }

  const mainRegion = largestConnectedRegion(core, width, height);
  const mainPerson = trimSparseBoundary(mainRegion, width, height, tuning.sparseNeighborMinimum);
  const headHalo = dilateMask(head, width, height, tuning.headHaloRadius);
  const headInterior = enclosedHeadMask(head, width, height);
  const foreground = new Uint8Array(size);

  for (let i = 0; i < size; i += 1) {
    const category = categories[i];
    if (mainPerson[i]) {
      foreground[i] = 1;
      continue;
    }

    // Class 5 is retained only near the head for glasses and small facial accessories.
    if (category === 5 && headHalo[i]) {
      foreground[i] = 1;
      continue;
    }

    if (headInterior[i]) foreground[i] = 1;
  }

  return softenMask(foreground, width, height, previous, tuning);
}

class MediaPipePersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.segmenter = null;
    this.initializing = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.delegate = '';
    this.realtimeTimer = null;
    this.realtimeCanvas = null;
    this.realtimeCtx = null;
    this.processing = false;
    this.closed = false;
  }

  async ensureReady() {
    if (this.segmenter) {
      this.#startRealtimeLoop();
      return this.segmenter;
    }
    if (this.initializing) return this.initializing;

    this.closed = false;
    this.initializing = this.#initialize()
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        this.onStatus('AI 로드 실패');
        throw normalized;
      })
      .finally(() => {
        this.initializing = null;
      });

    return this.initializing;
  }

  async #initialize() {
    this.onStatus('AI MediaPipe 모델 불러오는 중');
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
      console.warn('MediaPipe GPU segmentation unavailable. Falling back to CPU.', gpuError);
      this.segmenter = await ImageSegmenter.createFromOptions(vision, makeOptions('CPU'));
      this.delegate = 'CPU';
    }

    this.#startRealtimeLoop();
    this.#updateStatus();
    return this.segmenter;
  }

  #updateStatus() {
    const preset = PRESET_LABELS[currentPresetName()];
    this.onStatus(`AI 준비 · MediaPipe ${this.delegate} · ${preset}`);
  }

  #startRealtimeLoop() {
    if (this.realtimeTimer || this.closed) return;
    if (!this.realtimeCanvas) {
      this.realtimeCanvas = document.createElement('canvas');
      this.realtimeCanvas.width = MEDIAPIPE_INPUT_WIDTH;
      this.realtimeCanvas.height = MEDIAPIPE_INPUT_HEIGHT;
      this.realtimeCtx = this.realtimeCanvas.getContext('2d', { alpha: false });
    }

    const tick = () => {
      this.realtimeTimer = null;
      if (this.closed || !this.segmenter) return;

      const cameraVideo = document.getElementById('cameraVideo');
      if (!this.processing && cameraVideo?.readyState >= 2) {
        this.realtimeCtx.drawImage(cameraVideo, 0, 0, MEDIAPIPE_INPUT_WIDTH, MEDIAPIPE_INPUT_HEIGHT);
        this.#processFrame(this.realtimeCanvas, performance.now());
      }

      this.realtimeTimer = setTimeout(tick, runtimeTuning().intervalMs);
    };

    this.realtimeTimer = setTimeout(tick, 0);
  }

  #processFrame(imageSource, timestampMs) {
    if (!this.segmenter || this.processing) return this.latestMask;
    this.processing = true;
    let copiedMask = null;

    try {
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
    } finally {
      this.processing = false;
    }

    return copiedMask || this.latestMask;
  }

  segment(imageSource, timestampMs = performance.now()) {
    if (!this.segmenter) return this.latestMask;
    this.#startRealtimeLoop();
    if (!this.latestMask) return this.#processFrame(imageSource, timestampMs);
    this.#updateStatus();
    return this.latestMask;
  }

  close() {
    this.closed = true;
    if (this.realtimeTimer) clearTimeout(this.realtimeTimer);
    this.realtimeTimer = null;
    try { this.segmenter?.close(); } catch { /* best effort */ }
    this.segmenter = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.processing = false;
    this.onStatus('AI 대기');
  }
}

export class PersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.engine = null;
    this.engineMode = '';
    bindSettingsUi();
    this.#wireEngineUi();
  }

  #selectedMode() {
    const value = document.getElementById('aiEngineSelect')?.value;
    return value === 'native-onnx' && isNativeOnnxAvailable()
      ? 'native-onnx'
      : 'mediapipe';
  }

  #getEngine() {
    const selectedMode = this.#selectedMode();
    if (this.engine && this.engineMode === selectedMode) return this.engine;

    this.engine?.close?.();
    this.engineMode = selectedMode;
    this.engine = selectedMode === 'native-onnx'
      ? new NativeOnnxSegmenter(this.onStatus)
      : new MediaPipePersonSegmenter(this.onStatus);
    return this.engine;
  }

  #wireEngineUi() {
    const select = document.getElementById('aiEngineSelect');
    const nativeOption = document.getElementById('nativeOnnxOption');
    const advanced = document.getElementById('mediaPipeAdvanced');
    const engineNote = document.getElementById('aiEngineNote');
    const nativeInfo = document.getElementById('nativeEngineInfo');

    const refreshUi = () => {
      const nativeSelected = select?.value === 'native-onnx' && !nativeOption?.hidden;
      advanced?.classList.toggle('hidden', nativeSelected);
      if (engineNote) {
        const strong = engineNote.querySelector('strong');
        const span = engineNote.querySelector('span');
        if (strong) strong.textContent = nativeSelected
          ? 'AI 배경 제거 · ONNX Runtime Native'
          : 'AI 배경 제거 · MediaPipe';
        if (span) span.textContent = nativeSelected
          ? 'Windows 네이티브 ONNX Runtime이 저해상도 카메라 프레임을 GPU에서 처리합니다.'
          : '빠른 실시간 처리를 사용합니다. 환경에 따라 아래 고급 설정을 조절할 수 있습니다.';
      }
      nativeInfo?.classList.toggle('hidden', !nativeSelected);
    };

    select?.addEventListener('change', () => {
      this.engine?.close?.();
      this.engine = null;
      this.engineMode = '';
      refreshUi();
      this.ensureReady().catch((error) => {
        console.error('AI engine switch failed:', error);
        this.onStatus('AI 오류');
      });
    });

    refreshUi();

    if (!isNativeOnnxAvailable() || !nativeOption) return;
    probeNativeOnnx().then((info) => {
      if (!info?.available) return;
      nativeOption.hidden = false;
      if (nativeInfo) {
        nativeInfo.textContent = `Native: ${info.provider || 'ONNX Runtime'} · ${info.model || 'PP-HumanSegV2-Lite'}`;
      }
      refreshUi();
    }).catch((error) => {
      console.warn('Native ONNX runtime unavailable:', error);
      nativeOption.hidden = true;
      if (select?.value === 'native-onnx') select.value = 'mediapipe';
      refreshUi();
    });
  }

  async ensureReady() {
    return this.#getEngine().ensureReady();
  }

  segment(imageSource, timestampMs = performance.now()) {
    return this.#getEngine().segment(imageSource, timestampMs);
  }

  hasBackgroundReference() {
    return false;
  }

  clearBackgroundReference() {
    // Kept as a no-op for renderer compatibility.
  }

  close() {
    this.engine?.close?.();
    this.engine = null;
    this.engineMode = '';
  }
}
