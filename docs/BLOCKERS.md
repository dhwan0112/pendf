# BLOCKERS

진행을 막았거나 이번 세션에서 해결하지 못한 항목.

| # | 항목 | 상태 | 영향 | 다음 단계 |
| --- | --- | --- | --- | --- |
| B-01 | Obsidian 창이 백그라운드면 `requestAnimationFrame`이 멈춰 pdf.js 렌더링이 진행되지 않음 | 우회 | 자동 검증만 해당. 실사용에는 영향 없음 | `scripts/obsidian-harness.mjs`가 검증하는 동안만 rAF를 setTimeout으로 바꾸고 끝나면 되돌린다 |
| B-02 | iPad 실기기 검증 불가(Claude Code가 접근할 수 없음) | 대기 | Phase 1·2 iPad 항목 | `docs/DEVICE_CHECKLIST.md` |
