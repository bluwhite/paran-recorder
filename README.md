# Paran Recorder

강의용 화면 녹화 프로그램입니다. **웹 우선(Web-first)** 구조를 유지하면서, Windows 데스크톱에서는 Tauri 2 + ONNX Runtime Native를 선택적으로 사용할 수 있습니다.

## 현재 구조

- 평소 개발: 브라우저에서 `npm run dev`
- 웹 배경 제거: MediaPipe
- Windows 네이티브 배경 제거: ONNX Runtime Native + MODNet
- 네이티브 실행에서도 같은 `src/` UI와 녹화 화면을 사용
- 웹에서는 ONNX Native 선택지가 숨겨지고 MediaPipe만 표시
- Tauri Windows에서는 런타임 확인에 성공하면 `ONNX Runtime Native · MODNet` 선택지가 나타남

## 주요 기능

- 화면/창/탭 녹화
- 카메라 오버레이와 마이크 녹음
- 시스템 오디오 공유 지원(브라우저/OS가 제공하는 범위)
- 카메라 위치·크기·모양 변경
- 장면 프리셋: 화면만 / 작은 얼굴 / 큰 얼굴 / 얼굴만
- 단축키: F1~F4 장면 전환, M 녹화 마커, Ctrl+1~4 카메라 위치
- 실시간 마이크 레벨 미터
- AI 사람 분할 기반 카메라 배경 처리
  - 그대로
  - 다른 이미지로 교체
  - 배경 흐림
  - 배경 제거
- MediaPipe 사용자 튜닝
  - 균형 / 빠른 움직임 / 경계 우선
  - 움직임 추종 / 경계 정리 / 머리·안경 보존
- WebM 녹화
- 녹화 마커를 `.markers.json`으로 저장

## 웹 개발

처음 한 번:

```bash
npm install
```

평소 개발:

```bash
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다.

웹 개발에는 Rust, Tauri, ONNX 모델이 필요하지 않습니다.

프로덕션 웹 빌드:

```bash
npm run build:web
```

GitHub Pages 테스트판:

https://bluwhite.github.io/paran-recorder/

## Windows 네이티브 개발

Windows에서 Rust/Tauri 개발 환경이 설치되어 있다면:

```bash
npm run tauri:dev
```

처음 실행할 때 MODNet ONNX 모델(약 25.9 MB)을 자동으로 내려받아 SHA256을 확인합니다. 이후에는 이미 받은 파일을 재사용합니다. Tauri 개발 창은 GitHub Pages가 아니라 **로컬 Vite 개발 서버**를 사용하므로 웹 UI 수정도 바로 반영됩니다.

설치 없이 로컬 실행 바이너리만 빌드:

```bash
npm run tauri:exe
```

NSIS 설치 파일 빌드:

```bash
npm run tauri:build
```

## GitHub Actions Windows 테스트 빌드

`.github/workflows/native-windows.yml`은 네이티브 관련 코드가 main에 올라오면 Windows에서 자동으로 빌드합니다.

생성되는 산출물:

- `Paran-Recorder-Native-Test`
  - 설치하지 않고 압축을 풀어 `ParanRecorder.exe`를 실행하는 테스트판
  - MODNet 모델과 필요한 ONNX Runtime/DirectML DLL을 함께 포함
- `Paran-Recorder-Native-Installer`
  - NSIS 설치 EXE

우선 테스트판에서 `MediaPipe`와 `ONNX Runtime Native`를 같은 카메라로 비교한 뒤, 네이티브 방식이 충분히 좋으면 이 구조를 유지하면서 영상 처리·인코딩을 점차 네이티브 쪽으로 확장합니다.

## Native AI

현재 Windows 프로토타입은 Rust의 `ort` crate를 통해 ONNX Runtime을 사용하며 DirectML을 먼저 시도하고, 초기화에 실패하면 CPU로 폴백합니다. 프런트엔드와 Rust 사이에는 JSON 픽셀 배열 대신 Tauri raw binary IPC를 사용합니다.

MODNet 코드와 모델은 Apache License 2.0으로 공개되어 있습니다.

## 보존된 Electron 프로토타입

초기 Electron v0.1 코드는 `electron-prototype-v0.1` 브랜치에 보존되어 있습니다.
