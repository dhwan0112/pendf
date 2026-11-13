# INVESTIGATION — PDF.js 번들 조사

조사일 2026-11-13. 대상 `pdfjs-dist@6.5.438`(2026-11-01 릴리스, npm 최신 안정판).
측정 환경: Windows 11 개발 PC, Obsidian 1.15.1(Electron 37.10.2, Chromium 138.0.7204.251).
지시문은 Ubuntu 26.04 개발 기기를 전제하지만 이번 세션은 Windows에서 진행했다(DECISIONS D-01).

## 1. 버전 선택

| 후보 | 결과 |
| --- | --- |
| 6.5.438 (latest) | 채택. 정확한 버전으로 고정(`"pdfjs-dist": "6.5.438"`) |
| 5.x | 6.x와 API 차이는 작지만 보안·렌더링 수정이 늦음. 이유 없이 구버전을 고를 근거 없음 |

**modern 빌드 vs legacy 빌드.** `build/pdf.mjs`(modern)는 다음 최신 기능을 폴리필 없이 직접 쓴다.

| 기능 | modern `pdf.mjs` | modern worker | modern `pdf_viewer.mjs` |
| --- | --- | --- | --- |
| `Map/WeakMap#getOrInsertComputed` | 22곳 | 19곳 | 9곳 |
| `Math.sumPrecise` | 1 | 17 | – |
| `RegExp.escape` | – | – | 2 |
| `Promise.try`, `Iterator.prototype` 헬퍼, `Float16Array`, `Uint8Array#toHex/fromBase64` | 사용 | 사용 | – |

Obsidian 데스크톱의 Chromium 138과 iPadOS WebKit이 이것을 모두 지원한다고 보장할 수 없다. `getOrInsertComputed`는 2026년 기준으로도 최신 제안이다. 그래서 core-js 폴리필이 들어 있는 **legacy 빌드**(`legacy/build/pdf.mjs`, `legacy/web/pdf_viewer.mjs`, `legacy/build/pdf.worker.min.mjs`)를 쓴다. 크기 차이는 min 기준 474 KB와 538 KB(main), 1.27 MB와 1.33 MB(worker)로 작다.

## 2. 전역 변수 접근

| 위치 | 접근 | 결과 |
| --- | --- | --- |
| `legacy/build/pdf.mjs` 35672행 | **쓰기** `globalThis.pdfjsLib = {…}` | 코어 Obsidian의 `window.pdfjsLib`을 덮어쓴다. 반드시 제거해야 함 |
| `legacy/build/pdf.mjs` 35668행 | 쓰기 `globalThis._pdfjsTestingUtils` | 제거 |
| `legacy/build/pdf.mjs` 23578행 | 읽기 `globalThis.pdfjsWorker?.WorkerMessageHandler` (fake worker 지름길) | 코어 또는 다른 플러그인의 워커를 집어 올 수 있다. `null`로 치환 |
| `legacy/web/pdf_viewer.mjs` 4885행 | **읽기** `const {…} = globalThis.pdfjsLib;` (표시 계층 전체가 이 전역에 의존) | 번들 내부 모듈 import로 치환 |
| `legacy/web/pdf_viewer.mjs` 14849행 | 쓰기 `globalThis.pdfjsViewer = {…}` | 제거 |
| `legacy/build/pdf.worker.min.mjs` 끝 | 쓰기 `globalThis.pdfjsWorker={WorkerMessageHandler}` | 워커 안에서는 무해하지만, 메인 스레드 폴백 시 `window`에 쓰게 되므로 제거 |
| `pdf.mjs` 14253–14266행 | `globalThis.DOMMatrix/Path2D/navigator` 쓰기 | Node.js 분기에서만 실행(`isNodeJS`). Electron 렌더러에서는 `process.type === "renderer"`라 실행되지 않음 |

구현: `scripts/pdfjs-transform.mjs`. esbuild `onLoad` 단계에서 정규식으로 치환하고, 각 규칙이 **정확히 기대한 횟수만큼** 맞지 않으면 빌드를 실패시킨다. pdf.js를 올렸을 때 소스 모양이 바뀌면 조용히 새는 번들이 나가지 않고 빌드가 깨진다. `scripts/check-standalone.mjs`가 빌드된 `main.js`와 변환된 워커 소스에서 `pdfjsLib`·`pdfjsViewer`·`pdfjsWorker`·`loadPdfJs`가 0건인지 다시 검사한다.

`pdf_viewer.mjs`는 버전 일치를 검사한다(`The API version … does not match the Viewer version`). 두 파일을 같은 패키지에서 가져오므로 문제없다.

## 3. CJS 번들링

- 최상위 `await`: 없음.
- `import.meta.url`: `pdf.mjs`의 Node 분기(`createRequire`) 한 곳뿐이다. CJS 출력에서는 빈 객체가 되지만 Electron 렌더러와 iOS에서는 실행되지 않는다. esbuild 경고 `empty-import-meta`는 끔.
- 워커 안의 `import.meta.url`(emscripten 로더)은 워커가 Blob URL 모듈로 로드되므로 그대로 둔다. wasm은 아래 4절처럼 메인 스레드에서 바이트로 받는다.
- 동적 `import(workerSrc)`: fake worker(메인 스레드 폴백) 경로에서만 쓰인다. esbuild는 비리터럴 인자의 `import()`를 그대로 둔다.

## 4. 워커

- 워커 소스(변환 후 1.33 MB)를 gzip(-9)+base64로 `main.js`에 넣는다. 임베드 크기는 0.53 MB.
- 실행 시 `DecompressionStream("gzip")`으로 풀고 `Blob` → `URL.createObjectURL` → `new Worker(url, {type: "module"})`.
- pdf.js가 직접 워커를 만들게 두지 않는다. pdf.js의 `getWorkerSrc()`는 Blob URL이 문서와 동일 출처가 아니라고 판단해(`app://obsidian.md`, iOS `capacitor://localhost` 모두 origin이 `null`) `await import("blob:…")` 래퍼 Blob을 하나 더 만들고 해제하지 않는다. 그래서 워커를 직접 만들고, `ready` 핸드셰이크(15초 제한)를 확인한 뒤 `new PDFWorker({port: worker})`로 넘긴다.
- **iOS 실패 시 대안:** 핸드셰이크가 오류나 시간 초과로 끝나면 `new PDFWorker()`(포트 없음)로 다시 만든다. pdf.js는 같은 Blob URL로 `Worker` 생성을 다시 시도하고, 실패하면 fake worker(메인 스레드에서 `import(blobUrl)`)로 내려간다. 렌더링은 되지만 파싱이 UI 스레드를 막는다. iOS WebKit은 15부터 module worker를, 16.4부터 `DecompressionStream`을 지원하므로 iPadOS 26.2에서는 1차 경로가 동작할 것으로 예상한다(실기기 확인 대기, DEVICE_CHECKLIST).
- 수명: 열린 뷰 수로 참조를 센다. 마지막 뷰가 닫히면 60초 뒤 종료하고(DECISIONS D-07), 플러그인 unload 시에는 즉시 `terminate()`와 `URL.revokeObjectURL()`을 호출한다.

## 5. 보조 데이터(CMap, 표준 글꼴, wasm)

pdf.js 6.x는 이 데이터를 URL로 fetch한다. BRAT·커뮤니티 설치는 `main.js`, `manifest.json`, `styles.css`만 배포하므로 URL로 둘 수 없다. 대신 pdf.js가 `BinaryDataFactory` API 옵션을 받는다(`src.BinaryDataFactory`). `useWorkerFetch: false`로 두면 워커가 `FetchBinaryData` 메시지로 메인 스레드에 요청하고, 메인 스레드의 팩토리가 `{kind, filename}`에 응답한다. 우리 팩토리(`EmbeddedBinaryDataFactory`)는 `main.js` 안의 gzip+base64 데이터를 풀어 돌려준다. 네트워크 요청은 0건이다.

| 데이터 | 원본 | gzip | 임베드(base64) | 필요성 | 결정 |
| --- | --- | --- | --- | --- | --- |
| CMaps `*.bcmap` (169개) | 1.17 MB | 0.88 MB(합본) | 1.31 MB(파일별) | 글꼴이 임베드되지 않은 CJK PDF(예: `UniKS-UCS2-H` + `HYSMyeongJo-Medium`)는 CMap 없이는 글자를 표시할 수 없다. `fixtures/korean-cmap.pdf`로 확인함 | 전부 포함 |
| 표준 글꼴(Foxit `.pfb`, Liberation `.ttf`) | 0.77 MB | 0.54 MB | 0.72 MB | 글꼴을 임베드하지 않은 Helvetica/Times PDF(오래된 논문에 많음). 없으면 시스템 글꼴로 대체되어 폭과 모양이 달라진다 | 포함 |
| `openjpeg.wasm` | 216 KB | 70 KB | 94 KB | JPX(JPEG2000) 이미지(스캔 PDF) | 포함 |
| `jbig2.wasm` | 101 KB | 41 KB | 55 KB | JBIG2 흑백 스캔 PDF(도서관 스캔본에 흔함) | 포함 |
| `*_nowasm_fallback.js` | 132 + 338 KB | – | – | wasm이 없는 환경용 | 제외(웹뷰는 wasm 지원) |
| `qcms_bg.wasm` | 97 KB | 35 KB | – | ICC 색 변환. pdf.js는 `useWorkerFetch: false`이면 qcms를 쓰지 않고 JS 변환으로 대체한다 | 제외 |
| `quickjs-eval.wasm` | 469 KB | – | – | PDF 내장 JavaScript 실행 | 제외(`isEvalSupported: false`, 스크립팅 미사용) |
| `iccs/` | 20 KB | – | – | CMYK 출력 프로파일(qcms 전용) | 제외 |

CMap을 하나의 gzip 묶음으로 넣으면 약 0.15 MB 줄일 수 있다. 다만 첫 사용 시 전체를 풀어야 하므로 지금은 파일별로 둔다.

## 6. 뷰어 CSS

`legacy/web/pdf_viewer.css`(168 KB)는 `:root` 변수와 `.pdfViewer`, `.page`, `.textLayer`, `.annotationLayer` 같은 전역 셀렉터를 쓴다. 코어 Obsidian PDF 뷰어도 같은 클래스 이름을 쓰므로 그대로 넣으면 코어 뷰어의 모양이 바뀐다. `scripts/scope-css.mjs`(postcss)가 할 일은 셋이다.

- 모든 셀렉터 앞에 `.pdf-ppp-root `를 붙이고, `:root`/`html`/`body`는 `.pdf-ppp-root`로 바꾼다. `@keyframes` 안은 건드리지 않는다.
- `url(images/…)` 선언(편집기·툴바 아이콘 33종)을 지운다. 플러그인 폴더에 이미지가 없고 우리는 그 위젯을 그리지 않는다.
- 라이선스 주석 외의 주석은 지운다.

결과 `styles.css`는 180 KB이다. 반대 방향, 즉 Obsidian 코어 CSS가 우리 뷰 안으로 새는지는 9절에서 따로 확인한다.

## 7. 빌드 크기

`pnpm build`마다 `build-size.json`에 기록하고, 5 MB 이상이면 빌드를 실패시킨다.

| 항목 | 크기 |
| --- | --- |
| `main.js` | **3.31 MB** (3,471,050 B) |
| 그 중 워커 | 0.53 MB |
| 그 중 CMaps | 1.31 MB |
| 그 중 표준 글꼴 | 0.72 MB |
| 그 중 wasm | 0.15 MB |
| `styles.css` | 180 KB |

목표 5 MB(Obsidian Sync Standard 파일 크기 한도) 미만을 만족한다.

## 8. 기타 확인 사항

- `PDFViewer`는 컨테이너가 `position: absolute`가 아니면 예외를 던진다. `.ppp-container { position: absolute; inset: 0 }`로 둔다.
- 기본 `GenericL10n()`을 언어 인자 없이 만들면 내장 영어 번들을 쓰고 fetch하지 않는다(`#generateBundlesFallback`).
- `annotationEditorMode: AnnotationEditorType.DISABLE`(-1)로 두면 pdf.js 편집기 UI 관리자를 만들지 않는다. 우리 주석과 겹치지 않고 메모리도 아낀다.
- pdf.js는 페이지를 reset할 때(줌, 회전, 재렌더) 모르는 자식 노드를 지운다(`PDFPageView.reset`, `LAYERS_ORDER`). 우리 레이어는 `pagerendered`·`textlayerrendered`·`scalechanging` 때 다시 붙인다(`src/layers`).
- 렌더링 루프는 `requestAnimationFrame`을 쓴다. Obsidian 창이 가려져 있으면 rAF가 멈춰 렌더링이 진행되지 않는다. 플러그인 버그가 아니며, 자동 검증 하네스는 테스트하는 동안에만 rAF를 `setTimeout`으로 바꾼다.
- pdf.js 6의 핀치 줌 처리는 뷰어 앱(`app.js`)에 있고 `PDFViewer`에는 없다. 공개 export인 `TouchManager`로 같은 동작을 구현했다.
