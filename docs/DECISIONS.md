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

## D-31 썸네일과 전체 검색 (2026-11-15, 0.7.0, 사용자 제안)
- **패널 탭 다섯 개:** Outline / Pages / Search / Bookmarks / Annotations. 폭이 좁아 비활성 탭은 아이콘만 보인다. 목차는 0.4.0의 Outline 탭 그대로다.
- **썸네일:** pdf.js `page.render({ canvas, viewport })`로 폭 104 px(DPR 최대 2)로 그린다. `IntersectionObserver`(위아래 여유 300 px)로 보이는 것만 한 번에 하나씩 그리고, 멀어지면 캔버스를 해제한다(300쪽에서 캔버스 6~12개). 현재 쪽은 테두리로 표시하고 보기 밖이면 따라 스크롤한다. 주석(북마크 제외)이 있는 쪽은 개수 배지를 단다. 썸네일은 다크 모드 반전을 하지 않는다(원본 모습).
- **전체 검색:** 쪽마다 `getTextContent()`를 한 번 읽어 세션에 캐시하고, NFKC + 소문자 + 공백 하나로 정규화해 찾는다(대소문자·전각/반각·줄바꿈 무시). 결과는 쪽별로 앞뒤 문맥과 함께 보여 주고 최대 500개. 8쪽마다 UI에 양보하며 입력이 바뀌면 이전 검색을 중단한다. 결과를 누르면 텍스트 항목 안의 위치를 비례로 계산한 사각형으로 이동해 깜박인다(근사치). 기존 찾기 막대(⌘/Ctrl+F, 하나씩 이동)는 그대로 둔다.
- **같이 고친 것:** 펜 프로브 v3에서 펜을 뗀 뒤 화면 갱신이 300 ms 늦어져 `smoke-ui` 검사가 실패하던 것(0.5.1~0.6.0, 내보내는 JSON은 정상) — 즉시 한 번, 300 ms 뒤 한 번 그린다.
- **검증:** 하네스 `pages-search`: 300칸, 보이는 것만 그림(캔버스 ≤ 40), 썸네일 폭 104 px, 실제 페이지 픽셀, 끝으로 스크롤 시 앞쪽 해제·뒤쪽 그림, 썸네일 탭 이동과 현재 쪽 표시, "page 150" 검색 → 150쪽 이동·깜박임, 한글 검색(임베디드 글꼴 PDF 2쪽 모두).

## D-32 pdf.js 문서 id 접두사와 `--viewer-container-height` (2026-11-15, 0.7.1)
- **결정:** 빌드 변환으로 pdf.js 문서 id를 `d${n}`에서 `pendf_d${n}`으로 바꾼다. 이 id가 공유 문서의 글꼴 이름(`g_<id>_f…`, `g_<id>_s…`)과 SVG 필터 id(`g_<id>_…`)의 앞부분이라 이것 하나로 둘 다 분리된다. 워커는 메인에서 받은 id를 쓰므로 생성 지점은 메인 한 곳이다. 또 `PDFViewer`가 `<html>`에 쓰던 `--viewer-container-height`를 penDF 스크롤 컨테이너에 쓰게 바꾼다.
- **근거:** 코어 pdf.js도 `d0`부터 세므로 같은 이름으로 서로 다른 글꼴을 등록할 수 있다(Obsidian 밖 시험에서 실제 충돌 확인, INVESTIGATION §12). `<html>` 변수는 penDF가 코어 뷰어의 값을 덮어쓰고 있었다.
- **안전장치:** 두 규칙 모두 정확히 1회 일치해야 빌드가 된다(pdf.js를 올렸을 때 조용히 빠지지 않게). `check-standalone`이 빌드된 `main.js`에서 `pendf_d` 1회, 원래 패턴 0회, `--viewer-container-height`는 컨테이너에만 쓰는지 확인하고, `build-tools.test.ts`가 변환 결과를 확인한다.
- **대안:** 문서를 열 때마다 다른 id를 쓰게 pdf.js를 고치는 것(더 큰 패치), 또는 FontFace 대신 경로 렌더링(`disableFontFace`, 느림).
- **되돌리기:** `scripts/pdfjs-transform.mjs`의 두 규칙과 check-standalone의 `namespace-*` 검사를 지운다.
- **B-06:** 테스트 볼트에서 수정 전·후 빌드 모두 B-06이 재현되지 않았다(INVESTIGATION §12 Obsidian 재검증). 이 수정은 B-06의 해결책이라기보다 실제로 존재하는 이름 충돌을 막는 방어 수정이다.

## D-33 표준 글꼴 대체에서 `url(embedded://…)` 빼기 (2026-11-15, 0.7.1)
- **결정:** PDF에 들어 있지 않은 표준 글꼴(Helvetica-Bold 등)에 대해 pdf.js가 만드는 CSS 글꼴 소스 `local(…), …, url(<standardFontDataUrl><파일>)`에서, 경로가 penDF 내부 주소 `embedded:`이면 `url()`을 넣지 않는다(워커 변환, 1회 일치).
- **근거:** WebKit 스모크에서 로컬 글꼴이 없을 때 `embedded://standard_fonts/LiberationSans-Bold.ttf` 요청이 실패하고 콘솔 오류가 6번 났다(Chromium은 로컬 Arial을 찾아 드러나지 않음). iPad에서도 로컬 글꼴이 없으면 같은 일이 생긴다.
- **결과:** `local()` 시스템 글꼴은 그대로 쓰고, 없으면 브라우저 기본 대체 글꼴. 요청 실패와 콘솔 오류는 0.
- **대안:** `useSystemFonts: false`로 항상 내장 표준 글꼴(Foxit/Liberation)을 쓰기 — 어디서나 같은 모양이지만 지금 데스크톱 모양이 바뀐다. iPad 결과를 보고 결정한다.
- **되돌리기:** 변환 규칙을 지운다.

## D-34 전용 테스트 볼트와 안전장치 (2026-11-15, 0.7.1)
- **결정:** 데스크톱 하네스와 `install-dev`는 루트에 `.pendf-test-vault` 표지 파일이 있는 볼트에서만 돈다. 하네스는 디스크(`--path`)와 Obsidian 안(CLI가 실제로 연결된 볼트의 `basePath`)을 둘 다 확인한다. 경로는 테스트 볼트인데 `--vault SciWiki`처럼 다른 볼트를 가리키면 아무것도 설치하기 전에 멈춘다. 기본값은 볼트 이름 `pendf-testvault`, 경로 `<저장소 옆>/pendf-testvault`(저장소 안은 거부).
- **생성:** `node scripts/make-test-vault.mjs [<경로>]` — 폴더, 표지 파일, 최소 `.obsidian/`, fixture, 현재 빌드. 비어 있지 않은데 표지가 없는 폴더는 테스트 볼트로 바꾸지 않는다. Obsidian 등록(전역 설정 `obsidian.json`)은 하지 않고 사용자가 "Open folder as vault"를 한 번 한다. 새 볼트의 제한 모드는 하네스가 테스트 볼트 안에서 끈다.
- **근거:** 지금까지 하네스가 사용자 볼트(SciWiki)에 플러그인·fixture·사이드카를 쓰고 지웠다. 사용자 볼트는 손대지 않는다는 지시.
- **검증:** SciWiki 경로를 주면 디스크 검사에서, 테스트 볼트 경로에 `--vault SciWiki`를 주면 Obsidian 안 검사에서 거부되는 것을 확인했다(후자는 읽기만 함).
- **SciWiki에 남은 것(지우지 않음):** `.obsidian/plugins/pendf/{main.js,manifest.json,styles.css}`, `pendf-fixtures/`의 PDF 9개. 사이드카·로그·`data.json` 없음, `community-plugins.json`에 penDF 없음.
- **되돌리기:** `scripts/test-vault.mjs`의 `assertTestVault` 호출을 지운다.

## D-35 기본 열기(탭 전환)와 LinkRecorder — 동작 정리 (2026-11-15, 0.7.1 기준)
D-23, D-25, D-30을 합쳐 지금 코드가 실제로 하는 일을 한 곳에 적는다.

- **언제 전환하나:** 설정 "Open PDFs in penDF"(기본 켜짐)가 켜져 있을 때, `active-leaf-change`와 `file-open`(레이아웃 준비 뒤)에서 탭의 `getViewState().type`이 `"pdf"`이고 파일이 `.pdf`이면 같은 탭을 `setViewState({ type: "pendf-view", state: { file } }, eState)`로 바꾼다. 활성화되지 않은(지연 로드) 탭은 활성화될 때 바뀐다. 사용자가 "Open in Obsidian's PDF viewer"로 연 탭은 그 파일인 동안 바꾸지 않는다.
- **탭 전환 횟수:** Obsidian 자신의 열기가 우리 전환보다 늦게 끝나며 코어 뷰어를 한 번 더 세우므로, 보통 **전환이 2회** 일어난다. 첫 번째 penDF 로드는 곧 취소되어 PDF를 끝까지 여는 것은 1회다(하네스 `open-by-default`: 전환 2, "opened" 1). 코어 뷰어의 로드 비용은 그대로 든다.
- **링크 위치 전달:** Obsidian은 링크의 subpath(`#page=…&pendf=…&pendf-rect=…`)를 코어 뷰어에만 넘기고 공개 API로 알려 주지 않는다. 그래서 클릭을 가로채지 않고 **누른 링크를 기록**한다(`src/links/recorder.ts`).
  - 읽기 보기·백링크·검색 결과 등: 문서 캡처 단계 `pointerdown`에서 `a.internal-link`의 `data-href`(없으면 `href`).
  - 라이브 프리뷰·소스 모드: 공개 `registerEditorExtension`의 CodeMirror `mousedown`에서 누른 위치의 줄 텍스트로 `[[…]]`·`[…](…)` 링크를 찾는다.
  - 기록은 subpath가 있고 PDF로 해석될 때만 하고, **3초** 안에 같은 파일 탭이 전환될 때 한 번 쓰인다. 같은 탭이 위 이유로 다시 전환되면 **5초**까지 같은 subpath를 다시 쓴다.
- **후퇴(fallback):** 기록이 없으면(다른 플러그인이 코드로 연 링크, 빠른 전환기, 3초 초과) penDF는 그 파일의 기억된 위치에서 연다. `pendf=<id>`의 주석이 없으면(지워짐) 해당 쪽만 연다. 설정을 끄면 코어 뷰어가 `#page=N`을 처리하고 `pendf…` 파라미터는 무시한다(실측). penDF를 지우면 링크는 보통의 PDF 페이지 링크로 남는다.
- **iPad에서 확인할 것:** 손가락 탭이 읽기 보기에서 `pointerdown`, 라이브 프리뷰에서 CodeMirror `mousedown`으로 오는지(DEVICE_CHECKLIST 4-6, 4-7).

## D-36 WebKit 스모크 (2026-11-15, 0.7.1)
- **결정:** `pnpm smoke:webkit`(`scripts/webkit/smoke.mjs`)이 penDF의 실제 엔진 코드(`src/pdfjs`, 하이라이트 선택·기하)를 `main.js`와 같은 빌드 플러그인으로 묶어, Playwright의 WebKit과 Chromium에서 Obsidian 없이 돌린다. 확인: Blob 워커, 모든 fixture의 전 페이지 렌더링과 텍스트 추출, 뷰어 텍스트 레이어, 검색, 페이지 오류·콘솔 오류·요청 실패·처리 안 된 Promise 거부 0, 렌더링 전후 내장 객체(약 40종의 정적·프로토타입 속성) 추가·교체·삭제 0, 정답 선택 → quad 계산(기준 끝 오차 3 pt)과 WebKit·Chromium 차이. `--b06`으로 공유 이름 시나리오(D-32)도 돈다. CI의 `smoke-webkit` 작업이 매 push마다 돌린다.
- **개발 의존성:** `playwright` 1.64.1(한 달 전 판), `pdfjs-dist-core`(= `pdfjs-dist@5.3.31`, Obsidian 코어 pdf.js 5.3.34의 대역; 5.3.34는 npm에 없다). 둘 다 런타임 번들에 들어가지 않는다(check-standalone가 런타임 의존성을 `pdfjs-dist` 하나로 강제).
- **한계:** Playwright WebKit은 iOS WKWebView가 아니다. OS 글꼴·메모리 한도·터치/Pencil 입력·Obsidian 앱 껍데기·iPadOS 버전별 차이는 검사하지 못한다. 문법·내장 기능·워커·렌더링 문제를 iPad 전에 잡는 용도다.
- **찾은 것:** 표준 글꼴 `url(embedded://…)` 요청 실패(D-33, 고침). 시험 페이지에 `<html lang>`이 없으면 텍스트 레이어 폭이 5% 어긋남(측정 canvas와 DOM의 글꼴 대체 차이, INVESTIGATION §12).
- **결과(로컬, 2026-11-15):** WebKit 27.2·Chromium 156 모두 9개 fixture 319쪽, 오류 0, 내장 객체 변경 0, 끝 오차 −0.11/−0.18 pt, 엔진 간 quad 차이 최대 0.28 pt.

## D-37 하네스 검사의 위치 가정 (2026-11-16, 0.7.1)
- **결정:** `notes`, `persist-restart-rename`은 PDF를 연 뒤 1쪽으로 직접 이동하고, `state-restore`는 자기가 연 탭을 집는다(`getLeavesOfType(...)[0]` 대신).
- **근거:** 테스트 볼트에는 사용자가 연 penDF 탭이 있고, penDF는 파일마다 마지막 위치를 기억하므로 "열면 1쪽", "첫 penDF 탭 = 방금 연 탭"이라는 가정이 깨졌다(SciWiki에서는 우연히 맞았다). 제품 동작이 아니라 검사의 가정 문제다.
- **되돌리기:** 해당 줄을 이전 형태로.
- **추가(2026-11-16, 0.7.2):** 같은 종류의 순서 의존 둘을 더 찾았다. 둘 다 0.7.1 빌드로도 똑같이 실패해 제품 회귀가 아니다.
  1. `pdf-links`가 `highlight-palette`·`highlight-menu-undo`·`notes` 뒤에 돌면 링크 대상 쪽(9쪽, 12쪽)이 화면에 있는데도 pdf.js의 "현재 쪽"은 10쪽, 13쪽이었다(앞 검사가 남긴 뷰어 폭 때문). 판정을 "대상 쪽이 보이는 쪽에 들어 있음"으로 바꿨다.
  2. `fallback-main-thread`(플러그인을 끄고 켠 뒤 PDF를 연다)는 실행마다 절반쯤 시간 초과했다(처음엔 "첫 검사일 때"로 보였으나 단독 반복에서도 2번에 1번). 실패 때의 상태: penDF 탭이 하나도 없고 열려던 탭과 사용자 탭이 모두 `empty` 뷰. 뷰 등록을 기다려도 같았다. Obsidian이 다시 켜진 플러그인의 뷰를 다시 만드는 동안 검사가 탭을 열면 그 탭이 빈 뷰로 남는 경합이다(제품의 메인 스레드 대체 경로 문제가 아님: 열리기만 하면 매번 통과). 이어서 `unload-cleanup`도 남은 워커 때문에 실패하고, 그 뒤 그 창에서 Obsidian CLI가 응답하지 않은 적이 있다(창을 닫았다 다시 열면 회복). 하네스의 `openPenDF`가 탭이 우리 뷰를 유지하지 못하면 다시 열고(최대 3회), 플러그인을 켠 뒤에는 뷰 등록까지 기다린다. 이후 단독 6/6 통과.
  3. `links`가 `long-300.pdf`를 열 때 앞 검사가 남긴 기억된 위치 때문에 1쪽이 그려지지 않아 목차 링크를 못 찾은 적이 있다(가끔). 1쪽으로 직접 이동한다.
  4. `unload-cleanup`은 "이 실행에서 만들어진 blob 워커"를 penDF 것으로 셌다. `pdfjs-footprint`(하네스 자신의 pdf.js 프로브)가 먼저 돌면 그 워커가 섞여 "종료 안 됨"이 되고, 창이 복원한 penDF 탭이 이미 워커를 띄웠으면 이 검사 안에서는 새 워커가 없다. 워커 이름(`pendf-worker`)으로 penDF 워커를 가려, 이 실행에서 penDF가 띄운 모든 워커가 꺼짐 뒤 종료됐는지 본다(더 엄격). penDF 자체는 매번 정상이었다(워커 1개 종료, Blob URL 해제).
  5. 전체 실행은 `scripts/harness-batches.mjs`로 2~3개씩 12묶음, 묶음마다 테스트 볼트 창만 닫았다 다시 열고(다른 볼트 창은 건드리지 않음) Obsidian 프로세스 메모리와 시스템 여유 메모리를 기록한다. 중단되면 통과한 묶음은 건너뛰고 나머지만 잇는다. 상태는 `node_modules/.cache/pendf/harness-batches.json`.
  6. (0.8.0) `unload-cleanup`이 다시 실패했다: 하네스 준비 단계에서 Obsidian이 복원한 탭이 띄운 워커가 시작 확인(handshake)을 끝내지 못한 채 남았고, 플러그인을 끌 때 penDF가 그 워커를 몰랐다(`webWorker`는 확인 뒤에야 정해진다). **제품 버그로 고쳤다:** 모듈이 띄운 모든 워커를 기록해 `destroyWorker`가 전부 끝내고, 확인에 실패한 워커는 메인 스레드로 넘어가기 전에 끝낸다. 이 상태를 만드는 순서(`pdfjs-footprint` 직후에 `fallback-main-thread`)에서는 이제 대체 경로 검사가 그 경합을 다시 만나므로, 묶음을 `long-300-memory, pdfjs-footprint` / `fingerprint-mismatch, fallback-main-thread, unload-cleanup`으로 바꿨다(두 번 연속 통과, 전체 44/44).

## D-38 핀치·트랙패드 줌: 제스처 중에는 합성만, 손을 떼면 한 번 커밋 (2026-11-16, 0.7.2)
- **문제:** iPad에서 핀치 줌 중 화면이 검게 번쩍이고 끊긴다(사용자 보고). 0.7.1은 `TouchManager`의 `onPinching`마다 `viewer.updateScale({ scaleFactor, origin, drawingDelay: 400 })`을 불렀다. 0.7.1 기준선(`docs/evidence/zoom-baseline-0.7.1-*.json`, 하네스 `zoom-gesture`)에서 핀치 한 번에 pdf.js 배율 변경 10~29회, 레이어 제거 최대 13회, 손가락 아래 내용 이동 25~221 px, 프레임 간격 최대 36~49 ms였다.
- **결정:**
  1. **제스처 중:** `.pdfViewer`에 `transform-origin`(제스처 시작점)과 `translate() scale()`만 쓴다(rAF당 한 번). pdf.js에는 아무것도 알리지 않고, 레이아웃을 읽지 않으며, 레이어 관리(`LayerManager`)를 멈춘다(`setFrozen`). 배율은 0.1~10(시작 배율이 그 밖이면 시작 배율까지 허용)으로 묶고, 미리보기는 손을 뗀 뒤 스크롤로 닿을 수 있는 위치로 묶는다(문서 위·아래 끝, 컨테이너보다 좁아진 쪽은 가운데, `clampTranslate`). 두 손가락 팬도 같은 경로(떼면 스크롤).
  2. **손을 뗄 때(한 작업 안에서):** 미리보기에서 손가락 중심 아래 있던 쪽·쪽 안 비율을 기록 → transform 제거 → `viewer.currentScale = 새 배율` 한 번 → pdf.js가 동기로 보내는 `scalechanging` 안에서(아직 렌더할 쪽을 고르기 전) 그 점이 손가락 중심에 오도록 스크롤 보정 → 보이지 않는 쪽의 캔버스 해제 → 레이어 동기화 한 번. 브라우저는 최종 상태만 그린다.
  3. **바뀐 쪽의 그림:** pdf.js는 새 캔버스가 다 그려질 때까지 옛 캔버스(CSS로 늘린, 흐린)를 남겨 둔다. 그런데 그 재렌더가 취소되면(첫 커밋 직후 두 번째 핀치) 옛 캔버스까지 지워 쪽이 다음 렌더가 끝날 때까지 비었다. 빌드 변환 규칙 "keep the old page canvas when a re-render is cancelled"로 옛 캔버스를 남긴다(아래 pdf.js 내부 목록 7).
  4. **쪽 상자 맞춤:** pdf.js는 쪽을 새 배율로 그리기 시작할 때 쪽 상자를 캔버스 픽셀 격자에 맞춘다(`--scale-round-x/y`). DPR 2·캔버스 상한에서 이것이 커밋 뒤 레이아웃을 몇 px 옮겼다(하네스 iPad 프로필에서 3.8 px). 커밋 뒤 3초 동안 `pagerendered`마다 기준점을 다시 맞춘다(사용자가 그새 스크롤했으면 중단, 0.5~40 px만).
  5. **데스크톱 휠:** ⌘/Ctrl+휠 중 작은 픽셀 delta(트랙패드 핀치)는 같은 합성 경로로 연속 줌하고 이벤트가 160 ms 멈추면 커밋한다(배율 = Π exp(−Δy/100)). 마우스 휠 한 칸(줄 단위이거나 |Δy| ≥ 50)은 예전처럼 10% 한 단계이되, 같은 커밋 함수로 포인터 아래 내용을 고정한다. 툴바 버튼과 명령은 그대로 `updateScale({ steps, drawingDelay: 0 })`.
  6. **레이어:** pdf.js가 쪽을 리셋하며 모르는 자식(penDF 레이어)을 지우면 `MutationObserver`가 그 프레임이 그려지기 전에 되돌려 놓는다(`counters.restored`).
  7. **종이 배경:** `.canvasWrapper`에 흰 배경. 아직 그려지지 않았거나 iOS가 메모리를 못 받아 비어 있는 캔버스 뒤로 어두운 뷰 배경(`--background-secondary`)이 비치지 않는다. 반전 모드 필터 안에 있으므로 반전 시 어두운 종이가 된다. 원인: 스코프된 pdf.js CSS가 캔버스가 있는 쪽의 배경을 투명으로 바꾼다(`.page:has(> .canvasWrapper > canvas)`).
- **검증:** 하네스 `zoom-gesture`(9개 시나리오, 매 프레임 표본) 데스크톱과 iPad 프로필(DPR 2 + 모바일 렌더 설정) 모두 통과. WebKit/Chromium 스모크(DPR 2)에서 취소된 재렌더 때 캔버스 없는 프레임: 규칙 없이 1, 규칙과 함께 0. 수치는 REPORT.
- **pdf.js 내부에 기대는 지점(번들 6.5.438 고정, 지시에 따라 기록):**
  1. `TouchManager`(pdf.mjs export)의 `onPinchStart`/`onPinching(origin, prevDistance, distance)`/`onPanning(dx, dy)`/`onPinchEnd`, `isPinchingDisabled`. 0.1.0부터 쓰던 것. 임계값이 `OutputScale.pixelRatio`에 따라 바뀐다.
  2. `PDFViewer.currentScale` 설정자가 쪽 갱신·스크롤 뒤, `update()`(렌더할 쪽 선택) 전에 `scalechanging`을 **동기로** 보낸다는 순서(`#setScaleUpdatePages`). 커밋의 스크롤 보정과 캔버스 해제가 여기에 걸려 있다. 순서가 바뀌면 보정은 커밋 직후 다시 적용되지만(같은 배율이면 직접 호출) 첫 렌더가 화면 밖 쪽에 쓰일 수 있다.
  3. `PDFPageView.reset({ keepAnnotationLayer, keepAnnotationEditorLayer, keepXfaLayer, keepTextLayer })` — 쪽 캔버스 해제(`src/zoom/budget.ts`), `renderingState`(1 = 그리는 중이면 건드리지 않음), `div`.
  4. `PDFViewer` 옵션 `maxCanvasPixels`, `enableDetailCanvas`(D-39), 진단용으로 `viewer.maxCanvasPixels` 읽기.
  5. `pagerendered`의 `cssTransform`, `isDetailView`, `source.canvas`(타임라인, 진단 모드의 빈 캔버스 판정).
  6. 쪽 리셋이 모르는 자식을 지운다는 동작(레이어 복원), 그리기 시작 때 `--scale-round-x/y`로 쪽 상자를 맞춘다는 동작(4번).
  7. 빌드 변환(`scripts/pdfjs-transform.mjs`, pdf_viewer.mjs): `PDFPageView.draw()`의 취소 콜백 — 옛 캔버스가 문서에 붙어 있고 새 캔버스가 아직 안 붙었으면 새 캔버스를 0×0으로 비우고 `this.canvas = prevCanvas`로 되돌린다(`this.pendfKeptCanvas` 횟수 기록). 콜백은 `RenderTask.cancel()` 안에서 동기로 불리므로(`InternalRenderTask.cancel` → `task.onError`) 새 `draw()`보다 먼저 끝난다. 정확히 1회 일치해야 빌드되고 check-standalone가 `pendfKeptCanvas`를 확인한다.
- **더 이상 쓰지 않는 것:** 제스처의 `updateScale({ drawingDelay: 300/400 })`(후보 C: 손가락이 멈춘 사이 다시 그리기). 툴바 버튼과 명령만 예전대로 `updateScale({ steps, drawingDelay: 0 })`.
- **되돌리기:** `PdfView.installInput`을 0.7.1 형태로, 변환 규칙 하나 삭제.

## D-39 줌 렌더링 프리셋과 기본값 (2026-11-16, 0.7.2, 잠정)
- **결정:** 설정 → penDF → Diagnostics → **Zoom rendering**(`zoomRendering`). 바꾸면 열린 PDF를 다시 연다(PDFViewer 생성 옵션이므로).

  | 프리셋 | `maxCanvasPixels` 모바일 / 데스크톱 | 상세 캔버스 | 캔버스 예산 모바일 / 데스크톱 | 커밋 때 화면 밖 해제 |
  | --- | --- | --- | --- | --- |
  | Default | 5,242,880 / 2^25 | 켬 | 160 / 512 MB | 예 |
  | Memory saver | 2^21 / 2^23 | 켬 | 64 / 192 MB | 예 |
  | No detail canvas | 5,242,880 / 2^25 | 끔 | 160 / 512 MB | 예 |
  | pdf.js defaults | (pdf.js가 정함: iOS·Android 5,242,880, 그 밖 2^25) | (기본 켬) | 없음 | 아니오 |

  예산: 쪽이 그려질 때마다 쪽 캔버스(상세 포함) 합이 예산을 넘으면 보이는 범위에서 가장 먼 쪽부터 해제(보이는 쪽, 그 바로 앞뒤 쪽, 그리는 중인 쪽은 제외).
- **0.7.3 수정 — 예산 루프:** 0.7.2는 보이는 쪽만 보호했다. pdf.js는 보이는 쪽을 다 그린 뒤 다음 쪽을 미리 그리는데, 예산이 화면에 있는 것보다 작으면 그 쪽을 바로 해제하고 pdf.js가 다시 그리기를 끝없이 되풀이했다(데스크톱에서 예산 2 MB로 강제: 가만히 있는 4초 동안 렌더 554회). 기본값(데스크톱 512 MB)에서는 일어나지 않지만, iPad *Memory saver*(64 MB)에서는 보이는 두 쪽의 상세 캔버스(각 약 22 MB)와 앞쪽 하나로 넘을 수 있었다. 이제 보이는 범위 바로 앞뒤 쪽은 해제하지 않는다(예산은 화면 + 한 쪽만큼 넘을 수 있다). 하네스 `zoom-extras`가 예산 2 MB로 유휴 렌더 0회를 확인한다. 커밋 때의 화면 밖 해제는 한 번뿐이라 루프가 생기지 않는다.
- **0.7.3 수정 — 반전 모드의 빈 쪽:** 캔버스가 없는 쪽(아직 안 그렸거나 예산·커밋으로 해제된 쪽)은 쪽 자신의 배경(`--page-bg-color`, 흰색)을 보이는데, 이것은 `.canvasWrapper`의 반전 필터 밖이라 다크 읽기 모드에서 흰색으로 번쩍였다. `.pendf-root.pendf-invert`에서 `--page-bg-color: #000`(흰 종이를 반전한 색).
- **기본값 Default의 근거:** 0.7.1은 모바일에서 2^23(8,388,608 px = 쪽당 32 MB)을 썼다. pdf.js 자신의 iOS 값 5,242,880 px(20 MB)보다 크다(후보 A). iPad(DPR 2)에서 쪽 폭 맞춤이 대략 이 값에 닿으므로 그 이상 확대는 pdf.js의 상세 캔버스(보이는 부분만 고해상도)가 맡는다. pdf.js는 최근 쪽 10개 이상의 캔버스를 쥐고 있어 쪽당 크기만 줄여서는 합이 묶이지 않으므로 예산을 더했다.
- **잠정인 이유:** iOS의 실제 캔버스 메모리 한도와 검은 프레임의 직접 원인(후보 A)은 데스크톱에서 확인할 수 없다. DEVICE_CHECKLIST 7-3의 프리셋 비교와 7-2 타임라인으로 확정한다.
- **되돌리기:** `src/zoom/presets.ts`의 `default` 값을 바꾸거나, 사용자가 *pdf.js defaults*를 고른다.

## D-40 판정용 프리셋 "0.7.1 canvas cap" (2026-11-16, 0.7.3, 진단 전용)
- **결정:** 설정 → Diagnostics → Zoom rendering에 *0.7.1 canvas cap (diagnostic)*(`cap-071`)을 둔다. 모바일 `maxCanvasPixels` = 2^23(0.7.1 값, 데스크톱 2^25), 상세 캔버스 켬, **캔버스 예산 없음**, 커밋 때 화면 밖 캔버스 해제도 하지 않음 — 캔버스 크기와 메모리 동작을 0.7.1과 같게 한다. 나머지 0.7.2–0.7.3 수정(합성 전용 제스처, 취소된 재렌더 때 옛 캔버스 유지, 종이색 배경, 다크 모드 종이)은 그대로다.
- **목적:** 검은 번쩍임의 원인 판정. iPad에서 이 프리셋에서**만** 다시 나타나면 원인은 iOS 캔버스 메모리 한도(D-38 후보 A), 이 프리셋에서도 나타나지 않으면 원인은 0.7.2에서 고친 쪽(투명한 쪽 배경과 취소 시 캔버스 삭제, 멈춘 사이 재렌더)이었다(DEVICE_CHECKLIST 7-9).
- **커밋 때 해제도 끈 이유:** 해제는 0.7.2에서 메모리를 줄이려고 더한 것이라, 켜 두면 0.7.1보다 메모리가 적어 판정이 흐려진다. 지시가 남기라고 한 수정(합성, 캔버스 유지, 종이색, 앞뒤 보호)은 메모리 크기와 무관하므로 그대로 둔다(앞뒤 보호는 예산이 없으니 쓰이지 않는다).
- **기본값으로 쓰지 않는다:** 설정 설명에 "진단용, 평소에 쓰지 말 것"을 적었다. 판정이 끝나면 지워도 된다.

## D-42 보기 안 왼쪽 패널 (2026-11-17, 0.8.0)
- **결정:** 사이드바 패널의 탭(Outline, Pages, Search, Bookmarks, Annotations)을 penDF 보기 안 왼쪽 패널로도 띄운다. 탭 내용은 `src/panel/tabs.ts`의 공용 컴포넌트(`PanelContent`)이고 두 패널이 같은 코드를 쓴다. 탭은 `registerPanelTab()`으로 등록하므로 노트북·카드(Phase 8–9)가 탭으로 들어올 수 있다.
  - **배치:** 보기 너비 ≥ 패널 너비 + 560 px이면 페이지 옆 고정(docked), 아니면 페이지 위에 겹침(overlay). 겹침은 바깥(반투명 배경)을 누르면 닫히고, 패널 항목으로 이동하면 닫힌다. 패널 머리의 핀 버튼으로 "항상 겹침"을 고를 수 있다. 너비 200–480 px(기본 280), 오른쪽 가장자리를 끌어 바꾸며 고정일 때는 페이지 쪽 560 px를 남긴다. 겹침 너비는 보기의 85%까지.
  - iPad 기준: 가로(1024–1366 pt)는 고정, 세로(744–1024 pt)와 Split View는 대부분 겹침(세로 1024 pt인 12.9″만 고정). 560 px은 쪽 폭 맞춤에서 본문 글자가 읽히는 최소 폭으로 잡았다.
  - **왼쪽 가장자리 스와이프로 열지 않는다**(iPad Obsidian의 왼쪽 사이드바 제스처). 툴바 목록 버튼과 명령으로만 연다.
  - **읽던 위치 유지:** penDF가 "너비 맞춤" 상태를 직접 추적한다(pdf.js 컴포넌트는 컨테이너 크기가 바뀌어도 다시 맞추지 않는다). 스크롤할 때마다 화면 위쪽 가장자리의 내용(쪽 + 쪽 안 비율)을 기록해 두었다가, 보기 너비가 바뀌면(패널 열기·닫기·너비 변경, 창, Split View) 너비 맞춤이면 다시 맞추고 그 내용을 위쪽 가장자리로 되돌린다. 하네스 실측: 고정 패널 열기 0.38 px, 너비 변경 0.25 px, 닫기 0 px 어긋남.
  - **기억:** 열림·탭·너비·핀(고정/겹침 선호)은 보기 상태(작업 공간 `state.panel`)로, 파일별이 아니다. Outline의 펼침 상태는 파일별(플러그인 데이터의 파일별 보기 기억).
  - **설정 "Panel location":** In the penDF view(기본) / Obsidian sidebar. 툴바 목록 버튼과 명령(Show outline, Show page thumbnails, Search the whole PDF, Show bookmarks, Show annotations panel)이 이 설정을 따른다.
  - **썸네일:** 보이는 것(±300 px)만 그리고 화면 밖은 해제한다. 썸네일 캔버스는 보기의 캔버스 메모리 예산(D-39)에서 먼저 빼고 남은 만큼을 쪽 캔버스가 쓴다. 현재 쪽을 강조하고 따라간다. Outline은 현재 장·절(접혀 있으면 보이는 가장 가까운 조상)을 강조한다.
- **근거:** iPad에서 Obsidian 오른쪽 사이드바는 화면을 가리는 서랍이라 읽으면서 쓰기 어렵다. 같은 내용을 보기 안에 두면 PDF와 함께 보인다.
- **대안:** 패널 위치를 오른쪽에 두기(여백이 오른쪽에 열리므로 겹친다), 가장자리 스와이프(Obsidian 제스처와 충돌), 매번 겹침(가로 화면에서 공간 낭비).
- **되돌리기:** 설정을 Obsidian sidebar로. 코드는 `src/panel/InViewPanel.ts`, `PdfView.installResizeKeeping`.

## D-43 툴바: 이름표, 묶음, "더 보기" (2026-11-17, 0.8.0)
- **결정:** 모든 버튼에 `aria-label`과 Obsidian `setTooltip`(1.4.4+). 터치·펜으로 길게(450 ms) 누르면 이름표가 1.6초 보이고 버튼은 실행되지 않는다(iPad에는 hover가 없다). 묶음: 이동·배율 | 주석 도구 | 실행 취소 | 찾기·링크·패널. 각 버튼에 우선순위(1 항상, 2, 3)를 두고, 한 줄에 안 들어가면 3, 그다음 2를 오른쪽부터 "More"(⋯) 메뉴(Obsidian `Menu`)로 넘긴다. 항상 보이는 것: 메모, 필기, 실행 취소, 패널(그리고 쪽 번호 입력).
- **근거:** iPad 세로·Split View에서 툴바가 가로 스크롤되어 버튼이 숨었다.
- **되돌리기:** `src/view/toolbar.ts`의 우선순위를 모두 1로.

## D-41 여백 공간 (Phase 7a, 2026-11-17, 0.8.0)
- **결정:** 여백은 **각 쪽 상자의 일부**다. 여백을 켜면 pdf.js 쪽 div의 투명 테두리(원래 9 px)를 여백 쪽으로 `비율 × 쪽 너비(고유 방향) × 배율`만큼 넓힌다(CSS 변수 `--pendf-margin-pts` × `--total-scale-factor`). 여백 배경은 쪽의 `::before`, 여백 안 내용은 기존 레이어(SVG `overflow: visible`)가 그린다.
  - 왜 테두리인가: 절대 위치 자식(pdf.js 텍스트·주석 레이어, penDF 레이어)은 패딩 상자 기준이라 테두리를 넓혀도 자리가 바뀌지 않는다(하이라이트 정답 끝 오차 여백 75%에서 ≤ 0.45 pt, 회전 4종·CropBox). pdf.js의 쪽 배치(가운데 정렬), 보이는 쪽 계산(`offsetWidth`), 스크롤·링크 이동(`offsetLeft + clientLeft`)이 테두리를 포함해 계산되므로 그대로 맞는다. 포인터가 여백 위에 있어도 쪽 요소가 잡히므로(§13) 필기·지우개·메모 코드는 바꾸지 않았다. 줌 제스처(D-38)의 합성 변형에도 그대로 따라간다(하네스: 여백 안 점 기준 줌 커밋 0.45 px, 획 위치 변화 0).
  - 대안과 버린 이유: pdf.js 뷰포트(view box)를 넓히기 — 빈 영역까지 캔버스로 그려 메모리를 쓰고 텍스트 레이어 좌표가 바뀐다. 쪽 옆 별도 레이어 — 포인터 판정·스크롤·줌 기준점 코드를 모두 따로 맞춰야 한다. `padding` — 절대 위치 자식의 기준 상자가 바뀌어 텍스트 레이어가 어긋난다. `margin` — pdf.js 가운데 정렬(`margin: auto`)이 깨진다.
- **쪽(방향) 규약:** "오른쪽"은 쪽 고유 /Rotate를 적용한 표시 방향 기준. 사용자가 보기를 돌리면 여백이 쪽과 함께 돈다(보기 90°에서 오른쪽 여백은 화면 아래). SCHEMA.md "Off-page coordinates".
- **너비 맞춤:** penDF의 너비 맞춤(D-42)이 여백을 포함해 맞춘다(pdf.js 쪽 폭 배율 ÷ (1 + 비율)). 여백을 켜고 끄거나 너비를 바꾸면 위쪽 내용 기준으로 위치를 보정한다.
- **저장:** 여백 표시·쪽·비율은 보기 설정으로, 플러그인 데이터의 파일별 보기 기억(`positions[path].margin`)에 둔다. 사이드카에는 넣지 않는다. 새 여백의 기본 쪽·비율은 설정(오른쪽, 50%; 25/50/75/100%).
- **자동으로 켜기:** PDF를 열 때 주석이 쪽 상자 밖 좌·우로 1% 넘게 나가 있으면 여백을 켠다 — 내용이 더 많은 쪽, 설정 너비와 "가장 먼 내용 + 5%" 중 큰 값(최대 300%). 파일별로 꺼 두었더라도 내용이 있으면 켠다(지시).
- **숨은 내용:** 여백이 닫혀 있거나 좁으면 레이어를 쪽 상자(+12 px, 메모 표식 여유)로 자르고(`clip-path`), 내용이 있는 쪽 가장자리에 작은 표식(강조색 막대)을 둔다.
- **여백에서 되는 것:** 펜·형광펜·지우개, 점 메모 만들기·누르기·이동(메모 팝오버의 Move → 다음 탭, 다른 쪽으로도, 실행 취소 가능)·삭제. 텍스트 하이라이트는 본문에만(여백에는 텍스트가 없다).
- **썸네일:** 쪽만 그린다(여백 내용 없음). 썸네일 비율·클릭 이동은 그대로 맞는다. 여백 내용을 썸네일에 그리는 것은 범위 밖으로 둔다.
- **캔버스:** 여백은 캔버스를 만들지 않는다. 300쪽 PDF, 여백 50% + 고정 패널, 5곳 이동: 쪽 캔버스 최대 10개, 최대 10 MB(데스크톱 DPR 1).
- **Phase 11(PDF로 내보내기):** 여백 내용을 PDF에 쓰려면 그 쪽의 MediaBox(및 CropBox)를 여백까지 넓혀야 한다. 원본 무수정 원칙상 내보내기는 사본에 한다.
- **되돌리기:** 여백을 끄면 테두리는 9 px로 돌아간다. 코드 `src/margin/`, 스타일 `src/styles.css` "margin space".

## D-44 영역 발췌 (Phase 7b, 2026-11-17, 0.8.0)
- **데이터:** 새 주석 `area` — `quad`(하이라이트와 같은 순서), `color`, `text`(영역 안 텍스트: 텍스트 항목의 중심이 영역 안에 있는 것, 원래 대소문자), `label`(선택). 이미지는 저장하지 않고 필요할 때 pdf.js로 그 영역만 렌더링한다. 메모 대상에 `{ kind: "annotation", id }`를 더했다. 하이라이트 메모는 계속 옛 형식(`highlight`)으로 쓴다 — 0.7.x에서도 보이게. 읽기는 두 형식 모두.
- **호환성 / 스키마 버전:** 0.7.3 파서(사본 `tests/compat/v073`)로 왕복 시험: 0.7.3은 `area`와 `annotation` 메모를 `unknown`에 넣고 그대로 다시 쓴다(동기 병합도 보존). 0.8.0 파서는 이제 `unknown` 안에서 검증되는 항목을 주석으로 되돌린다(같은 id가 양쪽에 있으면 병합 규칙). 이 고침이 없으면 0.7.3 기기를 한 번 거친 영역이 0.8.0에서도 `unknown`에 갇혀 사라져 보였을 것이다. 결과가 손실 없음이므로 **schemaVersion은 1로 둔다**(올리면 0.7.3이 파일을 읽지 못하고 읽기 전용이 된다).
- **입력 우선순위:** 영역 도구가 켜져 있으면 Pencil·손가락·마우스 모두 끌어서 사각형을 그린다(필기, Pencil 상시 필기, 메모 놓기, 손가락 스크롤·글자 선택보다 우선; `touch-action: none`). 두 번째 손가락이 닿으면 그리기를 취소하고 평소처럼 핀치 줌. 도구를 켜면 필기 모드와 메모 놓기가 꺼지고, 필기·메모 놓기를 켜면 영역 도구가 꺼진다. 도구가 꺼져 있으면 기존 규칙(Pencil 필기, 손가락 스크롤·선택, 두 손가락 핀치) 그대로. 작게 누르기(6 px 미만)는 그리기가 아니라 영역 누르기.
- **동작:** 그리면 메뉴가 바로 열린다(색 → 메모·링크·이미지 복사·이미지로 저장·삭제). 영역을 누르면 같은 메뉴. 모두 실행 취소/다시 실행. 삭제하면 그 영역의 메모도 함께 지운다.
- **이미지:** 배율 = 설정(1–4×, 기본 2×) × 100% 배율(픽셀/pt = 배율 × 96/72), 쪽 고유 /Rotate로 바로 선 그림. 크기 상한: iOS 캔버스 한도(16,777,216 px), 프리셋의 쪽 캔버스 상한, 그리고 D-39 예산에서 지금 쓰는 쪽·썸네일 캔버스를 뺀 나머지(최소 1 M px) 중 작은 값 — 넘으면 해상도를 낮춘다. "Copy image"는 클립보드 API(`ClipboardItem`), 안 되면 "Save image"를 쓰라고 알린다. "Save image"는 `FileManager.getAvailablePathForAttachment`(1.5.7부터, minAppVersion과 같음)로 Obsidian 첨부 파일 위치에 `<PDF 이름> p<쪽> excerpt.png`를 만들고 경로를 알린다. 패널 썸네일은 220 px, 썸네일 캔버스로 예산에 들어간다.
- **링크:** 기존 형식 `#page=N&pendf=<id>`. 열면 그 영역으로 가서 깜박인다.
- **검증:** fixture `areas.pdf`(회전 4종 + CropBox, 알려진 좌표의 채운 사각형). 하네스 `area-ground-truth`(Pencil·손가락 끌기, 저장된 quad 오차 0 pt, 텍스트 "Figure N"), `area-image`(픽셀: 사각형 색 포함·주변 흰색, 크기 정확, 저장·복사·패널 썸네일), `area-link`. WebKit·Chromium 스모크도 5/5.
- **대안:** 이미지를 사이드카나 볼트에 저장(파일이 커지고 PDF와 어긋날 수 있다), 별도 이미지 주석 형식.
- **되돌리기:** 툴바·명령을 빼면 기존 데이터는 그대로 남는다(0.7.x와 같은 `unknown` 보존).

## D-45 볼트 전체 주석 색인 (Phase 8 기반, 2026-11-17, 0.8.0)
- **결정:** `src/index/` — 볼트의 `*.pdf.pendf.json`에서 (a) PDF 지문 → 현재 PDF 경로들(복사본이면 여럿), (b) 주석 id → { 지문, 종류, 쪽, 색, 텍스트 앞부분 160자, updatedAt }을 유지한다(삭제 표시는 뺀다). 참조 해석기 `{ fp, id }` → 현재 경로들 + 주석(복사본이 여럿이면 가장 최근에 고친 사본, 그 사본의 경로를 `path`로). 이후 노트북은 주석을 이 형식으로만 가리킨다.
  - **구축:** 레이아웃 준비 4초 뒤 또는 처음 쓸 때 지연 구축. 12 ms마다 UI에 양보(조각 처리). 캐시(`<플러그인 폴더>/annotation-index.json`, 재구축 가능한 데이터 — 볼트의 노트 영역에는 아무것도 만들지 않는다)를 먼저 읽고 mtime이 바뀐 사이드카만 다시 읽는다.
  - **증분 갱신:** vault `create`/`modify`(300 ms 모아서 다시 읽기), `delete`, `rename`(PDF 이름을 바꾸면 penDF가 사이드카를 옮기고, 그 이름 바꾸기 이벤트로 색인 경로가 바뀐다). 캐시 저장은 변경 5초 뒤.
  - **UI:** 명령 "Search annotations in vault" — 낱말(텍스트와 PDF 경로), `type:highlight|note|area|bookmark|ink`, `color:<설정의 색 이름 | #hex>`; 고르면 penDF로 그 주석 위치를 열고 깜박인다.
- **성능(하네스 `index-perf`, 실제 테스트 볼트, 데스크톱):** 합성 사이드카 500개·주석 50,000개 — 처음 구축 108 ms(파일 501개 읽기·파싱·검증 포함), 메인 스레드를 가장 오래 잡은 조각 12.4 ms(7조각), 캐시로 다시 시작 46 ms(다시 읽은 파일 0), 사이드카 하나 바뀜 → 반영 329 ms(그중 300 ms는 모으기 지연), 검색 18.6 ms. 단위 시험(Node): 구축 103 ms, 힙 약 34 MB, 갱신 0.28 ms, 이름 바꾸기 0.02 ms. iPad에서는 파일 읽기가 더 느릴 것이다(DEVICE_CHECKLIST).
- **대안:** Obsidian 메타데이터 캐시(마크다운이 아닌 JSON은 다루지 않는다), 노트 영역에 색인 파일(사용자 볼트 오염), 웹 워커(파일 읽기가 Obsidian API라 이득이 적다).
- **되돌리기:** `main.ts`의 색인 등록 부분을 지우고 플러그인 폴더의 `annotation-index.json`을 지운다.
