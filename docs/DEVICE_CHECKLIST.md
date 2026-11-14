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
| 1-2 | `long-300.pdf`를 열고 손가락으로 끝까지 빠르게 스크롤, 중간중간 핀치 줌(50%~300%), 다시 처음으로 | 앱이 종료되지 않는다. HUD의 `canvases`가 대략 10~20 사이를 유지한다 | 캔버스 메모리. `PdfView.ts`의 `maxCanvasPixels`(모바일 2^23)를 낮춘다 |
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

## Phase 5 — 북마크

| # | 확인 절차 | 기대 결과 | 실패 시 의심 지점 |
| --- | --- | --- | --- |
| 5-1 | `long-300.pdf`를 열고 패널의 Outline 탭을 연다 | Chapter 1~30과 하위 절이 쪽 번호와 함께 보이고, "Chapter 30"을 탭하면 292쪽으로 간다 | `outline()`, 이름 있는 목적지 해석 |
| 5-2 | 46쪽에서 툴바의 북마크(+) 버튼 | 제목 입력 창에 "Page 46 — 5.1 Introduction"이 미리 들어 있고, Add 후 Bookmarks 탭에 생긴다 | `topPosition()`, `sectionFor()` |
| 5-3 | 북마크 몇 개를 만들고 위/아래 화살표, 이름 바꾸기, 삭제, 툴바 실행 취소 | 순서·이름이 바뀌고 삭제가 되돌아온다 | `reorder()`, `UndoStack` |
| 5-4 | 북마크의 링크 버튼 → 노트에 붙여 넣고 탭 | 북마크 위치로 이동한다 | Phase 4 |
| 5-5 | 위 작업 뒤 PDF 파일의 수정 시각과 크기를 확인한다(파일 앱) | 바뀌지 않았다 | 원본 무수정 |

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
| 6-1 | 툴바의 펜 버튼 → Pencil로 글씨를 쓴다 | 쓰는 동안 페이지가 움직이지 않고, 펜을 떼면 획이 남는다 | Pencil `touchstart` 취소가 안 먹힘 → 설정 "Everything writes"로 바꿔 본다 |
| 6-2 | 필기 모드인 채로 손가락으로 위아래로 끈다, 손가락으로 길게 눌러 글자를 선택한다 | 스크롤된다, 글자가 선택된다(획은 생기지 않는다) | 손가락 입력 분기(`draws()`) |
| 6-3 | 손바닥을 화면에 댄 채 쓴다 | 확대·축소나 스크롤이 일어나지 않는다 | 획 중 핀치 차단(`isPinchingDisabled`), 손바닥 터치의 스크롤 |
| 6-4 | 화면 왼쪽 가장자리에서 오른쪽으로 가로획을 긋는다 | 사이드바가 열리지 않고 획이 그어진다 | Obsidian의 가장자리 스와이프 |
| 6-5 | 형광펜으로 줄을 긋고, 지우개로 획을 문지르고, 실행 취소 | 형광펜은 글자 위에 반투명, 지우개가 닿은 획이 지워졌다가 돌아온다 | `strokeHit`, 지우개 보간 |
| 6-6 | 점(마침표, i의 점)을 찍는다 | 점이 남는다 | 한 점짜리 획 |
| 6-7 | 쓴 뒤 핀치 줌, 툴바 회전, 다크 모드(설정 Invert page colors) | 획이 글자에 붙어 있고, 다크 모드에서 검은 펜이 흰색으로 보인다 | 잉크 레이어, invert 필터 |
| 6-8 | 한 페이지에 획을 수백 개 쓰고 다른 쪽으로 갔다 온다, 앱을 껐다 켠다 | 느려지지 않고 획이 그대로 있다 | 증분 렌더, 사이드카 크기 |
| 6-9 | **지연 비교(완료 기준)**: 240fps 슬로모션으로 penDF와 Excalidraw에서 같은 속도의 획을 찍고 펜 끝–잉크 끝 간격을 프레임 단위로 비교한다 | penDF가 Excalidraw보다 1프레임(120 Hz 기준 약 8 ms) 이내로 늦다 | 실시간 캔버스(`desynchronized`), coalesced 이벤트 지원 여부(펜 프로브) |
