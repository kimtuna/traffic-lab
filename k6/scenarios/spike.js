// spike 테스트 — 갑작스러운 폭증을 견디는가.
//
//   k6 run k6/scenarios/spike.js
//
// 티켓 오픈, 푸시 알림 발송, 특가 시작 같은 순간을 모사한다.
// 평상시 → 10배 폭증 → 평상시 로 돌아온다.
//
// 봐야 할 것은 최고점의 지연이 아니라 **회복 시간**이다.
// 폭증이 끝난 뒤에도 큐가 남아 한참 느린 경우가 많다.

import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const BASELINE = Number(__ENV.BASELINE || 50);
const PEAK     = Number(__ENV.PEAK || 500);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: BASELINE,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 5000,
      stages: [
        { duration: '40s', target: BASELINE },  // 평상시
        { duration: '10s', target: PEAK },      // 급격히 폭증
        { duration: '30s', target: PEAK },      // 유지
        { duration: '10s', target: BASELINE },  // 복귀
        { duration: '60s', target: BASELINE },  // ★ 회복 관찰 구간
      ],
    },
  },
};

export default function () {
  http.get(`${BASE}/api/users`);
}
