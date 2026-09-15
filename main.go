// traffic-lab: p99이 무너지는 순간을 눈으로 보기 위한 최소 서버.
//
// /api/users 는 크기가 작은 "DB 커넥션 풀"을 거쳐야만 응답한다.
// 동시 요청이 풀 크기를 넘어서는 순간부터 요청들이 큐에서 대기하기 시작하고,
// 평균은 멀쩡한데 p99만 먼저 치솟는 전형적인 패턴이 만들어진다.
package main

import (
	"context"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// ---------------------------------------------------------------------------
// 메트릭: RED (Rate / Errors / Duration) + 풀 내부 상태
// ---------------------------------------------------------------------------

var (
	// Rate 와 Errors 를 동시에 담당한다.
	// status 라벨이 있으므로 5xx 비율을 따로 계산할 수 있다.
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "처리한 HTTP 요청 수",
	}, []string{"path", "method", "status"})

	// Duration. 히스토그램이어야 histogram_quantile() 로 p99를 뽑을 수 있다.
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP 응답 시간(초)",
		Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10},
	}, []string{"path", "method"})

	httpInflight = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "http_inflight_requests",
		Help: "현재 처리 중인 요청 수",
	})

	poolSize = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "db_pool_size",
		Help: "커넥션 풀 전체 크기",
	})

	poolInUse = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "db_pool_in_use",
		Help: "현재 사용 중인 커넥션 수",
	})

	// 이 값이 치솟는다 == 병목이 풀이라는 직접 증거.
	poolWait = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "db_pool_wait_seconds",
		Help:    "커넥션을 얻기까지 큐에서 기다린 시간(초)",
		Buckets: []float64{.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5},
	})

	poolTimeouts = promauto.NewCounter(prometheus.CounterOpts{
		Name: "db_pool_timeouts_total",
		Help: "커넥션 대기 중 타임아웃되어 실패한 요청 수",
	})
)

// ---------------------------------------------------------------------------
// 가짜 커넥션 풀: 버퍼 채널 하나면 세마포어가 된다.
// ---------------------------------------------------------------------------

type pool struct {
	slots chan struct{}
}

func newPool(size int) *pool {
	poolSize.Set(float64(size))
	return &pool{slots: make(chan struct{}, size)}
}

// acquire 는 빈 자리가 날 때까지 기다린다. ctx 가 먼저 끝나면 포기한다.
func (p *pool) acquire(ctx context.Context) error {
	start := time.Now()
	select {
	case p.slots <- struct{}{}:
		poolWait.Observe(time.Since(start).Seconds())
		poolInUse.Set(float64(len(p.slots)))
		return nil
	case <-ctx.Done():
		poolWait.Observe(time.Since(start).Seconds())
		poolTimeouts.Inc()
		return ctx.Err()
	}
}

func (p *pool) release() {
	<-p.slots
	poolInUse.Set(float64(len(p.slots)))
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

// statusRecorder 는 핸들러가 실제로 쓴 상태 코드를 기록한다.
// 이게 없으면 Errors(5xx 비율)를 셀 수 없다.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// instrument 는 모든 핸들러를 감싸서 RED 세 가지를 한 곳에서 기록한다.
func instrument(path string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		httpInflight.Inc()
		defer httpInflight.Dec()

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)

		httpDuration.WithLabelValues(path, r.Method).Observe(time.Since(start).Seconds())
		httpRequests.WithLabelValues(path, r.Method, strconv.Itoa(rec.status)).Inc()
	}
}

// usersHandler: 풀을 거쳐야 하는 느린 엔드포인트. 여기가 병목이다.
func usersHandler(p *pool, cost costModel, acquireTimeout time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), acquireTimeout)
		defer cancel()

		if err := p.acquire(ctx); err != nil {
			// 풀이 고갈됐다. 실제 서비스에서도 이 지점이 503으로 나타난다.
			http.Error(w, `{"error":"db pool exhausted"}`, http.StatusServiceUnavailable)
			return
		}
		defer p.release()

		time.Sleep(queryCost(cost))

		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"users":[{"id":1,"name":"tuna"}]}`))
	}
}

// costModel: 요청마다 쿼리 비용이 다르다는 사실을 모델링한다.
//
// 이게 p99의 존재 이유다. 모든 요청이 똑같이 비싸면 큐가 생겨도 다 같이
// 기다릴 뿐이라 p50과 p99가 붙어서 움직인다. 현실은 그렇지 않다 —
// 대부분은 레코드 몇 개만 읽고 끝나지만, 어떤 사용자는 수만 건을 읽는다.
// 그 비싼 소수가 풀을 오래 점유하면 뒤에 줄 선 싼 요청들까지 막힌다.
// (head-of-line blocking)
type costModel struct {
	fast    time.Duration // 대부분의 요청
	slow    time.Duration // 무거운 소수
	slowPct float64       // 무거운 요청의 비율 (0~100)
}

// mean 은 평균 서비스 시간. 이론상 한계 처리량을 계산할 때 쓴다.
func (c costModel) mean() time.Duration {
	r := c.slowPct / 100
	return time.Duration((1-r)*float64(c.fast) + r*float64(c.slow))
}

func queryCost(c costModel) time.Duration {
	base := c.fast
	if rand.Float64()*100 < c.slowPct {
		base = c.slow
	}
	// ±30% 지터
	return time.Duration(float64(base) * (1 + (rand.Float64()-0.5)*0.6))
}

// healthHandler: 풀을 안 쓰는 빠른 엔드포인트.
// 부하를 걸었을 때 이쪽은 멀쩡하다는 걸 봐야 "병목이 풀"이라고 말할 수 있다.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok"}`))
}

// ---------------------------------------------------------------------------

func main() {
	var (
		addr           = ":" + env("PORT", "8080")
		poolCap        = envInt("POOL_SIZE", 5)
		acquireTimeout = time.Duration(envInt("ACQUIRE_TIMEOUT_MS", 3000)) * time.Millisecond

		cost = costModel{
			fast:    time.Duration(envInt("QUERY_MS", 10)) * time.Millisecond,
			slow:    time.Duration(envInt("SLOW_QUERY_MS", 400)) * time.Millisecond,
			slowPct: float64(envInt("SLOW_PCT", 5)),
		}
	)

	p := newPool(poolCap)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/users", instrument("/api/users", usersHandler(p, cost, acquireTimeout)))
	mux.HandleFunc("/api/health", instrument("/api/health", healthHandler))
	mux.Handle("/metrics", promhttp.Handler())

	// 이론적 최대 처리량 = 풀 크기 / 평균 쿼리 시간.
	capacity := float64(poolCap) / cost.mean().Seconds()
	log.Printf("listening on %s", addr)
	log.Printf("pool=%d  acquire_timeout=%v", poolCap, acquireTimeout)
	log.Printf("쿼리 비용: %v (%.0f%%) / %v (%.0f%%)  평균 %v",
		cost.fast, 100-cost.slowPct, cost.slow, cost.slowPct, cost.mean())
	log.Printf("이론상 한계 처리량 ≈ %.0f RPS (풀 %d개 / 평균 %v)", capacity, poolCap, cost.mean())

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
