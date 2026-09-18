use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

#[cfg(target_os = "windows")]
use ort::{ep::DirectML, session::Session, value::Tensor};

const MODEL_NAME: &str = "MODNet";
const MODEL_RELATIVE_PATH: &str = "models/modnet.onnx";

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
        return Err(format!("MODNet 모델 파일이 없습니다: {}", path.display()));
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
                    input_width: 512,
                    input_height: 288,
                }
            }
            Err(error) => NativeRuntimeInfo {
                available: false,
                provider: "Unavailable".to_string(),
                model: MODEL_NAME.to_string(),
                message: error,
                input_width: 512,
                input_height: 288,
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
            message: "현재 프로토타입은 Windows에서만 ONNX Runtime Native를 지원합니다.".to_string(),
            input_width: 512,
            input_height: 288,
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

        if width < 64 || height < 64 || width > 1280 || height > 720 {
            return Err(format!("지원하지 않는 입력 크기입니다: {width}x{height}"));
        }
        if width % 32 != 0 || height % 32 != 0 {
            return Err("MODNet 입력 크기는 32의 배수여야 합니다.".to_string());
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

        if values.len() != plane {
            return Err(format!(
                "ONNX 출력 크기가 예상과 다릅니다: {} / {}",
                values.len(),
                plane
            ));
        }

        let mut alpha = Vec::with_capacity(plane);
        for &value in values {
            let clamped = value.clamp(0.0, 1.0);
            alpha.push((clamped * 255.0).round() as u8);
        }

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
