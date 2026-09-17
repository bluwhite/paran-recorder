# Paran Recorder

강의용 화면 녹화 프로그램의 첫 번째 프로토타입입니다. Electron 기반으로 화면, 웹캠 얼굴, 마이크를 하나의 영상으로 합성해 저장합니다.

## v0.1 기능

- 전체 화면 또는 개별 창 선택
- 웹캠 오버레이
- 얼굴 위치 4곳 선택 및 크기 조절
- 웹캠 좌우 반전
- 마이크 녹음
- Windows에서 시스템 오디오 + 마이크 믹싱
- 녹화 중 데이터를 1초 단위로 파일에 기록하여 긴 강의에서도 메모리 사용량을 억제
- WebM(VP9/VP8 + Opus) 저장
- Windows NSIS 설치 파일 / macOS DMG 빌드 설정

> AI 배경 제거는 v0.2에서 추가할 예정입니다.

## 개발 환경에서 실행

Node.js와 npm이 설치되어 있어야 합니다.

```bash
npm install
npm start
```

앱이 처음 실행될 때 카메라와 마이크 권한을 요청할 수 있습니다.

## 설치 파일 만들기

Windows:

```bash
npm install
npm run dist:win
```

macOS:

```bash
npm install
npm run dist:mac
```

결과물은 `dist/` 폴더에 생성됩니다.

## GitHub Actions

`.github/workflows/build.yml`은 Windows와 macOS에서 자동 빌드를 수행하고 설치 파일을 Actions artifact로 올립니다. 현재 macOS 빌드는 서명/공증이 없는 개발용 빌드입니다. 공개 배포 단계에서는 Apple Developer 인증서와 notarization 설정을 추가해야 합니다.

## 다음 단계

1. AI 사람 분할을 이용한 카메라 배경 제거/흐림
2. MP4 자동 변환 또는 MP4 직접 저장 경로
3. 녹화 중 마커
4. 카메라 모양(원형/둥근 사각형) 선택
5. 오디오 레벨 미터 및 입력 테스트
6. 단축키로 얼굴 표시/위치 전환
