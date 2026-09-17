import * as ort from 'onnxruntime-web/webgpu';

const ORT_VERSION = '1.30.0';
const MODEL_URL = 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx';
const INPUT_WIDTH = 512;
const INPUT_HEIGHT = 288;

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
    this.canvas.width = INPUT_WIDTH;
    this.canvas.height = INPUT_HEIGHT;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    this.inputBuffer = new Float32Array(3 * INPUT_WIDTH * INPUT_HEIGHT);
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

  #preprocess(imageSource) {
    const width = INPUT_WIDTH;
    const height = INPUT_HEIGHT;
    const sourceWidth = imageSource.videoWidth || imageSource.width || width;
    const sourceHeight = imageSource.videoHeight || imageSource.height || height;
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

    this.context.drawImage(imageSource, sx, sy, sw, sh, 0, 0, width, height);
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
    const height = Number(dims[dims.length - 2]) || INPUT_HEIGHT;
    const width = Number(dims[dims.length - 1]) || INPUT_WIDTH;
    const size = width * height;
    const data = new Float32Array(size);
    const source = output.data;
    const previous = this.previousMask?.length === size ? this.previousMask : null;

    for (let i = 0; i < size; i += 1) {
      const current = clamp01(Number(source[i]));
      // MODNet already outputs an alpha matte. Keep only very light temporal smoothing
      // so hair/glasses edges remain stable without creating visible motion trails.
      data[i] = previous ? (current * 0.94) + (previous[i] * 0.06) : current;
    }

    this.previousMask = data;
    this.latestMask = { width, height, data };
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
    if (session?.release) {
      Promise.resolve(session.release()).catch(() => {});
    }
    this.onStatus('AI 대기');
  }
}
