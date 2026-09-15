// 전부 제대로 연결됐는지 30초짜리로 빠르게 확인하는 스크립트.
//
//   k6 run k6/smoke.js

import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';

export const options = {
  vus: 3,
  duration: '30s',
};

export default function () {
  const res = http.get(`${BASE}/api/users`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
