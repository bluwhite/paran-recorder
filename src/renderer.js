const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const screenVideo = document.getElementById('screenVideo');
const cameraVideo = document.getElementById('cameraVideo');
const emptyPreview = document.getElementById('emptyPreview');
const cameraSelect = document.getElementById('cameraSelect');
const microphoneSelect = document.getElementById('microphoneSelect');
const cameraEnabled = document.getElementById('cameraEnabled');
const cameraPosition = document.getElementById('cameraPosition');
const cameraSize = document.getElementById('cameraSize');
const cameraSizeValue = document.getElementById('cameraSizeValue');
const mirrorCamera = document.getElementById('mirrorCamera');
const previewButton = document.getElementById('previewButton');
const recordButton = document.getElementById('recordButton');
const stopButton = document.getElementById('stopButton');
const refreshDevicesButton = document.getElementById('refreshDevicesButton');
const message = document.getElementById('message');
const statusBadge = document.getElementById('statusBadge');
const recordingTimer = document.getElementById('recordingTimer');
const systemAudioInfo = document.getElementById('systemAudioInfo');
const saveModeInfo = document.getElementById('saveModeInfo');
const runtimeLabel = document.getElementById('runtimeLabel');

let displayStream = null;
let cameraStream = null;
let microphoneStream = null;
let audioContext = null;
let audioDestination = null;
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

const isTauri = Boolean(window.__TAURI_INTERNALS__);

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

function drawVideoContain(video, x, y, width, height) {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = x + (width - drawWidth) / 2;
  const drawY = y + (height - drawHeight) / 2;

  ctx.fillStyle = '#020617';
  ctx.fillRect(x, y, width, height);
  ctx.drawImage(video, drawX, drawY, drawWidth, drawHeight);
}

function cameraRect() {
  const width = canvas.width * (Number(cameraSize.value) / 100);
  const ratio = cameraVideo.videoWidth && cameraVideo.videoHeight
    ? cameraVideo.videoHeight / cameraVideo.videoWidth
    : 9 / 16;
  const height = width * ratio;
  const margin = 28;

  switch (cameraPosition.value) {
    case 'top-left': return { x: margin, y: margin, width, height };
    case 'top-right': return { x: canvas.width - width - margin, y: margin, width, height };
    case 'bottom-left': return { x: margin, y: canvas.height - height - margin, width, height };
    default: return { x: canvas.width - width - margin, y: canvas.height - height - margin, width, height };
  }
}

function drawCamera() {
  if (!cameraEnabled.checked || !cameraStream || cameraVideo.readyState < 2) return;

  const rect = cameraRect();
  const radius = 24;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, .38)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.roundRect(rect.x - 4, rect.y - 4, rect.width + 8, rect.height + 8, radius + 4);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  ctx.clip();

  if (mirrorCamera.checked) {
    ctx.translate(rect.x + rect.width, rect.y);
    ctx.scale(-1, 1);
    ctx.drawImage(cameraVideo, 0, 0, rect.width, rect.height);
  } else {
    ctx.drawImage(cameraVideo, rect.x, rect.y, rect.width, rect.height);
  }
  ctx.restore();
}

function drawLoop() {
  if (!previewActive) return;

  if (screenVideo.readyState >= 2) {
    drawVideoContain(screenVideo, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  drawCamera();
  drawFrameId = requestAnimationFrame(drawLoop);
}

async function makeAudioMix() {
  audioContext = new AudioContext();
  audioDestination = audioContext.createMediaStreamDestination();

  const connectStream = (stream) => {
    if (!stream || stream.getAudioTracks().length === 0) return;
    const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    source.connect(audioDestination);
  };

  connectStream(displayStream);
  connectStream(microphoneStream);

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
      types: [{
        description: 'WebM video',
        accept: { 'video/webm': ['.webm'] },
      }],
    });
    fileWriter = await handle.createWritable();
    currentFileName = handle.name;
    return 'direct';
  }

  return 'download';
}

async function writeChunk(blob) {
  if (!blob || blob.size === 0) return;
  if (fileWriter) {
    await fileWriter.write(blob);
  } else {
    fallbackChunks.push(blob);
  }
}

async function finishOutput(mimeType) {
  if (fileWriter) {
    await fileWriter.close();
    fileWriter = null;
    return currentFileName;
  }

  const blob = new Blob(fallbackChunks, { type: mimeType || 'video/webm' });
  fallbackChunks = [];
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = currentFileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return currentFileName;
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
    previewButton.disabled = true;
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
  setMessage('녹화를 마무리하고 있습니다...');
  const mimeType = mediaRecorder.mimeType;

  await new Promise((resolve) => {
    mediaRecorder.addEventListener('stop', resolve, { once: true });
    mediaRecorder.stop();
  });

  await recordingWriteChain;
  const fileName = await finishOutput(mimeType);
  stopTracks(recordingCanvasStream);
  recordingCanvasStream = null;
  mediaRecorder = null;
  endTimer();

  recordButton.disabled = false;
  previewButton.disabled = false;
  setStatus('미리보기');
  setMessage(`저장 완료: ${fileName}`);
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
refreshDevicesButton.addEventListener('click', () => guarded(() => refreshDevices(true)));
cameraSize.addEventListener('input', () => { cameraSizeValue.textContent = `${cameraSize.value}%`; });

window.addEventListener('beforeunload', () => {
  stopTracks(displayStream);
  stopTracks(cameraStream);
  stopTracks(microphoneStream);
});

runtimeLabel.textContent = isTauri ? 'TAURI 개발판' : 'WEB 개발판';
systemAudioInfo.textContent = '시스템 소리는 화면 선택 창에서 오디오 공유를 켠 경우 함께 녹음됩니다.';
saveModeInfo.textContent = 'Chrome/Edge에서는 가능한 경우 녹화 데이터를 파일에 바로 기록합니다.';

(async () => {
  if (!window.isSecureContext && location.hostname !== 'localhost') {
    setMessage('화면·카메라 녹화를 위해 HTTPS 환경이 필요합니다.', true);
    return;
  }
  await guarded(() => refreshDevices(true));
})();
