# DECISIONS

각 항목은 결정 / 근거 / 대안 / 되돌리는 방법 순서로 적는다.

## D-01 개발 환경: Windows에서 진행, 스크립트는 전부 Node
- **결정:** 이번 세션은 Windows 11 PC에서 진행했다. 빌드·검사·fixture 스크립트는 모두 Node(`.mjs`)로 쓰고 bash나 PowerShell에 의존하지 않는다. `.gitattributes`로 LF를 강제한다.
- **근거:** 지시문의 개발 기기는 Ubuntu 26.04 노트북이지만 세션이 Windows에서 열렸다. Node 스크립트는 양쪽에서 똑같이 돈다.
- **대안:** Ubuntu 전용 셸 스크립트.
- **되돌리기:** 해당 없음. Ubuntu에서도 `pnpm install && pnpm build`가 그대로 동작한다.

## D-02 저장소: 로컬 `C:\Users\denny\pdf-ppp`, git init만
- **결정:** `git init -b main`만 하고 원격은 설정하지 않았다. GitHub에 `dhwan0112/pdf-ppp`가 아직 없다.
- **근거:** 지시문이 "원격 설정은 남겨둘 것"이라고 했다. 저장소를 묻지 않고 새로 만들지 않는다는 기존 원칙도 있다.
- **되돌리기:** `gh repo create dhwan0112/pdf-ppp --private --source . --push`.

## D-03 pdfjs-dist 6.5.438, legacy 빌드
- **결정:** 최신 안정판을 정확한 버전으로 고정하고 legacy 빌드만 번들한다. modern 빌드 import는 esbuild 플러그인이 막는다.
- **근거:** INVESTIGATION 1절. modern 빌드는 Chromium 138이나 iPadOS WebKit이 보장하지 않는 JS 기능을 쓴다.
- **대안:** modern 빌드에 폴리필을 따로 넣기. 결국 legacy 빌드와 같은 결과다.
- **되돌리기:** `esbuild.config.mjs`의 `LEGACY_*` 경로를 `build/…`로 바꾼다. 워커 변환 규칙도 modern 소스에 맞춰야 한다.
- **부작용:** legacy 빌드의 core-js 폴리필은 해당 내장 기능이 **없을 때만** 전역 프로토타입에 추가한다. 실측 결과는 D-13.

## D-04 전역 접근은 빌드 시 변환으로 제거
- **결정:** `scripts/pdfjs-transform.mjs`가 pdfjs 전역 읽기·쓰기를 모두 지운다. 각 규칙의 일치 횟수가 다르면 빌드를 실패시킨다.
- **근거:** 코어 Obsidian이 `window.pdfjsLib`을 쓴다. 덮어쓰면 코어 PDF 뷰어가 우리 버전의 pdf.js를 쓰게 된다.
- **대안:** 런타임에 전역을 저장했다가 복원하기. 경쟁 상태가 생기고 지시문의 "전역을 읽거나 쓰지 않는다"에도 어긋난다.
- **되돌리기:** 되돌리면 안 된다. pdf.js를 올릴 때는 규칙의 정규식만 고친다.

## D-05 보조 데이터를 `main.js`에 gzip+base64로 임베드
- **결정:** 워커, CMap 전부, 표준 글꼴, openjpeg/jbig2 wasm을 넣는다. qcms, quickjs, nowasm 폴백, iccs는 뺀다.
- **근거:** INVESTIGATION 5절. 단일 파일 배포, iOS 동작, 네트워크 0건. 합계 3.31 MB로 5 MB 한도 아래다.
- **대안:** (a) 첫 실행 때 플러그인 폴더에 파일로 풀어 쓰기. iOS의 `app://` 경로 fetch 동작이 불확실하다. (b) CDN fetch. 네트워크 금지 원칙에 어긋난다.
- **되돌리기:** `esbuild.config.mjs`의 `ASSET_DIRS`에서 항목을 뺀다. 없는 데이터는 pdf.js가 시스템 글꼴 대체 등으로 처리한다.

## D-06 워커는 직접 생성해 `PDFWorker({port})`로 전달
- **결정:** pdf.js의 `workerSrc` 경로 대신 `new Worker(blobUrl, {type: "module"})`을 직접 만들고, `ready` 핸드셰이크를 확인한 뒤 넘긴다. 실패하면 pdf.js 기본 경로(결국 fake worker)로 내려간다.
- **근거:** INVESTIGATION 4절. pdf.js의 교차 출처 래퍼가 해제되지 않는 Blob URL을 만든다. 직접 만들면 종료 시점도 우리가 정한다.
- **되돌리기:** `createWorker()`에서 `GlobalWorkerOptions.workerSrc`만 두고 `new PDFWorker()`를 쓴다.

## D-07 워커 하나를 공유, 유휴 60초 후 종료
- **결정:** 모든 PDF+++ 뷰가 워커 하나를 공유한다. 참조가 0이 되면 60초 뒤 종료하고, 플러그인을 끄면 즉시 종료한다.
- **근거:** iPad 메모리. 워커마다 pdf.js 코드 사본(수 MB)이 든다. 탭 사이를 오갈 때마다 압축을 풀고 파싱하지 않도록 잠깐 살려 둔다.
- **대안:** 뷰를 닫는 즉시 종료(지시문 문구에 더 가까움).
- **되돌리기:** `src/pdfjs/index.ts`의 `IDLE_MS`를 0으로 둔다.

## D-08 사이드카 원자적 저장: tmp에 쓴 뒤 rename, 실패 시 삭제 후 rename
- **결정:** `<path>.tmp`에 쓰고 rename으로 덮어쓴다. 어댑터가 덮어쓰기를 거부하면 원본을 지우고 rename한다. 중단된 저장이 남긴 `.tmp`는 다음 로드 때 복구한다.
- **근거:** `vault.adapter`만 쓰는 조건에서 가장 원자적인 방법이다. 데스크톱의 `fs.rename`은 덮어쓰기를 지원하지만 iOS 어댑터는 확인이 필요하다.
- **되돌리기:** `SidecarStore.saveNow()`.

## D-09 하이라이트 렌더링은 SVG, PDF pt 단위 viewBox
- **결정:** 페이지마다 SVG 하나를 페이지 상자에 100%로 붙이고, viewBox를 PDF pt 단위(회전 반영)로 둔다. 줌이 바뀌어도 다시 계산하지 않고 회전이 바뀔 때만 다시 그린다.
- **근거:** 지시문의 "줌이 바뀌면 PDF 좌표에서 다시 배치만 하고 재계산하지 않는다"를 브라우저 레이아웃만으로 만족한다. 핀치 중 CSS 변환과도 자연스럽게 맞는다.
- **대안:** 절대 위치 div. 줌마다 다시 배치해야 한다.

## D-10 하이라이트 탭 판정은 좌표 계산으로
- **결정:** 하이라이트 레이어는 `pointer-events: none`이다. 컨테이너 click에서 PDF 좌표로 바꿔 사각형 포함 여부를 검사한다.
- **근거:** 하이라이트는 텍스트 레이어 **아래**에 있어야 텍스트 선택이 계속 동작한다. 그러면 이벤트를 직접 받을 수 없다.

## D-11 선택 → 팔레트: 선택을 캐시
- **결정:** `selectionchange`(220 ms 디바운스) 때 선택 범위를 페이지별 사각형과 텍스트로 미리 계산해 둔다. 팔레트 버튼은 그 캐시를 쓴다.
- **근거:** iOS에서는 버튼을 탭하는 순간 선택이 사라질 수 있다.

## D-12 매니페스트
- **결정:** id `pdf-ppp`, 이름 `PDF+++`(가칭), author `Denny Kim`, authorUrl `https://github.com/dhwan0112`, `minAppVersion` 1.5.0, `isDesktopOnly: false`. LICENSE 저작권자와 git 작성자는 Kim Donghwan이다.
- **근거:** 기존 플러그인(Wikiwurzel 등)과 같은 표기. 쓰는 API(`FileView`, `Scope`, `Platform`, `setIcon`)는 1.5 이전부터 공개되어 있다.

## D-13 (조사 후 채움) core-js 폴리필 흔적
아래 "실측" 절 참고.

## D-14 테스트 도구
- vitest 5.1, TypeScript 5.9.3(타입 검사; TS 7은 JS API가 없어 도구 연동이 불안정), postcss 8(CSS 스코핑), pdf-lib 1.17.1 + @pdf-lib/fontkit(fixture 생성, 개발 의존성만). 런타임 의존성은 `pdfjs-dist` 하나다.

## D-15 Obsidian Sync와 `.json` 사이드카
- **결정:** 사이드카 이름은 지시문대로 `<이름>.pdf.ppp.json`을 유지한다.
- **주의:** Obsidian Sync는 기본 설정에서 "기타 파일 형식"을 동기화하지 않는다. Obsidian Sync를 쓰면 *Settings → Sync → Sync all other types*를 켜야 사이드카가 기기 사이에 오간다. iCloud와 Git은 상관없다. REPORT의 열린 질문에 올렸다.
- **대안:** `.md` 확장자 사이드카. 항상 동기화되지만 노트 목록·검색·그래프에 보인다.
