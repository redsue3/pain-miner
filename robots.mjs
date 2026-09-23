// robots.mjs — robots.txt 게이트
//
// 왜 있나: 2026-09-21, 이 프로젝트는 처음에 브라우저 User-Agent 를 달고
// 디시·네이버 지식iN·루리웹을 긁었다. 셋 다 robots.txt 에서 거부하고 있었고,
// 지식iN 은 ClaudeBot / anthropic-ai / Claude-Web / Claude-SearchBot 를
// 이름으로 지목해 전면 차단하며 RAG 목적 접근 금지를 명시하고 있었다.
// 사람의 기억에 맡기지 않기 위해, 요청 직전에 코드가 직접 확인하고 막는다.
//
// 판정 규칙 (보수적):
//   1. Claude 계열 UA 중 하나라도 Disallow: / 면  →  그 호스트 전체 거부
//   2. User-agent: * 규칙에서 해당 경로가 Disallow 면  →  거부
//   3. robots.txt 가 없으면(404)  →  '미상'. 기본은 거부하고, 명시적으로 허용해야 통과
//
// 쿼리스트링을 포함한 경로로 매칭한다. Disallow: /*?s_type= 같은 패턴 때문.

import { execFile } from 'node:child_process';

const CLAUDE_UAS = ['claudebot', 'anthropic-ai', 'claude-web', 'claude-searchbot'];
const cache = new Map();

function fetchText(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-sL', '--compressed', '--max-time', '15', '-w', '\n%{http_code}', url],
      { maxBuffer: 5e6, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve({ code: 0, body: '' });
        const i = stdout.lastIndexOf('\n');
        resolve({ code: Number(stdout.slice(i + 1).trim()), body: stdout.slice(0, i) });
      });
  });
}

// robots.txt 를 UA 블록별로 쪼갠다.
function parse(text) {
  const groups = [];      // [{agents:[], rules:[{allow:bool, path:str}]}]
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
      if (!cur) continue;
      cur.rules.push({ allow: key === 'allow', path: val });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

// robots 패턴(* 와 $ 지원)을 경로에 맞춰본다.
function matches(pattern, path) {
  if (pattern === '') return false;                 // 빈 Disallow 는 '전부 허용'
  const rx = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\\\$$/, '$');
  try { return new RegExp(rx).test(path); } catch { return false; }
}

function groupFor(groups, agent) {
  return groups.find((g) => g.agents.includes(agent)) ?? null;
}

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

/**
 * @returns {{allowed:boolean, reason:string}}
 */
export async function check(urlStr) {
  const u = new URL(urlStr);
  const origin = u.origin;
  const path = u.pathname + (u.search || '');

  if (!cache.has(origin)) {
    const r = await fetchText(origin + '/robots.txt');
    const looksHtml = /^\s*<(!doctype|html)/i.test(r.body);
    cache.set(origin, (r.code === 200 && !looksHtml) ? parse(r.body) : null);
  }
  const groups = cache.get(origin);

  if (groups === null) {
    return { allowed: false, reason: 'robots.txt 없음/판독불가 → 기본 거부' };
  }

  // 1) Claude 계열 UA 전면 차단 여부
  for (const ua of CLAUDE_UAS) {
    const g = groupFor(groups, ua);
    if (!g) continue;
    if (g.rules.some((r) => !r.allow && (r.path === '/' || matches(r.path, path)))) {
      return { allowed: false, reason: `robots.txt 가 ${ua} 를 차단함` };
    }
  }

  // 2) User-agent: * 규칙
  const star = groupFor(groups, '*');
  const v = verdict(star, path);
  if (v === false) {
    const hit = star.rules.filter((r) => !r.allow && matches(r.path, path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return { allowed: false, reason: `Disallow: ${hit.path} (User-agent: *)` };
  }

  return { allowed: true, reason: star ? '허용' : 'User-agent:* 규칙 없음 → 허용' };
}

// CLI: node robots.mjs <url> [<url> ...]
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const u of process.argv.slice(2)) {
    const r = await check(u);
    console.log(`${r.allowed ? '허용' : '거부'}  ${u}\n      ${r.reason}`);
  }
}
