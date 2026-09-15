# 02. 메트릭 설계

## 왜 RED인가

"서버에서 뭘 측정해야 하나"에 대한 답은 여러 가지가 있다.

| 방법론 | 관점 | 측정 대상 |
|---|---|---|
| **RED** | 요청 흐름 | Rate / Errors / Duration |
| USE | 자원 | Utilization / Saturation / Errors |
| Four Golden Signals | 구글 SRE | 지연 / 트래픽 / 에러 / 포화 |

이 프로젝트는 **요청 처리 서비스**가 대상이므로 RED를 골랐다.
CPU·메모리 같은 자원 지표(USE)는 "왜 느린지"를 설명할 때 유용하지만,
"느린지 아닌지"를 판단하는 데는 RED가 직접적이다.

다만 RED만으로는 **원인**을 못 짚는다. 그래서 병목 자체를 관측하는
풀 내부 지표를 따로 추가했다.

## 노출하는 메트릭

### RED 3종

```go
http_requests_total{path, method, status}        // Counter
http_request_duration_seconds{path, method}      // Histogram
```

Counter 하나로 **Rate와 Errors를 동시에** 해결한다.
`status` 라벨이 있으므로 전체 증가율이 Rate고, `status=~"5.."`로 필터하면 Errors다.
지표를 두 개로 나눌 이유가 없다.

Duration은 반드시 **Histogram**이어야 한다. Summary나 Gauge로는
`histogram_quantile()`을 쓸 수 없고, 여러 인스턴스의 분위수를 합산할 수도 없다.

버킷 경계는 이렇게 잡았다:
```go
{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10}
```
싼 쿼리(10ms)와 비싼 쿼리(400ms)가 각각 다른 버킷에 떨어져야
분위수 해상도가 나온다. 버킷이 성긴 구간에서는 `histogram_quantile()`이
선형 보간을 하므로 오차가 커진다.

### 병목 관측용

```go
http_inflight_requests      // Gauge   현재 처리 중인 요청
db_pool_size                // Gauge   풀 전체 크기
db_pool_in_use              // Gauge   사용 중인 커넥션
db_pool_wait_seconds        // Histogram  커넥션 획득 대기 시간 ★
db_pool_timeouts_total      // Counter 대기 실패 → 503
```

**`db_pool_wait_seconds`가 이 프로젝트에서 가장 중요한 지표다.**
응답 시간은 `대기 시간 + 실제 작업 시간`인데, 이 둘을 분리하지 않으면
"느리다"까지만 알 수 있다. 대기가 지연의 대부분을 차지한다는 걸 보여야
**"풀 크기가 범인"**이라고 단정할 수 있다.

`in_use`와 `inflight`를 함께 보는 것도 같은 이유다:

```
db_pool_in_use = 5 에서 평평  ←── 풀이 꽉 참
http_inflight  = 40 에서 계속 상승
────────────────────────────────
   차이 35 = 큐에서 대기 중인 요청
```

## PromQL 모음

그대로 복사해서 Prometheus나 Grafana에 넣으면 된다.

### Rate — 초당 요청 수
```promql
sum by (path) (rate(http_requests_total[1m]))
```
`rate()`는 Counter의 초당 증가율을 계산한다. Counter는 계속 증가하기만 하므로
raw 값은 의미가 없고 항상 `rate()`나 `increase()`를 씌워야 한다.

### Errors — 5xx 비율
```promql
sum by (path) (rate(http_requests_total{status=~"5.."}[1m]))
/
sum by (path) (rate(http_requests_total[1m]))
```

### Duration — p99
```promql
histogram_quantile(0.99,
  sum by (le) (rate(http_request_duration_seconds_bucket{path="/api/users"}[1m]))
)
```
`le`(less than or equal) 라벨로 그룹화하는 게 핵심이다.
`sum by (le)`를 빠뜨리면 인스턴스별로 따로 계산되어 값이 틀린다.

### 평균 — p99과 비교할 대조군
```promql
sum(rate(http_request_duration_seconds_sum{path="/api/users"}[1m]))
/
sum(rate(http_request_duration_seconds_count{path="/api/users"}[1m]))
```
Histogram은 `_bucket` 외에 `_sum`과 `_count`도 자동으로 노출한다.
둘을 나누면 평균이 나온다. **이 값과 p99을 겹쳐 그리는 게
"평균이 무엇을 숨기는지" 보여주는 가장 좋은 방법이다.**

### 큐에 쌓인 요청 수
```promql
http_inflight_requests - db_pool_in_use
```

### 커넥션 대기 p99
```promql
histogram_quantile(0.99, rate(db_pool_wait_seconds_bucket[1m]))
```

### 대기가 응답 시간에서 차지하는 비율
```promql
histogram_quantile(0.99, rate(db_pool_wait_seconds_bucket[1m]))
/
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket{path="/api/users"}[1m])))
```
1에 가까울수록 "지연의 거의 전부가 대기" → 풀 크기가 범인.

## 알럿 규칙

`prometheus/alerts.yml`에 3개를 정의했다. 2단계에서 이 발화가
트리아지 백엔드를 깨우는 트리거가 된다.

| 알럿 | 조건 | `for` | 심각도 |
|---|---|---|---|
| `HighP99Latency` | p99 > 1s | 30s | warning |
| `HighErrorRate` | 5xx 비율 > 1% | 30s | critical |
| `DBPoolSaturated` | 커넥션 대기 p99 > 100ms | 30s | warning |

`for: 30s`가 중요하다. 조건이 순간적으로 참이 되는 건 흔한 일이고,
그때마다 알럿을 울리면 노이즈가 된다. **30초간 지속**되어야 발화한다.

`DBPoolSaturated`를 따로 둔 이유는, 이게 나머지 둘보다 **먼저** 울리기
때문이다. 대기가 길어지는 게 원인이고 p99 상승과 503은 결과다.
원인 쪽 알럿을 별도로 두면 트리아지에 쓸 수 있는 신호가 하나 더 생긴다.

## 대시보드 패널 (7개)

| # | 패널 | 보는 것 |
|---|---|---|
| 1 | R — 처리량(RPS) | 부하를 올려도 안 오르면 한계 도달 |
| 2 | E — 에러율 | 풀 완전 고갈 시점 |
| 3 | **D — 분위수 (p50/p95/p99)** | ★ 핵심. p99만 먼저 튀는 순간 |
| 4 | 평균 vs p99 | 평균이 숨기는 것 |
| 5 | 병목: 커넥션 풀 | `in_use` 평평 + `inflight` 상승 = 큐 |
| 6 | 커넥션 획득 대기 | 지연 중 순수 대기분 |
| 7 | 풀 고갈 타임아웃/초 | 503의 직접 원인 |
