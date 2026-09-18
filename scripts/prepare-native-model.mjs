import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const MODEL_PATH = resolve('src-tauri/resources/models/pp_humanseg_v2_lite.onnx');
const MIN_BYTES = 1_000_000;

async function main() {
  const info = await stat(MODEL_PATH);
  if (info.size < MIN_BYTES) {
    throw new Error('PP-HumanSegV2-Lite ONNX model is incomplete.');
  }
  console.log('PP-HumanSegV2-Lite ONNX model ready: ' + MODEL_PATH + ' (' + info.size + ' bytes)');
}

main().catch((error) => {
  console.error('PP-HumanSegV2-Lite ONNX model is not prepared.');
  console.error('Windows CI converts the official Paddle inference model automatically.');
  console.error('For local native development, place pp_humanseg_v2_lite.onnx in src-tauri/resources/models/.');
  console.error(error);
  process.exitCode = 1;
});
