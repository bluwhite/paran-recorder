# Paran Recorder

강의용 화면 녹화 프로그램입니다. 개발 단계에서는 **웹 애플리케이션으로 빠르게 테스트**하고, 완성 단계에서는 같은 프론트엔드를 **Tauri 2**로 패키징해 Windows/macOS 및 이후 모바일 플랫폼으로 확장하는 구조를 사용합니다.

## 현재 기능

- 브라우저의 화면/창/탭 공유 선택
- 웹캠 오버레이
- 얼굴 위치 4곳 선택 및 크기 조절
- 웹캠 좌우 반전
- 마이크 녹음
- 공유 화면이 제공하는 시스템 오디오 + 마이크 믹싱
- WebM(VP9/VP8 + Opus) 저장
- Chrome/Edge에서 가능한 경우 File System Access API를 이용해 녹화 데이터를 파일에 직접 기록
- 지원되지 않는 환경에서는 녹화 종료 후 WebM 다운로드

> AI 배경 제거는 다음 개발 단계에서 추가합니다.

## 가장 빠른 테스트 방법

웹 개발 서버를 사용합니다.

```bash
npm install
npm run dev
```

그 뒤 Chrome 또는 Edge에서 `http://localhost:5173`을 엽니다. Vite를 사용하기 때문에 코드를 수정하면 브라우저에서 빠르게 확인할 수 있습니다.

## GitHub Pages 웹 테스트

`.github/workflows/web.yml`은 `main`이 변경될 때 웹판을 빌드해 GitHub Pages로 배포하도록 설정되어 있습니다.

처음 한 번 GitHub 저장소에서 **Settings → Pages → Build and deployment → Source → GitHub Actions**를 선택해야 할 수 있습니다.

활성화되면 웹 테스트 주소는 다음 형태입니다.

`https://bluwhite.github.io/paran-recorder/`

화면 캡처, 카메라, 마이크 기능은 HTTPS 또는 localhost 환경에서 테스트하는 것이 안전합니다.

## Tauri 개발 모드

Rust와 Tauri 개발 환경이 준비된 PC에서는 같은 웹 코드를 Tauri 창에서 실행할 수 있습니다.

```bash
npm install
npm run tauri:dev
```

Tauri는 Vite 개발 서버(`http://localhost:5173`)를 자동으로 사용합니다.

## 설치 파일 만들기

완성 단계에서는 다음 명령으로 Tauri 앱을 빌드합니다.

```bash
npm run tauri:build
```

GitHub Actions의 `Build Tauri Installers` 워크플로는 자동으로 매번 실행되지 않으며, 필요할 때 **Run workflow**로 수동 실행하도록 설정했습니다.

- Windows: NSIS `.exe`
- macOS: `.dmg`

macOS 공개 배포 단계에서는 Apple 코드 서명과 notarization 설정을 추가해야 합니다.

## 프로젝트 구조

```text
src/                 공통 웹 UI 및 녹화 로직
src-tauri/           Tauri 데스크톱/모바일 앱 껍데기
vite.config.js       웹 개발 서버와 빌드 설정
.github/workflows/
  web.yml            웹판 GitHub Pages 배포
  build.yml          수동 Tauri 설치 파일 빌드
```

이전 Electron v0.1 프로토타입은 `electron-prototype-v0.1` 브랜치에 보존되어 있습니다.

## 다음 단계

1. AI 사람 분할을 이용한 카메라 배경 제거/흐림
2. 오디오 레벨 미터와 입력 테스트
3. 녹화 중 마커
4. 단축키로 얼굴 표시/위치 전환
5. MP4 저장 전략 검토
6. Tauri 네이티브 저장/권한 계층 연결
