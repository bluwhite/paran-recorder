use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

#[cfg(target_os = "windows")]
use ort::{ep::DirectML, session::Session, value::Tensor};

const MODEL_NAME: &str = "PP-HumanSegV2-Lite";
const MODEL_RELATIVE_PATH: &str = "models/pp_humanseg_v2_lite.onnx";
const INPUT_WIDTH: usize = 256;
const INPUT_HEIGHT: usize = 144;
const STRONG_CORE_THRESHOLD: f32 = 0.94;
const ERODE_RADIUS: isize = 2;
const DILATE_RADIUS: isize = 12;

#[derive(Default)]
struct NativeState {
    #[cfg(target_os = "windows")]
    engine: Mutex<Option<NativeEngine>>,
}

#[cfg(target_os = "windows")]
struct NativeEngine {
    session: Session,
    provider: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRuntimeInfo {
    available: bool,
    provider: String,
    model: String,
    message: String,
    input_width: usize,
    input_height: usize,
}

#[cfg(target_os = "windows")]
fn model_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .resource_dir()
        .map_err(|error| format!("리소스 폴더를 찾을 수 없습니다: {error}"))?;
    let path = base.join(MODEL_RELATIVE_PATH);
    if !path.exists() {
        return Err(format!(
            "PP-HumanSegV2-Lite ONNX 모델 파일이 없습니다: {}",
            path.display()
        ));
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
fn create_native_engine(app: &tauri::AppHandle) -> Result<NativeEngine, String> {
    let path = model_path(app)?;

    let directml_attempt = Session::builder()
        .map_err(|error| format!("ONNX Runtime 세션 준비 실패: {error}"))?
        .with_execution_providers([DirectML::default().build()])
        .map_err(|error| format!("DirectML 설정 실패: {error}"))?
        .commit_from_file(&path);

    match directml_attempt {
        Ok(session) => Ok(NativeEngine {
            session,
            provider: "DirectML".to_string(),
        }),
        Err(directml_error) => {
            eprintln!("DirectML initialization failed, falling back to CPU: {directml_error}");
            let session = Session::builder()
                .map_err(|error| format!("CPU 세션 준비 실패: {error}"))?
                .commit_from_file(&path)
                .map_err(|error| {
                    format!(
                        "ONNX Runtime 모델 로드 실패. DirectML: {directml_error}; CPU: {error}"
                    )
                })?;
            Ok(NativeEngine {
                session,
                provider: "CPU fallback".to_string(),
            })
        }
    }
}

#[cfg(target_os = "windows")]
fn ensure_native_engine<'a>(
    app: &tauri::AppHandle,
    state: &'a tauri::State<'_, NativeState>,
) -> Result<std::sync::MutexGuard<'a, Option<NativeEngine>>, String> {
    let mut guard = state
        .engine
        .lock()
        .map_err(|_| "ONNX Runtime 상태 잠금에 실패했습니다.".to_string())?;

    if guard.is_none() {
        *guard = Some(create_native_engine(app)?);
    }
    Ok(guard)
}

#[tauri::command]
fn native_runtime_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
) -> NativeRuntimeInfo {
    #[cfg(target_os = "windows")]
    {
        match ensure_native_engine(&app, &state) {
            Ok(guard) => {
                let provider = guard
                    .as_ref()
                    .map(|engine| engine.provider.clone())
                    .unwrap_or_else(|| "Unknown".to_string());
                NativeRuntimeInfo {
                    available: true,
                    provider,
                    model: MODEL_NAME.to_string(),
                    message: "ONNX Runtime Native 준비 완료".to_string(),
                    input_width: INPUT_WIDTH,
                    input_height: INPUT_HEIGHT,
                }
            }
            Err(error) => NativeRuntimeInfo {
                available: false,
                provider: "Unavailable".to_string(),
                model: MODEL_NAME.to_string(),
                message: error,
                input_width: INPUT_WIDTH,
                input_height: INPUT_HEIGHT,
            },
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        NativeRuntimeInfo {
            available: false,
            provider: "Unsupported".to_string(),
            model: MODEL_NAME.to_string(),
            message: "현재 네이티브 ONNX 프로토타입은 Windows에서만 지원합니다.".to_string(),
            input_width: INPUT_WIDTH,
            input_height: INPUT_HEIGHT,
        }
    }
}

fn request_dimension(request: &tauri::ipc::Request, name: &'static str) -> Result<usize, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("필수 헤더가 없습니다: {name}"))?
        .to_str()
        .map_err(|_| format!("헤더 형식이 잘못되었습니다: {name}"))?
        .parse::<usize>()
        .map_err(|_| format!("헤더 숫자 형식이 잘못되었습니다: {name}"))
}

fn erode_cross(source: &[u8], width: usize, height: usize, radius: isize) -> Vec<u8> {
    let radius = radius.max(0) as usize;
    let span = (radius * 2) + 1;
    let mut horizontal = vec![0u8; source.len()];
    let mut output = vec![0u8; source.len()];

    if span > width || span > height {
        return output;
    }

    for y in 0..height {
        let row = y * width;
        let mut count = 0usize;
        for x in 0..span {
            count += usize::from(source[row + x] != 0);
        }
        horizontal[row + radius] = u8::from(count == span);

        for center in (radius + 1)..(width - radius) {
            count += usize::from(source[row + center + radius] != 0);
            count -= usize::from(source[row + center - radius - 1] != 0);
            horizontal[row + center] = u8::from(count == span);
        }
    }

    for x in radius..(width - radius) {
        let mut count = 0usize;
        for y in 0..span {
            count += usize::from(source[y * width + x] != 0);
        }
        output[radius * width + x] = u8::from(
            count == span && horizontal[radius * width + x] != 0
        );

        for center in (radius + 1)..(height - radius) {
            count += usize::from(source[(center + radius) * width + x] != 0);
            count -= usize::from(source[(center - radius - 1) * width + x] != 0);
            output[center * width + x] = u8::from(
                count == span && horizontal[center * width + x] != 0
            );
        }
    }

    output
}

fn dilate_cross(source: &[u8], width: usize, height: usize, radius: isize) -> Vec<u8> {
    let radius = radius.max(0) as usize;
    let mut horizontal = vec![0u8; source.len()];
    let mut output = vec![0u8; source.len()];

    for y in 0..height {
        let row = y * width;
        let mut count = 0usize;
        let initial_right = radius.min(width.saturating_sub(1));
        for x in 0..=initial_right {
            count += usize::from(source[row + x] != 0);
        }

        for x in 0..width {
            if x > 0 {
                let add = x + radius;
                if add < width {
                    count += usize::from(source[row + add] != 0);
                }
                if x > radius {
                    count -= usize::from(source[row + x - radius - 1] != 0);
                }
            }
            horizontal[row + x] = u8::from(count > 0);
        }
    }

    for x in 0..width {
        let mut count = 0usize;
        let initial_bottom = radius.min(height.saturating_sub(1));
        for y in 0..=initial_bottom {
            count += usize::from(source[y * width + x] != 0);
        }

        for y in 0..height {
            if y > 0 {
                let add = y + radius;
                if add < height {
                    count += usize::from(source[add * width + x] != 0);
                }
                if y > radius {
                    count -= usize::from(source[(y - radius - 1) * width + x] != 0);
                }
            }
            output[y * width + x] = u8::from(
                horizontal[y * width + x] != 0 || count > 0
            );
        }
    }

    output
}

fn pp_humanseg_alpha(
    values: &[f32],
    plane: usize,
    width: usize,
    height: usize,
) -> Result<Vec<u8>, String> {
    let human = if values.len() == plane * 2 {
        &values[plane..(plane * 2)]
    } else if values.len() == plane {
        values
    } else {
        return Err(format!(
            "PP-HumanSeg 출력 크기가 예상과 다릅니다: {} / {} 또는 {}",
            values.len(),
            plane,
            plane * 2
        ));
    };

    let strong: Vec<u8> = human
        .iter()
        .map(|&value| u8::from(value >= STRONG_CORE_THRESHOLD))
        .collect();
    let eroded = erode_cross(&strong, width, height, ERODE_RADIUS);
    let gate = dilate_cross(&eroded, width, height, DILATE_RADIUS);
    let has_gate = gate.iter().any(|&value| value != 0);

    let mut alpha = Vec::with_capacity(plane);
    for i in 0..plane {
        let value = human[i].clamp(0.0, 1.0);
        let cleaned = if !has_gate || gate[i] != 0 { value } else { 0.0 };
        alpha.push((cleaned * 255.0).round() as u8);
    }
    Ok(alpha)
}

#[tauri::command]
fn native_segment(
    request: tauri::ipc::Request,
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "windows")]
    {
        let width = request_dimension(&request, "x-width")?;
        let height = request_dimension(&request, "x-height")?;

        if width != INPUT_WIDTH || height != INPUT_HEIGHT {
            return Err(format!(
                "PP-HumanSegV2-Lite 입력은 {}x{}여야 합니다: {}x{}",
                INPUT_WIDTH, INPUT_HEIGHT, width, height
            ));
        }

        let tauri::ipc::InvokeBody::Raw(rgba) = request.body() else {
            return Err("네이티브 영상 프레임은 raw binary로 전달해야 합니다.".to_string());
        };

        let plane = width * height;
        if rgba.len() != plane * 4 {
            return Err(format!(
                "RGBA 프레임 크기가 올바르지 않습니다: {} / {}",
                rgba.len(),
                plane * 4
            ));
        }

        let mut input = vec![0.0_f32; plane * 3];
        for i in 0..plane {
            let p = i * 4;
            input[i] = (rgba[p] as f32 / 127.5) - 1.0;
            input[plane + i] = (rgba[p + 1] as f32 / 127.5) - 1.0;
            input[(plane * 2) + i] = (rgba[p + 2] as f32 / 127.5) - 1.0;
        }

        let tensor = Tensor::from_array((
            [1usize, 3usize, height, width],
            input.into_boxed_slice(),
        ))
        .map_err(|error| format!("ONNX 입력 텐서 생성 실패: {error}"))?;

        let mut guard = ensure_native_engine(&app, &state)?;
        let engine = guard
            .as_mut()
            .ok_or_else(|| "ONNX Runtime 세션이 준비되지 않았습니다.".to_string())?;

        let outputs = engine
            .session
            .run(ort::inputs![tensor])
            .map_err(|error| format!("ONNX 추론 실패: {error}"))?;

        let (_shape, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("ONNX 출력 마스크 읽기 실패: {error}"))?;

        let alpha = pp_humanseg_alpha(values, plane, width, height)?;
        return Ok(tauri::ipc::Response::new(alpha));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (request, app, state);
        Err("현재 네이티브 ONNX 프로토타입은 Windows 전용입니다.".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativeState::default())
        .invoke_handler(tauri::generate_handler![
            native_runtime_info,
            native_segment
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paran Recorder");
}
