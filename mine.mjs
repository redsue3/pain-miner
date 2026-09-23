// mine.mjs — 커뮤니티에서 '사소한 일상 불편' 신호를 모은다.
//
// 모든 요청은 두 개의 관문을 통과해야 한다:
//   1. robots.mjs   — 이 호스트/경로를 긁어도 되는가
//   2. sourcecheck  — 이 사이트의 검색이 실제로 작동하는가 (별도 실행)
//
// 수집한 모든 행은 out/evidence.jsonl 에 '원문 그대로' 기록된다.
// verify.mjs 가 나중에 보고서의 인용문을 이 파일과 글자 단위로 대조한다.
// 즉, 내가 문장을 지어내거나 다듬으면 검증에서 걸린다.
//
// 사용법:
//   node mine.mjs                   전체
//   node mine.mjs --source arca     특정 소스만
//   node mine.mjs --pages 3         검색어당 페이지 수 (기본 2)

import { writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SOURCES, KEYWORDS, CURL_ARGS } from './sources.mjs';
import { check } from './robots.mjs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true);
};
const PAGES = Number(flag('pages', 2));
const ONLY = flag('source');
const SINCE = flag('since', null);   // 예: --since 2023  (그 해 이후 글만)
const DELAY = Number(flag('delay', 600));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex');

function curl(url, charset = 'utf-8') {
  return new Promise((resolve) => {
    // 버퍼로 받아 사이트별 인코딩으로 디코딩한다.
    // 뽐뿌는 EUC-KR 이라 UTF-8 로 읽으면 제목이 통째로 깨진다.
    execFile('curl', [...CURL_ARGS, url], { maxBuffer: 20e6, encoding: 'buffer' },
      (err, buf) => {
        if (err) return resolve({ ok: false, err: err.message.split('\n')[0] });
        if (!buf || buf.length < 500) return resolve({ ok: false, err: '빈 응답' });
        let html;
        try { html = new TextDecoder(charset).decode(buf); }
        catch { html = buf.toString('utf8'); }
        resolve({ ok: true, html });
      });
  });
}

async function get(url, charset) {
  const gate = await check(url);
  if (!gate.allowed) return { ok: false, blocked: true, err: gate.reason };
  return curl(url, charset);
}

// ---------- 신호 점수 ----------
// 제목만 보고 '해결책을 찾다 실패했나'를 가늠한다. 정렬용이지 판단이 아니다.
const STRONG = [/없나요|없을까|없나\?|없나$|없음\?/, /만들어\s*줬?으면/, /어떻게\s*(하|해야)/, /방법\s*(좀|있|없|알려)/];
const MEDIUM = [/매번|맨날|자꾸|일일이|하나하나/, /까먹|잊어버|헷갈/, /귀찮|번거|불편|짜증/];
// 제외 대상. 앞의 둘은 광고·공지, 뒤의 둘은 '앱으로 풀 문제가 아닌 것'이다.
// 신변·관계 상담이 "방법 없을까요"에 대량으로 걸려서 결과를 덮어버린다.
const NOISE = [
  /공지|이벤트|당첨|경품|쿠폰/,
  /쿠팡|특가|핫딜|파트너스|제휴/,
  /\bAV\b|섹스|야짤|19금|자위/,
  /자살|극단적\s*선택|유서|죽는\s*방법/,        // 수집돼도 보고서에 올릴 내용이 아니다
  /이혼|전도|바람\s*피|고소|소송|위자료|상간/,   // 신변·관계 상담
];

function score(t) {
  if (NOISE.some((r) => r.test(t))) return -1;
  let s = 0;
  for (const r of STRONG) if (r.test(t)) s += 3;
  for (const r of MEDIUM) if (r.test(t)) s += 1;
  if (t.length < 8) s -= 2;
  return s;
}
const tokenHit = (t, kw) => kw.split(/\s+/).every((x) => t.includes(x));

// ---------- 메인 ----------
mkdirSync('./out', { recursive: true });
const EV = './out/evidence.jsonl';
if (existsSync(EV)) rmSync(EV);

const sources = Object.values(SOURCES).filter((s) => !ONLY || s.name === ONLY);
const rows = [];
const seen = new Set();
const st = { req: 0, blocked: 0, fail: 0, empty: 0, raw: 0, kept: 0, old: 0, nodate: 0 };
const blockedMsgs = new Set();

for (const src of sources) {
  for (const [group, kws] of Object.entries(KEYWORDS)) {
    for (const kw of kws) {
      for (let p = 1; p <= PAGES; p++) {
        for (const board of src.boards) {
          const searchUrl = src.url(board, kw, p);
          st.req++;
          const r = await get(searchUrl, src.charset);
          await sleep(DELAY);

          if (r.blocked) { st.blocked++; blockedMsgs.add(`${src.name}: ${r.err}`); continue; }
          if (!r.ok) { st.fail++; continue; }

          let posts = [];
          try { posts = src.parse(r.html, board); } catch { st.fail++; continue; }
          if (!posts.length) { st.empty++; continue; }
          st.raw += posts.length;

          for (const post of posts) {
            if (seen.has(post.url)) continue;
            seen.add(post.url);
            const sc = score(post.title);
            if (sc < 0) continue;
            // 오래된 글은 신호가 아니다. 2008년 '기프티콘 엑셀 관리' 같은 글이
            // 지금의 빈자리를 뜻하지는 않는다.
            if (SINCE && post.date && post.date < String(SINCE)) { st.old++; continue; }

            const hit = tokenHit(post.title, kw);
            const id = sha(post.url).slice(0, 10);
            const row = {
              id, source: src.name, board, group, keyword: kw, date: post.date ?? '',
              hit: hit ? 'title' : 'loose',
              score: sc + (hit ? 2 : 0),
              title: post.title, url: post.url,
            };
            rows.push(row);
            st.kept++;

            // 증거 기록 — 보고서 검증의 근거가 된다.
            appendFileSync(EV, JSON.stringify({
              id, source: src.name, board, keyword: kw, date: post.date ?? '',
              title: post.title, url: post.url,
              searchUrl, fetchedAt: new Date().toISOString(),
              titleSha: sha(post.title),
            }) + '\n', 'utf8');
          }
          process.stdout.write(`\r[${src.name}/${board}] "${kw}" p${p} · 수집 ${st.kept} · 차단 ${st.blocked}      `);
        }
      }
    }
  }
}

rows.sort((a, b) => b.score - a.score);
const cell = (v) => `"${String(v).replace(/"/g, '""')}"`;
const H = ['id', 'source', 'board', 'date', 'group', 'keyword', 'hit', 'score', 'title', 'url'];
writeFileSync('./out/mined.csv',
  '﻿' + H.join(',') + '\n' + rows.map((r) => H.map((h) => cell(r[h])).join(',')).join('\n'),
  'utf8');

console.log(`\n\n요청 ${st.req} · robots차단 ${st.blocked} · 실패 ${st.fail} · 결과없음 ${st.empty}`);
console.log(`원본 ${st.raw}건 → 중복/노이즈/기간 제외 후 ${st.kept}건 (오래된 글 ${st.old}건 제외)`);
const nd = rows.filter((r) => !r.date).length;
if (nd) console.log(`날짜 미확보 ${nd}건 — 이 행들은 최신성을 판단할 수 없습니다.`);
const per = {};
for (const r of rows) per[r.source] = (per[r.source] ?? 0) + 1;
console.log('소스별:', Object.entries(per).map(([k, v]) => `${k} ${v}`).join(' / ') || '없음');
console.log(`→ out/mined.csv  /  out/evidence.jsonl`);
if (blockedMsgs.size) {
  console.log('\nrobots 차단:');
  for (const m of blockedMsgs) console.log('  ' + m);
}

const top = rows.filter((r) => r.hit === 'title').slice(0, 20);
console.log(`\n--- 제목 정확매치 상위 ${top.length}건 ---`);
for (const r of top) console.log(`[${r.score}] ${r.id} ${r.source}/${r.board}  ${r.title.slice(0, 64)}`);
