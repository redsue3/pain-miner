// core/fetch.mjs — 한 번의 '가져오기'. curl 로 먼저 시도하고, 막히면 브라우저로 올린다.
//
// ── 403 / 405 / 404 가 왜 뜨는가 ────────────────────────────────────────────
// 방화벽이 아니다. 원인은 보통 셋 중 하나고, 해법이 각각 다르다.
//
// (1) 헤더가 브라우저 같지 않다        → 403
//     User-Agent 가 없거나 도구 이름 그대로, Referer 없음, sec-fetch-* 없음.
//     아래 HEADERS 로 채워 보낸다. 한국 커뮤니티는 Referer 검사가 특히 심하다.
//
// (2) TLS 지문이 브라우저가 아니다     → 403  ← 이게 진짜 함정이다
//     Cloudflare 류는 헤더가 아니라 TLS 핸드셰이크 모양(JA3)을 본다.
//     Node 내장 fetch(undici)는 여기서 즉시 걸린다. 실측(2026-09-22, arca.live):
//       curl + 브라우저 UA        → 200
//       node fetch + 똑같은 헤더  → 403   (헤더를 하나씩 빼봐도 전부 403)
//       헤드리스 크롬             → 403   ("잠시만 기다리십시오…" 챌린지)
//     그래서 전송은 curl 에 맡긴다. 헤더를 아무리 만져도 undici 로는 못 푼다.
//
// (3) 그 경로가 GET 을 안 받는다       → 405
//     검색이 POST 폼인 경우. 어댑터에 method:'POST' 와 body 를 주면 된다.
//     404 는 대개 진짜로 주소가 틀린 것이다(게시판 id 변경 등) — 헤더로는 안 풀린다.
//
// 하는 일은 '위장'이 아니라 '평범한 브라우저 요청을 제대로 갖춰 보내는 것'이다.
// 그래도 거부하면 물러선다 — limiter 가 벌점을 매겨 점점 느려지고, 재시도는 없다.

import { execFile } from 'node:child_process';
import { readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { render } from './browser.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const SESSION_DIR = resolve('./.session');
const COOKIE_JAR = join(SESSION_DIR, 'cookies.txt');   // curl 이 직접 읽고 쓴다
const TMP_DIR = join(SESSION_DIR, 'tmp');

mkdirSync(TMP_DIR, { recursive: true });

/** 실제 Chrome 이 문서를 요청할 때 보내는 헤더 일습 */
function headerArgs(url, referer) {
  const origin = (() => { try { return new URL(url).origin + '/'; } catch { return null; } })();
  const h = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Referer': referer ?? origin,
  };
  const args = [];
  for (const [k, v] of Object.entries(h)) if (v) args.push('-H', `${k}: ${v}`);
  return args;
}

function decode(buf, charset = 'utf-8') {
  try { return new TextDecoder(charset).decode(buf); }
  catch { return Buffer.from(buf).toString('utf8'); }
}

/**
 * curl 한 번. 본문은 임시 파일로 받고(바이너리 보존 → EUC-KR 디코딩 가능),
 * stdout 으로는 상태코드만 받는다.
 */
function curlOnce(url, { charset, referer, method, body, timeout }) {
  const tmp = join(TMP_DIR, randomUUID() + '.bin');
  const args = [
    '-sL', '--compressed',
    // curl 은 소수점 초를 받는다. 올림하면 100ms 요청이 1초가 되어 타임아웃이 안 먹는다.
    '--max-time', (Math.max(timeout, 50) / 1000).toFixed(3),
    '-A', UA,
    '-b', COOKIE_JAR, '-c', COOKIE_JAR,      // 세션 쿠키가 실행 사이에 유지된다
    ...headerArgs(url, referer),
    '-o', tmp,
    '-w', '%{http_code}',
  ];
  if (method && method !== 'GET') args.push('-X', method);
  if (body) args.push('--data-raw', body, '-H', 'Content-Type: application/x-www-form-urlencoded');
  args.push(url);

  return new Promise((done) => {
    execFile('curl', args, { maxBuffer: 1e6, encoding: 'utf8' }, (err, stdout) => {
      let buf = null;
      try { buf = readFileSync(tmp); } catch { /* 본문 없음 */ }
      try { unlinkSync(tmp); } catch { /* 지우기 실패는 무시 */ }

      // 상태코드를 먼저 본다. curl 이 도중에 끊기면 %{http_code} 가 000 으로 찍히는데,
      // 이때 -o 파일에는 '끊긴 앞부분'이 남아 있을 수 있다. 그걸 성공으로 넘기면
      // 반쪽짜리 HTML 을 파싱해서 조용히 결과가 줄어든다. 그래서 status 0 은 무조건 실패다.
      const status = Number(String(stdout).trim()) || 0;
      if (status === 0) {
        const why = err ? String(err.message).split('\n')[0] : '응답 없음 (타임아웃이거나 연결 실패)';
        return done({ ok: false, status: 0, err: why });
      }
      if (status >= 400) return done({ ok: false, status, err: `HTTP ${status}` });
      if (!buf) return done({ ok: false, status, err: '본문 없음' });
      if (buf.length < 400) return done({ ok: false, status, err: `응답이 너무 짧음 (${buf.length}바이트)` });
      done({ ok: true, status, html: decode(buf, charset) });
    });
  });
}

/**
 * @param {string} url
 * @param {{charset?:string, referer?:string, method?:string, body?:string,
 *          mode?:'auto'|'http'|'browser', waitFor?:string, timeout?:number}} opt
 * @returns {{ok:boolean, status:number, html?:string, err?:string, via:'http'|'browser'}}
 */
export async function grab(url, opt = {}) {
  const {
    charset = 'utf-8', referer = null, method = 'GET', body = null,
    mode = 'auto', waitFor = null, timeout = 25000,
  } = opt;

  if (mode === 'browser') {
    const r = await render(url, { waitFor, referer, timeout });
    return { ...r, via: 'browser' };
  }

  const r = await curlOnce(url, { charset, referer, method, body, timeout });
  if (r.ok) return { ...r, via: 'http' };
  if (mode !== 'auto') return { ...r, via: 'http' };

  // curl 이 거부당했다. 진짜 브라우저로 한 번만 올려본다.
  // 브라우저는 JS 챌린지·리다이렉트·쿠키를 전부 정상 처리하므로 여기서 풀리기도 한다.
  // 다만 헤드리스는 Cloudflare 가 잡아내는 경우가 있다 — 그럴 땐 config 의
  // headless:false + offscreenWindow:true 로 진짜 창을 화면 밖에 띄우는 쪽이 통한다.
  const b = await render(url, { waitFor, referer, timeout });
  if (b.ok) return { ...b, via: 'browser' };
  return { ok: false, status: b.status || r.status, err: b.err ?? r.err, via: 'browser' };
}

// curl 이 쿠키 파일을 직접 관리하므로 따로 저장할 것이 없다. 호출부 호환용.
export const saveCookies = () => {};
