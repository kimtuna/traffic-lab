# 설계 결정 기록 (ADR)

ADR(Architecture Decision Record)은 **"왜 이렇게 만들었는가"**를 남기는 문서다.
코드는 결과만 보여주고 기각된 대안은 보여주지 않기 때문에,
나중의 나와 읽는 사람을 위해 판단 근거를 따로 기록한다.

각 ADR은 같은 형식을 따른다:
**맥락 → 결정 → 고려한 대안 → 결과 → 재검토 조건**

| # | 제목 | 상태 |
|---|---|---|
| [0001](0001-simulated-connection-pool.md) | 실제 DB 대신 세마포어로 커넥션 풀을 모사한다 | 채택 |
| [0002](0002-heterogeneous-query-cost.md) | 쿼리 비용을 이질적으로 모델링한다 | 채택 |
| [0003](0003-ai-as-explainer-not-detector.md) | AI는 탐지기가 아니라 설명기로 쓴다 | 채택 |
