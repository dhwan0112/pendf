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
- **갱신(2026-11-14):** 사용자 결정으로 공개 저장소 `dhwan0112/pdf_ppp`를 만들고 push했다(D-18).

## D-03 pdfjs-dist 6.5.438, modern 빌드 + 빌드 시 ponyfill 치환
- **결정:** 최신 안정판을 정확한 버전으로 고정한다. **modern 빌드**를 번들하고, Chromium 138이나 iPadOS WebKit에 없을 수 있는 최신 내장 기능의 호출 지점을 빌드 시 모듈 지역 함수로 바꾼다(`scripts/pdfjs-ponyfill.mjs`). 소스는 `"pdfjs-dist"`와 `"pdfjs-dist/web/pdf_viewer.mjs"`만 import할 수 있다. esbuild 플러그인이 둘을 변환된 modern 파일로 연결하고, 그 밖의 경로는 막는다.
- **근거:** 처음에는 legacy 빌드를 썼다. 깨끗한 realm에서 실측해 보니 legacy 빌드의 core-js가 공유 창의 내장 객체에 11개를 추가하고, 네이티브 `Promise.try`·`Iterator#take`·`#drop`을 교체했다(INVESTIGATION 10절, D-13). 스탠드얼론 원칙이 우선이므로 바꿨다. 교체 뒤에는 추가·교체가 0건이고 번들도 3.31에서 3.21 MB로 줄었다.
- **대안:** (a) legacy 빌드 유지: 전역 변경. (b) pdf.js 5.x로 내리기: 5.4도 같은 최신 기능을 쓴다. (c) modern 빌드에 전역 폴리필: (a)와 같다.
- **위험:** 치환하지 않은 네이티브 의존(Iterator 헬퍼 등)이 오래된 엔진에 없을 수 있다. 로드 시 엔진 검사(D-16)가 알린다. 치환할 수 없는 모양이 생기면 빌드가 실패한다.
- **되돌리기:** commit `0dfc589`(legacy 빌드) 상태로 `esbuild.config.mjs`와 `src/pdfjs/index.ts`의 import를 되돌린다.

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
- **결정:** 모든 penDF 뷰가 워커 하나를 공유한다. 참조가 0이 되면 60초 뒤 종료하고, 플러그인을 끄면 즉시 종료한다.
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
- **결정:** id `pendf`, 이름 `penDF`(D-19에서 확정), author `Denny Kim`, authorUrl `https://github.com/dhwan0112`, `minAppVersion` 1.5.0, `isDesktopOnly: false`. LICENSE 저작권자와 git 작성자는 Kim Donghwan이다.
- **근거:** 기존 플러그인(Wikiwurzel 등)과 같은 표기. 쓰는 API(`FileView`, `Scope`, `Platform`, `setIcon`)는 1.5 이전부터 공개되어 있다.

## D-13 내장 객체 무변경을 검증 기준으로 삼음
- **결정:** "다른 플러그인과 접점 없음"을 Obsidian API 수준을 넘어 **JS 내장 객체 수준**까지 적용한다. 번들된 pdf.js도 공유 창의 내장 객체를 추가·교체·삭제하지 않아야 한다.
- **검증:** (1) 정적 검사: check-standalone이 `main.js`와 그 안의 워커에서 `core-js`, `__core-js_shared__`, 내장 객체 대입을 금지한다. 빌드는 치환 뒤 AST를 다시 훑는다. (2) 동적 검사: 하네스 `pdfjs-footprint`가 깨끗한 iframe realm에서 실제로 렌더링한 뒤, `Function`을 포함한 내장 객체 50여 종을 동일성으로 비교한다.
- **측정값:** legacy는 추가 11개 + `__core-js_shared__`, 교체 3개(`Promise.try`, `Iterator#take`, `Iterator#drop`). modern+ponyfill은 0, 0, 0.
- **주의:** 개발 중 SciWiki 창에는 legacy 빌드를 로드했을 때의 core-js 흔적이 남아 있다. Obsidian을 재시작하면 사라진다.

## D-14 테스트 도구
- 런타임 의존성은 `pdfjs-dist` 하나다(정확한 버전, check-standalone이 검사). 개발 의존성은 다음과 같다.
  - esbuild 0.28: 번들, 워커 압축
  - TypeScript 5.9.3: 타입 검사(TS 7은 JS API가 없어 도구 연동이 불안정)
  - vitest 5.1, jsdom 26: 테스트(jsdom은 선택 분할 테스트용)
  - postcss 8: pdf.js CSS 스코핑
  - acorn 8, acorn-walk 8, magic-string 0.30: pdf.js ponyfill 치환(AST 파싱과 소스 수정)
  - pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1: fixture PDF 생성
  - obsidian 1.14.4: API 타입 정의
  - @types/node
  - 모든 개발 의존성은 `.npmrc`의 `save-exact`로 고정된다.

## D-15 Obsidian Sync와 `.json` 사이드카
- **결정:** 사이드카 이름은 지시문대로 `<이름>.pdf.pendf.json`을 유지한다.
- **주의:** Obsidian Sync는 기본 설정에서 "기타 파일 형식"을 동기화하지 않는다. Obsidian Sync를 쓰면 *Settings → Sync → Sync all other types*를 켜야 사이드카가 기기 사이에 오간다. iCloud와 Git은 상관없다. REPORT의 열린 질문에 올렸다.
- **대안:** `.md` 확장자 사이드카. 항상 동기화되지만 노트 목록·검색·그래프에 보인다.

## D-16 로드 시 엔진 검사
- **결정:** 플러그인을 로드할 때 `src/pdfjs/engine.ts`가 치환하지 않은 네이티브 의존(Iterator 헬퍼, `Set#intersection`, `Promise.withResolvers`, `AbortSignal.any`, `structuredClone`, `Object.hasOwn`, `Array#findLast/at`, `DecompressionStream`, `Worker`, `Path2D/DOMMatrix`)을 검사한다. 빠진 기능이 있으면 로그에 남기고 뷰 상단에 배너를 띄운다. 렌더링은 그대로 시도한다.
- **근거:** 전역 폴리필이라는 안전망을 걷어냈으므로, 테스트할 수 없는 기기(iPad)에서 실패하면 원인이 바로 보여야 한다.
- **되돌리기:** `main.ts`의 `checkEngine()` 호출을 지운다.

## D-17 데스크톱 자동 검증 하네스
- **결정:** `scripts/obsidian-harness.mjs`가 Obsidian CLI(`obsidian vault=… eval`)로 실제 Obsidian 안에서 Phase 1·2 완료 기준을 검사한다. 검사 대상은 SciWiki 테스트 볼트뿐이다. 하네스는 매번 자신이 연 탭, 심(shim), 플러그인 활성화, 사이드카, `data.json`을 되돌린다. 검사마다 150초 제한이 있고, Node 쪽이 중단돼도(SIGINT/SIGTERM) 정리 코드가 돈다.
- **주의:** 하네스 파일은 플러그인 코드가 아니다. 플러그인을 다시 로드하려고 `app.plugins`를 쓰므로 check-standalone 검사 대상(`src/`, `main.js`)에서 빠져 있다.
- **환경 제약:** 창이 숨어 있을 때의 Chromium 동작(rAF 정지, scroll 이벤트 없음, intensive timer throttling)은 INVESTIGATION 11절에 정리했다.

## D-18 이름 `PDF+++`, 저장소 `pdf_ppp`, id `pdf-ppp` (2026-11-14, 사용자 결정)
- **결정:** 표시 이름은 `PDF+++`로 정했다(D-19에서 `penDF`로 대체). GitHub 저장소는 공개 `dhwan0112/pdf_ppp`다. plugin id와 볼트 안 폴더 이름은 `pdf-ppp`로 둔다.
- **근거:** GitHub 저장소 이름에는 `+`를 쓸 수 없다(`pdf_+++`는 `pdf_---`가 된다). Obsidian 커뮤니티 목록은 id에 소문자·숫자·하이픈을 권장하고, id를 바꾸면 이미 설치한 볼트의 설정(`data.json`) 위치가 바뀐다.
- **되돌리기:** `gh repo rename`. id를 바꾸려면 `manifest.json`, `install-dev.mjs`, 하네스, 문서의 `pdf-ppp`를 함께 고친다.

## D-19 표시 이름 `penDF` (2026-11-14, 사용자 결정, D-18 대체)
- **결정:** 표시 이름을 `penDF`로 바꾼다. id `pdf-ppp`와 저장소 `dhwan0112/pdf_ppp`는 그대로 둔다. 로그 접두사도 `[penDF:…]`가 된다.
- **근거:** Obsidian 커뮤니티 등록 페이지가 `PDF+++`를 "An entry with this name already exists"로 막았다. 기호를 빼면 기존 `PDF++`(id `pdf-plus`)와 같은 `pdf`가 되기 때문으로 보인다. `penDF`는 2026-11-14 기준 community-plugins.json(10,375개)의 이름·id 어디와도 겹치지 않는다.
- **되돌리기:** `manifest.json`의 `name`과 소스·문서의 표시 문자열을 바꾼다. 사이드카 형식과 설정에는 이름이 들어가지 않는다.

## D-20 id·저장소·코드 이름을 모두 `pendf`로 통일 (2026-11-14, 사용자 결정)
- **결정:** plugin id `pendf`, 저장소 `dhwan0112/pendf`, 로컬 폴더 `C:\Users\denny\pendf`, 패키지 이름 `pendf`. 코드 안의 `ppp` 접두사도 바꿨다: 뷰 타입 `pendf-view`·`pendf-pen-probe`, CSS 클래스 `pendf-*`와 루트 `.pendf-root`, 빌드 helper `__pendf_*`, 가상 모듈 `pendf:assets`, 사이드카 `<pdf>.pendf.json`, fixture 폴더 `pendf-fixtures`.
- **근거:** 표시 이름이 `penDF`로 바뀌었고(D-19), 아직 릴리스 전이라 기존 설치나 사이드카가 없다. `pendf`는 커뮤니티 목록의 id와 겹치지 않는다.
- **주의:** `docs/evidence/`의 JSON, REPORT의 커밋 목록, D-02·D-18·D-19는 당시 기록이라 옛 이름(`pdf-ppp`, `ppp-*`, `.ppp.json`)을 그대로 둔다.
