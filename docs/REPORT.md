# REPORT — PDF+++ Phase 1(뷰어와 공통 기반) + Phase 2(하이라이트)

세션 날짜 2026-11-13. 저장소 `C:\Users\denny\pdf-ppp`(git init만 하고 원격은 없음, B-02).
개발 환경: Windows 11, Obsidian 1.15.1(Electron 37 / Chromium 138), Node 22, pnpm 10.

## 요약

- 다른 플러그인 없이 동작하는 독립 `FileView` PDF 뷰어와 하이라이트를 구현했다. pdf.js는 6.5.438 **modern 빌드를 번들**한다. 너무 새로운 내장 기능은 빌드 시 모듈 지역 함수로 치환하므로, Obsidian 창의 전역과 내장 객체를 하나도 바꾸지 않는다.
- `main.js` 3.21 MB(5 MB 미만). 워커, CJK CMap, 표준 글꼴, JBIG2/JPX 디코더를 모두 넣었고, 네트워크 요청은 0건이다.
- 단위 테스트 122개(vitest)와 실제 Obsidian에서 돌리는 데스크톱 하네스 19개 검사가 모두 통과한다. 18개는 전체 실행으로(`docs/evidence/harness-2026-11-13-modern.json`), 마지막에 추가한 팔레트 검사는 따로 돌렸다. iPad 항목은 `DEVICE_CHECKLIST.md`로 넘겼다.
- 진행하면서 지시문에 없던 문제 셋을 찾아 고쳤다. (1) pdf.js가 쓰는 CSS 중첩을 스코핑하다가 깨뜨린 문제. (2) Obsidian의 전역 `border-box`가 페이지 안으로 새는 문제. (3) legacy 빌드의 core-js가 공유 창의 내장 객체를 교체하는 문제. 마지막 것 때문에 처음 계획한 legacy 빌드를 버렸다(D-03, D-13).

## 완료 기준 대조

### Phase 1

| 기준 | 상태 | 근거 |
| --- | --- | --- |
| `pnpm build`, `pnpm test`, `pnpm lint`(check-standalone 포함) 통과, `main.js` 크기 기록 | ✅ | 빌드 3,361,584 B(`build-size.json`, `docs/evidence/build-size-2026-11-13.json`), 테스트 122/122, lint OK |
| 데스크톱에서 fixture 전부 표시·검색·내부 링크 이동·상태 복원 | ✅ | 하네스 `fixtures-render`(9종), `search`, `links`(페이지 링크, 300쪽 목차 링크, 외부 URL), `state-restore`(작업 공간 상태와 파일별 위치 기억) |
| 코어 PDF 뷰어로 같은 파일을 동시에 열어도 양쪽 정상 | ✅ | `coexistence-core-first`, `coexistence-ppp-first`: 분할 화면 양쪽 렌더링, `window.pdfjsLib`(코어 5.3.34)의 동일성과 버전 유지 |
| 플러그인을 끈 뒤 DOM·리스너·워커가 남지 않음 | ✅ | `unload-cleanup`: 우리 DOM 0, 워커 3개 모두 terminate, Blob URL 모두 해제, 저장 전 하이라이트도 디스크에 기록됨, 스타일 제거. 리스너는 `registerEvent`/`registerDomEvent`/AbortController로 묶여 있어 직접 셀 수 없다. 잔여 DOM 0과 워커 종료로 간접 확인했다 |
| (목표 문서) 300쪽 PDF 끝까지 스크롤·줌, 비공개 API 0 | 데스크톱 ✅ / iPad 대기 | `long-300-memory`: 3가지 배율로 300쪽을 훑는 동안 캔버스 최대 10, 주석 레이어 최대 4, 렌더 상태 페이지 최대 10. check-standalone 통과 |

### Phase 2

| 기준 | 상태 | 근거 |
| --- | --- | --- |
| 여러 줄, 2단 조판, 회전 페이지, 한국어에서 하이라이트가 선택 범위와 일치 | ✅ | `highlight-ground-truth`: `/Rotate` 0·90·180·270 페이지와 CropBox 페이지에서, 저장된 쿼드가 fixture에 그린 위치와 x 기준 0.32 pt 이내로 일치. `highlight-multiline-columns`: 4줄 → 쿼드 4개, 단을 넘지 않음. `highlight-korean`: 임베디드·CMap 한글 모두 IoU 0.6 초과 |
| 줌·회전·재시작·파일 이름 변경 후에도 위치 유지 | ✅ | 같은 하이라이트를 220%, 80%, 보기 회전 90°·270°에서 다시 재면 화면상 IoU 0.92–1.0. `persist-restart-rename`: 플러그인 재시작과 이름 변경 후 개수 유지, 사이드카가 함께 이동 |
| 탭하여 색 변경·삭제, 실행 취소 | ✅ | `highlight-menu-undo`(색 변경 → 삭제 → 실행 취소 ×2 → 다시 실행), `highlight-palette`(선택 → 팔레트 → 스와치 → 정확히 1개 생성) |
| 페이지를 넘는 선택은 그룹 id로 묶음 | ✅ | `highlight-cross-page` |
| PDF 원래 주석은 표시만 | ✅ | pdf.js 주석 레이어(`AnnotationMode.ENABLE`). 편집기는 끔 |

### 테스트(지시문 5절)

| 항목 | 결과 |
| --- | --- |
| 좌표 변환 왕복(회전 4종 × CropBox 오프셋 유무) 오차 0.01 pt 이내 | ✅ 3종 박스 × 4 회전 × 3 배율. 추가로 fixture 페이지에서 pdf.js 자체 `PageViewport`와 행렬이 일치함(1e-9) |
| 사이드카 1,000건 왕복 좌표 오차 0.5 pt 이내, 속성 보존 | ✅ 네 종류 모두 |
| 병합: 동시 추가, 한쪽 삭제, updatedAt 충돌, 중복 id | ✅ 교환법칙·멱등성도 확인 |
| 줄 사각형 병합, 페이지 경계 선택 분할 | ✅ (jsdom) |
| 스키마 검증과 마이그레이션 | ✅ |
| check-standalone 자체 테스트 | ✅ 금지 패턴 11종, 주석 무시, 의존성 버전, `main.js` 누락 시 실패, gzip 워커 내부까지 검사 |

## 구현 목록

- **뷰(`src/view/PdfView.ts`)**: 파일 메뉴 "Open in PDF+++", 명령(현재 PDF 열기, PDF 선택, 찾기, 하이라이트, 실행 취소/다시 실행, 줌, 너비 맞춤, 로그 내보내기, 펜 프로브), 연속 스크롤과 가상화, 핀치 줌(`TouchManager`), ⌘/Ctrl+휠 줌, 회전, 페이지 이동, 검색 바, 내부·외부 링크, 비밀번호 PDF, 작업 공간 상태와 파일별 위치 기억(최대 300개), 페이지 색 반전, 디버그 HUD.
- **공통 기반**: `src/geometry`(PageViewport와 같은 변환, 쿼드, 클라이언트→페이지), `src/store`(스키마 v1 네 종류, 검증, 마이그레이션 골격, 병합, 원자적 저장, `.tmp` 복구, 지문 보호, 외부 변경 병합, 이름 변경 추적, 실행 취소 스택), `src/layers`(보이는 페이지 ±1에만 SVG 레이어).
- **하이라이트(`src/highlight`)**: 선택 캐시, 4색 팔레트(설정에서 색과 기본색 지정), 줄 병합, 페이지별 분할, 텍스트 정규화, 탭 메뉴(색 변경·복사·삭제), 그룹 단위 편집.
- **pdf.js 통합(`src/pdfjs`, `scripts/`)**: 전역 제거 변환, ponyfill 치환, Blob module worker와 메인 스레드 폴백, 임베디드 `BinaryDataFactory`, CSS 스코핑, 엔진 검사.
- **펜 프로브(`src/probe`)**: pointerType, 필압, 소수점 좌표, 이벤트 빈도, coalesced/predicted 지원과 샘플 수, `Touch.touchType`, touch-action 값별 스크롤 여부를 측정해 JSON으로 내보낸다.
- **도구**: 결정적 fixture 생성기(9종 + 정답 좌표), `install-dev`, 데스크톱 하네스, 태그 릴리스 워크플로(draft).

## 지시문과 달리 한 것

| 내용 | 이유 |
| --- | --- |
| legacy가 아니라 modern 빌드 + 빌드 시 ponyfill | legacy core-js가 공유 창의 내장 객체를 추가·교체함을 실측(D-03, D-13). 스탠드얼론 원칙이 우선 |
| Windows에서 개발 | 세션 환경. 스크립트는 모두 Node라 Ubuntu에서도 그대로 돈다(D-01) |
| 하이라이트 메뉴에 "텍스트 복사" 추가 | 비용이 작고 Phase 4 링크 복사의 기반이 된다 |
| 워커를 뷰마다 만들지 않고 공유, 유휴 60초 뒤 종료 | iPad 메모리(D-07). 플러그인을 끄면 즉시 종료 |
| 데스크톱 하네스 추가 | 완료 기준 대부분이 데스크톱에서 확인 가능하므로, 단위 테스트로 잡을 수 없는 CSS·렌더링 문제를 실제 Obsidian에서 잡기 위해(D-17) |

## 미완료 / 확인 못 한 것

- **iPad 실기기 전 항목**(B-01) → `DEVICE_CHECKLIST.md`. 특히 0-1 엔진 검사, 0-2 Blob module worker, 1-2 300쪽 메모리, 2-1 팔레트와 iOS 선택 메뉴의 겹침, 펜 프로브.
- **Obsidian 재시작 후 하네스 1회**(B-04): 개발 중인 SciWiki 창에 legacy 빌드의 core-js 흔적이 남아 있다. 깨끗한 realm 검사는 이미 통과했다. 사용자의 Obsidian은 재시작하지 않았다.
- **원격 저장소와 릴리스**(B-02): 지시문대로 원격을 설정하지 않았다. 워크플로는 작성했지만 실행되지 않았다.
- 리스너 누수를 직접 세는 검사(간접 확인만 함).
- 데스크톱 Obsidian의 오래된 설치 파일(Electron < 122)은 Iterator 헬퍼가 없어 엔진 검사 배너가 뜬다. 데스크톱은 지시문상 개발·디버깅 대상이라 대응하지 않았다.

## 남아 있는 것(사용자 환경)

- SciWiki 테스트 볼트에 `.obsidian/plugins/pdf-ppp/`(꺼진 상태, `community-plugins.json`에는 넣지 않음)와 `pdf-ppp-fixtures/` 폴더(fixture PDF 9개)를 남겨 두었다. 데스크톱에서 직접 시험해 볼 때 쓰면 된다. 필요 없으면 두 폴더를 지우면 된다. 탭·심·사이드카·`data.json`은 모두 되돌렸다.

## 열린 질문

1. **이름**: "PDF+++"는 PDF++와 무관한 플러그인이라 오해를 부른다. 공개 전에 새 이름과 plugin id가 필요하다(id를 바꾸면 사용자 설정 경로도 바뀌므로 첫 공개 전에 정하는 편이 낫다).
2. **동기화 방식**: Obsidian Sync라면 "Sync all other types"를 켜야 사이드카가 오간다(D-15). iCloud나 Git이면 상관없다. 무엇을 쓰는지 알려 주면 병합 우선순위와 안내를 확정하겠다.
3. "모노 펜"을 필압 없는 균일 굵기 펜으로 해석했다(목표 문서). 단색 펜을 뜻한 것이라면 알려 달라.
4. 링크 파라미터(`&ink=` 등)를 코어가 무시하고 해당 페이지로 여는지는 Phase 4 전에 확인해야 한다.
5. PDF 표준 주석으로 내보낸 항목을 사이드카에서 지울지, 연결만 남길지(Phase 6 이후).

## 다음 세션 권장 작업

1. iPad에서 `DEVICE_CHECKLIST` 0–2절을 진행하고 로그와 펜 프로브 JSON을 가져온다. 결과에 따라 `maxCanvasPixels`, 팔레트 위치, touch-action을 조정한다.
2. `gh repo create dhwan0112/pdf-ppp --private --source . --push` 후 `0.1.0` 태그를 단다. draft 릴리스를 확인하고 BRAT로 설치한다.
3. Obsidian을 재시작한 뒤 하네스를 한 번 돌린다.
4. Phase 3(텍스트 주석): 스키마의 `note`는 이미 정의되어 있다. 하이라이트 메뉴에 "메모"를 추가하고, 페이지별 목록 패널(`ItemView`)과 마크다운 렌더링(`MarkdownRenderer`, 공개 API)을 만든다.
5. pdf.js를 올릴 때: `pnpm add pdfjs-dist@<정확한 버전>`, `pnpm build`. 전역 변환 규칙이나 ponyfill이 소스 모양 변화를 만나면 빌드가 실패하므로 그때 규칙을 고친다. 엔진 검사 목록도 다시 확인한다.

## 커밋

```
1fd42cf fix(highlight): keep the iOS selection while the palette is touched
044dd65 feat: modern pdf.js with build-time ponyfills instead of core-js
97d5517 test(harness): reveal the PDF+++ leaf in coexistence checks; diagnostics
0dfc589 fix: keep pdf.js CSS nesting intact and undo Obsidian's border-box
96a69f5 test: vitest suite, check-standalone, worker shutdown safety
0e44ede chore: scaffold PDF+++ plugin with bundled, global-free pdf.js
```
