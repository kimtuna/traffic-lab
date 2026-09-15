// 실무형 기본 부하 — open-loop (도착률 기반)
//
//   k6 run k6/scenarios/open-loop.js
//   RATE=300 k6 run k6/scenarios/open-loop.js
//
// load.js 와의 차이가 핵심이다.
//
//   load.js (closed-loop)      : "동시 사용자 100명"
//     → 서버가 느려지면 요청도 같이 느려진다. 서버가 스스로를 보호한다.
//
//   이 스크립트 (open-loop)    : "초당 200건 도착"
//     → 서버가 느려져도 요청은 계속 같은 속도로 들어온다.
//
// 실제 사용자 트래픽은 open-loop다. 내 서버가 느리다고 사용자가
// 접속을 덜 하지는 않는다. closed-loop 테스트만 하면 지연을 과소평가하게 되는데
// 이를 coordinated omission 이라 한다.

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const RATE = Number(__ENV.RATE || 200);      // 목표 도착률 (req/s)
const DUR  = __ENV.DURATION || '2m';

export const options = {
  scenarios: {
    steady: {
      executor: 'ramping-arrival-rate',
      startRate: Math.round(RATE * 0.1),
      timeUnit: '1s',
      // VU는 "도착률을 채우기 위한 일꾼"일 뿐, 더는 부하의 단위가 아니다.
      // 서버가 느려지면 k6가 알아서 VU를 더 투입해 도착률을 유지한다.
      preAllocatedVUs: Math.round(RATE * 0.5),
      maxVUs: RATE * 10,
      stages: [
        { duration: '30s', target: Math.round(RATE * 0.5) },
        { duration: '30s', target: RATE },
        { duration: DUR,   target: RATE },
        { duration: '20s', target: 0 },
      ],
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'http_req_duration{endpoint:users}': ['p(99)<1000'],
    // maxVUs가 모자라면 요청을 아예 못 보낸다. 이게 0이 아니면 측정 자체가 무효다.
    'dropped_iterations': ['count<1'],
  },
};

export default function () {
  const res = http.get(`${BASE}/api/users`, { tags: { endpoint: 'users' } });
  check(res, { 'users 200': (r) => r.status === 200 });

  // think time — 실제 사용자는 쉬지 않고 요청하지 않는다.
  // open-loop에서는 도착률이 이미 고정이라 부하 크기에 영향을 주지 않고,
  // 세션당 동시 연결 수를 현실적으로 만드는 역할만 한다.
  sleep(Math.random() * 0.5);
}
