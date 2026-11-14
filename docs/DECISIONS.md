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
- **함께 고친 것:** `.gitignore`의 `styles.css`가 빌드 결과물뿐 아니라 `src/styles.css`까지 무시해, 원본 스타일시트가 한 번도 커밋되지 않았다(이름 변경 스크립트가 git 추적 파일만 바꾸다가 드러남). 빌드 결과물 패턴을 저장소 루트(`/main.js`, `/styles.css` 등)로 한정하고 `src/styles.css`를 추가했다. 추적 파일만으로 만든 복사본에서 `pnpm install && pnpm build && pnpm test && pnpm lint`가 통과한다.

## D-21 릴리스 자산에 빌드 출처 증명(attestation) (2026-11-14)
- **결정:** `release.yml`이 `actions/attest@v4`로 `main.js`·`manifest.json`·`styles.css`에 SLSA build provenance를 서명해 붙인다. 확인: `gh attestation verify main.js --repo dhwan0112/pendf`. 0.1.0에는 없고 0.1.1부터 붙는다.
- **근거:** Obsidian 커뮤니티 등록 검토가 "Missing GitHub artifact attestations for release assets"를 권고했다. 공개 저장소에서는 무료다.
- **함께:** 액션을 현재 메이저(checkout v7, setup-node v7, pnpm/action-setup v6)로 올려 Node 20 경고를 없앴다. `main` push마다 도는 `ci.yml`(빌드·테스트·lint)을 추가했다. `versions.json`(버전 → minAppVersion)을 추가하고, 릴리스 워크플로가 태그·manifest·versions.json 일치를 검사한다.

## D-22 커뮤니티 스캐너 소스 검사 대응 (2026-11-14, 0.1.2)
- **결정:** 스캐너가 쓰는 `eslint-plugin-obsidianmd` 0.5.1의 recommended 설정을 `eslint.config.mjs`로 넣고 `pnpm lint`(따라서 CI)에 포함했다. 검토가 지적한 항목을 모두 고쳐 0건이다.
- **변경:** 떠 있는 팔레트·메뉴 위치를 인라인 style 대신 CSS 변수(`--pendf-x/y`, `setCssProps`)로 준다. 로그와 펜 프로브는 `navigator.userAgent` 대신 `Platform` 플래그와 `apiVersion`을 기록한다(그래서 WebKit 버전은 더 이상 기록되지 않는다). `minAppVersion`을 `View.scope`가 생긴 1.5.7로 올렸다. 설정 탭은 1.13+에서 `getSettingDefinitions()`로 그려져 설정 검색에 나오고, 더 낮은 버전은 기존 `display()`를 쓴다. 명령 이름에서 플러그인 이름을 뺐다("Open current PDF"). `document`/`globalThis`/전역 타이머 대신 요소의 문서·`activeDocument`·`window` 타이머를 쓴다. `onunload`는 동기 함수가 되고 비동기 정리를 분리해 실행한다(Obsidian은 원래 기다리지 않는다).
- **검증:** 테스트 122개, 데스크톱 하네스 21/21(`docs/evidence/harness-2026-11-14-0.1.2.json`), Obsidian 1.15에서 선언형 설정 탭 렌더링 확인.
- **0.1.3 후속:** 스캐너가 0.1.2에서 두 건을 더 찾았다(로컬 0.5.1 규칙으로는 재현되지 않음, 스캐너의 규칙이 더 새로움). `setControlValue`의 `this.update()`(1.13 API)를 `requireApiVersion("1.13.0")`로 감쌌고, `display()`의 `forEach` 화살표가 체인 결과를 돌려주던 것을 `for…of`로 바꿨다.
- **0.1.4 후속:** 스캐너가 `requireApiVersion("1.13.0") && this.update()`도 같은 오류로 보고했다. GitHub의 규칙 문서는 `&&` 오른쪽과 `setControlValue` 재정의 안을 허용한다고 하므로, 스캐너가 그보다 오래된 규칙을 쓰는 것으로 보인다. 추측으로 다른 가드 형태를 시도하는 대신 `update()` 호출을 없앴다. 색 이름을 바꾸면 기본 색 드롭다운에는 설정 탭을 다시 열 때 반영된다.

## D-23 PDF를 기본으로 penDF에서 연다 (2026-11-14, 사용자 결정, 0.1.5)
- **결정:** 설정 "Open PDFs in penDF"(기본 켜짐)가 켜져 있으면, Obsidian이 PDF를 코어 뷰어로 연 탭을 곧바로 penDF 뷰로 바꾼다(`active-leaf-change`·`file-open` 때 `leaf.getViewState()`가 `pdf`이면 `leaf.setViewState()`). 파일 메뉴에는 "Open in Obsidian's PDF viewer"가 생기고, 그렇게 연 탭은 그 파일인 동안 바꾸지 않는다. 설정을 끄면 예전처럼 "Open in penDF"가 나온다.
- **근거:** 사용자가 매번 따로 여는 것을 원하지 않았다. 지시문의 비목표("코어 PDF 확장 가로채기")를 사용자가 직접 뒤집은 것이다. 공개 API로는 `.pdf` 확장자를 다시 등록할 수 없으므로(코어가 등록해 둠), 코어 뷰어를 패치하거나 DOM을 건드리지 않고 공개 `WorkspaceLeaf` API로 탭의 뷰만 바꾼다. 비활성 탭(지연 로드)은 활성화될 때 바뀐다.
- **한계:** (1) 노트 안의 PDF 임베드와 호버 미리보기는 코어 뷰어 그대로다(임베드 등록은 비공개 API). (2) `[[file.pdf#page=3]]` 같은 페이지 링크는 마지막 위치로 열린다 — **0.3.0에서 해결**: 노트에서 누른 링크는 D-25의 방식으로 위치가 전달된다. Obsidian은 `{subpath:"#page=3"}`를 탭 전환이 끝나기 전(약 260 ms 뒤) 아직 코어 뷰인 탭에 넘기고, 코어 뷰는 그것을 상태로 내놓지 않는다(`getState()`는 `{file}`, `getEphemeralState()`는 `{}`)고 실측했다. penDF 뷰는 `subpath`의 `page=N`을 이해하므로, Phase 4(링크)에서 다시 다룬다. (3) 전환하는 동안 코어 뷰어가 잠깐 보이고 코어의 pdf.js가 로드된다.
- **검증:** 하네스 `open-by-default`(일반 열기 → penDF, 페이지 링크 → penDF, 코어로 열기 유지, 설정 끔 → 코어). 기존 검사들은 코어 뷰어가 필요해 하네스가 시작할 때 이 설정을 끈다.
- **참고:** 같은 날 `highlight-ground-truth`의 끝 오차가 -0.32~0.3 pt에서 1.0~1.4 pt로 바뀌었다. 0.1.2 릴리스 파일로도 같은 값이 나와 코드가 아니라 환경(Obsidian 창 1536×912, 배율 125%에서 page-width 배율이 달라짐) 때문이다. 전체 실행에서는 3.21 pt로 기준(3 pt)을 넘는데, 코어 PDF 뷰어를 먼저 연 뒤(`coexistence-core-first`)에만 그렇고 단독 실행은 통과한다. 0.1.2 빌드로도 같은 순서에서 똑같이 3.21 pt가 나와 이번 변경과는 무관한 기존 현상이다(BLOCKERS B-06).

## D-24 Phase 3 텍스트 주석 (2026-11-15, 0.2.0)
- **결정:** 메모는 스키마 v1의 `note` 그대로 쓴다(마이그레이션 없음). 대상은 하이라이트(마커는 첫 줄 사각형의 오른쪽 위) 또는 페이지 지점. 마커는 페이지 SVG 레이어에 PDF 포인트 단위(반지름 7 pt)로 그려 줌·회전을 따라간다. 하이라이트 레이어는 `multiply` 합성이라 마커 색이 바래므로, 레이어마다 합성하지 않는 두 번째 SVG(`overlay`)를 위에 두었다.
- **입력:** 하이라이트 메뉴의 메모 버튼, 툴바 "Add note" 후 페이지 탭(배치 모드). 마커 탭은 캡처 단계에서 처리해 하이라이트 메뉴보다 먼저 받는다. 편집은 모달(`NoteEditorModal`) — iPad 키보드와 터치 충돌이 가장 적다. 빈 내용으로 저장하면 새 메모는 만들지 않고 기존 메모는 지운다.
- **렌더링:** 팝오버와 패널 모두 공개 `MarkdownRenderer.render`로 그린다(위키링크, 목록, 체크박스 등). 소스 경로는 PDF 경로라 상대 링크가 PDF 위치 기준으로 풀린다.
- **연쇄 삭제:** 하이라이트를 지우면 거기 붙은 메모도 같은 실행 취소 단위로 지운다. 다른 기기에서 하이라이트만 지워져 고아가 된 메모는 지우지 않고 패널에만 보인다(데이터 보존 우선).
- **패널:** 오른쪽 사이드바 `ItemView`(`pendf-annotations`). 마지막으로 활성이던 penDF 탭을 따라가고, 페이지별로 위에서 아래(PDF y 기준) 순서. 회전된 페이지에서는 이 순서가 화면 순서와 다를 수 있다.
- **검증:** 단위 테스트 11개(앵커, 연쇄 대상, 패널 정렬, 저장 왕복, 실행 취소, 기기 간 병합에서 수정·삭제 우선). 하네스 `notes`가 실제 Obsidian에서 배치 모드 → 편집 모달 → 마커 → 탭 → 렌더링된 팝오버, 연쇄 삭제·실행 취소, 패널, 다시 열기 후 보존을 확인한다.

## D-25 Phase 4 링크 (2026-11-15, 0.3.0)
- **형식:** `#page=N&pendf=<id>` (하이라이트·메모), `#page=N&pendf-rect=x0,y0,x1,y1` (선택, PDF pt, 소수 1자리), `#page=N` (페이지). PDF++의 `rect=`와 겹치지 않는 이름이다. 링크 문자열은 `app.fileManager.generateMarkdownLink`로 만들어 볼트의 링크 형식 설정(위키링크/마크다운, 경로 방식)을 따른다. 별칭은 하이라이트 글, 메모 첫 줄, 또는 `파일, p. N`에서 `[ ] | # ^`를 뺀 60자 이내.
- **플러그인 없이:** penDF를 끈 볼트에서 `long-300.pdf#page=7&pendf=…&pendf-rect=…`를 열면 코어 뷰어가 7쪽을 연다고 실측했다(목표 문서 완료 기준).
- **정확한 위치로 이동:** 공개 API에는 링크의 subpath를 알려 주는 이벤트가 없고, Obsidian은 그것을 코어 뷰어에만 넘긴다(D-23). 그래서 클릭을 가로채지 않고 **누른 링크를 기록만** 한다(`LinkRecorder`). 읽기 보기·백링크 등은 문서 캡처 단계 `pointerdown`에서 `a.internal-link`의 `data-href`를, 편집기는 공개 `registerEditorExtension`의 CodeMirror `mousedown`에서 줄 텍스트의 링크를 읽는다. 3초 안에 같은 PDF가 열리면 탭 전환 때 그 subpath를 `setViewState(…, { subpath })`로 넘긴다. 클릭 처리(수정 키, 새 탭, 호버)는 Obsidian 그대로다.
- **이중 전환:** Obsidian의 열기가 우리 전환보다 늦게 끝나 탭을 한 번 더 코어 뷰어로 되돌리는 일이 있어(로그로 확인) 탭별로 5초간 같은 subpath를 다시 쓴다. **0.5.1에서 정정:** 링크만이 아니라 일반 열기에서도 전환이 두 번 일어난다(하네스 `open-by-default`: 전환 2회). 다만 첫 번째 로드는 곧 취소되어 PDF를 끝까지 여는 것은 한 번이다("opened" 로그 1회). 코어 뷰어의 로드 비용은 그대로 든다.
- **이동 후:** 하이라이트는 1.6초 강조, 메모는 팝오버, 선택 사각형은 2.2초 깜박임. 대상 id가 없으면(지워짐) 페이지만 연다.
- **하지 않은 것:** 노트 임베드(목표 문서의 "옵션")는 코어 임베드 DOM을 바꾸거나(비공개에 가까움) 노트 안에서 pdf.js로 페이지를 그려야(iPad 메모리) 해서 이번에는 넣지 않았다. 다른 플러그인이 코드로 여는 링크(`openLinkText`)는 기록할 클릭이 없으므로 기억된 위치로 열린다.
- **검증:** 단위 테스트 10개(subpath 생성·해석, 줄에서 링크 찾기, 별칭). 하네스 `pdf-links`가 실제 Obsidian에서 임시 노트를 만들어 읽기 보기 클릭(5쪽 + 강조), 편집기 누름 후 열기(9쪽 + 메모 팝오버), 선택 링크(12쪽 + 깜박임), 링크 없는 일반 열기(기억된 위치)를 확인한다.

## D-26 Phase 5 북마크 (2026-11-15, 0.4.0)
- **결정:** 사이드바 패널을 탭 세 개(Outline / Bookmarks / Annotations)로 나눴다. 탭은 패널의 뷰 상태로 저장된다.
- **개요:** pdf.js `getOutline()`을 한 번 읽어 세션에 캐시하고, 목적지(명시적 배열 또는 이름)를 `getDestination`·`getPageIndex`로 쪽 번호로 바꾼다. 이동은 `linkService.goToDestination`. 읽기만 하며 PDF에 쓰지 않는다.
- **북마크:** 스키마 v1의 `bookmark`(page, y, title, order). "지금 보이는 맨 위"(컨테이너 위쪽 16 px 지점의 PDF y)를 저장한다. 기본 제목은 그 쪽이 속한 개요 절을 붙인 "Page N — 절 제목". 순서는 실수 `order`로, 옮길 때 이웃 사이 값을 쓰고 간격이 1e-6보다 작아지면 전부 다시 매긴다. 추가·이름 변경·이동·삭제는 문서별 실행 취소에 들어간다. 링크는 Phase 4 형식(`pendf=<id>`).
- **확인한 pdf.js 동작:** 사이드바가 열리며 PDF 영역 크기가 바뀌는 동안 pdf.js는 "너비 맞춤"을 다시 적용하면서 마지막으로 기록한 위치로 되돌아간다. 사이드바 애니메이션(약 0.3초) 중에 코드로 페이지를 옮기면 되돌려질 수 있어, 하네스는 패널을 연 뒤 1초 기다린다. 사람이 쓰는 속도에서는 드물다.
- **픽스처:** `long-300.pdf`에 개요(30장 × 2절, 30장은 이름 있는 목적지 `chapter-30`)를 추가했다.
- **검증:** 단위 테스트 7개(정렬, 이동, 반복 이동 시 재번호, 절 찾기, 기본 제목). 하네스 `bookmarks`가 실제 Obsidian에서 개요 쪽 번호(명시적·이름 목적지), 개요 탭에서 292쪽 이동, 제목 입력 창의 추천 제목, 추가·이동·이름 변경·삭제·실행 취소, 북마크 탭 순서와 이동, 링크 이동, 다시 열기, PDF SHA-256·mtime·크기 불변을 확인한다.

## D-27 Phase 6 필기 (2026-11-15, 0.5.0)
- **도구:** 균일 굵기 펜(필압 없음, "모노 펜" 해석은 그대로), 형광펜, 획 지우개, 실행 취소/다시 실행(문서별 스택 공유). 색·굵기·도구는 설정에 기억한다.
- **입력:** 필기 모드에서 Apple Pencil은 쓰고 손가락은 스크롤·선택한다. Pencil의 `touchstart`만 `preventDefault`(그 터치의 스크롤·선택이 막힌다), 손가락 터치는 건드리지 않는다. iPad 웹뷰에서 이것이 통하는지는 아직 확인하지 못했으므로 설정 "Pencil and finger"에 대안 "Everything writes"(필기 모드에서 `touch-action: none`, 모든 포인터가 씀)를 두었고, 펜 프로브에 같은 방식("cancel Pencil touchstart")을 켜고 끄는 스위치를 넣어 iPad 한 번의 측정으로 판단할 수 있게 했다. 마우스는 필기 모드에서 쓴다(데스크톱 개발용). 획 중에는 핀치 줌을 막는다(손바닥 + 펜 = 두 터치).
- **실시간 획:** 뷰포트 크기 캔버스 하나(`.pendf-root` 안, `pointer-events: none`, `desynchronized`)에 포인터 핸들러 안에서 바로 그린다. `getCoalescedEvents`가 있으면 모든 샘플을 쓰고, 없거나 비면 이벤트 자체를 쓴다. 형광펜은 불투명하게 그리고 캔버스 요소에 투명도를 줘 이음새에 점이 생기지 않게 했다. 캔버스는 필기 모드를 끄면 해제한다. 예측 이벤트(`getPredictedEvents`)는 쓰지 않았다(지연 비교 결과를 보고 판단).
- **저장·렌더:** 펜을 떼면 중복 제거 → RDP 단순화 → 0.01 pt 반올림 후 `ink`로 저장하고, 페이지 SVG에 그 획만 덧붙인다(페이지 전체를 다시 그리지 않음). 펜 잉크는 합성하지 않는 별도 SVG 레이어에 두고 다크 모드에서는 캔버스와 같은 invert 필터를 받는다(그러지 않으면 검은 잉크가 사라짐). 형광펜 잉크는 하이라이트와 같은 multiply 레이어. 로컬 편집은 더 이상 모든 페이지를 다시 그리지 않고(각 컨트롤러가 자기 페이지만), 잉크 편집은 패널을 다시 그리지 않는다.
- **사이드카 크기:** `points`·`quads`를 한 줄로 쓴다(여전히 같은 JSON). 1,500획(획당 40점)이 975 KB.
- **경계 처리:** `pointercancel`(iPadOS가 제스처를 가져감)은 획을 버린다. 한 점 획은 점으로 그린다. 획 직후의 click은 450 ms 동안 삼켜 하이라이트 메뉴·메모가 열리지 않게 한다. 지우개는 샘플 사이를 보간해 빠르게 문질러도 건너뛰지 않고, 펜을 뗄 때 한 번에 기록해 실행 취소 한 번으로 되돌린다.
- **검증:** 단위 테스트 11개(단순화, 거리·히트, 경로, 압축 직렬화, 1,500획 크기). 하네스 `ink`: 합성 Pencil 이벤트로 회전 4종·CropBox 페이지를 150 %에서, 그리고 보기 회전 뒤에 그려 저장 좌표 오차 0.000 pt, 손가락 입력 무시, 하이라이트 위 획 뒤 메뉴 안 뜸, 점, 지우개·실행 취소, 1,500획 렌더 32 ms·저장 217 ms, 다시 열기. 다크 모드 화면도 확인했다. **합성 이벤트는 좌표와 저장만 증명한다** — 지연, Pencil/손가락 분기, 손바닥, 가장자리 스와이프는 iPad에서만 확인할 수 있다(DEVICE_CHECKLIST 6장).
- **같이 고친 것:** 하네스 `persist-restart-rename`이 앞선 검사가 남긴 사이드카에 기대고 있어 단독 실행 시 실패했다. 스스로 하이라이트를 만들도록 고쳤다.

## D-28 0.5.1 — 측정과 보정 (2026-11-15)
- **펜 프로브 v3:** iPadOS는 Pencil 획을 스크롤로 넘겨받을 때 포인터를 취소하는데, 그 순간에는 아직 페이지가 움직이지 않았을 수 있다. 그래서 취소를 `:cancelled`로 따로 세고, 스크롤 여부는 펜을 뗀 뒤 300 ms에 한 번 더 본다. DEVICE_CHECKLIST 6장의 판정 기준도 이에 맞췄다.
- **지우개:** 1,500획 페이지에서 이동 한 번에 3.19 ms가 들었다(획 경계 재계산, 샘플마다 `elementsFromPoint`, 지운 획마다 컨테이너 전체 검색). 지우개를 댈 때 획·경계·경로 요소를 한 번 모으고 지우개 아래 페이지를 기억하게 해 0.33 ms로 줄였다(같은 95획 삭제).
- **저장 보류:** 1초 디바운스 저장이 획 도중에 실행되지 않도록 `canSave`(필기 중이면 다시 미룸)를 두었다. 1,500획 직렬화는 약 4 ms라 실제로 문제 될 가능성은 낮지만 지연 측정 전에 변수를 줄였다.
- **B-06 재확인:** `coexistence-core-first` → `highlight-ground-truth` 순서로 다시 돌려 여전히 3.21 pt(기준 3 pt)임을 확인했다. 열린 상태로 둔다. 0.5.0의 "26/26 통과"는 이 순서를 포함하지 않는다.

## D-29 0.5.2 — 스캐너 지적 두 건 (2026-11-15)
- **`revealLeaf`:** 1.7.2에서 Promise를 돌려주게 바뀐 API라, 결과를 `await`하면 스캐너가 1.7.2 이상 API로 본다(로컬 lint는 통과 — 스캐너와 세 번째 차이). 패널을 열 때 `revealLeaf` 대신 `rightSplit.expand()` + `setActiveLeaf(leaf, { focus: true })`를 쓴다(모두 1.0 이전 API). 모바일 드로어 클래스(`WorkspaceMobileDrawer`, 1.6.6)를 이름으로 참조하지 않도록 `{ expand(): void }` 구조 타입으로 호출한다(데스크톱 독과 모바일 드로어 모두 `expand()`가 있다). `setActiveLeaf`만으로는 접힌 사이드바가 열리지 않음을 실제 Obsidian에서 확인했다.
- **`createElementNS`:** 선택 영역 깜박임 사각형을 공용 `svgEl` 도우미로 만든다.
- **하네스:** 패널을 연 뒤 고정 1초 대신 PDF 영역 폭이 안정될 때까지 기다린다(pdf.js가 크기 변화 중에 너비 맞춤을 다시 적용하며 마지막 위치로 돌아가는 현상, D-26).

## D-30 "Apple Pencil always writes" (2026-11-15, 0.6.0, 사용자 요청)
- **결정:** 설정 "Apple Pencil always writes"(기본 켜짐). 켜져 있으면 필기 모드를 켜지 않아도 Pencil(`pointerType: "pen"`)이 페이지에 닿는 순간 마지막으로 고른 도구(펜·형광펜·지우개)로 쓴다. 손가락은 언제나 스크롤·선택, 마우스는 필기 모드에서만 쓴다. 툴바의 펜 버튼은 도구·색·굵기를 고르는 잉크 바를 연다. 끄면 예전처럼 필기 모드에서만 Pencil이 쓴다.
- **대가:** Pencil로 글자를 길게 눌러 선택하는 동작은 할 수 없다(Pencil의 `touchstart`를 취소하므로). 하이라이트용 선택은 손가락으로 한다. "Add note"로 메모 위치를 고르는 중에는 Pencil 탭이 메모 위치로 쓰인다(획이 생기지 않음). 필기 모드 밖에서 쓴 뒤 10초 동안 쓰지 않으면 실시간 캔버스 메모리를 해제한다.
- **검증:** 하네스 `ink`에 필기 모드 밖에서 설정 켬 → Pencil 획 저장, 끔 → 무시, 마우스 → 무시를 추가했다. iPad에서의 스크롤 차단은 여전히 펜 프로브로 확인해야 한다(D-27).
