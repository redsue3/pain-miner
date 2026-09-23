// core/robots.mjs — robots.txt 판정
//
// 이전 버전은 판정하고 곧바로 요청을 막았다. 이번엔 '판정'과 '집행'을 나눈다.
//   · 판정은 언제나 한다 — 이 사이트가 뭐라고 써놨는지는 항상 알려준다.
//   · 집행 수위는 사이트마다 config.json 의 "robots" 값으로 정한다:
//       enforce  거부면 요청하지 않는다 (기본값)
//       warn     경고만 찍고 진행한다
//       off      확인조차 하지 않는다
//
// 기본을 enforce 로 둔 이유: 기본값이 안전한 쪽이어야 실수로 넘는 일이 없다.
//
// ── 누구에게 적용되는 규칙인가 (2026-09-23 정정) ──────────────────────────
// 예전 이 파일은 'robots.txt 가 ClaudeBot 을 막으면 그 호스트 전체를 거부'했다.
// 그건 틀렸다. robots.txt 는 각 크롤러가 '자기 이름에 해당하는 그룹'을 따르는 규약이고,
// 이름이 없는 클라이언트는 User-agent: * 를 따른다. 이 도구는 ClaudeBot 이 아니라
// 사용자가 자기 PC 에서 돌리는 개인 수집기다. 따라서 * 규칙이 우리 규칙이다.
//
// 그 오해 때문에 디시인사이드를 통째로 못 쓰는 곳으로 분류하고 있었다. 실제 파일은:
//   User-agent: ClaudeBot / GPTBot / CCBot ...  →  Disallow: /   ("AI 학습 크롤러 차단")
//   User-agent: *                               →  Allow: /
//   단, 갤러리 14곳은 * 에도 Disallow (47, cat, dog, stock_new2 …)
// 즉 '일반 수집은 되고, AI 학습 크롤러만 막고, 특정 갤러리는 모두 금지'다.
//
// 그래서 판정은 * 규칙으로 하되, AI 학습 크롤러를 막아뒀다는 사실은 따로 알려준다.
// 수집한 글을 모델 학습에 쓸 생각이라면 그건 사이트가 명시적으로 거부한 용도이기 때문이다.
// 갤러리 단위 Disallow 는 * 규칙이므로 그대로 지켜진다.

import { execFile } from 'node:child_process';

// '이 사이트는 AI 학습 크롤러를 막아뒀다' 를 알아보기 위한 목록. 차단 판정용이 아니다.
const AI_CRAWLER_UAS = [
  'claudebot', 'anthropic-ai', 'claude-web', 'claude-searchbot',
  'gptbot', 'ccbot', 'google-extended', 'applebot-extended',
  'bytespider', 'perplexitybot', 'cohere-ai', 'meta-externalagent', 'amazonbot',
];
const cache = new Map();

// robots.txt 를 받을 때도 평범한 브라우저처럼 보여야 한다.
// UA 없는 요청을 막는 사이트가 있다 — 코엑스는 403 을 준다 (2026-09-23 실측).
// 그걸 '판독 불가 → 거부' 로 처리하면, 실제로는 허용하는 사이트를 우리가 스스로 막게 된다.
const ROBOTS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function fetchText(url) {
  return new Promise((resolve) => {
    execFile('curl', [
      '-sL', '--compressed', '--max-time', '15',
      '-A', ROBOTS_UA,
      '-H', 'Accept: text/plain,*/*;q=0.8',
      '-H', 'Accept-Language: ko-KR,ko;q=0.9,en;q=0.8',
      '-w', '\n%{http_code}', url,
    ],
      { maxBuffer: 5e6, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve({ code: 0, body: '' });
        const i = stdout.lastIndexOf('\n');
        resolve({ code: Number(stdout.slice(i + 1).trim()), body: stdout.slice(0, i) });
      });
  });
}

function parse(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'disallow' || key === 'allow') {
      if (cur) cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

// robots 패턴(* 와 $ 지원)을 경로에 맞춰본다.
function matches(pattern, path) {
  if (pattern === '') return false;          // 빈 Disallow 는 '전부 허용'
  // robots.txt 에서 특별한 뜻을 가진 문자는 * 와 끝의 $ 뿐이다. 나머지는 전부 글자 그대로다.
  // 특히 '?' 를 안 막으면 정규식의 '앞 글자 0~1회'로 해석되어 규칙이 통째로 헛돈다.
  // 실제 사고 (2026-09-23): 디시 'Disallow: /board/lists/?id=stock_new2' 가
  // '/board/lists' + (/ 있어도 되고 없어도 됨) + 'id=...' 로 읽혀 매칭에 실패했고,
  // 금지된 갤러리가 '허용'으로 판정됐다.
  const rx = '^' + pattern
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')   // 메타문자 escape (* 는 일부러 뺀다)
    .replace(/\*/g, '.*')                    // robots 의 * 는 와일드카드
    .replace(/\\\$$/, '$');                  // 끝의 $ 는 앵커
  try { return new RegExp(rx).test(path); } catch { return false; }
}

const groupFor = (groups, agent) => groups.find((g) => g.agents.includes(agent)) ?? null;

// 가장 긴 매칭 규칙이 이긴다 (robots.txt 표준 동작)
function verdict(group, path) {
  if (!group) return null;
  let best = null;
  for (const r of group.rules) {
    if (!matches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length) best = r;
  }
  return best ? best.allow : null;
}

/** robots.txt 가 뭐라고 하는지만 돌려준다. 막지는 않는다. */
export async function check(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return { allowed: false, reason: '잘못된 URL' }; }
  const origin = u.origin;
  const path = u.pathname + (u.search || '');

  if (!cache.has(origin)) {
    const r = await fetchText(origin + '/robots.txt');
    const looksHtml = /^\s*<(!doctype|html)/i.test(r.body);
    if (r.code === 200 && !looksHtml) cache.set(origin, parse(r.body));
    // robots.txt 가 4xx 면 '규칙이 없다'는 뜻이다. 표준(RFC 9309)이 그렇게 정하고 있고,
    // 실제로 그런 호스트가 있다 — search.dcinside.com 은 robots.txt 가 404 다.
    // 예전엔 이걸 '판독 불가 → 거부'로 처리해서, 아무 제한도 걸지 않은 곳을 우리가 막았다.
    else if (r.code >= 400 && r.code < 500) cache.set(origin, 'none');
    // 아예 못 받은 경우(네트워크 실패, 5xx)는 '모르는' 것이므로 보수적으로 거부한다.
    else cache.set(origin, null);
  }
  const groups = cache.get(origin);

  if (groups === null) {
    return { allowed: false, aiBlocked: false, reason: 'robots.txt 를 받지 못함 → 기본 거부' };
  }
  if (groups === 'none') {
    return { allowed: true, aiBlocked: false, reason: 'robots.txt 없음(4xx) → 제한 없음' };
  }

  // 이 사이트가 AI 학습 크롤러를 이름으로 막아뒀는가.
  // 우리 판정을 바꾸지는 않는다 (우리는 그 크롤러가 아니다). 다만 알려준다 —
  // 모은 글을 모델 학습에 쓰는 것은 사이트가 명시적으로 거부한 용도다.
  const aiBlocked = AI_CRAWLER_UAS.some((ua) => {
    const g = groupFor(groups, ua);
    return !!g && g.rules.some((r) => !r.allow && r.path === '/');
  });

  // 이름 없는 클라이언트에게 적용되는 규칙은 User-agent: * 다.
  const star = groupFor(groups, '*');
  const v = verdict(star, path);
  if (v === false) {
    const hit = star.rules.filter((r) => !r.allow && matches(r.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return { allowed: false, aiBlocked, reason: `Disallow: ${hit.path} (User-agent: *)` };
  }
  return {
    allowed: true, aiBlocked,
    reason: star ? '허용 (User-agent: *)' : 'User-agent:* 규칙 없음 → 허용',
  };
}

/**
 * 정책까지 적용한 게이트.
 * @returns {{go:boolean, warn:string|null, reason:string}}
 */
export async function gate(urlStr, policy = 'enforce') {
  if (policy === 'off') return { go: true, warn: null, reason: 'robots 확인 안 함(off)' };
  const r = await check(urlStr);
  if (r.allowed) return { go: true, warn: null, reason: r.reason };
  if (policy === 'warn') return { go: true, warn: r.reason, reason: r.reason };
  return { go: false, warn: null, reason: r.reason };
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (const u of process.argv.slice(2)) {
    const r = await check(u);
    console.log(`${r.allowed ? '허용' : '거부'}  ${u}\n      ${r.reason}`);
  }
}
