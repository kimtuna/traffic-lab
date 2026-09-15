// soak 테스트 — 오래 돌리면 새는 곳이 있는가.
//
//   k6 run k6/scenarios/soak.js                 (기본 30분)
//   DURATION=4h k6 run k6/scenarios/soak.js     (실무는 보통 4~24시간)
//
// 짧은 테스트로는 절대 안 보이는 것들을 잡는다.
//   - 메모리 누수 (힙이 계속 우상향)
//   - 커넥션/파일디스크립터 누수
//   - 로그·디스크 누적
//   - 캐시 무한 증가
//
// 부하는 평상시 수준으로 둔다. 무너뜨리는 게 목적이 아니다.
// **시간에 따른 기울기**를 보는 것이 목적이다.

import http from 'k6/http';
import { sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const RATE = Number(__ENV.RATE || 80);   // 여유 있는 수준
const DUR  = __ENV.DURATION || '30m';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DUR,
      preAllocatedVUs: 50,
      maxVUs: 500,
    },
  },
  thresholds: {
    // 시작과 끝의 지연이 같아야 한다. 우상향하면 누수 신호.
    'http_req_duration': ['p(99)<1000'],
    'http_req_failed': ['rate<0.001'],
  },
};

export default function () {
  http.get(`${BASE}/api/users`);
  sleep(1);
}
