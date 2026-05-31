# dangsun-novel-murim

선협·신화 무협 자동연재 **「신을 먹는 자」**. **dangsun.kr/novel/murim** 에서 렌더링.

괴력난신(한중월야) 풍의 *결*(신·요괴·난신 실재 중원, 사패 주인공)을 따른 **오리지널** 작품.
신을 먹어 강해지는 금기의 식신자 묵야가 인간을 제물 삼는 난신을 사냥한다. (시즌1 100화)

## 구조
- `YYYY-MM-DD_NNN.md` — 회차
- `canon/` — 옵시디언 볼트. `premise.md`(한 끗)·`world.md`·`arc.md`(100화)·`characters/*.md`·`threads.md` / `state.md` / `synopsis.md`
- `scripts/build-local.mjs` — 생성기(opus, 연속성+재미 채점, 회귀물 아님 → timeline 없음)
- `scripts/run-daily.ps1` — 매일 08:35 스케줄러

## 실행
```bash
node scripts/build-local.mjs              # 다음 화
DRY_RUN=1 node scripts/build-local.mjs    # 프롬프트만
FORCE=1 node scripts/build-local.mjs      # 오늘 강제 추가
```

> 개입(steering)은 `novel_steering` 의 `novel_id` 스코핑 적용 후 활성화 예정. 현재는 자동 연재만.
