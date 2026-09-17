import * as ort from 'onnxruntime-web/webgpu';

const ORT_VERSION = '1.30.0';
const MODEL_URL = 'https://github.com/PeterL1n/BackgroundMattingV2/releases/download/v1.0.0/onnx_mobilenetv2_hd.onnx';
const MAX_INPUT_WIDTH = 640;

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
ort.env.wasm.numThreads = 1;

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

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// renderer.js applies smoothstep after mapping [0.12, 0.88] to [0, 1].
// BackgroundMattingV2 already outputs a continuous alpha matte, so encode the
// inverse here to preserve its alpha while keeping the shared renderer unchanged.
function encodeAlphaForSharedRenderer(alpha) {
  const y = clamp01(alpha);
  const x = 0.5 - Math.sin(Math.asin(1 - (2 * y)) / 3);
  return 0.12 + (0.76 * x);
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

function rgbaToRgbTensorData(rgba, width, height, target) {
  const plane = width * height;
  for (let pixel = 0, offset = 0; pixel < plane; pixel += 1, offset += 4) {
    target[pixel] = rgba[offset] / 255;
    target[plane + pixel] = rgba[offset + 1] / 255;
    target[(plane * 2) + pixel] = rgba[offset + 2] / 255;
  }
}

export class BackgroundMattingV2Engine {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.session = null;
    this.initializing = null;
    this.delegate = '';
    this.latestMask = null;
    this.previousAlpha = null;
    this.busy = false;
    this.pendingError = null;

    this.width = 0;
    this.height = 0;
    this.sourceCanvas = document.createElement('canvas');
    this.sourceContext = this.sourceCanvas.getContext('2d', { willReadFrequently: true });
    this.referenceCanvas = document.createElement('canvas');
    this.referenceContext = this.referenceCanvas.getContext('2d', { willReadFrequently: true });
    this.sourceBuffer = null;
    this.referenceBuffer = null;
    this.referenceReady = false;
  }

  async ensureReady() {
    if (this.session) return this.session;
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
    this.onStatus('배경 기준 AI 모델 불러오는 중');
    const commonOptions = {
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    };

    if (navigator.gpu) {
      try {
        this.session = await ort.InferenceSession.create(MODEL_URL, {
          ...commonOptions,
          executionProviders: ['webgpu'],
        });
        this.delegate = 'WebGPU';
      } catch (gpuError) {
        console.warn('BackgroundMattingV2 WebGPU initialization failed. Falling back to WASM.', gpuError);
      }
    }

    if (!this.session) {
      this.onStatus('배경 기준 AI CPU 모드 준비 중');
      this.session = await ort.InferenceSession.create(MODEL_URL, {
        ...commonOptions,
        executionProviders: ['wasm'],
      });
      this.delegate = 'WASM';
    }

    this.#updateStatus();
    return this.session;
  }

  #updateStatus() {
    if (!this.session) return;
    if (!this.referenceReady) {
      this.onStatus(`AI 준비 · 배경 기준 ${this.delegate} · 배경 촬영 필요`);
    } else {
      this.onStatus(`AI 준비 · 배경 기준 ${this.delegate} · ${this.width}×${this.height}`);
    }
  }

  #prepareSize(width, height) {
    this.width = width;
    this.height = height;
    this.sourceCanvas.width = width;
    this.sourceCanvas.height = height;
    this.referenceCanvas.width = width;
    this.referenceCanvas.height = height;
    this.sourceBuffer = new Float32Array(3 * width * height);
    this.referenceBuffer = new Float32Array(3 * width * height);
    this.latestMask = null;
    this.previousAlpha = null;
  }

  captureBackground(imageSource) {
    if (!imageSource || (imageSource.readyState !== undefined && imageSource.readyState < 2)) {
      throw new Error('카메라 화면이 준비되지 않았습니다.');
    }

    const { width, height } = targetSize(imageSource);
    this.#prepareSize(width, height);
    this.referenceContext.clearRect(0, 0, width, height);
    this.referenceContext.drawImage(imageSource, 0, 0, width, height);
    const pixels = this.referenceContext.getImageData(0, 0, width, height).data;
    rgbaToRgbTensorData(pixels, width, height, this.referenceBuffer);
    this.referenceReady = true;
    this.#updateStatus();
    return { width, height };
  }

  clearBackground() {
    this.referenceReady = false;
    this.latestMask = null;
    this.previousAlpha = null;
    this.#updateStatus();
  }

  hasBackground() {
    return this.referenceReady;
  }

  #preprocessSource(imageSource) {
    const width = this.width;
    const height = this.height;
    this.sourceContext.clearRect(0, 0, width, height);
    this.sourceContext.drawImage(imageSource, 0, 0, width, height);
    const pixels = this.sourceContext.getImageData(0, 0, width, height).data;
    rgbaToRgbTensorData(pixels, width, height, this.sourceBuffer);
  }

  async #run(imageSource) {
    if (!this.referenceReady) return;
    this.#preprocessSource(imageSource);

    const dims = [1, 3, this.height, this.width];
    const feeds = {
      src: new ort.Tensor('float32', this.sourceBuffer, dims),
      bgr: new ort.Tensor('float32', this.referenceBuffer, dims),
    };

    const results = await this.session.run(feeds, ['pha']);
    const output = results.pha || Object.values(results)[0];
    if (!output?.data) throw new Error('BackgroundMattingV2 알파 마스크를 받지 못했습니다.');

    const outputDims = output.dims || [];
    const height = Number(outputDims[outputDims.length - 2]) || this.height;
    const width = Number(outputDims[outputDims.length - 1]) || this.width;
    const size = width * height;
    const data = new Float32Array(size);
    const rawAlpha = new Float32Array(size);
    const previous = this.previousAlpha?.length === size ? this.previousAlpha : null;

    for (let i = 0; i < size; i += 1) {
      const current = clamp01(Number(output.data[i]));
      const alpha = previous ? (current * 0.98) + (previous[i] * 0.02) : current;
      rawAlpha[i] = alpha;
      data[i] = encodeAlphaForSharedRenderer(alpha);
    }

    this.previousAlpha = rawAlpha;
    this.latestMask = { width, height, data };
    this.#updateStatus();
  }

  segment(imageSource) {
    if (!this.session || !this.referenceReady) return this.latestMask;

    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = null;
      throw error;
    }

    if (!this.busy) {
      this.busy = true;
      this.#run(imageSource)
        .catch((error) => {
          this.pendingError = new Error(`배경 기준 AI 처리 실패: ${errorText(error)}`);
          this.onStatus('AI 오류');
        })
        .finally(() => {
          this.busy = false;
        });
    }

    return this.latestMask;
  }

  close() {
    const session = this.session;
    this.session = null;
    this.initializing = null;
    this.latestMask = null;
    this.previousAlpha = null;
    this.pendingError = null;
    this.busy = false;
    this.referenceReady = false;
    this.sourceBuffer = null;
    this.referenceBuffer = null;
    this.width = 0;
    this.height = 0;
    if (session?.release) {
      Promise.resolve(session.release()).catch(() => {});
    }
    this.onStatus('AI 대기');
  }
}
