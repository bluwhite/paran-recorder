const HQ_WIDTH = 640;
const HQ_HEIGHT = 480;
const HQ_DOWNSAMPLE_RATIO = 0.60;
const MIN_IDLE_MS = 0;

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
  throw new Error('RVM HQ 응답 형식을 확인할 수 없습니다.');
}

function drawCameraToCanvas(context, video, width, height) {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;

  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else if (sourceRatio < targetRatio) {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }

  context.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
}

export class NativeRvmHqSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.latestFrame = null;
    this.ready = false;
    this.initializing = null;
    this.closed = false;
    this.processing = false;
    this.timer = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = HQ_WIDTH;
    this.canvas.height = HQ_HEIGHT;
    this.context = this.canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    this.runtimeInfo = null;
    this.frameId = 0;
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
    if (!invoke) throw new Error('RVM 고품질 테스트는 데스크톱 EXE에서만 사용할 수 있습니다.');

    this.onStatus('AI RVM HQ 모델 준비 중 · 640×480');
    const info = await invoke('native_rvm_prepare');
    if (!info?.available) {
      throw new Error(info?.message || 'RVM 고품질 테스트를 사용할 수 없습니다.');
    }

    const cameraVideo = document.getElementById('cameraVideo');
    const track = cameraVideo?.srcObject?.getVideoTracks?.()[0];
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({
          width: { ideal: HQ_WIDTH },
          height: { ideal: HQ_HEIGHT },
          frameRate: { ideal: 30 },
        });
      } catch (error) {
        console.warn('RVM HQ camera constraint fallback:', error);
      }
    }

    await invoke('native_rvm_reset');
    this.runtimeInfo = info;
    this.ready = true;
    this.#startLoop();
    this.onStatus(`AI 준비 · RVM HQ · ${info.provider || 'ONNX Runtime'} · 640×480 · ratio 0.60`);
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
      drawCameraToCanvas(this.context, cameraVideo, HQ_WIDTH, HQ_HEIGHT);
      const rgba = this.context.getImageData(0, 0, HQ_WIDTH, HQ_HEIGHT).data;
      const response = await invoke(
        'native_rvm_segment',
        new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        {
          headers: {
            'x-width': String(HQ_WIDTH),
            'x-height': String(HQ_HEIGHT),
            'x-downsample-ratio': HQ_DOWNSAMPLE_RATIO.toFixed(2),
            'x-output': 'foreground-rgba',
            'x-format': 'rgba8',
          },
        },
      );

      const bytes = normalizeBinaryResponse(response);
      const expected = HQ_WIDTH * HQ_HEIGHT * 4;
      if (bytes.length !== expected) {
        throw new Error(`RVM HQ RGBA 크기가 올바르지 않습니다. ${bytes.length} / ${expected}`);
      }

      this.frameId += 1;
      this.latestFrame = {
        width: HQ_WIDTH,
        height: HQ_HEIGHT,
        foregroundRgba: bytes,
        format: 'rvm-foreground-rgba',
        frameId: this.frameId,
      };

      const now = performance.now();
      this.lastInferenceMs = now - startedAt;
      this.framesSinceStatus += 1;
      if (now - this.lastStatusAt >= 1000) {
        const elapsed = this.lastStatusAt > 0 ? (now - this.lastStatusAt) / 1000 : 1;
        const fps = Math.max(1, Math.round(this.framesSinceStatus / elapsed));
        this.onStatus(
          `AI 준비 · RVM HQ · ${this.runtimeInfo?.provider || 'ONNX Runtime'} · ${Math.round(this.lastInferenceMs)}ms / ${fps}fps`,
        );
        this.lastStatusAt = now;
        this.framesSinceStatus = 0;
      }
    } catch (error) {
      console.error('Native RVM HQ failed:', error);
      this.onStatus(`AI RVM HQ 오류 · ${error.message || String(error)}`);
    } finally {
      this.processing = false;
    }
  }

  segment() {
    this.#startLoop();
    return this.latestFrame;
  }

  close() {
    this.closed = true;
    this.ready = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.processing = false;
    this.latestFrame = null;
    this.runtimeInfo = null;
    this.frameId = 0;
    this.lastStatusAt = 0;
    this.framesSinceStatus = 0;
    this.lastInferenceMs = 0;

    const invoke = tauriInvoke();
    if (invoke) {
      invoke('native_rvm_reset').catch((error) => {
        console.warn('RVM HQ recurrent state reset failed:', error);
      });
    }
    this.onStatus('AI 대기');
  }
}
