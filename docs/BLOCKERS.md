# BLOCKERS

이번 세션에서 진행을 막았거나 해결하지 못한 항목이다.

| # | 항목 | 상태 | 영향 | 다음 단계 |
| --- | --- | --- | --- | --- |
| B-01 | iPad 실기기 검증 불가(Claude Code가 접근할 수 없음) | 대기 | Phase 1·2의 iPad 항목, 펜 프로브 측정 | `docs/DEVICE_CHECKLIST.md` |
| B-02 | GitHub 원격 저장소 없음 | 해결(2026-11-14): 공개 저장소 `dhwan0112/pendf`에 push(D-18) | `0.1.0` 태그 전에는 릴리스가 없어 BRAT 설치 불가 | iPad 확인 뒤 `0.1.0` 태그를 단다(`.github/workflows/release.yml`이 draft 릴리스를 만든다) |
| B-03 | Obsidian 창이 숨어 있으면 rAF가 멈추고, `scroll` 이벤트가 오지 않고, 5분이 지나면 타이머가 1분 단위로 묶임 | 우회 | 자동 하네스만 해당. 실사용 영향 없음 | 하네스가 rAF를 바꾸고, scroll 이벤트를 직접 보내고, `@electron/remote`로 background throttling을 잠시 끈다. 모두 정리 단계에서 되돌린다. Obsidian을 보이게 두고 돌리는 것이 가장 확실하다 |
| B-04 | 최종 "폴리필 없음" 확인에는 Obsidian 재시작이 필요 | 대기 | SciWiki 창에는 개발 중 legacy 빌드를 로드했을 때의 core-js 흔적이 남아 있어, 그 창에서 통과해도 증거가 되지 않는다 | Obsidian을 재시작한 뒤 하네스를 한 번 돌린다. 깨끗한 realm 검사(`pdfjs-footprint`)는 이미 0/0/0으로 통과했다 |
| B-05 | Obsidian Sync는 기본 설정에서 `.json`을 동기화하지 않음 | 열린 질문 | 사이드카가 기기 사이에 오가지 않을 수 있음 | 실제로 쓰는 동기화 방식을 확인한다(REPORT 열린 질문). Obsidian Sync라면 "Sync all other types"를 켠다 |
| B-06 | 코어 PDF 뷰어를 먼저 연 창에서 `highlight-ground-truth`의 `rotations.pdf` 1쪽 끝 오차가 3.21 pt(기준 3 pt) | **테스트 볼트에서 재현 안 됨**(수정 전·후 빌드 모두), SciWiki 고유 조건으로 남김 | 실사용 영향: 하이라이트 끝이 한 글자 폭의 일부만큼 길어질 수 있음(SciWiki 환경) | 2026-11-16 테스트 볼트에서 코어 먼저·임베드 먼저·같은 PDF 동시 표시 모두 끝 오차 −0.71 pt(단독 −0.13~−0.33 pt), **수정 전 빌드도 같은 값**. SciWiki의 테마·글꼴(Wikibaum, IBM Plex Sans KR)을 테스트 볼트에 적용해도 재현 안 됨. 남은 후보: SciWiki의 다른 플러그인·CSS 스니펫·창/사이드바 폭. SciWiki를 시험해도 될 때 같은 검사를 거기서 돌려 판정한다. 공유 이름 수정(D-32)은 실제 충돌을 없애는 방어 수정으로 유지 |
| B-07 | 전용 테스트 볼트 `C:\Users\denny\pendf-testvault`가 Obsidian에 등록되지 않음 | **해결**(2026-11-16, 사용자가 볼트를 열었다) | — | 전체 하네스 31개 통과(`docs/evidence/harness-2026-11-16-0.7.1.json`) |
| B-08 | 하네스: `fallback-main-thread`가 `pdfjs-footprint` 바로 뒤(같은 묶음)에 돌면 매번 실패(새 탭이 빈 뷰로 남고, 옛 인스턴스 쪽에서 `No "GlobalWorkerOptions.workerSrc" specified`가 찍힘) | **열림 — 원인 미확정**, 우회 중 | 하네스 순서에만 나타남. 단독·다른 순서에서는 통과(2회 연속), 같은 단계를 손으로 재현한 시험에서도 정상. 제품 쪽 워커 누수(D-37 6)는 따로 확인해 고쳤다 | 묶음을 `long-300-memory, pdfjs-footprint` / `fingerprint-mismatch, fallback-main-thread, unload-cleanup`으로 나눴다. 원인 후보: 준비 단계에서 시작이 끝나지 않은 워커와 플러그인 끄고 켜기의 경합, `pdfjs-footprint`의 별도 pdf.js 실행. 다음에 그 순서로 돌리며 옛 인스턴스의 로그를 남겨 판정한다 |

