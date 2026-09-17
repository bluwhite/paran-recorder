# Paran Recorder

강의용 화면 녹화 프로그램입니다. 개발 중에는 브라우저에서 바로 테스트하고, 완성 단계에서는 같은 웹 프론트엔드를 Tauri 2로 패키징하는 구조입니다.

## 현재 기능 (v0.3)

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
- 사용자 배경 이미지는 서버에 업로드하지 않고 로컬 브라우저에서 합성
- 녹화 마커를 `.markers.json`으로 함께 저장
- WebM 녹화
- 지원 브라우저에서는 File System Access API로 녹화 데이터를 파일에 직접 기록

AI 배경 처리는 MediaPipe Tasks Vision의 Selfie Segmenter를 사용합니다. 모델과 WASM 런타임은 최초 사용 시 네트워크에서 불러오며, 영상 프레임 자체는 로컬에서 처리합니다.

## 웹 개발

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173`을 엽니다.

프로덕션 웹 빌드:

```bash
npm run build:web
```

GitHub Pages 웹 테스트판:

https://bluwhite.github.io/paran-recorder/

## Tauri 개발

Rust와 Tauri 개발 의존성이 설치된 환경에서:

```bash
npm install
npm run tauri:dev
```

설치 파일 빌드:

```bash
npm run tauri:build
```

`src/`의 웹 UI와 영상 합성 로직을 그대로 사용하고, 추후 OS별 화면 캡처·시스템 오디오·파일 저장 기능만 Tauri/네이티브 계층으로 보강합니다.

## 보존된 Electron 프로토타입

초기 Electron v0.1 코드는 `electron-prototype-v0.1` 브랜치에 보존되어 있습니다.

## 다음 단계

- AI 배경 경계 품질·성능 튜닝
- 배경 이미지 프리셋/최근 사용 설정 저장
- MP4 출력 경로
- 녹화 후 간단 편집(마커 이동, 앞뒤 자르기, 실수 구간 삭제)
- 자막/무음 탐지
- Android/iOS용 네이티브 캡처 계층 검토
