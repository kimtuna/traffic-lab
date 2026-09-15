// breakpoint 테스트 — "어디서 무너지는가"를 찾는다.
//
//   k6 run k6/scenarios/breakpoint.js
//
// 도착률을 계속 올리면서 SLO를 처음 위반하는 지점을 찾는다.
// 용량 계획의 출발점이 되는 숫자를 여기서 얻는다.
//
// 기본 설정(풀 5개)의 이론 한계는 169 RPS이므로 그 근처에서 무너져야 한다.

import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const MAX  = Number(__ENV.MAX_RATE || 400);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 3000,
      stages: [
        { duration: '30s', target: Math.round(MAX * 0.25) },
        { duration: '30s', target: Math.round(MAX * 0.50) },
        { duration: '30s', target: Math.round(MAX * 0.75) },
        { duration: '30s', target: MAX },
      ],
    },
  },
  // abortOnFail: SLO를 깨는 순간 테스트를 중단한다.
  // 그 시점의 도착률이 곧 '한계 용량'이다.
  thresholds: {
    'http_req_failed': [{ threshold: 'rate<0.01', abortOnFail: true }],
    'http_req_duration': [{ threshold: 'p(99)<1000', abortOnFail: true }],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/users`);
  check(res, { 'ok': (r) => r.status === 200 });
}
