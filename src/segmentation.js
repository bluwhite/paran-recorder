import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

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

    // CPU 우선: 현재 웹 개발판에서는 브라우저별 WebGL/GPU 마스크 차이를 피하고
    // 일반 배경에서 안정적으로 사람 마스크를 얻는 것을 우선한다.
    const options = {
      baseOptions: {
        modelAssetPath: MODEL_URL,
        delegate: 'CPU',
      },
      runningMode: 'VIDEO',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    };

    this.segmenter = await ImageSegmenter.createFromOptions(vision, options);
    this.delegate = 'CPU';
    this.onStatus('AI 준비 · 사람 분할');
    return this.segmenter;
  }

  segment(imageSource, timestampMs) {
    if (!this.segmenter) return null;

    // MediaPipe 웹 문서의 콜백 경로를 사용한다. 콜백은 segmentForVideo가
    // 반환되기 전에 동기적으로 호출되며, 그 안에서 마스크를 즉시 복사한다.
    // 이렇게 하면 브라우저/GPU별 결과 수명 문제를 피할 수 있다.
    let copiedMask = null;

    this.segmenter.segmentForVideo(imageSource, timestampMs, (result) => {
      const mask = result.confidenceMasks?.[0];
      if (!mask) return;

      const source = mask.getAsFloat32Array();
      copiedMask = {
        width: mask.width,
        height: mask.height,
        data: new Float32Array(source),
      };
    });

    return copiedMask;
  }

  close() {
    try { this.segmenter?.close(); } catch { /* best effort */ }
    this.segmenter = null;
    this.onStatus('AI 대기');
  }
}
