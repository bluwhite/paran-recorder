const api = window.paranRecorder;

const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const screenVideo = document.getElementById('screenVideo');
const cameraVideo = document.getElementById('cameraVideo');
const emptyPreview = document.getElementById('emptyPreview');
const sourceSelect = document.getElementById('sourceSelect');
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
const refreshSourcesButton = document.getElementById('refreshSourcesButton');
const refreshDevicesButton = document.getElementById('refreshDevicesButton');
const message = document.getElementById('message');
const statusBadge = document.getElementById('statusBadge');
const recordingTimer = document.getElementById('recordingTimer');
const systemAudioInfo = document.getElementById('systemAudioInfo');

let displayStream = null;
let cameraStream = null;
let microphoneStream = null;
let audioContext = null;
let audioDestination = null;
let drawFrameId = null;
let mediaRecorder = null;
let recordingCanvasStream = null;
let recordingWriteChain = Promise.resolve();
let recordingStartedAt = 0;
let timerInterval = null;
let previewActive = false;

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
    const option = new Option(fallbackText, '');
    select.add(option);
    return;
  }

  devices.forEach((device, index) => {
    const label = device.label || `${fallbackText} ${index + 1}`;
    select.add(new Option(label, device.deviceId));
  });

  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

async function refreshSources() {
  try {
    const sources = await api.listDesktopSources();
    const previous = sourceSelect.value;
    sourceSelect.innerHTML = '';

    sources.forEach((source) => {
      sourceSelect.add(new Option(source.name, source.id));
    });

    if ([...sourceSelect.options].some((option) => option.value === previous)) {
      sourceSelect.value = previous;
    }

    if (!sources.length) setMessage('녹화할 화면을 찾지 못했습니다.', true);
  } catch (error) {
    console.error(error);
    setMessage(`화면 목록을 가져오지 못했습니다: ${error.message}`, true);
  }
}

async function refreshDevices(requestPermission = true) {
  let permissionStream = null;
  if (requestPermission) {
    try {
      permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (error) {
      console.warn('Combined media permission request failed:', error);
      try {
        permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        // Device lists below can still show whatever the OS exposes.
      }
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
  previewButton.textContent = '▶ 미리보기 시작';
  emptyPreview.classList.remove('hidden');
  setStatus('준비');
}

async function startPreview() {
  if (!sourceSelect.value) throw new Error('녹화할 화면을 선택하세요.');

  await stopPreview();
  await api.selectDesktopSource(sourceSelect.value);

  displayStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: api.platform === 'win32',
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
  previewButton.textContent = '↻ 미리보기 다시 시작';
  recordButton.disabled = false;
  setStatus('미리보기');
  setMessage('미리보기가 시작되었습니다. 화면 구성을 확인한 뒤 녹화를 시작하세요.');
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

  const fileResult = await api.beginRecording(defaultFileName());
  if (fileResult.canceled) {
    setMessage('녹화가 취소되었습니다.');
    return;
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
      recordingWriteChain = recordingWriteChain.then(async () => {
        const buffer = await event.data.arrayBuffer();
        await api.writeRecordingChunk(buffer);
      });
    });

    mediaRecorder.addEventListener('error', async (event) => {
      console.error('MediaRecorder error:', event.error);
      setMessage(`녹화 오류: ${event.error?.message || '알 수 없는 오류'}`, true);
      await api.abortRecording();
    });

    mediaRecorder.start(1000);
    beginTimer();
    recordButton.disabled = true;
    stopButton.disabled = false;
    previewButton.disabled = true;
    setStatus('● 녹화 중', true);
    setMessage(`녹화 중 · ${fileResult.filePath}`);
  } catch (error) {
    await api.abortRecording();
    throw error;
  }
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

  stopButton.disabled = true;
  setMessage('녹화를 마무리하고 있습니다...');

  await new Promise((resolve) => {
    mediaRecorder.addEventListener('stop', resolve, { once: true });
    mediaRecorder.stop();
  });

  await recordingWriteChain;
  const result = await api.finishRecording();
  stopTracks(recordingCanvasStream);
  recordingCanvasStream = null;
  mediaRecorder = null;
  endTimer();

  recordButton.disabled = false;
  previewButton.disabled = false;
  setStatus('미리보기');
  setMessage(`저장 완료: ${result.filePath}`);
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
refreshSourcesButton.addEventListener('click', () => guarded(refreshSources));
refreshDevicesButton.addEventListener('click', () => guarded(() => refreshDevices(true)));
cameraSize.addEventListener('input', () => { cameraSizeValue.textContent = `${cameraSize.value}%`; });

window.addEventListener('beforeunload', () => {
  stopTracks(displayStream);
  stopTracks(cameraStream);
  stopTracks(microphoneStream);
});

systemAudioInfo.textContent = api.platform === 'win32'
  ? 'Windows에서는 화면의 시스템 소리도 함께 섞어 녹음합니다.'
  : '현재 v0.1의 시스템 소리 자동 녹음은 Windows 우선 지원입니다.';

(async () => {
  await guarded(refreshSources);
  await guarded(() => refreshDevices(true));
})();
