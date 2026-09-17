import { BackgroundMattingV2Engine } from './background-matting-engine.js';

export class ModNetEngine extends BackgroundMattingV2Engine {
  constructor(onStatus = () => {}) {
    super(onStatus);
    this.referenceButton = document.getElementById('backgroundReferenceButton');
    this.referenceStatus = document.getElementById('backgroundReferenceStatus');
    this.captureHandler = () => this.#captureReference();
    this.referenceButton?.addEventListener('click', this.captureHandler);
  }

  async #captureReference() {
    try {
      await this.ensureReady();
      const cameraVideo = document.getElementById('cameraVideo');
      if (!cameraVideo || cameraVideo.readyState < 2) {
        throw new Error('먼저 미리보기를 시작해 카메라 화면을 준비해 주세요.');
      }
      const { width, height } = this.captureBackground(cameraVideo);
      if (this.referenceButton) this.referenceButton.textContent = '빈 배경 다시 촬영';
      if (this.referenceStatus) this.referenceStatus.textContent = `기준 배경 저장 완료 · ${width}×${height}`;
    } catch (error) {
      console.error('Background reference capture failed:', error);
      if (this.referenceStatus) this.referenceStatus.textContent = error.message || String(error);
    }
  }

  close() {
    this.referenceButton?.removeEventListener('click', this.captureHandler);
    super.close();
  }
}
