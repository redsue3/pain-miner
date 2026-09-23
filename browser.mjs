// browser.mjs — 헤드리스 Chrome 으로 페이지를 렌더링해서 HTML 을 돌려준다.
//
// 왜 필요한가: 82cook 과 인벤은 검색 결과를 JS 로 그린다.
// curl 로 받으면 검색어와 무관하게 늘 기본 목록이 온다 (실측: 존재하지 않는
// 문자열로 검색해도 결과 건수가 동일했다).
//
// 무엇이 아닌가: 이건 차단을 우회하는 장치가 아니다.
// 모든 요청은 robots.mjs 게이트를 먼저 통과해야 하고, 게이트는 전송 수단과
// 무관하게 판정한다. 거부된 호스트는 브라우저로도 열지 않는다.

import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { check } from './robots.mjs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findChrome() {
  const hit = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!hit) throw new Error('Chrome/Edge 를 찾지 못했습니다.');
  return hit;
}

let browser = null;

export async function launch() {
  if (browser) return browser;
  browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--lang=ko-KR'],
  });
  return browser;
}

export async function close() {
  if (browser) { await browser.close(); browser = null; }
}

/**
 * 페이지를 열고, waitFor 선택자가 나타날 때까지 기다린 뒤 HTML 을 반환한다.
 * robots 게이트를 통과하지 못하면 요청 자체를 보내지 않는다.
 */
export async function render(url, { waitFor = null, timeout = 20000 } = {}) {
  const gate = await check(url);
  if (!gate.allowed) return { ok: false, blocked: true, err: gate.reason };

  const b = await launch();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 8000 }).catch(() => {});
    }
    const html = await page.content();
    return { ok: true, html };
  } catch (e) {
    return { ok: false, err: String(e.message || e).split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}
