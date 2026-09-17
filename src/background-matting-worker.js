import * as ort from 'onnxruntime-web';

const ORT_VERSION = '1.30.0';
const MODEL_URL = 'https://huggingface.co/onnx-community/BackgroundMattingV2-hd/resolve/main/onnx/model.onnx';

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let session = null;
let width = 0;
let height = 0;
let canvas = null;
let context = null;
let sourceBuffer = null;
let referenceBuffer = null;
let previousAlpha = null;

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

function encodeAlphaForSharedRenderer(alpha) {
  const y = clamp01(alpha);
  const x = 0.5 - Math.sin(Math.asin(1 - (2 * y)) / 3);
  return 0.12 + (0.76 * x);
}

function prepareSize(nextWidth, nextHeight) {
  if (!canvas) {
    canvas = new OffscreenCanvas(nextWidth, nextHeight);
    context = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (width === nextWidth && height === nextHeight && sourceBuffer && referenceBuffer) return;

  width = nextWidth;
  height = nextHeight;
  canvas.width = width;
  canvas.height = height;
  sourceBuffer = new Float32Array(3 * width * height);
  referenceBuffer = new Float32Array(3 * width * height);
  previousAlpha = null;
}

function rgbaToRgbTensorData(rgba, target) {
  const plane = width * height;
  for (let pixel = 0, offset = 0; pixel < plane; pixel += 1, offset += 4) {
    target[pixel] = rgba[offset] / 255;
    target[plane + pixel] = rgba[offset + 1] / 255;
    target[(plane * 2) + pixel] = rgba[offset + 2] / 255;
  }
}

function preprocessBitmap(bitmap, target) {
  context.clearRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const pixels = context.getImageData(0, 0, width, height).data;
  rgbaToRgbTensorData(pixels, target);
}

function backgroundDifference() {
  if (!sourceBuffer || !referenceBuffer || sourceBuffer.length !== referenceBuffer.length) return 1;

  // Compare mostly the outer/background region so the presenter's body does not
  // by itself make a previously captured room look invalid.
  const plane = width * height;
  const leftLimit = Math.floor(width * 0.22);
  const rightStart = Math.ceil(width * 0.78);
  const topLimit = Math.floor(height * 0.22);
  let total = 0;
  let count = 0;

  for (let y = 0; y < height; y += 2) {
    const row = y * width;
    for (let x = 0; x < width; x += 2) {
      if (!(x < leftLimit || x >= rightStart || y < topLimit)) continue;
      const pixel = row + x;
      total += Math.abs(sourceBuffer[pixel] - referenceBuffer[pixel]);
      total += Math.abs(sourceBuffer[plane + pixel] - referenceBuffer[plane + pixel]);
      total += Math.abs(sourceBuffer[(plane * 2) + pixel] - referenceBuffer[(plane * 2) + pixel]);
      count += 3;
    }
  }

  return count ? total / count : 1;
}

async function ensureSession() {
  if (session) return session;
  session = await ort.InferenceSession.create(MODEL_URL, {
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    executionProviders: ['wasm'],
  });
  return session;
}

async function runMatting(bitmap) {
  preprocessBitmap(bitmap, sourceBuffer);
  const referenceDiff = backgroundDifference();
  const dims = [1, 3, height, width];
  const startedAt = performance.now();
  const results = await session.run({
    src: new ort.Tensor('float32', sourceBuffer, dims),
    bgr: new ort.Tensor('float32', referenceBuffer, dims),
  }, ['pha']);
  const inferenceMs = performance.now() - startedAt;

  const output = results.pha || Object.values(results)[0];
  if (!output?.data) throw new Error('BackgroundMattingV2 알파 마스크를 받지 못했습니다.');

  const outputDims = output.dims || [];
  const outputHeight = Number(outputDims[outputDims.length - 2]) || height;
  const outputWidth = Number(outputDims[outputDims.length - 1]) || width;
  const size = outputWidth * outputHeight;
  const data = new Float32Array(size);
  const rawAlpha = new Float32Array(size);
  const previous = previousAlpha?.length === size ? previousAlpha : null;
  let minAlpha = 1;
  let maxAlpha = 0;
  let sumAlpha = 0;

  for (let i = 0; i < size; i += 1) {
    const current = clamp01(Number(output.data[i]));
    const alpha = previous ? (current * 0.98) + (previous[i] * 0.02) : current;
    rawAlpha[i] = alpha;
    data[i] = encodeAlphaForSharedRenderer(alpha);
    minAlpha = Math.min(minAlpha, alpha);
    maxAlpha = Math.max(maxAlpha, alpha);
    sumAlpha += alpha;
  }

  previousAlpha = rawAlpha;
  return {
    width: outputWidth,
    height: outputHeight,
    data,
    minAlpha,
    maxAlpha,
    meanAlpha: sumAlpha / Math.max(1, size),
    referenceDiff,
    inferenceMs,
  };
}

self.addEventListener('message', async (event) => {
  const { id, type } = event.data || {};
  try {
    if (type === 'init') {
      await ensureSession();
      self.postMessage({ id, ok: true });
      return;
    }

    if (type === 'capture') {
      await ensureSession();
      prepareSize(event.data.width, event.data.height);
      preprocessBitmap(event.data.bitmap, referenceBuffer);
      previousAlpha = null;
      const persistedReference = referenceBuffer.slice();
      self.postMessage({
        id,
        ok: true,
        width,
        height,
        referenceBuffer: persistedReference.buffer,
      }, [persistedReference.buffer]);
      return;
    }

    if (type === 'restore') {
      await ensureSession();
      prepareSize(event.data.width, event.data.height);
      const restored = new Float32Array(event.data.referenceBuffer);
      if (restored.length !== referenceBuffer.length) {
        throw new Error('저장된 배경 기준 데이터의 크기가 맞지 않습니다.');
      }
      referenceBuffer.set(restored);
      previousAlpha = null;
      self.postMessage({ id, ok: true, width, height });
      return;
    }

    if (type === 'run') {
      if (!session || !referenceBuffer) throw new Error('배경 기준이 준비되지 않았습니다.');
      const result = await runMatting(event.data.bitmap);
      self.postMessage({
        id,
        ok: true,
        width: result.width,
        height: result.height,
        buffer: result.data.buffer,
        minAlpha: result.minAlpha,
        maxAlpha: result.maxAlpha,
        meanAlpha: result.meanAlpha,
        referenceDiff: result.referenceDiff,
        inferenceMs: result.inferenceMs,
      }, [result.data.buffer]);
      return;
    }

    if (type === 'clear') {
      previousAlpha = null;
      referenceBuffer = null;
      sourceBuffer = null;
      width = 0;
      height = 0;
      self.postMessage({ id, ok: true });
      return;
    }

    throw new Error(`알 수 없는 worker 요청: ${type}`);
  } catch (error) {
    try { event.data?.bitmap?.close?.(); } catch { /* best effort */ }
    self.postMessage({ id, ok: false, error: errorText(error) });
  }
});
