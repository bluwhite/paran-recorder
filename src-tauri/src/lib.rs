use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

#[cfg(target_os = "windows")]
use ort::{ep::DirectML, session::Session, value::Tensor};
#[cfg(target_os = "windows")]
use sha2::{Digest, Sha256};

const MODEL_NAME: &str = "PP-HumanSegV2-Lite";
const MODEL_RELATIVE_PATH: &str = "models/pp_humanseg_v2_lite.onnx";
const INPUT_WIDTH: usize = 256;
const INPUT_HEIGHT: usize = 144;
const STRONG_CORE_THRESHOLD: f32 = 0.94;
const ERODE_RADIUS: isize = 2;
const DILATE_RADIUS: isize = 12;

const RVM_MODEL_NAME: &str = "RVM MobileNetV3 FP32";
const RVM_MODEL_FILE: &str = "rvm_mobilenetv3_fp32.onnx";
const RVM_MODEL_URL: &str =
    "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx";
const RVM_MODEL_SHA256: &str =
    "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828";
const RVM_MODEL_BYTES: u64 = 14_975_696;
const RVM_INPUT_WIDTH: usize = 256;
const RVM_INPUT_HEIGHT: usize = 144;
const RVM_DOWNSAMPLE_RATIO: f32 = 1.0;

#[derive(Default)]
struct NativeState {
    #[cfg(target_os = "windows")]
    engine: Mutex<Option<NativeEngine>>,
    #[cfg(target_os = "windows")]
    rvm_engine: Mutex<Option<RvmEngine>>,
}

#[cfg(target_os = "windows")]
struct NativeEngine {
    session: Session,
    provider: String,
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct RecurrentState {
    shape: Vec<i64>,
    data: Vec<f32>,
}

#[cfg(target_os = "windows")]
impl RecurrentState {
    fn initial() -> Self {
        Self {
            shape: vec![1, 1, 1, 1],
            data: vec![0.0],
        }
    }
}

#[cfg(target_os = "windows")]
struct RvmEngine {
    session: Session,
    provider: String,
    rec: Vec<RecurrentState>,
    config: Option<(usize, usize, u32)>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RvmRuntimeInfo {
    available: bool,
    downloaded: bool,
    provider: String,
    model: String,
    message: String,
    input_width: usize,
    input_height: usize,
}

#[cfg(target_os = "windows")]
fn create_session(path: &std::path::Path) -> Result<(Session, String), String> {
    let directml_attempt = Session::builder()
        .map_err(|error| format!("ONNX Runtime 세션 준비 실패: {error}"))?
        .with_execution_providers([DirectML::default().build()])
        .map_err(|error| format!("DirectML 설정 실패: {error}"))?
        .commit_from_file(path);

    match directml_attempt {
        Ok(session) => Ok((session, "DirectML".to_string())),
        Err(directml_error) => {
            eprintln!("DirectML initialization failed, falling back to CPU: {directml_error}");
            let session = Session::builder()
                .map_err(|error| format!("CPU 세션 준비 실패: {error}"))?
                .commit_from_file(path)
                .map_err(|error| {
                    format!(
                        "ONNX Runtime 모델 로드 실패. DirectML: {directml_error}; CPU: {error}"
                    )
                })?;
            Ok((session, "CPU fallback".to_string()))
        }
    }
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
fn rvm_model_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("앱 데이터 폴더를 찾을 수 없습니다: {error}"))?;
    Ok(base.join("models").join(RVM_MODEL_FILE))
}

#[cfg(target_os = "windows")]
fn create_native_engine(app: &tauri::AppHandle) -> Result<NativeEngine, String> {
    let path = model_path(app)?;
    let (session, provider) = create_session(&path)?;
    Ok(NativeEngine { session, provider })
}

#[cfg(target_os = "windows")]
fn create_rvm_engine(app: &tauri::AppHandle) -> Result<RvmEngine, String> {
    let path = rvm_model_path(app)?;
    if !path.exists() {
        return Err("RVM 모델이 아직 다운로드되지 않았습니다.".to_string());
    }

    let (session, provider) = create_session(&path)?;
    Ok(RvmEngine {
        session,
        provider,
        rec: vec![
            RecurrentState::initial(),
            RecurrentState::initial(),
            RecurrentState::initial(),
            RecurrentState::initial(),
        ],
        config: None,
    })
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

#[cfg(target_os = "windows")]
fn ensure_rvm_engine<'a>(
    app: &tauri::AppHandle,
    state: &'a tauri::State<'_, NativeState>,
) -> Result<std::sync::MutexGuard<'a, Option<RvmEngine>>, String> {
    let mut guard = state
        .rvm_engine
        .lock()
        .map_err(|_| "RVM Runtime 상태 잠금에 실패했습니다.".to_string())?;

    if guard.is_none() {
        *guard = Some(create_rvm_engine(app)?);
    }
    Ok(guard)
}

#[cfg(target_os = "windows")]
async fn ensure_rvm_model_downloaded(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let path = rvm_model_path(app)?;

    if path.exists() {
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("RVM 모델 정보를 읽지 못했습니다: {error}"))?;
        if metadata.len() == RVM_MODEL_BYTES {
            let bytes = std::fs::read(&path)
                .map_err(|error| format!("RVM 모델 검증을 위해 읽지 못했습니다: {error}"))?;
            let digest = format!("{:x}", Sha256::digest(&bytes));
            if digest == RVM_MODEL_SHA256 {
                return Ok(path);
            }
        }
        let _ = std::fs::remove_file(&path);
    }

    let parent = path
        .parent()
        .ok_or_else(|| "RVM 모델 저장 폴더를 만들 수 없습니다.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("RVM 모델 폴더를 만들지 못했습니다: {error}"))?;

    let response = reqwest::Client::builder()
        .user_agent("ParanRecorder-RVM-Local-Test/0.5")
        .build()
        .map_err(|error| format!("RVM 다운로드 클라이언트 준비 실패: {error}"))?
        .get(RVM_MODEL_URL)
        .send()
        .await
        .map_err(|error| format!("RVM 모델 다운로드 실패: {error}"))?
        .error_for_status()
        .map_err(|error| format!("RVM 모델 다운로드 HTTP 오류: {error}"))?;

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("RVM 모델 데이터 읽기 실패: {error}"))?;

    if bytes.len() as u64 != RVM_MODEL_BYTES {
        return Err(format!(
            "RVM 모델 크기가 예상과 다릅니다: {} / {}",
            bytes.len(),
            RVM_MODEL_BYTES
        ));
    }

    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != RVM_MODEL_SHA256 {
        return Err(format!("RVM 모델 SHA256 검증 실패: {digest}"));
    }

    let temp = path.with_extension("onnx.part");
    std::fs::write(&temp, &bytes)
        .map_err(|error| format!("RVM 임시 모델 저장 실패: {error}"))?;
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::rename(&temp, &path)
        .map_err(|error| format!("RVM 모델 저장 완료 처리 실패: {error}"))?;

    let notice = parent.join("RVM-LICENSE-NOTICE.txt");
    let notice_text = concat!(
        "Robust Video Matting (RVM) local personal test model\n\n",
        "Upstream: https://github.com/PeterL1n/RobustVideoMatting\n",
        "Release model: rvm_mobilenetv3_fp32.onnx v1.0.0\n",
        "Upstream license: GNU GPL v3.0\n",
        "This model was downloaded directly from the upstream GitHub release for local testing.\n"
    );
    let _ = std::fs::write(notice, notice_text);

    Ok(path)
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

#[tauri::command]
fn native_rvm_info(
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
) -> RvmRuntimeInfo {
    #[cfg(target_os = "windows")]
    {
        let downloaded = rvm_model_path(&app)
            .map(|path| path.exists())
            .unwrap_or(false);
        let provider = state
            .rvm_engine
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|engine| engine.provider.clone()))
            .unwrap_or_else(|| "선택 시 DirectML 초기화".to_string());

        RvmRuntimeInfo {
            available: true,
            downloaded,
            provider,
            model: RVM_MODEL_NAME.to_string(),
            message: if downloaded {
                "RVM 로컬 모델이 준비되어 있습니다.".to_string()
            } else {
                "처음 선택하면 공식 RVM 모델 약 15MB를 로컬에 다운로드합니다.".to_string()
            },
            input_width: RVM_INPUT_WIDTH,
            input_height: RVM_INPUT_HEIGHT,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        RvmRuntimeInfo {
            available: false,
            downloaded: false,
            provider: "Unsupported".to_string(),
            model: RVM_MODEL_NAME.to_string(),
            message: "현재 RVM Native 테스트는 Windows 전용입니다.".to_string(),
            input_width: RVM_INPUT_WIDTH,
            input_height: RVM_INPUT_HEIGHT,
        }
    }
}

#[tauri::command]
async fn native_rvm_prepare(app: tauri::AppHandle) -> RvmRuntimeInfo {
    #[cfg(target_os = "windows")]
    {
        if let Err(error) = ensure_rvm_model_downloaded(&app).await {
            return RvmRuntimeInfo {
                available: false,
                downloaded: false,
                provider: "Unavailable".to_string(),
                model: RVM_MODEL_NAME.to_string(),
                message: error,
                input_width: RVM_INPUT_WIDTH,
                input_height: RVM_INPUT_HEIGHT,
            };
        }

        let state = app.state::<NativeState>();
        let result = match ensure_rvm_engine(&app, &state) {
            Ok(guard) => {
                let provider = guard
                    .as_ref()
                    .map(|engine| engine.provider.clone())
                    .unwrap_or_else(|| "Unknown".to_string());
                RvmRuntimeInfo {
                    available: true,
                    downloaded: true,
                    provider,
                    model: RVM_MODEL_NAME.to_string(),
                    message: "RVM Native 준비 완료".to_string(),
                    input_width: RVM_INPUT_WIDTH,
                    input_height: RVM_INPUT_HEIGHT,
                }
            }
            Err(error) => RvmRuntimeInfo {
                available: false,
                downloaded: true,
                provider: "Unavailable".to_string(),
                model: RVM_MODEL_NAME.to_string(),
                message: error,
                input_width: RVM_INPUT_WIDTH,
                input_height: RVM_INPUT_HEIGHT,
            },
        };
        result
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        RvmRuntimeInfo {
            available: false,
            downloaded: false,
            provider: "Unsupported".to_string(),
            model: RVM_MODEL_NAME.to_string(),
            message: "현재 RVM Native 테스트는 Windows 전용입니다.".to_string(),
            input_width: RVM_INPUT_WIDTH,
            input_height: RVM_INPUT_HEIGHT,
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

fn request_float(request: &tauri::ipc::Request, name: &'static str) -> Result<f32, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("필수 헤더가 없습니다: {name}"))?
        .to_str()
        .map_err(|_| format!("헤더 형식이 잘못되었습니다: {name}"))?
        .parse::<f32>()
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

#[cfg(target_os = "windows")]
fn recurrent_tensor(state: &RecurrentState) -> Result<Tensor<f32>, String> {
    Tensor::from_array((state.shape.clone(), state.data.clone().into_boxed_slice()))
        .map_err(|error| format!("RVM recurrent tensor 생성 실패: {error}"))
}

#[cfg(target_os = "windows")]
fn recurrent_from_output(
    outputs: &ort::session::SessionOutputs<'_>,
    name: &str,
) -> Result<RecurrentState, String> {
    let (shape, values) = outputs[name]
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("RVM {name} 읽기 실패: {error}"))?;

    Ok(RecurrentState {
        shape: shape.to_vec(),
        data: values.to_vec(),
    })
}

#[tauri::command]
fn native_rvm_segment(
    request: tauri::ipc::Request,
    app: tauri::AppHandle,
    state: tauri::State<'_, NativeState>,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "windows")]
    {
        let width = request_dimension(&request, "x-width")?;
        let height = request_dimension(&request, "x-height")?;

        let supported_resolution = matches!(
            (width, height),
            (256, 144) | (224, 126) | (192, 108)
        );
        if !supported_resolution {
            return Err(format!("지원하지 않는 RVM 입력 해상도입니다: {}x{}", width, height));
        }

        let downsample_ratio = request_float(&request, "x-downsample-ratio")?;
        if !(0.50..=1.00).contains(&downsample_ratio) {
            return Err(format!(
                "RVM downsample ratio는 0.50~1.00이어야 합니다: {}",
                downsample_ratio
            ));
        }

        let tauri::ipc::InvokeBody::Raw(rgba) = request.body() else {
            return Err("RVM 영상 프레임은 raw binary로 전달해야 합니다.".to_string());
        };

        let plane = width * height;
        if rgba.len() != plane * 4 {
            return Err(format!(
                "RVM RGBA 프레임 크기가 올바르지 않습니다: {} / {}",
                rgba.len(),
                plane * 4
            ));
        }

        let mut input = vec![0.0_f32; plane * 3];
        for i in 0..plane {
            let p = i * 4;
            input[i] = rgba[p] as f32 / 255.0;
            input[plane + i] = rgba[p + 1] as f32 / 255.0;
            input[(plane * 2) + i] = rgba[p + 2] as f32 / 255.0;
        }

        let src = Tensor::from_array((
            [1usize, 3usize, height, width],
            input.into_boxed_slice(),
        ))
        .map_err(|error| format!("RVM src tensor 생성 실패: {error}"))?;

        let ratio = Tensor::from_array((
            [1usize],
            vec![downsample_ratio].into_boxed_slice(),
        ))
        .map_err(|error| format!("RVM downsample ratio tensor 생성 실패: {error}"))?;

        let mut guard = ensure_rvm_engine(&app, &state)?;
        let engine = guard
            .as_mut()
            .ok_or_else(|| "RVM Runtime 세션이 준비되지 않았습니다.".to_string())?;

        let config = (width, height, downsample_ratio.to_bits());
        if engine.config != Some(config) {
            engine.rec = vec![
                RecurrentState::initial(),
                RecurrentState::initial(),
                RecurrentState::initial(),
                RecurrentState::initial(),
            ];
            engine.config = Some(config);
        }

        let r1 = recurrent_tensor(&engine.rec[0])?;
        let r2 = recurrent_tensor(&engine.rec[1])?;
        let r3 = recurrent_tensor(&engine.rec[2])?;
        let r4 = recurrent_tensor(&engine.rec[3])?;

        let outputs = engine
            .session
            .run(ort::inputs![
                "src" => src,
                "r1i" => r1,
                "r2i" => r2,
                "r3i" => r3,
                "r4i" => r4,
                "downsample_ratio" => ratio
            ])
            .map_err(|error| format!("RVM ONNX 추론 실패: {error}"))?;

        let (_pha_shape, pha_values) = outputs["pha"]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("RVM alpha 출력 읽기 실패: {error}"))?;

        if pha_values.len() != plane {
            return Err(format!(
                "RVM alpha 크기가 예상과 다릅니다: {} / {}",
                pha_values.len(),
                plane
            ));
        }

        let next_rec = vec![
            recurrent_from_output(&outputs, "r1o")?,
            recurrent_from_output(&outputs, "r2o")?,
            recurrent_from_output(&outputs, "r3o")?,
            recurrent_from_output(&outputs, "r4o")?,
        ];

        let alpha: Vec<u8> = pha_values
            .iter()
            .map(|&value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
            .collect();

        drop(outputs);
        engine.rec = next_rec;

        return Ok(tauri::ipc::Response::new(alpha));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (request, app, state);
        Err("현재 RVM Native 테스트는 Windows 전용입니다.".to_string())
    }
}

#[tauri::command]
fn native_rvm_reset(state: tauri::State<'_, NativeState>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut guard = state
            .rvm_engine
            .lock()
            .map_err(|_| "RVM Runtime 상태 잠금에 실패했습니다.".to_string())?;
        if let Some(engine) = guard.as_mut() {
            engine.rec = vec![
                RecurrentState::initial(),
                RecurrentState::initial(),
                RecurrentState::initial(),
                RecurrentState::initial(),
            ];
            engine.config = None;
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(NativeState::default())
        .invoke_handler(tauri::generate_handler![
            native_runtime_info,
            native_segment,
            native_rvm_info,
            native_rvm_prepare,
            native_rvm_segment,
            native_rvm_reset
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paran Recorder");
}
