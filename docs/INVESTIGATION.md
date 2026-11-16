# INVESTIGATION — PDF.js 번들 조사

조사일 2026-11-13. 대상 `pdfjs-dist@6.5.438`(2026-11-01 릴리스, npm 최신 안정판).
측정 환경: Windows 11 개발 PC, Obsidian 1.15.1(Electron 37.10.2, Chromium 138.0.7204.251). 같은 창에서 코어 PDF 뷰어는 pdf.js 5.3.34를 쓴다.
지시문은 Ubuntu 26.04 개발 기기를 전제하지만 이번 세션은 Windows에서 진행했다(DECISIONS D-01).

## 1. 버전과 빌드 선택

| 후보 | 결과 |
| --- | --- |
| 6.5.438 (latest) | 채택. 정확한 버전으로 고정(`"pdfjs-dist": "6.5.438"`) |
| 5.x | 5.4 modern 빌드도 `Math.sumPrecise`, `RegExp.escape`, Uint8Array base64/hex를 쓴다. 5.7부터는 `getOrInsertComputed`도 쓴다. 버전을 낮춰도 아래 문제는 사라지지 않아 구버전을 고를 근거가 없다 |

**modern 빌드는 최신 내장 기능을 폴리필 없이 직접 쓴다.**

| 기능 | Chromium 138(Obsidian 데스크톱) | modern 빌드 사용처 |
| --- | --- | --- |
| `Map/WeakMap#getOrInsert(Computed)` | 없음 | pdf.mjs 22, viewer 9, worker 19 |
| `Math.sumPrecise` | 없음 | pdf.mjs 1, worker 17 |
| `Uint8Array#toBase64/toHex`, `Uint8Array.fromBase64` | 없음 | pdf.mjs 3, worker 3 |
| `Promise.try`, `RegExp.escape`, `URL.parse` | 있음 | 각 4·2·13 |
| Iterator 헬퍼, `Set#intersection`, `Promise.withResolvers`, `AbortSignal.any` | 있음 | 여러 곳 |

Chromium 138에 무엇이 없는지는 기억이 아니라, Obsidian 안의 깨끗한 iframe realm에서 legacy 빌드를 실행하고 무엇이 추가되는지를 보고 확인했다(10절).

**legacy 빌드를 쓰지 않은 이유(10절 실측).** legacy 빌드는 core-js 폴리필을 품고 있다. 이 폴리필은 모든 플러그인이 함께 쓰는 Obsidian 창의 내장 객체를 고친다. 기능을 **추가**하고, Chromium 138에서는 네이티브 구현까지 **교체**한다. 스탠드얼론 원칙의 "다른 플러그인과 접점 없음"에 어긋나고, 플러그인을 꺼도 되돌아가지 않는다. pdf.js modern 빌드 자체에도 전역 폴리필이 한 군데 있다(`Iterator.prototype.join`).

**채택: modern 빌드 + 빌드 시 호출 지점 치환(ponyfill).** `scripts/pdfjs-ponyfill.mjs`가 acorn AST로 해당 호출 지점을 모듈 지역 함수 호출로 바꾼다. 예를 들어 `m.getOrInsertComputed(k, f)`는 `__pendf_getOrInsertComputed(m, k, f)`가 된다. 이 함수는 네이티브 메서드가 있으면 그것을 부르고, 없으면 지역 구현을 쓴다. 전역은 하나도 건드리지 않는다.

| 치환 대상 | pdf.mjs | pdf_viewer.mjs | worker |
| --- | --- | --- | --- |
| `.getOrInsertComputed()` / `.getOrInsert()` | 22 / 0 | 8 / 1 | 18 / 1 |
| `Math.sumPrecise` | 1 | – | 17 |
| `.toBase64()` / `.toHex()` / `Uint8Array.fromBase64` | 2 / 0 / 1 | – | 0 / 2 / 1 |
| `Promise.try` / `RegExp.escape` / `URL.parse` | 4 / 0 / 8 | 0 / 2 / 2 | 4 / 0 / 3 |
| `.join()` (`Iterator.prototype.join` 폴리필 제거 대가) | 39 | 15 | 73 |

- 처리할 수 없는 모양은 빌드를 실패시킨다: 계산된 접근, 메서드를 값으로 쓰는 경우(`.join` 데이터 속성 제외), 복잡한 수신자의 옵셔널 호출, 호출 뒤에도 이어지는 옵셔널 체인.
- 치환 뒤 AST를 다시 훑어, 대상 이름에 대한 접근이나 내장 객체 대입이 남아 있으면 빌드를 실패시킨다(`assertNoTargets`).
- 괄호로 감싼 수신자(`(cache ??= new Map()).getOrInsertComputed(…)`)는 acorn 노드 범위에 괄호가 빠지므로, 수신자 범위를 괄호까지 넓혀 치환한다.
- 나머지 네이티브 의존(Iterator 헬퍼, `Set#intersection`, `Promise.withResolvers`, `AbortSignal.any`, `structuredClone`, `DecompressionStream`, `Worker`, `Path2D`, `DOMMatrix`)은 플러그인 로드 시 `src/pdfjs/engine.ts`가 검사한다. 빠진 기능은 로그와 뷰 상단 배너로 알린다. iPadOS 26.2 WebKit에는 모두 있을 것으로 예상하며, DEVICE_CHECKLIST 0-1에서 확인한다.

## 2. 전역 변수 접근

| 위치(modern) | 접근 | 처리 |
| --- | --- | --- |
| `build/pdf.mjs` 끝 | **쓰기** `globalThis.pdfjsLib = {…}` | 제거. 남겨 두면 코어 Obsidian의 `window.pdfjsLib`을 덮어쓴다 |
| `build/pdf.mjs` | 쓰기 `globalThis._pdfjsTestingUtils` | 제거 |
| `build/pdf.mjs` `PDFWorker` | 읽기 `globalThis.pdfjsWorker?.WorkerMessageHandler`(fake worker 지름길) | `null`로 치환. 다른 플러그인의 워커를 집어 올 수 있기 때문 |
| `web/pdf_viewer.mjs` 머리 | **읽기** `const {…} = globalThis.pdfjsLib;`(표시 계층 전체가 이 전역에 의존) | 번들 내부 모듈 import(`import * as __pendfPdfjs from "pdfjs-dist/build/pdf.mjs"`)로 치환 |
| `web/pdf_viewer.mjs` 끝 | 쓰기 `globalThis.pdfjsViewer = {…}` | 제거 |
| `build/pdf.worker.mjs` 끝 | 쓰기 `globalThis.pdfjsWorker = {…}` | 제거. 메인 스레드 폴백에서는 이 코드가 `window`에서 돈다 |
| `build/pdf.mjs`·worker | 쓰기 `Iterator.prototype.join = …`(없을 때만) | 제거하고 `.join()` 호출을 `__pendf_join`으로 치환 |
| `build/pdf.mjs` Node 분기 | `globalThis.DOMMatrix/Path2D/navigator` 쓰기 | `isNodeJS`일 때만 실행된다. Electron 렌더러(`process.type === "renderer"`)와 iOS에서는 실행되지 않음 |

구현은 `scripts/pdfjs-transform.mjs`다. esbuild `onLoad` 단계에서 치환하고, 각 규칙이 **정확히 기대한 횟수만큼** 맞지 않으면 빌드를 실패시킨다. pdf.js를 올려 소스 모양이 바뀌면 조용히 새는 번들이 나가지 않고 빌드가 깨진다. `scripts/check-standalone.mjs`는 빌드된 `main.js`와 그 안에 gzip으로 들어간 워커 소스를 풀어 다음이 0건인지 다시 검사한다: `pdfjsLib`·`pdfjsViewer`·`pdfjsWorker`·`loadPdfJs`·`core-js`·내장 객체 대입.

## 3. CJS 번들링

- 최상위 `await`: 없음.
- `import.meta.url`: `pdf.mjs`의 Node 분기 한 곳뿐이다. CJS 출력에서는 빈 객체가 되지만 실행되지 않으므로 esbuild 경고(`empty-import-meta`)를 끈다.
- 동적 `import(workerSrc)`: fake worker(메인 스레드 폴백) 경로 전용이다. esbuild는 리터럴이 아닌 인자의 `import()`를 그대로 둔다.
- 대상 문법 `es2022`. 워커는 별도로 `esbuild.transformSync`(minify, ESM)를 거치고, 경고가 하나라도 나오면 빌드를 실패시킨다.

## 4. 워커

- 변환하고 압축한 워커 소스(1.23 MB)를 gzip(-9)+base64로 `main.js`에 넣는다. 임베드 크기는 0.51 MB.
- 실행 시 `DecompressionStream("gzip")`으로 풀고 `Blob` → `URL.createObjectURL` → `new Worker(url, {type: "module"})`로 띄운다.
- pdf.js가 직접 워커를 만들게 두지 않는다. pdf.js의 `getWorkerSrc()`는 Blob URL이 문서와 동일 출처가 아니라고 판단하고(`app://obsidian.md`, iOS `capacitor://localhost` 모두 origin이 `null`), `await import("blob:…")` 래퍼 Blob을 하나 더 만든 뒤 해제하지 않는다. 그래서 워커를 직접 만들고 `ready` 핸드셰이크(15초 제한)를 확인한 다음 `new PDFWorker({port: worker})`로 넘긴다.
- **실패 시 대안:** 핸드셰이크가 오류나 시간 초과로 끝나면 `new PDFWorker()`(포트 없음)로 다시 만든다. pdf.js는 같은 Blob URL로 `Worker` 생성을 다시 시도하고, 실패하면 fake worker(메인 스레드에서 `import(blobUrl)`)로 내려간다. 렌더링은 되지만 파싱이 UI 스레드를 막는다. 데스크톱 하네스에서 `Worker`를 막아 이 경로가 렌더링되는 것을 확인했다(`fallback-main-thread`, `pdfjs-footprint`).
- 수명: 열린 뷰 수로 참조를 센다. 마지막 뷰가 닫히면 60초 뒤 종료한다(D-07). 플러그인 unload 시에는 열린 문서를 먼저 닫고, 그다음 워커를 종료하고 Blob URL을 해제한다. 세대(generation) 카운터가 있어서, 이미 종료된 워커에 대한 `destroy()`는 기다리지 않는다.

## 5. 보조 데이터(CMap, 표준 글꼴, wasm)

pdf.js 6.x는 이 데이터를 URL로 가져온다. BRAT와 커뮤니티 설치는 `main.js`, `manifest.json`, `styles.css`만 배포하므로 URL을 쓸 수 없다. pdf.js는 `BinaryDataFactory` API 옵션을 받는다. `useWorkerFetch: false`로 두면 워커가 `FetchBinaryData` 메시지로 메인 스레드에 요청하고, 메인 스레드의 팩토리가 `{kind, filename}`에 답한다. `EmbeddedBinaryDataFactory`는 `main.js` 안의 gzip+base64 데이터를 풀어 돌려준다. 네트워크 요청은 0건이다.

| 데이터 | 원본 | 임베드(base64) | 필요성 | 결정 |
| --- | --- | --- | --- | --- |
| CMaps `*.bcmap` 169개 | 1.17 MB | 1.31 MB(파일별 gzip) | 글꼴을 임베드하지 않은 CJK PDF(예: `UniKS-UCS2-H` + `HYSMyeongJo-Medium`)는 CMap 없이 글자를 표시하지 못한다. `fixtures/korean-cmap.pdf`로 확인 | 전부 포함 |
| 표준 글꼴(Foxit `.pfb`, Liberation `.ttf`) | 0.77 MB | 0.72 MB | 글꼴을 임베드하지 않은 Helvetica/Times PDF. 없으면 시스템 글꼴로 대체되어 폭이 달라진다 | 포함 |
| `openjpeg.wasm` / `jbig2.wasm` | 216 / 101 KB | 94 / 55 KB | JPX·JBIG2 스캔 이미지 | 포함 |
| `*_nowasm_fallback.js` | 132 + 338 KB | – | wasm이 없는 환경용 | 제외 |
| `qcms_bg.wasm` | 97 KB | – | ICC 색 변환. `useWorkerFetch: false`이면 pdf.js가 쓰지 않고 JS 변환으로 대체 | 제외 |
| `quickjs-eval.wasm` | 469 KB | – | PDF 내장 JavaScript | 제외(`isEvalSupported: false`) |
| `iccs/` | 20 KB | – | qcms 전용 | 제외 |

CMap을 gzip 하나로 묶으면 약 0.15 MB를 더 줄일 수 있다. 다만 처음 쓸 때 전체를 풀어야 하므로 파일별로 둔다.

## 6. 뷰어 CSS

`web/pdf_viewer.css`(168 KB)는 `:root` 변수와 `.pdfViewer`, `.page`, `.textLayer` 같은 전역 셀렉터를 쓰고, **CSS 네이티브 중첩**도 쓴다(예: `.textLayer { > :not(.markedContent) { … } }`). 코어 Obsidian PDF 뷰어도 같은 클래스 이름을 쓰므로 그대로 넣으면 코어 뷰어의 모양이 바뀐다. `scripts/scope-css.mjs`(postcss)가 하는 일은 다음과 같다.

- **최상위 규칙에만** `.pendf-root `를 붙이고, `:root`/`html`/`body`는 `.pendf-root`로 바꾼다. 중첩 규칙은 이미 범위가 잡힌 부모 규칙의 상대 셀렉터이므로 그대로 둔다. 처음 구현은 중첩 규칙에도 접두사를 붙였는데, 텍스트 레이어 span의 크기와 변환 규칙이 무효가 되어 선택 영역과 하이라이트가 어긋났다. 데스크톱 하네스의 정답 검사로 발견해 고쳤다.
- `@keyframes` 안은 건드리지 않는다.
- `url(images/…)` 선언(편집기·툴바 아이콘)을 지운다. 플러그인 폴더에 이미지가 없고, 그 위젯을 그리지 않는다.

결과 `styles.css`는 170 KB이다.

## 7. 빌드 크기

`pnpm build`마다 `build-size.json`에 기록하고, 5 MB 이상이면 빌드를 실패시킨다.

| 항목 | 크기 |
| --- | --- |
| `main.js` | **3.21 MB** (3,361,584 B) |
| 그 중 워커 | 0.51 MB |
| 그 중 CMaps | 1.31 MB |
| 그 중 표준 글꼴 | 0.72 MB |
| 그 중 wasm | 0.15 MB |
| `styles.css` | 170 KB |

목표 5 MB(Obsidian Sync Standard 파일 크기 한도) 미만을 만족한다. legacy 빌드였을 때는 3.31 MB였다.

## 8. 기타 확인 사항

- `PDFViewer`는 컨테이너가 `position: absolute`가 아니면 예외를 던진다. `.pendf-container { position: absolute; inset: 0 }`로 둔다.
- 기본 `GenericL10n()`을 언어 인자 없이 만들면 내장 영어 번들을 쓰고 아무것도 가져오지 않는다.
- `annotationEditorMode: AnnotationEditorType.DISABLE`로 두면 pdf.js 편집기 UI 관리자를 만들지 않는다.
- pdf.js는 페이지를 reset할 때(줌, 회전, 재렌더) 모르는 자식 노드를 지운다. 우리 레이어는 `pagerendered`·`textlayerrendered`·`scalechanging` 때 다시 붙인다(`src/layers`).
- pdf.js 6의 핀치 줌 처리는 뷰어 앱(`app.js`)에 있고 `PDFViewer`에는 없다. 공개 export인 `TouchManager`로 같은 동작을 구현했다.
- pdf.js 페이지에는 9px 투명 테두리가 있다. 클라이언트 좌표를 페이지 좌표로 바꿀 때는 페이지 div가 아니라 테두리 안쪽 레이어(텍스트 레이어나 캔버스)의 사각형을 기준으로 삼는다(`pageContentRect`).

## 9. Obsidian CSS가 안으로 새는 문제

데스크톱 하네스의 `css-inward` 검사가 우리 뷰의 페이지 요소에 걸리는 Obsidian `app.css` 규칙을 나열한다.

- `* { box-sizing: border-box; }`: pdf.js는 content-box를 전제로 페이지 크기를 잡는다(테두리는 캔버스 바깥). border-box가 적용되면 캔버스 래퍼가 텍스트 레이어보다 테두리 두 배(18px)만큼 작아져 서로 어긋난다. `src/styles.css`에서 `.pendf-root .pdfViewer *`를 content-box로 되돌렸다. 고친 뒤 텍스트 레이어와 캔버스의 크기·위치가 일치한다(`aligned: true`).
- Obsidian `app.css`에는 코어 뷰어용 pdf.js CSS가 범위 없이 들어 있다(`.textLayer span`, `.textLayer > :not(.markedContent)` 등). 우리 규칙은 `.pendf-root` 접두사 덕분에 명시도가 더 높아 우선한다. 같은 이름의 속성은 결과값이 pdf.js 6.5 규칙과 일치함을 확인했다.
- `* { text-shadow: none !important }`, 스크롤바 변수: 영향 없음.

## 10. core-js 흔적 실측(legacy 빌드를 버린 근거)

방법: Obsidian 창 안에 숨긴 `<iframe>`(깨끗한 realm)을 만들고, 내장 객체 50여 종(`Function` 포함)의 모든 속성을 **함수 동일성**으로 스냅샷했다. 그 realm에서 빌드된 pdf.js를 실행한 뒤 다시 비교했다. core-js는 `Function.prototype.toString`을 고쳐 자기 폴리필이 `[native code]`로 보이게 하므로, 소스 문자열로는 판별할 수 없다.

| 빌드 | 추가된 것 | 교체된 네이티브 |
| --- | --- | --- |
| legacy 6.5.438 | `Map/WeakMap#getOrInsert(Computed)`, `Math.sumPrecise`, `Uint8Array.fromBase64`·`#toBase64`·`#toHex`·`#setFromBase64`·`#setFromHex`, `Iterator#join`, 전역 `__core-js_shared__` | **`Promise.try`, `Iterator#take`, `Iterator#drop`** |
| **modern 6.5.438 + ponyfill(채택)** | 없음 | 없음 |

modern 빌드 측정은 비교만 한 것이 아니다. 같은 realm에서 fixture 4개(a4, korean-embedded, rotations, cropbox)를 실제 워커와 메인 스레드 폴백으로 각각 열고, 텍스트 추출·연산자 목록·캔버스 렌더링까지 끝낸 뒤에 비교했다. 추가·교체·삭제 모두 0건이다(`pdfjs-footprint` 검사).

참고로 개발 중 SciWiki 창에서 legacy 빌드를 여러 번 로드했기 때문에, 그 창에는 core-js 3.51.0 흔적이 남아 있다. 다른 플러그인도 core-js 3.1.3과 3.42.0을 등록해 두었다. 그래서 이 창에서 하네스가 통과한다고 해서 "폴리필 없이 동작한다"는 증거가 되지는 않는다. 그 증거는 위 iframe 검사다. 최종 확인은 Obsidian을 재시작한 뒤 하네스를 한 번 돌리는 것이다(REPORT).

## 11. 자동 검증 하네스에서 알게 된 Chromium 동작

Obsidian 창이 가려지거나 최소화되어 있으면 다음 세 가지가 일어난다. 모두 플러그인 버그가 아니라 하네스 환경 문제다.

1. `requestAnimationFrame`이 멈춘다. pdf.js 렌더링 루프가 진행되지 않는다. 하네스는 검증하는 동안 rAF를 `setTimeout`으로 바꾼다.
2. 프로그램으로 `scrollTop`을 바꿔도 `scroll` 이벤트가 오지 않는다. 이벤트가 렌더링 단계에서 발송되기 때문이다. 그래서 pdf.js가 새로 보이는 페이지를 그리지 않는다. 하네스는 컨테이너의 스크롤 위치가 바뀌면 `scroll` 이벤트를 직접 발송한다.
3. 창이 5분 넘게 숨어 있으면 Chromium의 intensive timer throttling이 연쇄 타이머를 1분에 한 번으로 묶는다. 하네스가 매우 느려진다. Obsidian 창을 보이게 둔 채 돌리는 것이 확실하다.

## 12. 공유 문서 네임스페이스 감사 (B-06, 2026-11-15)

Obsidian 창에는 pdf.js가 두 벌 있다: 코어(5.3.34, Obsidian 자체 빌드라 npm에 없음)와 penDF(6.5.438). 둘은 같은 `document`에 이름이 있는 것을 넣는다. 아래는 pdf.js 6.5.438 소스(`build/pdf.mjs`, `build/pdf.worker.mjs`, `web/pdf_viewer.mjs`, `web/pdf_viewer.css`)를 훑어 공유 문서에 남기는 것을 모두 분류한 결과다.

| 항목 | 이름 | 만드는 곳 | 분류 | 조치 |
| --- | --- | --- | --- | --- |
| 글꼴(`document.fonts`, FontFace API) | `g_${docId}_f${n}`, 대체 글꼴 `g_${docId}_s${n}` | 워커가 메인에서 받은 `docId`로 만듦 | **충돌 가능** → **penDF 접두사로 분리됨** | `docId`를 `pendf_d${n}`으로 (변환 규칙, 1회 일치) |
| 글꼴(@font-face 규칙, FontFace API가 없을 때) | 같은 이름, `adoptedStyleSheets` 또는 `<head>`의 `<style>` | `FontLoader` | 위와 같음 | 위와 같음 |
| SVG 필터 `<defs>`(본문 끝 숨은 `div` 안) | `g_${docId}_transfer_map_…`, `_hcm_filter`, `_alpha_map_…`, `_luminosity_map_…`, `_knockout_filter_…` | `DOMFilterFactory` | **충돌 가능** → **penDF 접두사로 분리됨** | 위와 같음(같은 `docId`) |
| CSS 사용자 속성 `--viewer-container-height` | `<html>`의 인라인 스타일 | `PDFViewer.#updateContainerHeightCss` | **충돌 가능**(penDF가 코어 뷰어의 값을 덮어씀. penDF 쪽은 `.pendf-root`의 기본값 0이 이겨 효과도 없었음) | penDF 스크롤 컨테이너에 쓰도록 변환(1회 일치) |
| 그 밖의 CSS 사용자 속성(`--scale-factor`, `--user-unit`, `--hcm-highlight-filter` 등) | 뷰어·페이지 요소의 인라인 스타일 | `PDFViewer`, `PDFPageView` | 뷰 컨테이너 안에만 존재 | 없음 |
| `pdf_viewer.css`의 `:root` 변수와 규칙 | `.pendf-root` 아래로 범위 지정 | 빌드(scope-css) | 뷰 컨테이너 안에만 존재 | 없음(`@keyframes`·`@font-face` 없음 확인) |
| 측정용 canvas, 색 값 측정 span, 최소 글꼴 크기 측정 div, 글꼴 로드 확인 span | 이름 없음, 측정 뒤 제거 또는 사본마다 따로 | `TextLayer`, `getColorValues`, `FontLoader` | 사본마다 따로(충돌 없음) | 없음 |
| 전역 `pdfjsLib`/`pdfjsViewer`/`pdfjsWorker`/`_pdfjsTestingUtils` | `globalThis` | 원본 빌드 | penDF는 읽지도 쓰지도 않음(0.1.0부터, 변환 규칙) | 없음 |
| `documentElement`·`body`의 클래스·data 속성 | — | 해당 코드 없음 | 해당 없음 | 없음 |
| 표준 글꼴 대체의 `url(…)` 소스 | `url(embedded://standard_fonts/…)` | 워커 `generateFont` | 충돌은 아니지만 **브라우저가 가져올 수 없는 주소**(WebKit에서 요청 실패·콘솔 오류) | `embedded:` 경로면 `url()`을 빼도록 변환(D-33) |

### 가설 확인 (수정 전/후, Obsidian 밖)

`scripts/webkit/smoke.mjs --b06`이 한 페이지에 코어 대역(pdfjs-dist 5.3.31, 같은 `d${n}` 규칙)과 penDF 엔진을 함께 올려, 변환 규칙을 뺀 "수정 전" 번들과 넣은 "수정 후" 번들을 비교한다. 증거: `docs/evidence/b06-namespace-browsers-2026-11-15.json`.

| 엔진 | 순서(코어 → penDF) | 글꼴 이름 충돌 수정 전 → 후 | `<html>` 변수 | penDF 1쪽 화면 | 정답 끝 오차 |
| --- | --- | --- | --- | --- | --- |
| Chromium 156 | a4 → rotations | **2 → 0** | 수정 전 penDF가 `""`→`760px`로 씀, 수정 후 그대로 | 같음 | −0.18 pt(전후 같음) |
| WebKit 27.2 | a4 → rotations | **1 → 0** | 같음 | 같음 | −0.11 pt(전후 같음) |
| 둘 다 | korean-embedded → 다른 임베디드 글꼴(Arial) PDF | **1 → 0**(서로 다른 글꼴이 같은 `g_d0_f1`) | 같음 | 같음 | — |

- **확인된 것:** 두 사본이 같은 글꼴 이름을 실제로 등록한다(수정 전). 수정 후 0. penDF가 `<html>`의 `--viewer-container-height`를 덮어쓰는 것도 실제였고 수정 후 사라졌다.
- **확인되지 않은 것:** 이 시험들에서는 충돌이 penDF의 렌더링(픽셀 지문 동일)이나 하이라이트 끝 오차를 바꾸지 않았다. 같은 이름의 FontFace가 둘이면 브라우저는 글리프가 없는 쪽에서 다른 쪽으로 넘어가므로, 글리프 범위가 겹치는 서로 다른 글꼴이어야 눈에 보이는 차이가 날 것으로 본다. 즉 B-06(3.21 pt)의 원인이 이것이라는 증거는 아직 없다. Obsidian 안의 재현(`ground-truth-after-core` 등)은 테스트 볼트 등록 뒤에 돌린다(BLOCKERS B-07).
- **덧붙여 발견한 것:** 시험 페이지에 `<html lang>`이 없으면 정답 끝 오차가 16.67 pt가 됐다. pdf.js 텍스트 레이어는 canvas로 잰 폭에 맞춰 span을 늘이는데, 측정 canvas와 DOM이 `sans-serif`를 서로 다른 글꼴로 고르면(언어에 따른 대체 글꼴 차이) 폭이 어긋난다. Obsidian은 `lang`이 있어 문제가 없었지만, B-06처럼 "환경에 따라 1~3 pt 달라지는" 현상의 다른 후보다.

### Obsidian 안 재검증 (2026-11-16, 테스트 볼트)

같은 볼트·같은 창에서 수정 후 빌드와 수정 전 빌드(공유 이름 규칙 두 개만 뺀 같은 코드)를 번갈아 설치해 같은 검사를 돌렸다. 증거: `docs/evidence/b06-obsidian-2026-11-16.json`.

| 조건 | 빌드 | `shared-namespace` | 코어 먼저 | 임베드 먼저 | 같은 PDF 동시 | 단독 |
| --- | --- | --- | --- | --- | --- | --- |
| 기본 모양 | 수정 후 | 통과(충돌 0, `g_pendf_d3_…`) | −0.71 pt | −0.71 | −0.71 | −0.13 ~ −0.33 |
| 기본 모양 | 수정 전 | 실패(접두사 없음, 이번 세션은 코어 `d8`·penDF `d3`라 충돌 자체는 없음) | −0.71 | −0.71 | −0.71 | −0.13 ~ −0.33 |
| Wikibaum·IBM Plex Sans KR·어두운 테마 | 수정 후 / 수정 전 | 통과 / 실패 | −0.71 / −0.71 | — | −0.71 / −0.71 | 같음 |

- 테스트 볼트에서는 B-06이 어느 빌드로도 재현되지 않는다. 즉 SciWiki의 3.21 pt는 SciWiki에만 있는 조건(다른 플러그인, CSS 스니펫, 창·사이드바 폭에 따른 배율 등)과 관련이 있고, 공유 이름 충돌이 원인이라는 증거는 없다.
- 공유 이름 충돌은 두 사본의 문서 카운터가 같은 값일 때만 생긴다(이번 세션은 코어가 이미 9개 문서를 열어 `d8`). 그래도 실제로 일어날 수 있는 일이므로 수정은 유지한다.
- 시나리오 검사의 −0.71 pt와 단독 −0.21 pt의 차이는 코어 탭을 옆에 열어 penDF 창 폭(즉 너비 맞춤 배율)이 달라진 데서 온다. 수정 전 빌드도 같은 차이를 보인다.
