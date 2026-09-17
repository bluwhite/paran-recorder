import * as ort from 'onnxruntime-web/webgpu';

const MODEL_URL = 'https://huggingface.co/square-zero-labs/modnet/resolve/main/onnx/model.onnx?download=true';
const INPUT_WIDTH = 512;
const INPUT_HEIGHT = 288;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export class ModnetSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.session = null;
    this.initializing = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.busy = false;
    this.closed = false;
    this.frames = 0;
    this.totalInferenceMs = 0;

    this.inputCanvas = document.createElement('canvas');
    this.inputCanvas.width = INPUT_WIDTH;
    this.inputCanvas.height = INPUT_HEIGHT;
    this.inputCtx = this.inputCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true,
    });
  }

  async ensureReady() {
    if (this.session) return this.session;
    if (this.initializing) return this.initializing;

    this.initializing = this.#initialize().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  async #initialize() {
    if (!navigator.gpu) {
      throw new Error('이 브라우저에서 WebGPU를 사용할 수 없습니다. 최신 Chrome/Edge와 GPU 가속 설정을 확인해 주세요.');
    }

    this.onStatus('AI MODNet 모델 다운로드 중');
    ort.env.logLevel = 'warning';

    this.session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['webgpu'],
      graphOptimizationLevel: 'all',
    });

    if (this.closed) {
      try { await this.session.release?.(); } catch { /* best effort */ }
      this.session = null;
      return null;
    }

    this.onStatus('AI 준비 · MODNet WebGPU');
    return this.session;
  }

  segment(imageSource) {
    if (!this.session || this.closed) return this.latestMask;

    const cameraVideo = document.getElementById('cameraVideo');
    const source = cameraVideo?.readyState >= 2 ? cameraVideo : imageSource;
    if (!source || this.busy) return this.latestMask;

    this.busy = true;
    const startedAt = performance.now();
    this.#infer(source)
      .then((mask) => {
        if (!mask || this.closed) return;
        this.latestMask = mask;
        const elapsed = performance.now() - startedAt;
        this.frames += 1;
        this.totalInferenceMs += elapsed;
        if (this.frames % 20 === 0) {
          const average = Math.round(this.totalInferenceMs / this.frames);
          this.onStatus(`AI 준비 · MODNet WebGPU · ${average}ms`);
        }
      })
      .catch((error) => {
        console.error('MODNet inference failed:', error);
        this.onStatus('AI MODNet 오류');
      })
      .finally(() => {
        this.busy = false;
      });

    return this.latestMask;
  }

  async #infer(source) {
    const ctx = this.inputCtx;
    ctx.drawImage(source, 0, 0, INPUT_WIDTH, INPUT_HEIGHT);
    const rgba = ctx.getImageData(0, 0, INPUT_WIDTH, INPUT_HEIGHT).data;
    const planeSize = INPUT_WIDTH * INPUT_HEIGHT;
    const input = new Float32Array(planeSize * 3);

    for (let pixel = 0, offset = 0; pixel < planeSize; pixel += 1, offset += 4) {
      input[pixel] = (rgba[offset] / 127.5) - 1;
      input[planeSize + pixel] = (rgba[offset + 1] / 127.5) - 1;
      input[(planeSize * 2) + pixel] = (rgba[offset + 2] / 127.5) - 1;
    }

    const inputName = this.session.inputNames[0];
    const outputName = this.session.outputNames[0];
    const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_HEIGHT, INPUT_WIDTH]);
    const output = await this.session.run({ [inputName]: tensor });
    const matte = output[outputName];
    const raw = matte.data;
    const alpha = new Float32Array(planeSize);
    const previous = this.previousAlpha;

    for (let i = 0; i < planeSize; i += 1) {
      let current = Number(raw[i]);
      if (!Number.isFinite(current)) current = 0;
      current = clamp(current);

      // Preserve fine hair/glasses transparency while trimming faint background haze.
      current = current <= 0.015 ? 0 : current >= 0.985 ? 1 : current;
      alpha[i] = previous?.length === planeSize
        ? (current * 0.94) + (previous[i] * 0.06)
        : current;
    }

    this.previousAlpha = alpha;
    return { width: INPUT_WIDTH, height: INPUT_HEIGHT, data: alpha };
  }

  async close() {
    this.closed = true;
    this.latestMask = null;
    this.previousAlpha = null;
    const session = this.session;
    this.session = null;
    if (session) {
      try { await session.release?.(); } catch { /* best effort */ }
    }
    this.onStatus('AI 대기');
  }
}
