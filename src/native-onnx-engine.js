const INPUT_WIDTH = 384;
const INPUT_HEIGHT = 224;
const MIN_IDLE_MS = 2;

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
  throw new Error('네이티브 마스크 응답 형식을 확인할 수 없습니다.');
}

export function isNativeOnnxAvailable() {
  return Boolean(tauriInvoke());
}

export async function probeNativeOnnx() {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return invoke('native_runtime_info');
}

export class NativeOnnxSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.latestMask = null;
    this.ready = false;
    this.initializing = null;
    this.closed = false;
    this.processing = false;
    this.timer = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = INPUT_WIDTH;
    this.canvas.height = INPUT_HEIGHT;
    this.context = this.canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    this.runtimeInfo = null;
    this.lastStatusAt = 0;
    this.framesSinceStatus = 0;
    this.lastInferenceMs = 0;
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
    if (!invoke) throw new Error('ONNX Runtime Native는 데스크톱 EXE에서만 사용할 수 있습니다.');

    this.onStatus('AI ONNX Runtime Native 준비 중');
    const info = await invoke('native_runtime_info');
    if (!info?.available) {
      throw new Error(info?.message || '네이티브 ONNX Runtime을 사용할 수 없습니다.');
    }

    this.runtimeInfo = info;
    this.ready = true;
    this.#startLoop();
    const provider = info.provider || 'ONNX Runtime';
    this.onStatus(`AI 준비 · ONNX Native · ${provider}`);
    return info;
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
      this.context.drawImage(cameraVideo, 0, 0, INPUT_WIDTH, INPUT_HEIGHT);
      const rgba = this.context.getImageData(0, 0, INPUT_WIDTH, INPUT_HEIGHT).data;
      const response = await invoke(
        'native_segment',
        new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        {
          headers: {
            'x-width': String(INPUT_WIDTH),
            'x-height': String(INPUT_HEIGHT),
            'x-format': 'rgba8',
          },
        },
      );

      const bytes = normalizeBinaryResponse(response);
      const expected = INPUT_WIDTH * INPUT_HEIGHT;
      if (bytes.length !== expected) {
        throw new Error(`네이티브 마스크 크기가 올바르지 않습니다. ${bytes.length} / ${expected}`);
      }

      this.latestMask = {
        width: INPUT_WIDTH,
        height: INPUT_HEIGHT,
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
        this.onStatus(`AI 준비 · ONNX Native · ${provider} · ${Math.round(this.lastInferenceMs)}ms / ${fps}fps`);
        this.lastStatusAt = now;
        this.framesSinceStatus = 0;
      }
    } catch (error) {
      console.error('Native ONNX segmentation failed:', error);
      this.onStatus('AI ONNX Native 오류');
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
    this.onStatus('AI 대기');
  }
}
