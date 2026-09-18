import { PersonSegmenter } from './segmentation.js';

const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const screenVideo = document.getElementById('screenVideo');
const cameraVideo = document.getElementById('cameraVideo');
const segmentationInput = document.getElementById('segmentationInput');
const segmentationInputCtx = segmentationInput.getContext('2d', { alpha: false, willReadFrequently: false });

const emptyPreview = document.getElementById('emptyPreview');
const cameraSelect = document.getElementById('cameraSelect');
const microphoneSelect = document.getElementById('microphoneSelect');
const cameraEnabled = document.getElementById('cameraEnabled');
const cameraPosition = document.getElementById('cameraPosition');
const positionEditEnabled = document.getElementById('positionEditEnabled');
const positionEditLabel = document.getElementById('positionEditLabel');
const positionOverlay = document.getElementById('positionOverlay');
const cameraX = document.getElementById('cameraX');
const cameraY = document.getElementById('cameraY');
const cameraXValue = document.getElementById('cameraXValue');
const cameraYValue = document.getElementById('cameraYValue');
const positionResetButton = document.getElementById('positionResetButton');
const cameraSize = document.getElementById('cameraSize');
const cameraSizeValue = document.getElementById('cameraSizeValue');
const cameraShape = document.getElementById('cameraShape');
const mirrorCamera = document.getElementById('mirrorCamera');
const backgroundMode = document.getElementById('backgroundMode');
const backgroundImageControls = document.getElementById('backgroundImageControls');
const backgroundImageInput = document.getElementById('backgroundImageInput');
const backgroundImageName = document.getElementById('backgroundImageName');
const previewButton = document.getElementById('previewButton');
const recordButton = document.getElementById('recordButton');
const stopButton = document.getElementById('stopButton');
const markerButton = document.getElementById('markerButton');
const refreshDevicesButton = document.getElementById('refreshDevicesButton');
const sceneButtons = [...document.querySelectorAll('.scene-button')];
const message = document.getElementById('message');
const statusBadge = document.getElementById('statusBadge');
const aiStatus = document.getElementById('aiStatus');
const recordingTimer = document.getElementById('recordingTimer');
const markerCount = document.getElementById('markerCount');
const latestMarker = document.getElementById('latestMarker');
const micLevelBar = document.getElementById('micLevelBar');
const micDb = document.getElementById('micDb');
const systemAudioInfo = document.getElementById('systemAudioInfo');
const saveModeInfo = document.getElementById('saveModeInfo');
const runtimeLabel = document.getElementById('runtimeLabel');

const cameraCompositeCanvas = document.createElement('canvas');
const cameraCompositeCtx = cameraCompositeCanvas.getContext('2d');
const foregroundCanvas = document.createElement('canvas');
const foregroundCtx = foregroundCanvas.getContext('2d');
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

let displayStream = null;
let cameraStream = null;
let microphoneStream = null;
let audioContext = null;
let audioDestination = null;
let micAnalyser = null;
let micMeterFrameId = null;
let drawFrameId = null;
let mediaRecorder = null;
let recordingCanvasStream = null;
let recordingStartedAt = 0;
let timerInterval = null;
let previewActive = false;
let fileWriter = null;
let fallbackChunks = [];
let recordingWriteChain = Promise.resolve();
let currentFileName = '';
let activeScene = 'small';
let recordingMarkers = [];
let backgroundImage = null;
let backgroundImageUrl = null;
let latestMask = null;
let maskImageVersion = 0;
let renderedMaskVersion = -1;
let segmentBusy = false;
let lastSegmentAt = 0;
let segmentErrorShown = false;
let presenterPosition = { x: 0.86, y: 0.84 };
let presenterDrag = null;

const PRESENTER_SETTINGS_KEY = 'paran-recorder-presenter-v1';
const PRESENTER_POSITION_MIN = -0.5;
const PRESENTER_POSITION_MAX = 1.5;
const isTauri = Boolean(window.__TAURI_INTERNALS__);
const segmenter = new PersonSegmenter((text) => {
  aiStatus.textContent = text;
  aiStatus.classList.toggle('ready', text.startsWith('AI 준비'));
});

function setMessage(text, isError = false) {
  message.textContent = text || '';
  message.classList.toggle('error', isError);
}

function setStatus(text, recording = false) {
  statusBadge.textContent = text;
  statusBadge.classList.toggle('recording', recording);
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => track.stop());
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function defaultFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  return `ParanRecorder_${stamp}.webm`;
}

function fillSelect(select, devices, fallbackText) {
  const previous = select.value;
  select.innerHTML = '';

  if (!devices.length) {
    select.add(new Option(`${fallbackText} 없음`, ''));
    return;
  }

  devices.forEach((device, index) => {
    select.add(new Option(device.label || `${fallbackText} ${index + 1}`, device.deviceId));
  });

  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

async function refreshDevices(requestPermission = true) {
  let permissionStream = null;
  if (requestPermission) {
    try {
      permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (error) {
      console.warn('Camera/microphone permission request:', error);
    } finally {
      stopTracks(permissionStream);
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect(cameraSelect, devices.filter((device) => device.kind === 'videoinput'), '카메라');
  fillSelect(microphoneSelect, devices.filter((device) => device.kind === 'audioinput'), '마이크');
}

function drawCover(context, source, x, y, width, height) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width || width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height || height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
}

function drawContain(context, source, x, y, width, height) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width || width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;
  context.fillStyle = '#020617';
  context.fillRect(x, y, width, height);
  context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cameraRect() {
  const width = canvas.width * (Number(cameraSize.value) / 100);
  const ratio = cameraShape.value === 'circle'
    ? 1
    : (cameraVideo.videoWidth && cameraVideo.videoHeight
      ? cameraVideo.videoHeight / cameraVideo.videoWidth
      : 9 / 16);
  const height = width * ratio;
  const centerX = presenterPosition.x * canvas.width;
  const centerY = presenterPosition.y * canvas.height;

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}

function syncPresenterControls() {
  const xPercent = Math.round(presenterPosition.x * 100);
  const yPercent = Math.round(presenterPosition.y * 100);
  cameraX.value = String(xPercent);
  cameraY.value = String(yPercent);
  cameraXValue.textContent = `${xPercent}%`;
  cameraYValue.textContent = `${yPercent}%`;
  cameraSizeValue.textContent = `${cameraSize.value}%`;
}

function savePresenterSettings() {
  try {
    localStorage.setItem(PRESENTER_SETTINGS_KEY, JSON.stringify({
      x: presenterPosition.x,
      y: presenterPosition.y,
      size: Number(cameraSize.value),
    }));
  } catch (error) {
    console.warn('Presenter settings save failed:', error);
  }
}

function loadPresenterSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRESENTER_SETTINGS_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      presenterPosition = {
        x: clamp(Number(saved.x), PRESENTER_POSITION_MIN, PRESENTER_POSITION_MAX),
        y: clamp(Number(saved.y), PRESENTER_POSITION_MIN, PRESENTER_POSITION_MAX),
      };
    }
    if (saved && Number.isFinite(saved.size)) {
      cameraSize.value = String(clamp(Number(saved.size), Number(cameraSize.min), Number(cameraSize.max)));
    }
  } catch (error) {
    console.warn('Presenter settings load failed:', error);
  }
  cameraPosition.value = 'custom';
  syncPresenterControls();
}

function setPresenterPosition(x, y, save = true) {
  presenterPosition = {
    x: clamp(Number(x), PRESENTER_POSITION_MIN, PRESENTER_POSITION_MAX),
    y: clamp(Number(y), PRESENTER_POSITION_MIN, PRESENTER_POSITION_MAX),
  };
  cameraPosition.value = 'custom';
  syncPresenterControls();
  updatePositionOverlay();
  if (save) savePresenterSettings();
}

function applyPositionPreset(position, save = true) {
  const width = canvas.width * (Number(cameraSize.value) / 100);
  const ratio = cameraShape.value === 'circle'
    ? 1
    : (cameraVideo.videoWidth && cameraVideo.videoHeight
      ? cameraVideo.videoHeight / cameraVideo.videoWidth
      : 9 / 16);
  const height = width * ratio;
  const margin = 28;
  const leftX = (margin + width / 2) / canvas.width;
  const rightX = (canvas.width - margin - width / 2) / canvas.width;
  const topY = (margin + height / 2) / canvas.height;
  const bottomY = (canvas.height - margin - height / 2) / canvas.height;

  switch (position) {
    case 'top-left': presenterPosition = { x: leftX, y: topY }; break;
    case 'top-right': presenterPosition = { x: rightX, y: topY }; break;
    case 'bottom-left': presenterPosition = { x: leftX, y: bottomY }; break;
    case 'bottom-right': presenterPosition = { x: rightX, y: bottomY }; break;
    default: return;
  }
  cameraPosition.value = position;
  syncPresenterControls();
  updatePositionOverlay();
  if (save) savePresenterSettings();
}

function canEditPresenterPosition() {
  return previewActive
    && positionEditEnabled.checked
    && !positionEditEnabled.disabled
    && cameraEnabled.checked
    && activeScene !== 'screen'
    && activeScene !== 'camera'
    && (!mediaRecorder || mediaRecorder.state !== 'recording');
}

function updatePositionEditState() {
  const editing = canEditPresenterPosition();
  positionEditLabel.textContent = positionEditEnabled.checked ? (editing ? '조정 중' : '대기') : '잠금';
  canvas.classList.toggle('position-editing', editing);
  if (!editing) {
    canvas.classList.remove('presenter-hover', 'dragging-presenter');
    presenterDrag = null;
  }
  updatePositionOverlay();
}

function updatePositionOverlay() {
  if (!positionOverlay) return;
  const visible = canEditPresenterPosition();
  positionOverlay.classList.toggle('hidden', !visible);
  if (!visible) return;
  const rect = cameraRect();
  positionOverlay.style.left = `${(rect.x / canvas.width) * 100}%`;
  positionOverlay.style.top = `${(rect.y / canvas.height) * 100}%`;
  positionOverlay.style.width = `${(rect.width / canvas.width) * 100}%`;
  positionOverlay.style.height = `${(rect.height / canvas.height) * 100}%`;
  positionOverlay.style.borderRadius = cameraShape.value === 'circle' ? '50%' : (cameraShape.value === 'rectangle' ? '4px' : '12px');
}

function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
    y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
  };
}

function pointInsideRect(point, rect) {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function resizeCameraWorkCanvases() {
  const sourceWidth = cameraVideo.videoWidth || 640;
  const sourceHeight = cameraVideo.videoHeight || 360;
  const scale = Math.min(1, 960 / sourceWidth);
  const width = Math.max(2, Math.round(sourceWidth * scale));
  const height = Math.max(2, Math.round(sourceHeight * scale));

  for (const workCanvas of [cameraCompositeCanvas, foregroundCanvas]) {
    if (workCanvas.width !== width || workCanvas.height !== height) {
      workCanvas.width = width;
      workCanvas.height = height;
    }
  }
}

function updateMaskCanvas() {
  if (!latestMask || renderedMaskVersion === maskImageVersion) return;
  const { width, height, data, format } = latestMask;
  if (maskCanvas.width !== width || maskCanvas.height !== height) {
    maskCanvas.width = width;
    maskCanvas.height = height;
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 1) {
    const offset = i * 4;
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    if (format === 'alpha8') {
      pixels[offset + 3] = data[i];
    } else {
      const confidence = Math.max(0, Math.min(1, (data[i] - 0.12) / 0.76));
      const smooth = confidence * confidence * (3 - 2 * confidence);
      pixels[offset + 3] = Math.round(smooth * 255);
    }
  }
  maskCtx.putImageData(new ImageData(pixels, width, height), 0, 0);
  renderedMaskVersion = maskImageVersion;
}

async function ensureSegmenter() {
  if (backgroundMode.value === 'original') return;
  await segmenter.ensureReady();
}

function requestSegmentation(now) {
  if (backgroundMode.value === 'original' || !cameraStream || cameraVideo.readyState < 2) return;
  const engineMode = document.getElementById('aiEngineSelect')?.value || 'mediapipe';
  const intervalMs = engineMode.startsWith('native-') ? 16 : 30;
  if (segmentBusy || now - lastSegmentAt < intervalMs) return;
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
      setMessage(`AI 배경 처리 오류: ${error.message}`, true);
      segmentErrorShown = true;
    }
  }).finally(() => {
    segmentBusy = false;
  });
}

function drawVirtualCameraBackground(context, width, height) {
  const mode = backgroundMode.value;

  if (mode === 'image') {
    if (backgroundImage) {
      drawCover(context, backgroundImage, 0, 0, width, height);
    } else {
      context.fillStyle = '#152238';
      context.fillRect(0, 0, width, height);
    }
    return;
  }

  if (mode === 'blur') {
    context.save();
    context.filter = 'blur(22px) saturate(.9)';
    const overscan = 28;
    drawCover(context, cameraVideo, -overscan, -overscan, width + overscan * 2, height + overscan * 2);
    context.restore();
    return;
  }

  context.clearRect(0, 0, width, height);
}

function buildCameraComposite() {
  if (!cameraStream || cameraVideo.readyState < 2) return null;
  resizeCameraWorkCanvases();
  const width = cameraCompositeCanvas.width;
  const height = cameraCompositeCanvas.height;
  const mode = backgroundMode.value;

  cameraCompositeCtx.clearRect(0, 0, width, height);

  if (mode === 'original' || !latestMask) {
    drawCover(cameraCompositeCtx, cameraVideo, 0, 0, width, height);
    return cameraCompositeCanvas;
  }

  updateMaskCanvas();
  drawVirtualCameraBackground(cameraCompositeCtx, width, height);

  foregroundCtx.clearRect(0, 0, width, height);
  drawCover(foregroundCtx, cameraVideo, 0, 0, width, height);
  foregroundCtx.globalCompositeOperation = 'destination-in';
  foregroundCtx.drawImage(maskCanvas, 0, 0, width, height);
  foregroundCtx.globalCompositeOperation = 'source-over';
  cameraCompositeCtx.drawImage(foregroundCanvas, 0, 0);

  return cameraCompositeCanvas;
}

function clipCameraShape(context, rect) {
  if (cameraShape.value === 'circle') {
    const radius = Math.min(rect.width, rect.height) / 2;
    context.beginPath();
    context.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, radius, 0, Math.PI * 2);
    context.clip();
    return;
  }

  if (cameraShape.value === 'rectangle') {
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
    return;
  }

  context.beginPath();
  context.roundRect(rect.x, rect.y, rect.width, rect.height, 24);
  context.clip();
}

function drawCameraInto(rect, fullScreen = false) {
  if (!cameraEnabled.checked || !cameraStream || cameraVideo.readyState < 2) return;
  const composite = buildCameraComposite();
  if (!composite) return;

  const transparentCutout = backgroundMode.value === 'remove';
  if (!transparentCutout && !fullScreen) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, .38)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = '#0f172a';
    if (cameraShape.value === 'circle') {
      const radius = Math.min(rect.width, rect.height) / 2 + 4;
      ctx.beginPath();
      ctx.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, radius, 0, Math.PI * 2);
    } else if (cameraShape.value === 'rectangle') {
      ctx.fillRect(rect.x - 4, rect.y - 4, rect.width + 8, rect.height + 8);
      ctx.restore();
      ctx.save();
      clipCameraShape(ctx, rect);
      drawCompositeToMain(rect, composite);
      ctx.restore();
      return;
    } else {
      ctx.beginPath();
      ctx.roundRect(rect.x - 4, rect.y - 4, rect.width + 8, rect.height + 8, 28);
    }
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (!fullScreen) clipCameraShape(ctx, rect);
  drawCompositeToMain(rect, composite);
  ctx.restore();
}

function drawCompositeToMain(rect, composite) {
  ctx.save();
  if (mirrorCamera.checked) {
    ctx.translate(rect.x + rect.width, rect.y);
    ctx.scale(-1, 1);
    drawCover(ctx, composite, 0, 0, rect.width, rect.height);
  } else {
    drawCover(ctx, composite, rect.x, rect.y, rect.width, rect.height);
  }
  ctx.restore();
}

function drawLoop(now = performance.now()) {
  if (!previewActive) return;
  requestSegmentation(now);

  if (activeScene === 'camera') {
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const fullRect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    drawCameraInto(fullRect, true);
  } else {
    if (screenVideo.readyState >= 2) {
      drawContain(ctx, screenVideo, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    if (activeScene !== 'screen') drawCameraInto(cameraRect());
  }

  updatePositionOverlay();
  drawFrameId = requestAnimationFrame(drawLoop);
}

function resetMicMeter() {
  if (micMeterFrameId) cancelAnimationFrame(micMeterFrameId);
  micMeterFrameId = null;
  micAnalyser = null;
  micLevelBar.style.width = '0%';
  micDb.textContent = '-∞ dB';
}

function startMicMeter() {
  if (!micAnalyser) return;
  const data = new Float32Array(micAnalyser.fftSize);

  const tick = () => {
    if (!micAnalyser) return;
    micAnalyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    const rms = Math.sqrt(sum / data.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const normalized = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0;
    micLevelBar.style.width = `${Math.round(normalized * 100)}%`;
    micDb.textContent = Number.isFinite(db) ? `${Math.round(db)} dB` : '-∞ dB';
    micMeterFrameId = requestAnimationFrame(tick);
  };
  tick();
}

async function makeAudioMix() {
  audioContext = new AudioContext();
  audioDestination = audioContext.createMediaStreamDestination();

  if (displayStream?.getAudioTracks().length) {
    const source = audioContext.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks()));
    source.connect(audioDestination);
  }

  if (microphoneStream?.getAudioTracks().length) {
    const micSource = audioContext.createMediaStreamSource(new MediaStream(microphoneStream.getAudioTracks()));
    micSource.connect(audioDestination);
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.75;
    micSource.connect(micAnalyser);
    startMicMeter();
  }

  if (audioContext.state === 'suspended') await audioContext.resume();
}

async function stopPreview() {
  previewActive = false;
  if (drawFrameId) cancelAnimationFrame(drawFrameId);
  drawFrameId = null;

  stopTracks(displayStream);
  stopTracks(cameraStream);
  stopTracks(microphoneStream);
  displayStream = null;
  cameraStream = null;
  microphoneStream = null;
  screenVideo.srcObject = null;
  cameraVideo.srcObject = null;
  latestMask = null;

  resetMicMeter();
  if (audioContext) {
    try { await audioContext.close(); } catch { /* already closed */ }
  }
  audioContext = null;
  audioDestination = null;

  recordButton.disabled = true;
  previewButton.textContent = '▶ 화면 선택 · 미리보기';
  emptyPreview.classList.remove('hidden');
  setStatus('준비');
}

async function startPreview() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('이 브라우저는 화면 공유 녹화를 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용하세요.');
  }

  await stopPreview();

  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: true,
  });
  screenVideo.srcObject = displayStream;
  await screenVideo.play();

  const displayTrack = displayStream.getVideoTracks()[0];
  const settings = displayTrack.getSettings();
  if (settings.width && settings.height) {
    const ratio = settings.width / settings.height;
    canvas.width = 1280;
    canvas.height = Math.round(canvas.width / ratio);
    if (canvas.height > 900) {
      canvas.height = 720;
      canvas.width = Math.round(canvas.height * ratio);
    }
  }

  displayTrack.addEventListener('ended', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') await stopRecording();
    await stopPreview();
    setMessage('화면 공유가 종료되었습니다.');
  }, { once: true });

  if (cameraEnabled.checked && cameraSelect.value) {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: cameraSelect.value },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
    cameraVideo.srcObject = cameraStream;
    await cameraVideo.play();
  }

  if (microphoneSelect.value) {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: { exact: microphoneSelect.value },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  if (backgroundMode.value !== 'original') {
    ensureSegmenter().catch((error) => {
      console.error(error);
      setMessage(`AI 배경 모델을 불러오지 못했습니다: ${error.message}`, true);
    });
  }

  await makeAudioMix();
  previewActive = true;
  emptyPreview.classList.add('hidden');
  previewButton.textContent = '↻ 화면 다시 선택';
  recordButton.disabled = false;
  setStatus('미리보기');

  const hasSystemAudio = displayStream.getAudioTracks().length > 0;
  setMessage(hasSystemAudio
    ? '미리보기가 시작되었습니다. 공유 화면의 소리도 감지되었습니다.'
    : '미리보기가 시작되었습니다. 시스템 소리는 현재 공유되지 않고 있습니다.');
  drawLoop();
}

function chooseMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function prepareOutput() {
  currentFileName = defaultFileName();
  fallbackChunks = [];
  fileWriter = null;

  if ('showSaveFilePicker' in window) {
    const handle = await window.showSaveFilePicker({
      suggestedName: currentFileName,
      types: [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }],
    });
    fileWriter = await handle.createWritable();
    currentFileName = handle.name;
    return 'direct';
  }
  return 'download';
}

async function writeChunk(blob) {
  if (!blob || blob.size === 0) return;
  if (fileWriter) await fileWriter.write(blob);
  else fallbackChunks.push(blob);
}

async function finishOutput(mimeType) {
  if (fileWriter) {
    await fileWriter.close();
    fileWriter = null;
    return currentFileName;
  }

  const blob = new Blob(fallbackChunks, { type: mimeType || 'video/webm' });
  fallbackChunks = [];
  downloadBlob(blob, currentFileName);
  return currentFileName;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function abortOutput() {
  fallbackChunks = [];
  if (fileWriter) {
    try { await fileWriter.abort(); } catch { /* best effort */ }
  }
  fileWriter = null;
}

function beginTimer() {
  recordingStartedAt = Date.now();
  recordingTimer.textContent = '00:00:00';
  timerInterval = setInterval(() => {
    recordingTimer.textContent = formatTime(Date.now() - recordingStartedAt);
  }, 500);
}

function endTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function resetMarkers() {
  recordingMarkers = [];
  markerCount.textContent = '0';
  latestMarker.textContent = '아직 마커 없음';
}

function addMarker() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  const elapsedMs = Date.now() - recordingStartedAt;
  const marker = {
    index: recordingMarkers.length + 1,
    timeMs: elapsedMs,
    time: formatTime(elapsedMs),
    label: `마커 ${recordingMarkers.length + 1}`,
  };
  recordingMarkers.push(marker);
  markerCount.textContent = String(recordingMarkers.length);
  latestMarker.textContent = `최근 ${marker.time}`;
  setMessage(`${marker.time}에 마커를 추가했습니다.`);
}

function exportMarkers(videoFileName) {
  if (!recordingMarkers.length) return;
  const markerFileName = videoFileName.replace(/\.webm$/i, '') + '.markers.json';
  const payload = {
    format: 'paran-recorder-markers',
    version: 1,
    videoFile: videoFileName,
    createdAt: new Date().toISOString(),
    markers: recordingMarkers,
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), markerFileName);
}

async function startRecording() {
  if (!previewActive) await startPreview();

  let outputMode;
  try {
    outputMode = await prepareOutput();
  } catch (error) {
    if (error.name === 'AbortError') {
      setMessage('파일 저장 선택이 취소되었습니다.');
      return;
    }
    throw error;
  }

  try {
    recordingCanvasStream = canvas.captureStream(30);
    const tracks = [...recordingCanvasStream.getVideoTracks()];
    if (audioDestination) tracks.push(...audioDestination.stream.getAudioTracks());
    const outputStream = new MediaStream(tracks);
    const mimeType = chooseMimeType();

    mediaRecorder = new MediaRecorder(outputStream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 160_000,
    });

    resetMarkers();
    recordingWriteChain = Promise.resolve();
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (!event.data || event.data.size === 0) return;
      recordingWriteChain = recordingWriteChain.then(() => writeChunk(event.data));
    });

    mediaRecorder.addEventListener('error', async (event) => {
      console.error('MediaRecorder error:', event.error);
      setMessage(`녹화 오류: ${event.error?.message || '알 수 없는 오류'}`, true);
      await abortOutput();
    });

    mediaRecorder.start(1000);
    beginTimer();
    recordButton.disabled = true;
    stopButton.disabled = false;
    markerButton.disabled = false;
    previewButton.disabled = true;
    positionEditEnabled.checked = false;
    positionEditEnabled.disabled = true;
    updatePositionEditState();
    setStatus('● 녹화 중', true);
    setMessage(outputMode === 'direct'
      ? `녹화 중 · ${currentFileName}에 직접 기록합니다.`
      : '녹화 중 · 종료하면 WebM 파일을 다운로드합니다.');
  } catch (error) {
    await abortOutput();
    throw error;
  }
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

  stopButton.disabled = true;
  markerButton.disabled = true;
  setMessage('녹화를 마무리하고 있습니다...');
  const mimeType = mediaRecorder.mimeType;

  await new Promise((resolve) => {
    mediaRecorder.addEventListener('stop', resolve, { once: true });
    mediaRecorder.stop();
  });

  await recordingWriteChain;
  const fileName = await finishOutput(mimeType);
  exportMarkers(fileName);
  stopTracks(recordingCanvasStream);
  recordingCanvasStream = null;
  mediaRecorder = null;
  endTimer();

  recordButton.disabled = false;
  previewButton.disabled = false;
  positionEditEnabled.disabled = false;
  updatePositionEditState();
  setStatus('미리보기');
  setMessage(`저장 완료: ${fileName}${recordingMarkers.length ? ` · 마커 ${recordingMarkers.length}개` : ''}`);
}

function applyScene(scene) {
  activeScene = scene;
  sceneButtons.forEach((button) => button.classList.toggle('active', button.dataset.scene === scene));

  if (scene === 'screen') {
    cameraEnabled.checked = false;
  } else {
    cameraEnabled.checked = true;
    if (scene === 'small') cameraSize.value = '24';
    if (scene === 'large') cameraSize.value = '42';
    cameraSizeValue.textContent = `${cameraSize.value}%`;
  }
}

function setPositionByShortcut(number) {
  const map = {
    '1': 'top-left',
    '2': 'top-right',
    '3': 'bottom-left',
    '4': 'bottom-right',
  };
  if (map[number]) applyPositionPreset(map[number]);
}

function updateBackgroundControls() {
  backgroundImageControls.classList.toggle('hidden', backgroundMode.value !== 'image');
  if (backgroundMode.value !== 'original') {
    ensureSegmenter().catch((error) => {
      console.error(error);
      setMessage(`AI 배경 모델을 불러오지 못했습니다: ${error.message}`, true);
    });
  }
}

function loadBackgroundImage(file) {
  if (!file) return;
  if (backgroundImageUrl) URL.revokeObjectURL(backgroundImageUrl);
  backgroundImageUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    backgroundImage = image;
    backgroundImageName.textContent = file.name;
    backgroundMode.value = 'image';
    updateBackgroundControls();
    setMessage(`가상 배경 이미지를 불러왔습니다: ${file.name}`);
  };
  image.onerror = () => setMessage('배경 이미지를 불러오지 못했습니다.', true);
  image.src = backgroundImageUrl;
}

async function guarded(action) {
  try {
    setMessage('');
    await action();
  } catch (error) {
    console.error(error);
    setMessage(error.message || String(error), true);
  }
}

previewButton.addEventListener('click', () => guarded(startPreview));
recordButton.addEventListener('click', () => guarded(startRecording));
stopButton.addEventListener('click', () => guarded(stopRecording));
markerButton.addEventListener('click', addMarker);
refreshDevicesButton.addEventListener('click', () => guarded(() => refreshDevices(true)));
sceneButtons.forEach((button) => button.addEventListener('click', () => {
  applyScene(button.dataset.scene);
  savePresenterSettings();
  updatePositionEditState();
}));
cameraSize.addEventListener('input', () => {
  cameraSizeValue.textContent = `${cameraSize.value}%`;
  savePresenterSettings();
  updatePositionOverlay();
});
cameraX.addEventListener('input', () => setPresenterPosition(Number(cameraX.value) / 100, presenterPosition.y));
cameraY.addEventListener('input', () => setPresenterPosition(presenterPosition.x, Number(cameraY.value) / 100));
cameraPosition.addEventListener('change', () => {
  if (cameraPosition.value !== 'custom') applyPositionPreset(cameraPosition.value);
});
positionEditEnabled.addEventListener('change', updatePositionEditState);
positionResetButton.addEventListener('click', () => {
  applyPositionPreset('bottom-right');
  cameraPosition.value = 'custom';
  setMessage('인물 위치를 기본 위치로 되돌렸습니다.');
});
cameraShape.addEventListener('change', updatePositionOverlay);

canvas.addEventListener('pointerdown', (event) => {
  if (!canEditPresenterPosition()) return;
  const rect = cameraRect();
  const point = canvasPoint(event);
  if (!pointInsideRect(point, rect)) return;
  presenterDrag = {
    pointerId: event.pointerId,
    offsetX: point.x - (rect.x + rect.width / 2),
    offsetY: point.y - (rect.y + rect.height / 2),
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging-presenter');
  event.preventDefault();
});

canvas.addEventListener('pointermove', (event) => {
  if (!canEditPresenterPosition()) {
    canvas.classList.remove('presenter-hover');
    return;
  }

  const point = canvasPoint(event);
  if (presenterDrag && presenterDrag.pointerId === event.pointerId) {
    setPresenterPosition(
      (point.x - presenterDrag.offsetX) / canvas.width,
      (point.y - presenterDrag.offsetY) / canvas.height,
      false,
    );
    return;
  }

  canvas.classList.toggle('presenter-hover', pointInsideRect(point, cameraRect()));
});

function finishPresenterDrag(event) {
  if (!presenterDrag || presenterDrag.pointerId !== event.pointerId) return;
  try { canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  presenterDrag = null;
  canvas.classList.remove('dragging-presenter');
  savePresenterSettings();
  updatePositionOverlay();
}

canvas.addEventListener('pointerup', finishPresenterDrag);
canvas.addEventListener('pointercancel', finishPresenterDrag);
canvas.addEventListener('pointerleave', () => {
  if (!presenterDrag) canvas.classList.remove('presenter-hover');
});

backgroundMode.addEventListener('change', updateBackgroundControls);
backgroundImageInput.addEventListener('change', () => loadBackgroundImage(backgroundImageInput.files?.[0]));

cameraEnabled.addEventListener('change', () => {
  if (!cameraEnabled.checked && activeScene !== 'screen') applyScene('screen');
  if (cameraEnabled.checked && activeScene === 'screen') applyScene('small');
  updatePositionEditState();
});

window.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;

  const sceneMap = { F1: 'screen', F2: 'small', F3: 'large', F4: 'camera' };
  if (sceneMap[event.key]) {
    event.preventDefault();
    applyScene(sceneMap[event.key]);
    savePresenterSettings();
    updatePositionEditState();
    return;
  }

  if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    addMarker();
    return;
  }

  if (event.ctrlKey && ['1', '2', '3', '4'].includes(event.key)) {
    event.preventDefault();
    setPositionByShortcut(event.key);
  }
});

window.addEventListener('beforeunload', () => {
  stopTracks(displayStream);
  stopTracks(cameraStream);
  stopTracks(microphoneStream);
  segmenter.close();
  if (backgroundImageUrl) URL.revokeObjectURL(backgroundImageUrl);
});

runtimeLabel.textContent = isTauri ? 'TAURI 개발판' : 'WEB 개발판';
systemAudioInfo.textContent = '시스템 소리는 화면 선택 창에서 오디오 공유를 켠 경우 함께 녹음됩니다.';
saveModeInfo.textContent = 'Chrome/Edge에서는 가능한 경우 녹화 데이터를 파일에 바로 기록합니다.';

(async () => {
  if (!window.isSecureContext && location.hostname !== 'localhost') {
    setMessage('화면·카메라 녹화를 위해 HTTPS 환경이 필요합니다.', true);
    return;
  }
  applyScene('small');
  loadPresenterSettings();
  updatePositionEditState();
  updateBackgroundControls();
  await guarded(() => refreshDevices(true));
})();
