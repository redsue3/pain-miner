// core/browser.mjs — 실제 Chrome 을 백그라운드에 띄워 페이지를 렌더링한다.
//
// "창이 실제로 열려 있어야만 들어가지는 사이트" 에 대한 답이다.
// 세 가지 모드가 있고 config.json 의 engine 에서 고른다:
//
//   headless: true                   창이 아예 안 뜬다. 평소엔 이걸 쓴다.
//   headless:false, offscreen:true   진짜 창을 띄우되 화면 밖(-3000,-3000)에 둔다.
//                                    headless 를 거부하는 사이트용. 눈에는 안 보인다.
//   headless:false, offscreen:false  창이 보인다. 셀렉터가 깨졌을 때 눈으로 디버깅용.
//
// 세션 유지가 핵심이다. userDataDir 를 고정하면 쿠키와 로컬스토리지가 실행 사이에
// 남는다. 매번 새 손님처럼 들어가지 않고 '어제 왔던 그 브라우저'로 보이기 때문에,
// 첫 방문자에게 인터스티셜을 띄우는 사이트에서 반복 재검증을 겪지 않는다.
//
// 이미지·폰트·동영상은 받지 않는다. 우리가 필요한 건 HTML 뿐이다.
// 부수 효과로 전송량이 크게 줄어 상대 서버 부담도 그만큼 준다.

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const P = String.raw;   // 윈도우 경로의 역슬래시를 그대로 쓰기 위해

const CHROME_CANDIDATES = [
  P`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  P`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
  (process.env.LOCALAPPDATA ?? '') + P`\Google\Chrome\Application\chrome.exe`,
  P`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
  P`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];

export function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!hit) {
    throw new Error('Chrome 또는 Edge 를 찾지 못했습니다. 설치 경로를 core/browser.mjs 의 CHROME_CANDIDATES 에 추가하세요.');
  }
  return hit;
}

// stylesheet 는 막지 않는다. Cloudflare 챌린지 페이지가 자기 리소스를 못 받으면
// 검증을 끝내지 못하고 그 자리에 멈춘다. 이미지·폰트·동영상만 막아도 전송량은 충분히 준다.
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

// "잠시만 기다리십시오…" / "Just a moment…" — 통과 대기가 필요한 화면
const CHALLENGE_TITLE = /just a moment|잠시만 기다|checking your browser|attention required|ddos/i;

let _browser = null;
let _cfg = {};

export async function launch(cfg = {}) {
  if (_browser?.connected) return _browser;
  _cfg = cfg;

  const args = [
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--lang=ko-KR',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1366,900',
  ];
  if (cfg.headless === false && cfg.offscreenWindow) {
    args.push('--window-position=-3000,-3000');
  }

  const opts = {
    executablePath: findChrome(),
    headless: cfg.headless !== false,
    args,
    defaultViewport: { width: 1366, height: 900 },
  };

  if (cfg.keepSession !== false) {
    const dir = resolve('./.session/profile');
    mkdirSync(dir, { recursive: true });
    opts.userDataDir = dir;          // 쿠키·세션이 실행 사이에 남는다
  }

  _browser = await puppeteer.launch(opts);
  return _browser;
}

export async function close() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

/**
 * URL 을 열고 HTML 과 HTTP 상태코드를 돌려준다.
 * @returns {{ok:boolean, status:number, html?:string, err?:string, finalUrl?:string}}
 */
export async function render(url, { waitFor = null, referer = null, timeout = 25000 } = {}) {
  const b = await launch(_cfg);
  const page = await b.newPage();
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      ...(referer ? { Referer: referer } : {}),
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (BLOCKED_TYPES.has(req.resourceType())) req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });

    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    let status = res?.status() ?? 0;

    // 검증 화면이 떴으면 스스로 풀릴 때까지 기다린다. 두드리지 않고 그냥 기다리는 것이다.
    // 통과하면 사이트가 알아서 본래 페이지로 넘겨준다.
    if (CHALLENGE_TITLE.test(await page.title().catch(() => ''))) {
      const until = Date.now() + Math.min(timeout, 20000);
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        const t = await page.title().catch(() => '');
        if (!CHALLENGE_TITLE.test(t)) { status = 200; break; }
      }
      if (CHALLENGE_TITLE.test(await page.title().catch(() => ''))) {
        return {
          ok: false, status: status || 403, finalUrl: page.url(),
          err: '봇 검증 화면을 통과하지 못했습니다 — config 의 headless 를 false, offscreenWindow 를 true 로 바꿔보세요',
        };
      }
    }

    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 8000 }).catch(() => {});
    } else {
      // 목록이 JS 로 채워지는 사이트를 위해 아주 짧게만 더 기다린다.
      await new Promise((r) => setTimeout(r, 700));
    }

    const html = await page.content();
    return { ok: status > 0 && status < 400, status, html, finalUrl: page.url() };
  } catch (e) {
    return { ok: false, status: 0, err: String(e.message ?? e).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}
