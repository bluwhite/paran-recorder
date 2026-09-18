const MIN_IDLE_MS = 0;
const SETTINGS_KEY = 'paran-recorder-rvm-settings-v1';

const RESOLUTIONS = {
  '256x144': { width: 256, height: 144 },
  '224x126': { width: 224, height: 126 },
  '192x108': { width: 192, height: 108 },
};

const PRESETS = {
  quality: { resolution: '256x144', downsample: 1.00 },
  balanced: { resolution: '224x126', downsample: 0.75 },
  speed: { resolution: '192x108', downsample: 0.50 },
};

const PRESET_LABELS = {
  quality: '품질 우선',
  balanced: '균형',
  speed: '속도 우선',
  custom: '사용자 설정',
};

let currentSettings = loadSettings();
let settingsUiBound = false;

function tauriInvoke() {
  return window.__TAURI__?.core?.invoke || null;
}

function normalizeBinaryResponse(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('RVM 마스크 응답 형식을 확인할 수 없습니다.');
}

function normalizedSettings(value = {}) {
  const resolution = RESOLUTIONS[value.resolution] ? value.resolution : PRESETS.quality.resolution;
  const numeric = Number(value.downsample);
  const downsample = Number.isFinite(numeric)
    ? Math.max(0.50, Math.min(1.00, Math.round(numeric * 20) / 20))
    : PRESETS.quality.downsample;
  return { resolution, downsample };
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    return normalizedSettings(saved || PRESETS.quality);
  } catch {
    return { ...PRESETS.quality };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings));
  } catch {
    // RVM remains usable even when storage is unavailable.
  }
}

function sameSettings(a, b) {
  return a.resolution === b.resolution && Math.abs(a.downsample - b.downsample) < 0.001;
}

function currentPresetName() {
  for (const [name, values] of Object.entries(PRESETS)) {
    if (sameSettings(currentSettings, values)) return name;
  }
  return 'custom';
}

function updatePerformance(text) {
  const element = document.getElementById('rvmPerformance');
  if (element) element.textContent = text;
}

function updateSettingsUi() {
  const resolution = document.getElementById('rvmResolution');
  const downsample = document.getElementById('rvmDownsample');
  const downsampleValue = document.getElementById('rvmDownsampleValue');
  const presetLabel = document.getElementById('rvmPresetLabel');
  const presetName = currentPresetName();

  if (resolution) resolution.value = currentSettings.resolution;
  if (downsample) downsample.value = String(Math.round(currentSettings.downsample * 100));
  if (downsampleValue) downsampleValue.textContent = currentSettings.downsample.toFixed(2);
  if (presetLabel) presetLabel.textContent = PRESET_LABELS[presetName];

  document.querySelectorAll('[data-rvm-preset]').forEach((button) => {
    button.classList.toggle('active', button.dataset.rvmPreset === presetName);
  });
}

function notifySettingsChanged(forceReset = false) {
  window.dispatchEvent(new CustomEvent('paran-rvm-settings-changed', {
    detail: { ...currentSettings, forceReset },
  }));
}

function applySettings(next, notify = true) {
  currentSettings = normalizedSettings(next);
  saveSettings();
  updateSettingsUi();
  if (notify) notifySettingsChanged(false);
}

export function bindRvmSettingsUi() {
  if (settingsUiBound) {
    updateSettingsUi();
    return;
  }
  settingsUiBound = true;

  const resolution = document.getElementById('rvmResolution');
  const downsample = document.getElementById('rvmDownsample');

  resolution?.addEventListener('change', () => {
    applySettings({ ...currentSettings, resolution: resolution.value });
  });

  downsample?.addEventListener('input', () => {
    applySettings({ ...currentSettings, downsample: Number(downsample.value) / 100 });
  });

  document.querySelectorAll('[data-rvm-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = PRESETS[button.dataset.rvmPreset];
      if (preset) applySettings(preset);
    });
  });

  document.getElementById('rvmResetButton')?.addEventListener('click', () => {
    updatePerformance('현재 성능 · RVM 상태 초기화 중');
    notifySettingsChanged(true);
  });

  updateSettingsUi();
}

export function currentRvmSettings() {
  const dims = RESOLUTIONS[currentSettings.resolution] || RESOLUTIONS['256x144'];
  return {
    ...currentSettings,
    width: dims.width,
    height: dims.height,
  };
}

export function isNativeRvmAvailable() {
  return Boolean(tauriInvoke());
}

export async function probeNativeRvm() {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return invoke('native_rvm_info');
}

export class NativeRvmSegmenter {
  constructor(onStatus = () => {}) {
    bindRvmSettingsUi();
    this.onStatus = onStatus;
    this.latestMask = null;
    this.ready = false;
    this.initializing = null;
    this.closed = false;
    this.processing = false;
    this.timer = null;
    this.canvas = document.createElement('canvas');
    const initial = currentRvmSettings();
    this.canvas.width = initial.width;
    this.canvas.height = initial.height;
    this.context = this.canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    this.runtimeInfo = null;
    this.lastStatusAt = 0;
    this.framesSinceStatus = 0;
    this.lastInferenceMs = 0;
    this.activeSignature = '';
    this.settingsChangedHandler = () => {
      this.activeSignature = '';
      updatePerformance('현재 성능 · 새 설정 적용 대기');
    };
    window.addEventListener('paran-rvm-settings-changed', this.settingsChangedHandler);
  }

  async ensureReady() {
    if (this.ready) {
      this.#startLoop();
      return this.runtimeInfo;
    }
    if (this.initializing) return this.initializing;

    this.closed = false;
    this.initializing = this.#initialize().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  async #initialize() {
    const invoke = tauriInvoke();
    if (!invoke) throw new Error('RVM Native는 데스크톱 EXE에서만 사용할 수 있습니다.');

    this.onStatus('AI RVM 모델 준비 중 · 처음에는 약 15MB 다운로드');
    updatePerformance('현재 성능 · RVM 모델 준비 중');
    const info = await invoke('native_rvm_prepare');
    if (!info?.available) {
      throw new Error(info?.message || 'RVM Native를 사용할 수 없습니다.');
    }

    this.runtimeInfo = info;
    this.ready = true;
    this.#startLoop();
    const provider = info.provider || 'ONNX Runtime';
    this.onStatus(`AI 준비 · RVM Native · ${provider}`);
    updatePerformance('현재 성능 · 첫 프레임 대기 중');
    return info;
  }

  async #syncSettings() {
    const invoke = tauriInvoke();
    const settings = currentRvmSettings();
    const signature = `${settings.width}x${settings.height}@${settings.downsample.toFixed(2)}`;
    if (signature === this.activeSignature) return settings;

    this.canvas.width = settings.width;
    this.canvas.height = settings.height;
    this.context = this.canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });

    if (invoke) await invoke('native_rvm_reset');
    this.activeSignature = signature;
    this.lastStatusAt = 0;
    this.framesSinceStatus = 0;
    updatePerformance(
      `현재 성능 · 적용 중 · ${settings.width}×${settings.height} · ratio ${settings.downsample.toFixed(2)}`,
    );
    return settings;
  }

  #startLoop() {
    if (this.timer || this.closed) return;

    const tick = async () => {
      this.timer = null;
      if (this.closed || !this.ready) return;

      const cameraVideo = document.getElementById('cameraVideo');
      if (!this.processing && cameraVideo?.readyState >= 2) {
        await this.#processCamera(cameraVideo);
      }

      if (!this.closed) this.timer = setTimeout(tick, MIN_IDLE_MS);
    };

    this.timer = setTimeout(tick, 0);
  }

  async #processCamera(cameraVideo) {
    const invoke = tauriInvoke();
    if (!invoke || this.processing) return;

    this.processing = true;
    const startedAt = performance.now();
    try {
      const settings = await this.#syncSettings();
      const { width, height, downsample } = settings;

      this.context.drawImage(cameraVideo, 0, 0, width, height);
      const rgba = this.context.getImageData(0, 0, width, height).data;
      const response = await invoke(
        'native_rvm_segment',
        new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        {
          headers: {
            'x-width': String(width),
            'x-height': String(height),
            'x-downsample-ratio': downsample.toFixed(2),
            'x-format': 'rgba8',
          },
        },
      );

      const bytes = normalizeBinaryResponse(response);
      const expected = width * height;
      if (bytes.length !== expected) {
        throw new Error(`RVM 마스크 크기가 올바르지 않습니다. ${bytes.length} / ${expected}`);
      }

      this.latestMask = {
        width,
        height,
        data: bytes,
        format: 'alpha8',
      };

      const now = performance.now();
      this.lastInferenceMs = now - startedAt;
      this.framesSinceStatus += 1;
      if (now - this.lastStatusAt >= 1000) {
        const elapsedSeconds = this.lastStatusAt > 0 ? (now - this.lastStatusAt) / 1000 : 1;
        const fps = Math.max(1, Math.round(this.framesSinceStatus / elapsedSeconds));
        const provider = this.runtimeInfo?.provider || 'ONNX Runtime';
        const performanceText =
          `현재 성능 · ${Math.round(this.lastInferenceMs)}ms / ${fps}fps · ` +
          `${width}×${height} · ratio ${downsample.toFixed(2)}`;
        this.onStatus(
          `AI 준비 · RVM Native · ${provider} · ${Math.round(this.lastInferenceMs)}ms / ${fps}fps`,
        );
        updatePerformance(performanceText);
        this.lastStatusAt = now;
        this.framesSinceStatus = 0;
      }
    } catch (error) {
      console.error('Native RVM segmentation failed:', error);
      this.onStatus('AI RVM Native 오류');
      updatePerformance(`현재 성능 · 오류 · ${error.message || String(error)}`);
    } finally {
      this.processing = false;
    }
  }

  segment() {
    this.#startLoop();
    return this.latestMask;
  }

  close() {
    this.closed = true;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.processing = false;
    this.latestMask = null;
    this.runtimeInfo = null;
    this.lastStatusAt = 0;
    this.framesSinceStatus = 0;
    this.lastInferenceMs = 0;
    this.activeSignature = '';
    window.removeEventListener('paran-rvm-settings-changed', this.settingsChangedHandler);

    const invoke = tauriInvoke();
    if (invoke) {
      invoke('native_rvm_reset').catch((error) => {
        console.warn('RVM recurrent state reset failed:', error);
      });
    }
    updatePerformance('현재 성능 · 대기 중');
    this.onStatus('AI 대기');
  }
}
