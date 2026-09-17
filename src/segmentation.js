import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite';

export class PersonSegmenter {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.segmenter = null;
    this.initializing = null;
    this.delegate = '';
  }

  async ensureReady() {
    if (this.segmenter) return this.segmenter;
    if (this.initializing) return this.initializing;

    this.initializing = this.#initialize();
    try {
      return await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async #initialize() {
    this.onStatus('AI 모델 불러오는 중');
    const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);

    const makeOptions = (delegate) => ({
      baseOptions: {
        modelAssetPath: MODEL_URL,
        ...(delegate ? { delegate } : {}),
      },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });

    try {
      this.segmenter = await ImageSegmenter.createFromOptions(vision, makeOptions('GPU'));
      this.delegate = 'GPU';
    } catch (gpuError) {
      console.warn('MediaPipe GPU delegate unavailable, falling back to CPU.', gpuError);
      this.segmenter = await ImageSegmenter.createFromOptions(vision, makeOptions('CPU'));
      this.delegate = 'CPU';
    }

    this.onStatus(`AI 준비 · ${this.delegate}`);
    return this.segmenter;
  }

  segment(imageSource, timestampMs) {
    if (!this.segmenter) return null;

    const result = this.segmenter.segmentForVideo(imageSource, timestampMs);
    try {
      const mask = result.confidenceMasks?.[0];
      if (!mask) return null;
      return {
        width: mask.width,
        height: mask.height,
        data: new Float32Array(mask.getAsFloat32Array()),
      };
    } finally {
      result.close();
    }
  }

  close() {
    try { this.segmenter?.close(); } catch { /* best effort */ }
    this.segmenter = null;
    this.onStatus('AI 대기');
  }
}
