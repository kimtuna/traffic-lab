// 부하를 계단식으로 올리면서 "언제 무너지는지"를 찾는 스크립트.
//
//   k6 run k6/load.js
//
// 서버 기본 설정(풀 5개 / 쿼리 50ms)의 이론상 한계는 약 100 RPS다.
// 가상 사용자가 그 지점을 넘어서는 구간에서 p99가 꺾이는 걸 보게 된다.

import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  stages: [
    { duration: '30s', target: 5 },   // 여유 구간 — 풀이 안 찬다
    { duration: '30s', target: 20 },  // 슬슬 큐가 생긴다
    { duration: '30s', target: 50 },  // p99가 먼저 꺾이기 시작
    { duration: '60s', target: 100 }, // 풀 고갈 → 503 등장
    { duration: '30s', target: 0 },   // 회복 구간
  ],

  // 통과/실패 기준. CI에 걸면 이게 그대로 성능 게이트가 된다.
  // 임계값 실패 시 k6는 종료 코드 99로 끝난다 (통과하면 0).
  //
  // ※ 기본 설정(POOL_SIZE=5)에서는 p(95)가 690ms로 **의도적으로 실패한다.**
  //   게이트가 실제로 막는 걸 보여주기 위한 것이다.
  //   POOL_SIZE=50 으로 올리면 285ms로 통과한다.
  thresholds: {
    'http_req_duration{endpoint:users}': ['p(95)<500', 'p(99)<1000'],
    'http_req_failed': ['rate<0.01'],
  },
};

export default function () {
  // 병목이 있는 엔드포인트
  const res = http.get(`${BASE}/api/users`, {
    tags: { endpoint: 'users' },
  });
  check(res, {
    'users 200': (r) => r.status === 200,
  });

  // 풀을 안 쓰는 엔드포인트. 부하 중에도 이쪽이 빠르다는 걸 대조군으로 확인한다.
  http.get(`${BASE}/api/health`, {
    tags: { endpoint: 'health' },
  });
}
