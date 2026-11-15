# REPORT — penDF 현재 상태 (0.7.1 작업 기준, 2026-11-15)

버전별 변경은 [CHANGELOG.md](../CHANGELOG.md), 결정은 [DECISIONS.md](DECISIONS.md), 막힌 것은 [BLOCKERS.md](BLOCKERS.md), iPad 확인 절차는 [DEVICE_CHECKLIST.md](DEVICE_CHECKLIST.md)에 있다. 이 문서는 시간순 기록이 아니라 지금의 상태다.

## 한눈에

- 목표 문서의 6단계(뷰어, 하이라이트, 텍스트 주석, 링크, 북마크, 필기)와 추가 기능(기본 열기, 썸네일, 전체 검색, Pencil 상시 필기)이 모두 구현되어 있다. 최신 릴리스 0.7.0, 0.7.1은 아래 조건을 채우면 태그한다.
- **iPad에서는 아직 아무것도 확인되지 않았다.** 데스크톱(Obsidian/Chromium)과 Obsidian 밖 WebKit에서만 검증했다.
- 0.7.1의 데스크톱 하네스는 **아직 돌리지 못했다**: 전용 테스트 볼트가 Obsidian에 등록되지 않았다(B-07). 그래서 B-06 수정이 Obsidian 안에서 효과가 있는지도 미확인이다.

## 기능별 상태

검증 열: **단위** = vitest, **하네스** = 실제 Obsidian 데스크톱 자동 검사(마지막 실행 버전), **WebKit** = Playwright WebKit/Chromium 스모크(Obsidian 밖, 0.7.1), **iPad** = 실기기.

| 기능 | 구현 | 단위 | 하네스 | WebKit | iPad |
| --- | --- | --- | --- | --- | --- |
| Phase 1 뷰어: 연속 스크롤, 가상화, 줌, 회전, 검색 막대, 내부·외부 링크, 위치 기억, 다크 페이지 | 0.1.0 | ○ | ○ 0.7.0(`fixtures-render`, `search`, `links`, `state-restore`, `long-300-memory` …) | ○ 모든 fixture 전 페이지 렌더, 텍스트, 검색 | 미확인 |
| 엔진 격리: 전역·내장 객체 무변경, Blob 워커 | 0.1.0 | ○ | ○ 0.7.0(`pdfjs-footprint`, `fallback-main-thread`) | ○ 내장 객체 변경 0, Blob 워커 | 미확인 |
| Phase 2 하이라이트: 여러 줄·2단·쪽 넘김, 색 변경, 실행 취소 | 0.1.0 | ○ | ○ 0.7.0(`highlight-*`) | ○ 선택→quad 계산, WebKit·Chromium 차이 0.28 pt | 미확인 |
| Phase 3 메모: 하이라이트·지점 메모, 마크다운, 패널 | 0.2.0 | ○ | ○ 0.7.0(`notes`) | — | 미확인 |
| Phase 4 링크: 복사, 정확한 위치 이동, 플러그인 없이 쪽 열기 | 0.3.0 | ○ | ○ 0.7.0(`pdf-links`) | — | 미확인 |
| Phase 5 북마크: 개요, 사용자 북마크, PDF 무수정 | 0.4.0 | ○ | ○ 0.7.0(`bookmarks`) | — | 미확인 |
| Phase 6 필기: 펜, 형광펜, 지우개, 실행 취소 | 0.5.0 | ○ | ○ 0.7.0(`ink`, 합성 Pencil 이벤트) | — | **미확인(입력 분기·지연은 실기기로만)** |
| Pencil 상시 필기 | 0.6.0 | — | ○ 0.7.0(`ink`의 `pencilAlways`) | — | 미확인 |
| 썸네일·전체 검색 | 0.7.0 | — | ○ 0.7.0(`pages-search`) | — | 미확인 |
| 기본 열기(탭 전환)와 링크 위치 전달 | 0.1.5 / 0.3.0 | ○ | ○ 0.7.0(`open-by-default`, `pdf-links`) | — | 미확인(D-35) |
| 공유 이름 분리(B-06 수정) | 0.7.1 | ○ 변환·check-standalone | **미실행(B-07)** `shared-namespace`, `ground-truth-after-*` | ○ 충돌 수정 전 1~2 → 후 0 | 미확인 |

## 0.7.1에서 한 일

1. **B-06 / 공유 이름:** 가설(두 pdf.js가 같은 `g_d0_f1` 같은 이름을 공유 문서에 등록)을 Obsidian 밖에서 실제로 확인했다(충돌 수정 전 Chromium 2·WebKit 1 → 수정 후 0). 문서 id를 `pendf_d…`로 바꾸고, penDF가 `<html>`의 `--viewer-container-height`를 덮어쓰던 것도 고쳤다. 다만 시험한 조합에서는 충돌이 렌더링이나 하이라이트 끝 오차를 바꾸지 않아, B-06(3.21 pt)의 원인이라는 증거는 아직 없다. 감사 표는 INVESTIGATION §12.
2. **fixture:** `.ttc`(글꼴 모음)에서 한국어 면을 골라 쓰고, 하나가 실패해도 나머지를 만들고 이유를 남긴다. CI가 CJK 글꼴이 있는 경우와 없는 경우를 둘 다 돌린다(둘 다 통과 확인).
3. **WebKit 스모크:** Playwright WebKit 27.2·Chromium 156에서 9개 fixture 319쪽 전부 렌더, Blob 워커, 텍스트 레이어, 검색, 오류 0, 내장 객체 변경 0, 정답 끝 오차 −0.11(WebKit)·−0.18(Chromium) pt. 이 과정에서 실제 버그 하나(표준 글꼴 `url(embedded://…)` 요청 실패, D-33)를 찾아 고쳤다. **한계:** Playwright WebKit은 iOS WKWebView가 아니다(OS 통합, 메모리 한도, 터치·Pencil, Obsidian 앱 껍데기가 다르다).
4. **테스트 볼트:** 하네스와 `install-dev`는 `.pendf-test-vault` 표지가 있는 볼트에서만 돈다(디스크와 Obsidian 안 둘 다 확인). `C:\Users\denny\pendf-testvault`를 만들어 두었다.
5. **문서:** 이 문서를 현재 상태로 다시 쓰고, 버전별 변경을 CHANGELOG로 옮겼다. 기본 열기와 LinkRecorder 동작은 D-35.

## 증거

- `docs/evidence/b06-namespace-browsers-2026-11-15.json` — WebKit/Chromium 스모크와 B-06 시나리오 20개(수정 전/후 × 코어 먼저/안 먼저 × 글꼴 조합).
- `docs/evidence/harness-2026-11-15-0.5.0.json` — 마지막 전체 하네스(0.5.0, SciWiki, 26개 통과). 0.6.0·0.7.0은 해당 검사를 SciWiki에서 부분 실행했다(커밋 기록). **0.7.1 전체 하네스는 B-07 해소 뒤** `docs/evidence/`에 추가한다.

## 열린 버그

| # | 내용 | 상태 |
| --- | --- | --- |
| B-06 | 코어 뷰어를 먼저 연 뒤 `rotations.pdf` 하이라이트 끝 3.21 pt(기준 3 pt) | 공유 이름 수정 적용, Obsidian 재검증 대기(B-07). 다른 후보: 측정 canvas와 DOM의 글꼴 대체 차이(INVESTIGATION §12) |
| B-07 | 테스트 볼트 미등록 | 사용자 작업 대기 |

## 알려진 한계

- 노트 안 PDF 임베드와 호버 미리보기는 Obsidian 자체 뷰어가 그린다(공개 API로 바꿀 수 없음).
- 기본 열기 때 코어 뷰어가 잠깐 보이고 탭 전환이 2회 일어난다(전체 로드는 1회, D-35).
- 다른 플러그인이 코드로 연 PDF 링크, 빠른 전환기로 연 PDF는 기억된 위치로 열린다(누른 링크 기록이 없으므로).
- 표준 글꼴이 PDF에 없고 기기에도 맞는 로컬 글꼴이 없으면 브라우저 기본 대체 글꼴로 그린다(D-33, 대안 `useSystemFonts: false`).
- 필기: 필압 없음(모노 펜), Pencil로 글자 선택 불가(상시 필기 켜짐 시), 예측 이벤트 미사용.
- 데스크톱은 개발·디버깅용(마우스 필기는 필기 모드에서만).

## 사용자가 할 일

1. **테스트 볼트 등록(B-07):** Obsidian → 볼트 전환 → "Open folder as vault" → `C:\Users\denny\pendf-testvault` → 작성자 신뢰, 커뮤니티 플러그인 켜기. 그 뒤 `node scripts/obsidian-harness.mjs`(기본값이 이 볼트)로 전체 하네스를 돌리면 B-06 판정과 0.7.1 증거가 나온다.
2. **iPad:** 펜 프로브부터(DEVICE_CHECKLIST 6장 머리말), 이어서 0~7장과 새 항목 4-6~4-8. 로그(**penDF: Export log**)와 프로브 JSON을 가져온다.
3. **커뮤니티 심사 스캐너 재실행:** 0.2.0 이후 버전을 아직 거치지 않았다. 로컬 lint(eslint-plugin-obsidianmd 0.5.1)는 스캐너와 세 번 결과가 달랐다.
4. **SciWiki 정리(선택):** 예전 실행이 남긴 아래 파일은 지우지 않았다. 필요 없으면 직접 지운다.
   - `C:\Users\denny\Documents\Obsidian Vault\.obsidian\SciWiki\.obsidian\plugins\pendf\main.js`
   - `…\SciWiki\.obsidian\plugins\pendf\manifest.json`
   - `…\SciWiki\.obsidian\plugins\pendf\styles.css`
   - `…\SciWiki\pendf-fixtures\` 안의 `a4.pdf`, `cropbox.pdf`, `korean-cmap.pdf`, `korean-embedded.pdf`, `letter.pdf`, `links.pdf`, `long-300.pdf`, `rotations.pdf`, `two-column.pdf`
   - (`*.pendf.json` 사이드카, 로그, `data.json`은 없음. `community-plugins.json`에 penDF 없음)

## 다음 권장 작업

1. 테스트 볼트에서 전체 하네스 → B-06 판정. 수정으로 해결되지 않았으면 측정 글꼴 가설(INVESTIGATION §12) 조사.
2. iPad 체크리스트 결과로 입력 기본값(Pencil 상시 필기, touch 처리), `maxCanvasPixels`, 글꼴 정책(D-33) 조정.
3. 커뮤니티 심사 재실행 후 0.7.1(또는 iPad 수정 반영 버전) 제출.
