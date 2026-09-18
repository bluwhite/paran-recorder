import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL_URL = 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model.onnx?download=true';
const MODEL_PATH = resolve('src-tauri/resources/models/modnet.onnx');
const TEMP_PATH = `${MODEL_PATH}.part`;
const EXPECTED_BYTES = 25_888_640;
const EXPECTED_SHA256 = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9';

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function isReady() {
  try {
    const info = await stat(MODEL_PATH);
    if (info.size !== EXPECTED_BYTES) return false;
    return await fileSha256(MODEL_PATH) === EXPECTED_SHA256;
  } catch {
    return false;
  }
}

async function main() {
  if (await isReady()) {
    console.log('MODNet ONNX model ready.');
    return;
  }

  await mkdir(dirname(MODEL_PATH), { recursive: true });
  await rm(TEMP_PATH, { force: true });

  console.log('Downloading MODNet ONNX model (25.9 MB)...');
  const response = await fetch(MODEL_URL, {
    redirect: 'follow',
    headers: { 'user-agent': 'ParanRecorder/0.5' },
  });

  if (!response.ok || !response.body) {
    throw new Error(`MODNet download failed: HTTP ${response.status}`);
  }

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(TEMP_PATH));
    const info = await stat(TEMP_PATH);
    if (info.size !== EXPECTED_BYTES) {
      throw new Error(`Unexpected MODNet size: ${info.size} / ${EXPECTED_BYTES}`);
    }

    const digest = await fileSha256(TEMP_PATH);
    if (digest !== EXPECTED_SHA256) {
      throw new Error(`MODNet SHA256 mismatch: ${digest}`);
    }

    await rm(MODEL_PATH, { force: true });
    await rename(TEMP_PATH, MODEL_PATH);
    console.log(`MODNet ready: ${MODEL_PATH}`);
  } catch (error) {
    await rm(TEMP_PATH, { force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
