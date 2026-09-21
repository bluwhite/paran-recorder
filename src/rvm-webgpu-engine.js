import * as ort from 'onnxruntime-web/webgpu';

const MODEL_URL = new URL(
  './models/rvm_mobilenetv3_fp32.onnx',
  window.location.href,
).toString();
const WIDTH = 640;
const HEIGHT = 480;
const RATIO = 0.60;
const MIN_IDLE_MS = 0;

let sharedModelBytesPromise = null;

export function isRvmWebGpuAvailable() {
  return Boolean(
    typeof navigator !== 'undefined'
    && navigator.gpu
    && window.isSecureContext,
  );
}

async function loadModelBytes(onStatus) {
  if (!sharedModelBytesPromise) {
    sharedModelBytesPromise = (async () => {
      onStatus('RVM WebGPU 모델 다운로드 중 · 약 15MB');
      const response = await fetch(MODEL_URL, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`RVM 모델 다운로드 실패: HTTP ${response.status}`);
      }
      return response.arrayBuffer();
    })().catch((error) => {
      sharedModelBytesPromise = null;
      throw error;
    });
  }
  return sharedModelBytesPromise;
}

function initialState() {
  return new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
}

function safeDispose(tensor) {
  try { tensor?.dispose?.(); } catch { /* best effort */ }
}

function drawCameraToCanvas(context, video) {
  const sourceWidth = video.videoWidth || WIDTH;
  const sourceHeight = video.videoHeight || HEIGHT;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = WIDTH / HEIGHT;

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

  context.drawImage(video, sx, sy, sw, sh, 0, 0, WIDTH, HEIGHT);
}

function rgbaFromOutputs(fgr, pha) {
  const fgrData = fgr.data;
  const phaData = pha.data;
  const plane = WIDTH * HEIGHT;

  if (!fgrData || fgrData.length !== plane * 3) {
    throw new Error(`RVM WebGPU fgr 크기 오류: ${fgrData?.length || 0} / ${plane * 3}`);
  }
  if (!phaData || phaData.length !== plane) {
    throw new Error(`RVM WebGPU pha 크기 오류: ${phaData?.length || 0} / ${plane}`);
  }

  const rgba = new Uint8Array(plane * 4);
  for (let i = 0, p = 0; i < plane; i += 1, p += 4) {
    rgba[p] = Math.round(Math.max(0, Math.min(1, fgrData[i])) * 255);
    rgba[p + 1] = Math.round(Math.max(0, Math.min(1, fgrData[plane + i])) * 255);
    rgba[p + 2] = Math.round(Math.max(0, Math.min(1, fgrData[(plane * 2) + i])) * 255);
    rgba[p + 3] = Math.round(Math.max(0, Math.min(1, phaData[i])) * 255);
  }
  return rgba;
}

export class RvmWebGpuSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.session = null;
    this.initializing = null;
    this.ready = false;
    this.closed = false;
    this.processing = false;
    this.timer = null;
    this.latestFrame = null;
    this.frameId = 0;
    this.rec = [];
    this.ratioTensor = null;
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.context = this.canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
    this.lastStatusAt = 0;
    this.framesSinceStatus = 0;
    this.lastInferenceMs = 0;
  }

  async ensureReady() {
    if (this.ready) {
      this.#startLoop();
      return { available: true, provider: 'WebGPU', width: WIDTH, height: HEIGHT };
    }
    if (this.initializing) return this.initializing;

    this.closed = false;
    this.initializing = this.#initialize().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  async #initialize() {
    if (!isRvmWebGpuAvailable()) {
      throw new Error('이 브라우저에서는 WebGPU를 사용할 수 없습니다. 최신 Chrome/Edge에서 HTTPS로 실행하세요.');
    }

    ort.env.webgpu.powerPreference = 'high-performance';
    const modelBytes = await loadModelBytes(this.onStatus);

    this.onStatus('RVM WebGPU 세션 준비 중');
    this.session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
    });

    this.rec = [initialState(), initialState(), initialState(), initialState()];
    this.ratioTensor = new ort.Tensor('float32', new Float32Array([RATIO]), [1]);

    const cameraVideo = document.getElementById('cameraVideo');
    const track = cameraVideo?.srcObject?.getVideoTracks?.()[0];
    if (track?.applyConstraints) {
      try {
        await track.applyConstraints({
          width: { ideal: WIDTH },
          height: { ideal: HEIGHT },
          frameRate: { ideal: 30 },
        });
      } catch (error) {
        console.warn('RVM WebGPU camera constraint fallback:', error);
      }
    }

    this.ready = true;
    this.#startLoop();
    this.onStatus('AI 준비 · RVM WebGPU · 640×480 · ratio 0.60');
    return { available: true, provider: 'WebGPU', width: WIDTH, height: HEIGHT };
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
    if (!this.session || this.processing) return;
    this.processing = true;
    const startedAt = performance.now();
    let src = null;
    let outputs = null;

    try {
      drawCameraToCanvas(this.context, cameraVideo);
      const imageData = this.context.getImageData(0, 0, WIDTH, HEIGHT);
      src = await ort.Tensor.fromImage(imageData, {
        tensorFormat: 'RGB',
        tensorLayout: 'NCHW',
        dataType: 'float32',
      });

      outputs = await this.session.run({
        src,
        r1i: this.rec[0],
        r2i: this.rec[1],
        r3i: this.rec[2],
        r4i: this.rec[3],
        downsample_ratio: this.ratioTensor,
      });

      const fgr = outputs.fgr;
      const pha = outputs.pha;
      if (!fgr || !pha || !outputs.r1o || !outputs.r2o || !outputs.r3o || !outputs.r4o) {
        throw new Error('RVM WebGPU 출력(fgr/pha/recurrent state)을 찾지 못했습니다.');
      }

      const rgba = rgbaFromOutputs(fgr, pha);
      const previousRec = this.rec;
      this.rec = [outputs.r1o, outputs.r2o, outputs.r3o, outputs.r4o];

      for (const tensor of previousRec) safeDispose(tensor);
      safeDispose(fgr);
      safeDispose(pha);

      this.frameId += 1;
      this.latestFrame = {
        width: WIDTH,
        height: HEIGHT,
        foregroundRgba: rgba,
        format: 'rvm-foreground-rgba',
        frameId: this.frameId,
      };

      const now = performance.now();
      this.lastInferenceMs = now - startedAt;
      this.framesSinceStatus += 1;
      if (now - this.lastStatusAt >= 1000) {
        const elapsed = this.lastStatusAt > 0 ? (now - this.lastStatusAt) / 1000 : 1;
        const fps = Math.max(1, Math.round(this.framesSinceStatus / elapsed));
        this.onStatus(`AI 준비 · RVM WebGPU · ${Math.round(this.lastInferenceMs)}ms / ${fps}fps`);
        this.lastStatusAt = now;
        this.framesSinceStatus = 0;
      }
    } catch (error) {
      console.error('RVM WebGPU inference failed:', error);
      this.onStatus(`RVM WebGPU 오류 · ${error.message || String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      safeDispose(src);
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
    this.frameId = 0;
    for (const tensor of this.rec) safeDispose(tensor);
    this.rec = [];
    safeDispose(this.ratioTensor);
    this.ratioTensor = null;
    try { this.session?.release?.(); } catch { /* best effort */ }
    this.session = null;
    this.lastStatusAt = 0;
    this.framesSinceStatus = 0;
    this.lastInferenceMs = 0;
    this.onStatus('AI 대기');
  }
}
