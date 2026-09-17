import { defineConfig } from 'vite';

function optimizeSegmentationLoop() {
  const originalBlock = `function requestSegmentation(now) {
  if (backgroundMode.value === 'original' || !cameraStream || cameraVideo.readyState < 2) return;
  if (segmentBusy || now - lastSegmentAt < 70) return;
  lastSegmentAt = now;
  segmentBusy = true;

  Promise.resolve().then(async () => {
    await ensureSegmenter();
    segmentationInputCtx.drawImage(cameraVideo, 0, 0, segmentationInput.width, segmentationInput.height);
    const mask = segmenter.segment(segmentationInput, performance.now());
    if (mask) {
      latestMask = mask;
      maskImageVersion += 1;
      segmentErrorShown = false;
    }
  }).catch((error) => {
    console.error('Segmentation failed:', error);
    aiStatus.textContent = 'AI 오류';
    if (!segmentErrorShown) {
      setMessage(\`AI 배경 처리 오류: \${error.message}\`, true);
      segmentErrorShown = true;
    }
  }).finally(() => {
    segmentBusy = false;
  });
}`;

  const optimizedBlock = `function requestSegmentation(now) {
  if (backgroundMode.value === 'original' || !cameraStream || cameraVideo.readyState < 2) return;
  if (segmentBusy || now - lastSegmentAt < segmentIntervalMs) return;
  lastSegmentAt = now;
  segmentBusy = true;
  const startedAt = performance.now();

  Promise.resolve().then(async () => {
    await ensureSegmenter();
    const mask = segmenter.segment(cameraVideo, performance.now());
    if (mask) {
      latestMask = mask;
      maskImageVersion += 1;
      segmentErrorShown = false;
    }
  }).catch((error) => {
    console.error('Segmentation failed:', error);
    aiStatus.textContent = 'AI 오류';
    if (!segmentErrorShown) {
      setMessage(\`AI 배경 처리 오류: \${error.message}\`, true);
      segmentErrorShown = true;
    }
  }).finally(() => {
    const elapsed = performance.now() - startedAt;
    segmentIntervalMs = Math.max(33, Math.min(50, elapsed * 1.05));
    segmentBusy = false;
  });
}`;

  return {
    name: 'paran-optimize-segmentation-loop',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/renderer.js')) return null;

      let transformed = code.replace(
        'let segmentErrorShown = false;',
        'let segmentErrorShown = false;\nlet segmentIntervalMs = 33;'
      );
      transformed = transformed.replace(originalBlock, optimizedBlock);

      if (transformed === code) {
        console.warn('[Paran Recorder] segmentation optimization transform did not match renderer.js');
      }

      return { code: transformed, map: null };
    },
  };
}

export default defineConfig({
  root: 'src',
  base: './',
  clearScreen: false,
  plugins: [optimizeSegmentationLoop()],
  server: {
    port: 5173,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
