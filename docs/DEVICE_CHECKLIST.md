# DEVICE_CHECKLIST — iPad 실기기 확인

Claude Code는 iPad에 접근할 수 없다. 아래 항목은 데스크톱(Windows, Obsidian 1.15.1 / Chromium 138)에서 구현과 자동 검증(`scripts/obsidian-harness.mjs`)까지 끝냈고, iPad에서 확인할 일만 남았다.

## 준비

1. BRAT로 `dhwan0112/pendf`를 설치한다(최신 릴리스).
2. `pnpm fixtures`로 만든 `fixtures/out/*.pdf`를 볼트의 `pendf-fixtures/` 폴더에 넣는다.
3. 설정 → penDF에서 **Debug overlay**를 켠다. 펜 프로브 항목을 확인할 때는 **Pen probe**도 켠다.
4. 문제가 생기면 명령 팔레트 → **penDF: Export log to vault**를 실행해 만들어지는 `pendf-log-*.md`를 가져온다. Linux에서는 iPad 웹뷰를 원격으로 검사할 수 없을 수 있으므로, 이 로그가 주 진단 수단이다.

모든 항목은 **확인 절차 / 기대 결과 / 실패 시 의심 지점** 순서다.

## 0. 엔진·워커 (가장 먼저)

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 0-1 | 아무 PDF나 penDF로 연 뒤 로그를 내보내고 `engine:` 줄을 본다 | `"ok":true`, `missing: []` | 빌드 시 대체(ponyfill)하지 않은 최신 내장 기능이 iPadOS WebKit에 없음. `src/pdfjs/engine.ts`의 REQUIRED 목록, 화면 상단 빨간 배너 |
| 0-2 | 같은 로그에서 `web worker ready` 또는 `falling back to main-thread`를 찾는다 | `web worker ready (blob URL, module)` | Blob URL module worker가 iOS에서 막힘. 폴백으로도 렌더링은 되지만 큰 PDF에서 UI가 끊긴다. `src/pdfjs/index.ts`의 `createWorker()` |
| 0-3 | 같은 로그의 `ponyfilled` 항목을 기록한다(정보용) | 어떤 값이든 괜찮음. iPadOS가 기본 지원하는 기능 목록 | 해당 없음 |

## Phase 1 — 뷰어

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 1-1 | 파일 목록에서 `a4.pdf`를 탭한다(0.1.5부터 기본으로 penDF가 연다) | penDF 툴바가 보이고 `/ 3`이 나온다. 코어 뷰어가 잠깐 보였다가 바뀔 수 있다 | 0-1, 0-2. 코어 뷰어로 남으면 설정 → penDF → Open PDFs in penDF |
| 1-2 | `long-300.pdf`를 열고 손가락으로 끝까지 빠르게 스크롤, 중간중간 핀치 줌(50%~300%), 다시 처음으로 | 앱이 종료되지 않는다. HUD의 `canvases`가 대략 10~20 사이를 유지한다 | 캔버스 메모리. 설정 → penDF → Diagnostics → **Zoom rendering**을 *Memory saver*로 바꾸고 다시 한다(7장) |
| 1-3 | 1-2 직후 HUD의 `renderMs`와 체감 속도를 기록한다 | 한 페이지가 1초 안에 그려진다 | 0-2 폴백 여부 |
| 1-4 | `korean-cmap.pdf`(글꼴 미포함, CMap 필요)와 `korean-embedded.pdf`를 연다 | 두 파일 모두 한글이 깨지지 않는다 | CMap 임베드(`pendf:assets`) 또는 iOS의 CJK 대체 글꼴 |
| 1-5 | `a4.pdf`에서 손가락으로 단어를 길게 눌러 선택하고 핸들을 끈다 | 텍스트가 선택되고, 선택 영역이 글자와 겹친다 | 텍스트 레이어 CSS(중첩 규칙 스코핑, `box-sizing`) |
| 1-6 | 같은 PDF를 코어 PDF 뷰어로도 열어 분할 화면으로 나란히 둔다. 양쪽을 스크롤·줌한다 | 둘 다 정상 표시. 코어 뷰어의 모양이 평소와 같다 | CSS 누출(`.pendf-root` 범위), 전역 충돌(이론상 없음) |
| 1-7 | 돋보기 버튼으로 "spectra"를 검색하고 Enter로 다음 결과로 이동 | `1 / N`, `2 / N`으로 바뀌고 일치 항목이 강조된다 | `PDFFindController` 이벤트 |
| 1-8 | `links.pdf`에서 "Go to page 2"를 탭, `long-300.pdf` 1쪽 목차의 링크를 탭 | 해당 페이지로 이동한다 | 주석 레이어 링크 |
| 1-9 | `links.pdf`의 "External" 링크를 탭 | 시스템 브라우저(또는 Obsidian 내장 브라우저)가 열린다 | iOS의 `window.open` 처리. 열리지 않으면 BLOCKERS에 기록 |
| 1-10 | `a4.pdf`를 3쪽·150%로 두고 탭을 닫았다가 다시 연다. 앱을 완전히 종료했다 다시 켠다 | 3쪽·150%로 다시 열린다 | `positions`(플러그인 data.json), 작업 공간 상태 |
| 1-11 | 설정에서 **Invert page colors**를 켠다 | 페이지만 반전되고 하이라이트 색은 유지된다 | CSS 필터 |
| 1-12 | penDF 탭을 연 채로 플러그인을 끈다 | 화면에 penDF 요소가 남지 않는다 | `onunload` / `closeSession()` |

## Phase 1 — 펜 프로브

설정에서 **Pen probe**를 켜고, 명령 팔레트에서 **penDF: Open pen probe (diagnostics)**를 실행한다. `touch-action` 값마다 Pencil로 한 번, 손가락으로 한 번씩 상자 안에 긴 획을 긋고, 마지막에 **Export JSON**을 누른다.

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| P-1 | `touch-action`을 바꿔 가며 Pencil 획을 긋는다 | JSON `scrollByPointerType.pen`에 `"<값>:no-scroll"`이 나오는 값이 하나 이상 있다(`none` 예상) | Phase 6 입력 설계 |
| P-2 | Pencil 획의 `pressure` | 0과 1 사이에서 연속으로 변한다(`distinctValues`가 큼) | 모노 펜은 필압을 쓰지 않으므로 기록만 한다 |
| P-3 | `fractionalCoordinateShare` | 0보다 큼(좌표에 소수점이 있음) | iPadOS 26.2 미만에서는 정수로 반올림된다는 보고가 있다 |
| P-4 | `getCoalescedEvents`, `coalescedSamplesPerMove`, `maxMoveRateHz` | 값을 기록한다(120 Hz 기기에서 coalesced 샘플이 1보다 크면 240 Hz Pencil 샘플이 들어오는 것) | Phase 6 지연 예산 |
| P-5 | `touchType` | `stylus`와 `direct`가 모두 집계된다 | `Touch.touchType` 미지원이면 `(unsupported)` |

## Phase 2 — 하이라이트

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 2-1 | `two-column.pdf`에서 손가락으로 왼쪽 단 여러 줄을 선택한다 | 선택 아래에 4색 팔레트가 뜨고 iOS 선택 메뉴와 겹치지 않는다 | 팔레트 위치(`HighlightController.place`). 겹치면 위쪽 배치로 바꾼다 |
| 2-2 | 팔레트에서 색을 탭한다 | 선택이 사라지고 줄마다 하이라이트가 생기며, 오른쪽 단으로 번지지 않는다 | 선택 캐시(D-11), 줄 병합 |
| 2-3 | 하이라이트를 탭한다 → 다른 색 → 다시 탭 → 휴지통 → 툴바 실행 취소 | 색 변경, 삭제, 복원이 차례로 된다 | 탭 판정(D-10) |
| 2-4 | `rotations.pdf` 각 페이지에서 "This line is near…" 줄을 하이라이트한 뒤 핀치 줌과 툴바 회전 버튼을 쓴다 | 하이라이트가 글자에서 벗어나지 않는다 | `src/geometry`, 레이어 재부착 |
| 2-5 | `korean-embedded.pdf`에서 한 줄을 하이라이트한다 | 한글 줄과 정확히 겹친다 | 텍스트 레이어 폭(`--scale-x`) |
| 2-6 | 데스크톱에서 만든 하이라이트가 동기화 뒤 iPad에 보이는지, iPad에서 만든 하이라이트가 데스크톱에 보이는지 확인한다 | 양쪽 모두 보인다 | Obsidian Sync의 "Sync all other types"(D-15), 사이드카 병합 |
| 2-7 | 하이라이트를 만들자마자 홈 화면으로 나갔다가 돌아온다 | 하이라이트가 남아 있다(`visibilitychange` 즉시 저장) | `flushAll()` |

## Phase 3 — 텍스트 주석

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 3-1 | 하이라이트를 탭 → 메뉴의 메모 버튼 → 키보드로 "**굵게** [[아무 노트]]" 입력 → Save | 하이라이트 첫 줄 오른쪽 위에 원형 마커가 생긴다 | `NoteEditorModal`, 마커 렌더(`notes/controller.ts`) |
| 3-2 | 마커를 손가락으로 탭한다 | 마크다운이 렌더링된 팝오버(굵게, 링크)가 뜨고 하이라이트 메뉴는 뜨지 않는다 | 마커 판정 반경(`MARKER_R`), 캡처 단계 탭 처리 |
| 3-3 | 툴바의 메모(+) 버튼 → 페이지 빈 곳을 탭 → 입력 → Save | 탭한 지점에 마커가 생기고 버튼 강조가 꺼진다 | 배치 모드, `pointAt()` |
| 3-4 | 팝오버의 연필로 고치고, 휴지통으로 지운 뒤 툴바 실행 취소 | 수정·삭제·복원이 된다 | `UndoStack` |
| 3-5 | 메모가 붙은 하이라이트를 지우고 실행 취소한다 | 하이라이트와 메모가 함께 사라졌다가 함께 돌아온다 | 연쇄 삭제(`notesForHighlights`) |
| 3-6 | 툴바의 목록 버튼으로 패널을 연다 | 오른쪽 사이드바에 페이지별 하이라이트·메모가 보이고, 항목을 탭하면 그 위치로 이동한다(메모는 팝오버가 열린다) | `AnnotationsView`, `revealAnnotation()` |
| 3-7 | 데스크톱에서 메모를 쓰고 동기화 뒤 iPad에서 보고, iPad에서 고친 내용이 데스크톱에 반영되는지 본다 | 양쪽 모두 최신 내용이 보이고, 한쪽에서 지운 메모는 다른 쪽에서도 지워진다 | 사이드카 병합(D-15), 동기화 설정 |

## Phase 4 — 링크

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 4-1 | 하이라이트 메뉴의 링크 버튼 → 아무 노트에 붙여 넣기 | `[[파일.pdf#page=N&pendf=…\|하이라이트 글]]`이 붙는다(볼트의 링크 형식 설정대로) | `generateMarkdownLink`, 클립보드 권한 |
| 4-2 | 읽기 보기에서 그 링크를 탭한다 | penDF가 그 페이지에서 열리고 하이라이트가 잠깐 강조된다 | `LinkRecorder.onPointerDown`, 탭 전환 |
| 4-3 | 편집(라이브 프리뷰) 모드에서 같은 링크를 탭한다 | 4-2와 같다 | iOS에서 CodeMirror `mousedown`이 오는지(`editorExtension`) |
| 4-4 | 메모 팝오버의 링크, 선택 팔레트의 링크(하이라이트 없이), 툴바 링크(현재 페이지)로 각각 링크를 만들어 탭한다 | 메모는 팝오버가 열리고, 선택은 사각형이 깜박이고, 페이지 링크는 그 페이지가 열린다 | `tryNav`, `revealRect` |
| 4-5 | 설정에서 "Open PDFs in penDF"를 끄고 4-2의 링크를 탭한다 | Obsidian의 PDF 뷰어가 해당 페이지로 연다 | 코어가 `pendf=`를 무시하는지(데스크톱에서는 확인함) |
| 4-6 | **손가락으로** 읽기 보기의 penDF 링크(하이라이트·메모·선택·페이지 각각)를 탭한다 | 각각 정확한 위치로 열린다(하이라이트 강조, 메모 팝오버, 선택 사각형 깜박임, 해당 쪽) | iOS에서 탭이 `pointerdown`으로 오는지(D-35), 3초 기억 창 |
| 4-7 | **손가락으로** 라이브 프리뷰(편집 모드)의 같은 링크를 탭한다 | 4-6과 같다. 커서가 링크 안으로 들어가 편집 상태가 되면 그것도 기록한다 | CodeMirror `mousedown`이 iOS 탭에서 오는지(D-35) |
| 4-8 | `![[파일.pdf]]` 임베드가 있는 노트를 연 뒤(코어가 임베드를 그림) penDF로 다른 PDF와 같은 PDF를 각각 연다 | penDF 화면·글자 모양이 정상이고, 기존 하이라이트가 글자에 정확히 겹친다 | 두 pdf.js의 공유 이름(B-06, D-32) |

## Phase 5 — 북마크

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 5-1 | `long-300.pdf`를 열고 패널의 Outline 탭을 연다 | Chapter 1~30과 하위 절이 쪽 번호와 함께 보이고, "Chapter 30"을 탭하면 292쪽으로 간다 | `outline()`, 이름 있는 목적지 해석 |
| 5-2 | 46쪽에서 툴바의 북마크(+) 버튼 | 제목 입력 창에 "Page 46 — 5.1 Introduction"이 미리 들어 있고, Add 후 Bookmarks 탭에 생긴다 | `topPosition()`, `sectionFor()` |
| 5-3 | 북마크 몇 개를 만들고 위/아래 화살표, 이름 바꾸기, 삭제, 툴바 실행 취소 | 순서·이름이 바뀌고 삭제가 되돌아온다 | `reorder()`, `UndoStack` |
| 5-4 | 북마크의 링크 버튼 → 노트에 붙여 넣고 탭 | 북마크 위치로 이동한다 | Phase 4 |
| 5-5 | 위 작업 뒤 PDF 파일의 수정 시각과 크기를 확인한다(파일 앱) | 바뀌지 않았다 | 원본 무수정 |

## 0.7.0 — 썸네일과 전체 검색

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 7-1 | `long-300.pdf`에서 패널의 Pages 탭을 열고 끝까지 빠르게 스크롤한다 | 보이는 썸네일이 곧 그려지고, 앱이 느려지거나 종료되지 않는다 | 썸네일 가상화(보이는 것만 그림, 멀어지면 해제) |
| 7-2 | 썸네일을 탭한다, PDF를 스크롤한다 | 그 쪽으로 이동한다 / 현재 쪽 썸네일 테두리가 따라온다 | `onPageChange` |
| 7-3 | Search 탭에 "page 150", 한국어 PDF에서 한글 단어를 입력한다 | 결과가 쪽별로 문맥과 함께 나오고, 탭하면 그 위치로 가서 깜박인다 | 텍스트 추출·정규화, `revealHit` |

## 공존 (spec 4.2)

| # | 확인 절차 | 기대 결과 |
| --- | --- | --- |
| C-1 | PDF++를 설치·활성화한 볼트에서 위 Phase 1·2 항목을 반복한다 | 결과가 같다 |
| C-2 | penDF를 켜기 전과 후에 PDF++의 하이라이트·백링크 기능을 비교한다 | 바뀐 것이 없다 |
| C-3 | penDF를 제거한 뒤 볼트를 살펴본다 | `*.pdf.pendf.json` 사이드카만 남는다 |

## Phase 6 — 필기

먼저 펜 프로브(설정 → Pen probe → 명령 "Open pen probe", 0.5.1 이상)에서 **cancel Pencil touchstart**를 켠 채 `touch-action: auto`로 Pencil 획과 손가락 끌기를 각각 몇 번씩 하고 JSON을 내보낸다. `scrollByPointerType.pen`에 `auto+cancel-stylus:no-scroll`만 있고 `:scrolled`·`:cancelled`가 없으며, `touch`에 `auto+cancel-stylus:scrolled`가 나오면 기본 입력 방식("Pencil writes, finger scrolls")이 이 기기에서 맞다. Pencil에 `:cancelled`가 나오면 iPadOS가 획을 스크롤로 가져간 것이므로 "Everything writes"를 쓴다.

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 6-1 | 필기 모드를 켜지 않은 채 Pencil로 글씨를 쓴다("Apple Pencil always writes" 켜짐, 기본값) | 쓰는 동안 페이지가 움직이지 않고, 펜을 떼면 획이 남는다 | Pencil `touchstart` 취소가 안 먹힘 → 설정 "Everything writes"로 바꿔 본다 |
| 6-2 | 필기 모드인 채로 손가락으로 위아래로 끈다, 손가락으로 길게 눌러 글자를 선택한다 | 스크롤된다, 글자가 선택된다(획은 생기지 않는다) | 손가락 입력 분기(`draws()`) |
| 6-3 | 손바닥을 화면에 댄 채 쓴다 | 확대·축소나 스크롤이 일어나지 않는다 | 획 중 핀치 차단(`isPinchingDisabled`), 손바닥 터치의 스크롤 |
| 6-4 | 화면 왼쪽 가장자리에서 오른쪽으로 가로획을 긋는다 | 사이드바가 열리지 않고 획이 그어진다 | Obsidian의 가장자리 스와이프 |
| 6-5 | 형광펜으로 줄을 긋고, 지우개로 획을 문지르고, 실행 취소 | 형광펜은 글자 위에 반투명, 지우개가 닿은 획이 지워졌다가 돌아온다 | `strokeHit`, 지우개 보간 |
| 6-6 | 점(마침표, i의 점)을 찍는다 | 점이 남는다 | 한 점짜리 획 |
| 6-7 | 쓴 뒤 핀치 줌, 툴바 회전, 다크 모드(설정 Invert page colors) | 획이 글자에 붙어 있고, 다크 모드에서 검은 펜이 흰색으로 보인다 | 잉크 레이어, invert 필터 |
| 6-8 | 한 페이지에 획을 수백 개 쓰고 다른 쪽으로 갔다 온다, 앱을 껐다 켠다 | 느려지지 않고 획이 그대로 있다 | 증분 렌더, 사이드카 크기 |
| 6-9 | **지연 비교(완료 기준)**: 240fps 슬로모션으로 penDF와 Excalidraw에서 같은 속도의 획을 찍고 펜 끝–잉크 끝 간격을 프레임 단위로 비교한다 | penDF가 Excalidraw보다 1프레임(120 Hz 기준 약 8 ms) 이내로 늦다 | 실시간 캔버스(`desynchronized`), coalesced 이벤트 지원 여부(펜 프로브) |

## 7. 줌 (0.7.2) — 핀치 중 검은 화면, 부드러움

0.7.2부터 핀치·트랙패드 줌은 손가락이 움직이는 동안 화면을 합성(transform)만 하고, 손을 떼는 순간 한 번에 배율을 바꾼다. 아래 항목은 그 결과를 실기기에서 확인한다. 준비: 설정 → penDF에서 **Debug overlay**를 켠다. HUD에 `canvasMB`(살아 있는 캔버스 메모리 추정, 폭×높이×4), `zoomPreset`, `lastZoom`(마지막 제스처 요약) 줄이 나온다.

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 7-1 | `long-300.pdf`를 열고 5쪽쯤에서 천천히, 빠르게, 중간에 멈췄다가 계속하는 핀치(50%↔300%)를 각각 몇 번 한다. **다른 기기로 240fps 슬로모션 촬영**(없으면 iPad 화면 기록) | 손가락이 움직이는 동안 검은·빈 프레임이 없다. 손을 뗀 뒤 흐림→선명 교체가 한 번. 손가락 사이에 있던 글자가 손가락 사이에 남는다 | `lastZoom`의 `scale changes during`이 0이 아니면 제스처가 합성 경로를 타지 않음(로그). 검은 프레임이면 7-3 |
| 7-2 | 7-1의 각 핀치 직후 명령 **penDF: Export last zoom timeline to vault** → 볼트 루트의 `pendf-zoom-*.json`을 가져온다 | `frames` 간격이 대부분 16.7 ms(60 Hz) 또는 8.3 ms(ProMotion), `scaleChangesDuringGesture` 0, `layerDetachDuringGesture` 0, `blank` 0, `anchorErrorPx` ≤ 2 | `memPeakMB`, `canvasesCreated`, `renders`(쪽별 다시 그림)가 원인 판정 자료 |
| 7-3 | 설정 → penDF → Diagnostics → **Zoom rendering**을 *Default* → *Memory saver* → *No detail canvas* → *pdf.js defaults*로 바꿔 가며 7-1·7-2를 반복한다(바꾸면 열린 PDF가 다시 열린다) | 프리셋마다 검은 프레임 유무, `memPeakMB`, 선명해지기까지 걸린 시간, 쪽 폭 맞춤에서 글자가 흐린지(가로 화면 포함)를 적는다 | 이 비교로 기본 프리셋을 확정한다(현재 *Default*는 잠정, D-39). 원인 판정은 7-9(*0.7.1 canvas cap*과 비교) |
| 7-4 | **앱 종료 확인:** *Default*로 `long-300.pdf`를 최대(1000%)까지 확대하고 1분 동안 빠르게 스크롤·축소·확대를 반복한다. 멈춘 뒤 HUD의 `rendering`·`rendered`를 10초 지켜본다 | Obsidian이 꺼지거나 다시 시작하지 않는다. HUD `canvasMB`가 대략 160 이하(화면 + 한 쪽만큼은 넘을 수 있음)에서 오르내린다. 멈춘 뒤에는 렌더가 멈춘다 | 꺼지면 *Memory saver*로 다시 해 보고, 다시 켠 뒤 **Export log**와 7-2 파일을 가져온다 |
| 7-5 | 두 손가락을 벌리지 않고 같이 움직인다(두 손가락 팬) | 화면이 손가락을 따라가고, 떼면 그 자리로 스크롤된다 | `onPanning` |
| 7-6 | 필기 중 손바닥을 댄다, Pencil로 쓰는 중에 다른 손가락을 댄다 | 확대·축소되지 않는다 | `isPinchingDisabled`, 제스처 취소 |
| 7-7 | **Invert page colors**를 켜고 7-1을 반복한다 | 흰 번쩍임도 없다(아직 안 그려진 페이지는 반전된 종이색) | `.canvasWrapper`의 종이 배경 |
| 7-8 | 매직 키보드·트랙패드가 있으면 트랙패드로 핀치, 마우스가 있으면 ⌘+휠 한 칸 | 트랙패드는 연속으로 부드럽게, 휠 한 칸은 10% 한 단계. 포인터 아래 내용이 그 자리에 남는다 | `ZoomController.wheel` |
| 7-9 | **원인 판정(0.7.3, D-40):** 같은 PDF·같은 위치에서 7-1의 핀치(특히 빠르게 크게, 멈췄다 계속, 최대 확대)를 *Default*로 10번, *0.7.1 canvas cap (diagnostic)*으로 10번 한다. 각각 슬로모션 촬영과 7-2 타임라인(`memPeakMB`, `blank`)을 남긴다. 끝나면 *Default*로 되돌린다 | **판정:** 0.7.1 cap에서만 검은 번쩍임 → 원인은 iOS 캔버스 메모리 한도(A). 기본 프리셋을 Default로 확정한다(Memory saver가 필요할 수도). 둘 다에서 없음 → 원인은 0.7.2에서 고친 투명 배경·캔버스 삭제·멈춘 사이 재렌더였고, 메모리는 원인이 아니다. 둘 다에서 남음 → 아직 모르는 원인이니 타임라인과 영상을 가져온다 | 0.7.1 cap에서는 `memPeakMB`가 Default보다 크게 나와야 정상(쪽당 최대 32 MB, 예산 없음). 앱이 꺼지면 그것도 A의 증거 |

## 8. 0.8.0 — 보기 안 패널, 툴바, 여백, 영역 발췌, 볼트 검색

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 8-1 | 가로 화면에서 툴바 목록 버튼 → 패널을 연다. 오른쪽 가장자리를 끌어 너비를 바꾼다. 닫는다 | 페이지 옆에 붙어 열리고(고정), 페이지가 다시 너비에 맞춰지며 화면 위쪽 내용이 그대로다. 너비가 바뀌어도, 닫아도 읽던 곳이 그대로 | D-42 기준 너비(패널 + 560 pt). `PdfView.onWidthChange` |
| 8-2 | 세로 화면, 그리고 Split View(반/⅓)에서 패널을 연다 → 바깥(페이지)을 탭한다 | 페이지 위에 겹쳐 열리고, 바깥 탭으로 닫히며, 페이지 배율·위치는 그대로 | 겹침 배경(`.pendf-inpanel-backdrop`) |
| 8-3 | 화면 왼쪽 가장자리에서 오른쪽으로 쓸어 본다 | penDF 패널은 열리지 않고 Obsidian의 왼쪽 사이드바가 평소처럼 동작한다 | (penDF는 가장자리 제스처를 쓰지 않음) |
| 8-4 | Pages 탭에서 300쪽 PDF 썸네일을 빠르게 끝까지 스크롤하고 다시 위로 | 보이는 것만 그려지고, 현재 쪽이 강조되며 읽는 쪽을 따라간다. HUD `thumbMB`가 몇 MB 안 | IntersectionObserver, 썸네일 해제 |
| 8-5 | 툴바 버튼을 길게 누른다 | 버튼 이름이 잠깐 보이고 버튼은 실행되지 않는다 | `Toolbar.add` 길게 누르기(450 ms) |
| 8-6 | 세로 화면에서 툴바를 본다 | 한 줄에 들어가고, 넘치는 버튼은 ⋯(More)에 있다. 패널 버튼은 항상 보인다(주석 도구는 9장의 팔레트로 옮김) | `Toolbar.fit` |
| 8-7 | **Toggle margin** → 여백에 Pencil로 글씨를 쓴다. 여백에서 손가락으로 위아래로 끈다 | 여백에 필기가 남고(본문은 가려지지 않음), 손가락은 스크롤한다 | 쪽 요소 테두리 판정(§13), Pencil 상시 필기 |
| 8-8 | 여백의 획을 지우개로 지운다, 메모 버튼으로 여백에 메모를 놓고 Move로 옮긴다 | 지워지고, 메모가 놓이고 옮겨진다. 실행 취소 가능 | `eraseAt`, `notes.pointAt`, `startMove` |
| 8-9 | 여백을 끈다 → PDF를 닫았다 다시 연다 | 끄면 필기가 숨고 쪽 가장자리에 작은 표식. 다시 열면 여백이 저절로 켜진다 | `MarginController`, 자동 켜기 |
| 8-10 | 여백을 켠 채 핀치 줌 | 여백 필기가 페이지와 함께 움직이고 손을 떼도 제자리 | D-38 합성 변형, 쪽 상자 비율 |
| 8-11 | 팔레트에서 **영역**을 고르고 Pencil로 사각형을 끈다, 손가락으로도 끈다. 두 손가락으로 핀치 | Pencil: 사각형이 그려지고 색 메뉴가 열린다. 손가락: 페이지가 스크롤된다(D-46; "Everything writes"에서는 손가락도 그린다). 두 손가락은 확대·축소 | `AreaController.onDown`, 영역 도구의 Pencil `touchstart` 취소 |
| 8-12 | 영역 메뉴 → **Copy image** → 노트에 붙여 넣기 | 그림이 붙는다. 안 되면 "Save image를 쓰라"는 알림 | iPadOS 클립보드(`ClipboardItem`) — 결과를 BLOCKERS에 적는다 |
| 8-13 | 영역 메뉴 → **Save image** | 첨부 파일 위치에 `<PDF> p<쪽> excerpt.png`가 생기고 경로가 알림으로 나온다 | `getAvailablePathForAttachment` |
| 8-14 | 영역 메뉴 → **Copy link** → 노트에 붙여 넣고 누른다 | 그 영역으로 가서 깜박인다 | 링크 subpath, D-35 |
| 8-15 | **300쪽 안정성:** `long-300.pdf`에서 여백(50%)과 고정 패널(Pages 탭)을 켠 채 1분 동안 스크롤·확대·축소 | 앱이 꺼지지 않는다. HUD `canvasMB`가 Default 프리셋 예산(160 MB) 근처 이하 | D-39 예산(썸네일 포함) |
| 8-16 | **Search annotations in vault**를 실행해 낱말, `type:area`, `color:yellow`로 찾고 하나를 고른다 | 결과가 바로(1초 안) 나오고, 고르면 penDF가 그 위치를 연다 | 색인 구축(앱 시작 4초 뒤), iPad 파일 읽기 속도 |

## 9. 0.8.2 — 도구 팔레트 (D-46)

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 9-1 | **가로 화면**, 패널 닫힘·고정 패널 열림에서 팔레트를 본다 | 페이지 영역 아래 가운데에 한 줄로 뜨고(이름표 포함), 고정 패널과 겹치지 않는다. 스크롤해도 제자리 | `ToolPalette.layout`, `.pendf-tools` |
| 9-2 | **세로 화면**, Split View(½, ⅓)·Slide Over에서 팔레트를 본다 | 아이콘만 한 줄, 넘치면 ⋯(More)에 영역·메모부터. 겹친 패널을 열면 패널이 팔레트 위에 온다 | `Toolbar.fit`(labels), 우선순위 |
| 9-3 | **홈 인디케이터:** 화면 아래 가장자리와 팔레트 사이를 본다. 팔레트 버튼을 아래쪽 끝까지 눌러 본다 | 팔레트가 홈 인디케이터 위에 있고, 버튼을 눌러도 앱 전환 제스처가 일어나지 않는다 | `env(safe-area-inset-bottom)`이 Obsidian 보기 안에서 0일 수 있음 — 사진을 남긴다 |
| 9-4 | 마지막 쪽 끝까지 스크롤한다(펼침, 접힘 둘 다) | 마지막 쪽 아래 가장자리가 팔레트 위로 보인다 | `--pendf-tools-space` |
| 9-5 | **Pencil 도구 전환:** 펜 → 쓰기, 형광펜 → 쓰기, 지우개 → 획 지우기, 텍스트 → 글자 위를 끌기, 영역 → 사각형, 메모 → 탭. 사이사이 손가락으로 스크롤·핀치 | 각 도구대로 기록된다. 손가락은 늘 스크롤·핀치(텍스트 도구에서도). 메모를 놓으면 그 전 도구로 돌아간다 | `PdfView.setTool`, 각 컨트롤러의 Pencil `touchstart` 취소 |
| 9-6 | **텍스트 도구 + Pencil:** 한 줄, 여러 줄, 거꾸로(오른쪽→왼쪽) 끈다 | 끈 범위가 곧바로 도구 색으로 하이라이트되고 페이지는 스크롤되지 않는다 | `TextTool.caretAt`(`caretRangeFromPoint`) — WKWebView에서 null이면 결과를 BLOCKERS에 |
| 9-7 | 도구 없음을 고르고 Pencil로 쓴다("Apple Pencil always writes" 켬/끔) | 켬: 마지막 펜 도구(펜/형광펜)로 써진다. 지우개였어도 지우지 않는다. 끔: Pencil이 스크롤·선택 | `inkTool` |
| 9-8 | 선택된 도구를 다시 눌러 옵션을 바꾼다(색, 굵기, 형광펜 투명도) → PDF를 닫고 다시 연다 | 팝오버가 막대 위에 뜨고, 바꾼 값과 마지막 도구가 다시 열어도 그대로 | `settings.tools`, `saveQuietly` |
| 9-9 | 팔레트 버튼과 옵션 버튼을 길게 누른다 | 이름이 버튼 위에 잠깐 보이고 실행되지 않는다 | `Toolbar` 길게 누르기(`above`) |
| 9-10 | 외장 키보드: 설정 → 단축키에서 `penDF: Select tool: Pen` 등에 키를 주고 눌러 본다 | 도구가 바뀌고 팔레트 강조가 따라간다 | 명령 `select-tool-*` |
| 9-11 | 팔레트를 접는다(⌄) → 앱을 다시 연다 → 손잡이를 눌러 편다 | 접힌 상태가 기억되고, 손잡이에 현재 도구 아이콘이 보인다 | `tools.collapsed` |
