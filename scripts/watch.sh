#!/usr/bin/env bash
# 대시보드 없이 터미널에서 핵심 지표만 본다.
#
#   ./scripts/watch.sh        2초마다 갱신
#   ./scripts/watch.sh once   한 번만 출력
set -u

PROM=${PROM:-http://localhost:9090}
PATH_LABEL=${PATH_LABEL:-/api/users}

query() {
  curl -s --get "$PROM/api/v1/query" --data-urlencode "query=$1" \
    | python3 -c 'import sys,json
r=json.load(sys.stdin).get("data",{}).get("result",[])
print(r[0]["value"][1] if r else "nan")' 2>/dev/null || echo nan
}

bucket="http_request_duration_seconds_bucket{path=\"$PATH_LABEL\"}"

row() {
  rps=$(query "sum(rate(http_requests_total{path=\"$PATH_LABEL\"}[1m]))")
  p50=$(query "histogram_quantile(0.50, sum by (le) (rate($bucket[1m])))")
  p99=$(query "histogram_quantile(0.99, sum by (le) (rate($bucket[1m])))")
  wait=$(query "histogram_quantile(0.99, rate(db_pool_wait_seconds_bucket[1m]))")
  queue=$(query "http_inflight_requests - db_pool_in_use")

  python3 - "$rps" "$p50" "$p99" "$wait" "$queue" <<'PY'
import sys, math
def f(x):
    try:
        v = float(x)
        return None if math.isnan(v) else v
    except ValueError:
        return None
rps, p50, p99, wait, queue = map(f, sys.argv[1:6])
def s(v, w, d=4):
    return f"{v:{w}.{d}f}" if v is not None else f"{'-':>{w}}"
ratio = f"{p99/p50:8.2f}x" if p50 and p99 and p50 > 0 else f"{'-':>9}"
print(f"{s(rps,6,2)} {s(p50,8)} {s(p99,8)} {ratio} {s(queue,5,0)} {s(wait,8)}")
PY
}

header="   RPS      p50      p99   p99/p50    큐   대기p99"

if [ "${1:-}" = "once" ]; then
  echo "$header"; row; exit 0
fi

echo "$header  (Ctrl+C로 종료)"
while true; do row; sleep 2; done
