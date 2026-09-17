import * as ort from 'onnxruntime-web/webgpu';

const ORT_VERSION = '1.30.0';
const MODEL_URL = 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx';
const REF_SIZE = 512;
const SIZE_DIVISIBILITY = 32;

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

function roundDown32(value) {
  return Math.max(SIZE_DIVISIBILITY, Math.floor(value / SIZE_DIVISIBILITY) * SIZE_DIVISIBILITY);
}

// renderer.js applies smoothstep after mapping [0.12, 0.88] to [0, 1].
// MODNet already produces a continuous alpha matte, so encode the inverse here
// to preserve the original matte without changing the shared MediaPipe renderer path.
function encodeAlphaForSharedRenderer(alpha) {
  const y = clamp01(alpha);
  const x = 0.5 - Math.sin(Math.asin(1 - (2 * y)) / 3);
  return 0.12 + (0.76 * x);
}

export class ModNetEngine {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.session = null;
    this.initializing = null;
    this.latestMask = null;
    this.previousMask = null;
    this.busy = false;
    this.pendingError = null;
    this.delegate = '';
    this.inputName = 'input';
    this.outputName = 'output';
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.inputBuffer = null;
    this.inputWidth = 0;
    this.inputHeight = 0;
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
    this.onStatus('MODNet 모델 불러오는 중');

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
        console.warn('MODNet WebGPU initialization failed. Falling back to WASM.', gpuError);
      }
    }

    if (!this.session) {
      this.onStatus('MODNet CPU 모드 준비 중');
      this.session = await ort.InferenceSession.create(MODEL_URL, {
        ...commonOptions,
        executionProviders: ['wasm'],
      });
      this.delegate = 'WASM';
    }

    this.inputName = this.session.inputNames?.[0] || 'input';
    this.outputName = this.session.outputNames?.[0] || 'output';
    this.onStatus(`AI 준비 · MODNet ${this.delegate}`);
    return this.session;
  }

  #targetSize(imageSource) {
    const sourceWidth = imageSource.videoWidth || imageSource.naturalWidth || imageSource.width || 1280;
    const sourceHeight = imageSource.videoHeight || imageSource.naturalHeight || imageSource.height || 720;

    if (sourceWidth >= sourceHeight) {
      return {
        height: REF_SIZE,
        width: roundDown32((sourceWidth / sourceHeight) * REF_SIZE),
      };
    }

    return {
      width: REF_SIZE,
      height: roundDown32((sourceHeight / sourceWidth) * REF_SIZE),
    };
  }

  #prepareBuffers(width, height) {
    if (this.inputWidth === width && this.inputHeight === height && this.inputBuffer) return;
    this.inputWidth = width;
    this.inputHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.inputBuffer = new Float32Array(3 * width * height);
  }

  #preprocess(imageSource) {
    const { width, height } = this.#targetSize(imageSource);
    this.#prepareBuffers(width, height);

    // MODNet reference preprocessing keeps the source aspect ratio, resizes the
    // shorter side to 512, and makes both dimensions divisible by 32.
    this.context.clearRect(0, 0, width, height);
    this.context.drawImage(imageSource, 0, 0, width, height);

    const pixels = this.context.getImageData(0, 0, width, height).data;
    const plane = width * height;
    const input = this.inputBuffer;

    for (let pixel = 0, rgba = 0; pixel < plane; pixel += 1, rgba += 4) {
      input[pixel] = ((pixels[rgba] / 255) - 0.5) / 0.5;
      input[plane + pixel] = ((pixels[rgba + 1] / 255) - 0.5) / 0.5;
      input[(plane * 2) + pixel] = ((pixels[rgba + 2] / 255) - 0.5) / 0.5;
    }

    return new ort.Tensor('float32', input, [1, 3, height, width]);
  }

  async #run(imageSource) {
    const inputTensor = this.#preprocess(imageSource);
    const results = await this.session.run({ [this.inputName]: inputTensor });
    const output = results[this.outputName] || Object.values(results)[0];
    if (!output?.data) throw new Error('MODNet 출력 마스크를 받지 못했습니다.');

    const dims = output.dims || [];
    const height = Number(dims[dims.length - 2]) || this.inputHeight;
    const width = Number(dims[dims.length - 1]) || this.inputWidth;
    const size = width * height;
    const data = new Float32Array(size);
    const source = output.data;
    const previous = this.previousMask?.length === size ? this.previousMask : null;
    const rawAlpha = new Float32Array(size);

    for (let i = 0; i < size; i += 1) {
      const current = clamp01(Number(source[i]));
      // Keep temporal smoothing extremely light. MODNet is an image matting model,
      // and stronger smoothing visibly trails when the lecturer moves.
      rawAlpha[i] = previous ? (current * 0.98) + (previous[i] * 0.02) : current;
      data[i] = encodeAlphaForSharedRenderer(rawAlpha[i]);
    }

    this.previousMask = rawAlpha;
    this.latestMask = { width, height, data };
    this.onStatus(`AI 준비 · MODNet ${this.delegate} · ${width}×${height}`);
  }

  segment(imageSource) {
    if (!this.session) return this.latestMask;

    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = null;
      throw error;
    }

    if (!this.busy) {
      this.busy = true;
      this.#run(imageSource)
        .catch((error) => {
          this.pendingError = new Error(`MODNet 처리 실패: ${errorText(error)}`);
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
    this.latestMask = null;
    this.previousMask = null;
    this.pendingError = null;
    this.busy = false;
    this.inputBuffer = null;
    this.inputWidth = 0;
    this.inputHeight = 0;
    if (session?.release) {
      Promise.resolve(session.release()).catch(() => {});
    }
    this.onStatus('AI 대기');
  }
}
