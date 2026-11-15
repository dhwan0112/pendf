# BLOCKERS

이번 세션에서 진행을 막았거나 해결하지 못한 항목이다.

| # | 항목 | 상태 | 영향 | 다음 단계 |
| --- | --- | --- | --- | --- |
| B-01 | iPad 실기기 검증 불가(Claude Code가 접근할 수 없음) | 대기 | Phase 1·2의 iPad 항목, 펜 프로브 측정 | `docs/DEVICE_CHECKLIST.md` |
| B-02 | GitHub 원격 저장소 없음 | 해결(2026-11-14): 공개 저장소 `dhwan0112/pendf`에 push(D-18) | `0.1.0` 태그 전에는 릴리스가 없어 BRAT 설치 불가 | iPad 확인 뒤 `0.1.0` 태그를 단다(`.github/workflows/release.yml`이 draft 릴리스를 만든다) |
| B-03 | Obsidian 창이 숨어 있으면 rAF가 멈추고, `scroll` 이벤트가 오지 않고, 5분이 지나면 타이머가 1분 단위로 묶임 | 우회 | 자동 하네스만 해당. 실사용 영향 없음 | 하네스가 rAF를 바꾸고, scroll 이벤트를 직접 보내고, `@electron/remote`로 background throttling을 잠시 끈다. 모두 정리 단계에서 되돌린다. Obsidian을 보이게 두고 돌리는 것이 가장 확실하다 |
| B-04 | 최종 "폴리필 없음" 확인에는 Obsidian 재시작이 필요 | 대기 | SciWiki 창에는 개발 중 legacy 빌드를 로드했을 때의 core-js 흔적이 남아 있어, 그 창에서 통과해도 증거가 되지 않는다 | Obsidian을 재시작한 뒤 하네스를 한 번 돌린다. 깨끗한 realm 검사(`pdfjs-footprint`)는 이미 0/0/0으로 통과했다 |
| B-05 | Obsidian Sync는 기본 설정에서 `.json`을 동기화하지 않음 | 열린 질문 | 사이드카가 기기 사이에 오가지 않을 수 있음 | 실제로 쓰는 동기화 방식을 확인한다(REPORT 열린 질문). Obsidian Sync라면 "Sync all other types"를 켠다 |
| B-06 | 코어 PDF 뷰어를 먼저 연 창에서 `highlight-ground-truth`의 `rotations.pdf` 1쪽 끝 오차가 3.21 pt(기준 3 pt) | 수정 적용, **Obsidian 재검증 대기**(B-07) | 하이라이트 끝이 한 글자 폭의 일부만큼 길어질 수 있음 | 가설(두 pdf.js의 글꼴·필터 이름 충돌)은 Obsidian 밖에서 실제로 확인했고 0.7.1에서 이름을 분리했다(D-32). 다만 그 시험들에서는 충돌이 오차를 만들지 않아 원인이라는 증거는 아직 없다(INVESTIGATION §12). 테스트 볼트에서 `ground-truth-after-core`·`-after-embed`·`-same-pdf-embed`를 돌려 판정한다 |
