// core/limiter.mjs — 호스트별 속도 제어 + 적응형 백오프
//
// 차단을 피하는 방법은 '들키지 않는 것'이 아니라 '차단당할 짓을 안 하는 것'이다.
// 짧은 시간에 여러 글을 보면 막는 사이트가 많다는 건, 뒤집으면
// 간격을 두면 막지 않는다는 뜻이다. 이 모듈이 그 간격을 강제한다.
//
// 동작:
//   · 호스트마다 독립된 큐. 한 호스트에 동시에 N개만 나간다(기본 1 = 순차).
//   · 매 요청 사이에 minDelay + random(jitter) 를 둔다. 고정 간격은 그 자체로
//     기계처럼 보이므로 흔들어 준다.
//   · 429 / 403 / 503 을 받으면 그 호스트의 대기시간을 2배로 늘린다(최대 5분).
//     연속 성공이 쌓이면 원래 속도로 천천히 되돌린다.
//
// 즉, 사이트가 "그만"이라고 하면 이 크롤러는 더 세게 두드리지 않고 물러선다.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HostState {
  constructor(cfg) {
    this.cfg = cfg;
    this.running = 0;
    this.queue = [];
    this.penaltyMs = 0;      // 백오프로 추가된 대기시간
    this.okStreak = 0;
    this.lastAt = 0;
    this.stats = { sent: 0, blocked: 0, waitedMs: 0 };
  }
}

export class Limiter {
  constructor(rateCfg) {
    this.cfg = rateCfg;
    this.hosts = new Map();
  }

  _host(url) {
    let h;
    try { h = new URL(url).host; } catch { h = String(url); }
    if (!this.hosts.has(h)) this.hosts.set(h, new HostState(this.cfg));
    return this.hosts.get(h);
  }

  /**
   * 이 호스트에 지금 요청해도 되는 시점까지 기다린다.
   * @param {number} [floorMs] 이 요청에 강제할 최소 간격.
   *   robots.txt 의 Crawl-delay 를 지키기 위한 것이다 (코엑스는 10초를 명시한다).
   *   설정값보다 크면 이쪽이 이긴다 — 사이트가 말한 것을 설정으로 덮지 않는다.
   */
  async acquire(url, floorMs = 0) {
    const st = this._host(url);
    // 동시 실행 슬롯
    if (st.running >= this.cfg.perHostConcurrency) {
      await new Promise((resolve) => st.queue.push(resolve));
    }
    st.running++;

    const base = Math.max(this.cfg.minDelayMs, floorMs || 0);
    const gap = base
      + Math.floor(Math.random() * this.cfg.jitterMs)
      + st.penaltyMs;
    const since = Date.now() - st.lastAt;
    const wait = Math.max(0, gap - since);
    if (wait > 0) { st.stats.waitedMs += wait; await sleep(wait); }
    st.lastAt = Date.now();
    st.stats.sent++;
    return st;
  }

  release(url) {
    const st = this._host(url);
    st.running = Math.max(0, st.running - 1);
    const next = st.queue.shift();
    if (next) next();
  }

  /** 응답을 보고 속도를 조정한다. status 는 HTTP 코드(모르면 0). */
  report(url, { ok, status = 0 }) {
    const st = this._host(url);
    const b = this.cfg.backoff;
    const isBlock = status === 429 || status === 403 || status === 503 || status === 405;

    if (isBlock || !ok) {
      if (isBlock) {
        st.stats.blocked++;
        st.okStreak = 0;
        st.penaltyMs = st.penaltyMs === 0
          ? b.startMs
          : Math.min(b.maxMs, Math.round(st.penaltyMs * b.factor));
        return { slowedTo: st.penaltyMs };
      }
      return null;
    }

    st.okStreak++;
    if (st.penaltyMs > 0 && st.okStreak >= b.recoverAfterOk) {
      st.penaltyMs = Math.floor(st.penaltyMs / 2);
      if (st.penaltyMs < b.startMs / 2) st.penaltyMs = 0;
      st.okStreak = 0;
      return { recoveredTo: st.penaltyMs };
    }
    return null;
  }

  /** 현재 이 호스트가 벌점 상태인가 */
  penaltyOf(url) { return this._host(url).penaltyMs; }

  summary() {
    const out = {};
    for (const [h, st] of this.hosts) {
      out[h] = { ...st.stats, penaltyMs: st.penaltyMs, waitedSec: Math.round(st.stats.waitedMs / 1000) };
    }
    return out;
  }
}
