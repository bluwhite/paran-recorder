const ASSET_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747';

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // Fall through to a readable generic message.
  }
  return String(error ?? '알 수 없는 오류');
}

export class PersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.solution = null;
    this.initializing = null;
    this.latestMask = null;
    this.busy = false;
    this.pendingError = null;
    this.inputWidth = 256;
    this.inputHeight = 144;
    this.maskCanvas = document.createElement('canvas');
    this.maskContext = this.maskCanvas.getContext('2d', { willReadFrequently: true });
  }

  async ensureReady() {
    if (this.solution) return this.solution;
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
    this.onStatus('AI 모델 불러오는 중');

    const SelfieSegmentation = globalThis.SelfieSegmentation;
    if (typeof SelfieSegmentation !== 'function') {
      throw new Error('Selfie Segmentation 라이브러리를 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
    }

    const solution = new SelfieSegmentation({
      locateFile: (file) => `${ASSET_ROOT}/${file}`,
    });

    solution.setOptions({
      modelSelection: 0,
      selfieMode: false,
    });

    solution.onResults((results) => {
      try {
        if (!results?.segmentationMask) return;

        const width = Math.max(2, this.inputWidth || 256);
        const height = Math.max(2, this.inputHeight || 144);
        if (this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
          this.maskCanvas.width = width;
          this.maskCanvas.height = height;
        }

        this.maskContext.clearRect(0, 0, width, height);
        this.maskContext.drawImage(results.segmentationMask, 0, 0, width, height);
        const pixels = this.maskContext.getImageData(0, 0, width, height).data;
        const confidence = new Float32Array(width * height);

        for (let i = 0, pixel = 0; i < pixels.length; i += 4, pixel += 1) {
          confidence[pixel] = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) / 255;
        }

        this.latestMask = { width, height, data: confidence };
        this.pendingError = null;
      } catch (error) {
        this.pendingError = error instanceof Error ? error : new Error(errorText(error));
      }
    });

    try {
      await solution.initialize();
    } catch (error) {
      try { await solution.close(); } catch { /* best effort */ }
      throw new Error(`셀피 분할 모델 초기화 실패: ${errorText(error)}`);
    }

    this.solution = solution;
    this.onStatus('AI 준비 · 셀피 분할');
    return solution;
  }

  segment(imageSource) {
    if (!this.solution) return this.latestMask;

    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = null;
      throw error;
    }

    this.inputWidth = imageSource.videoWidth || imageSource.width || 256;
    this.inputHeight = imageSource.videoHeight || imageSource.height || 144;

    if (!this.busy) {
      this.busy = true;
      this.solution.send({ image: imageSource })
        .catch((error) => {
          this.pendingError = new Error(`셀피 분할 처리 실패: ${errorText(error)}`);
          this.onStatus('AI 오류');
        })
        .finally(() => {
          this.busy = false;
        });
    }

    return this.latestMask;
  }

  close() {
    const solution = this.solution;
    this.solution = null;
    this.latestMask = null;
    this.busy = false;
    this.pendingError = null;
    if (solution) {
      Promise.resolve(solution.close()).catch(() => {});
    }
    this.onStatus('AI 대기');
  }
}
