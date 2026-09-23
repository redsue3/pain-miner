// free.mjs — 수집한 핫딜 중 '값이 0인 게임'만 골라낸다.
//
//   node free.mjs [--dir out/games] [--days 20]
//
// 할인(3,250원)과 무료(0원)를 가른다. 핫딜 제목은 보통 (가격/배송비) 꼴이라
// 가격 자리가 '무료'나 '0원'이어야 진짜 공짜다.
// '스팀 안대', '스팀 청소기' 같은 오탐은 여기서 뺀다.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const dir = flag('dir', './out/games');
const days = Number(flag('days', 20));

const file = join(dir, 'results.jsonl');
if (!existsSync(file)) { console.log('결과 파일이 없습니다:', file); process.exit(1); }
const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// 증기(steam) 제품들. '스팀'이 게임 플랫폼이 아닌 경우를 걸러낸다.
const NOT_GAME = /안대|청소기|로청|커피머신|다리미|찜기|오븐|세탁|청정기|밥솥|팬츠|마스크팩|타월|물걸레|스티머/;

// 게임 플랫폼 신호
const PLATFORM = /에픽|EPIC|Epic|GOG|스팀|Steam|STEAM|유비소프트|Ubisoft|험블|Humble|프라임\s*게이밍|Prime\s*Gaming|itch|배틀넷|origin|Xbox|PS스토어|플스토어/i;

// 가격이 0이라는 표시
const IS_FREE = [
  /\(\s*무료\s*[/,]/,          // (무료/무료)  (무료,무료)
  /\(\s*무료\s*\)/,            // (무료)
  /\(\s*0\s*원/,               // (0원/...
  /무료\s*(배포|증정|제공|풀림)/,
  /\bfree\b/i,
];
// 가격이 붙어 있으면 무료가 아니다 — '3,250원', '23,100원'
const HAS_PRICE = /\(\s*[\d,]{3,}\s*원/;

const today = new Date();
const cutoff = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);

const DEADLINE = [
  /(\d{1,2}\s*월\s*\d{1,2}\s*일[^\n]{0,14}?(까지|마감|종료))/,
  /((\d{4}[.\-/])?\d{1,2}[.\-/]\d{1,2}[^\n]{0,8}?(까지|마감|종료))/,
  /(~\s*\d{1,2}\s*[./월]\s*\d{1,2}\s*일?)/,
  /(\d{1,2}\s*월\s*\d{1,2}\s*일\s*\d{1,2}\s*시)/,
  /(기간\s*[:：]\s*[^\n]{0,40})/,
];
function deadlineOf(r) {
  const hay = `${r.title}\n${r.body ?? ''}`;
  for (const re of DEADLINE) {
    const m = hay.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim().slice(0, 46);
  }
  // '9월 18일 - 9월 25일' 같은 기간 표기는 뒤쪽 날짜가 마감이다.
  const range = hay.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*[-~]\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (range) return `${range[3]}월 ${range[4]}일까지`;
  return '';
}

/**
 * 마감 문구에서 실제 날짜를 뽑아 오늘과 견준다.
 * 연도가 안 적혀 있으므로 글이 올라온 해를 쓰고, 12월→1월처럼 해를 넘는 경우만 보정한다.
 * @returns {{state:'진행중'|'종료'|'불명', until:string}}
 */
function status(dl, postDate, now) {
  if (!dl) return { state: '불명', until: '' };
  const m = dl.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/)
        ?? dl.match(/(?:\d{4}[.\-/])?(\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return { state: '불명', until: '' };

  const year = postDate ? Number(postDate.slice(0, 4)) : now.getFullYear();
  const mo = Number(m[1]), da = Number(m[2]);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return { state: '불명', until: '' };

  let y = year;
  // 글은 12월인데 마감이 1월이면 다음 해다.
  if (postDate && Number(postDate.slice(5, 7)) === 12 && mo === 1) y += 1;

  const until = `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
  const todayStr = now.toISOString().slice(0, 10);
  return { state: until >= todayStr ? '진행중' : '종료', until };
}

const free = rows.filter((r) => {
  if (r.date && r.date < cutoff) return false;
  if (NOT_GAME.test(r.title)) return false;
  if (!PLATFORM.test(r.title)) return false;
  if (HAS_PRICE.test(r.title)) return false;
  return IS_FREE.some((re) => re.test(r.title));
});

// 같은 게임이 여러 사이트/여러 글로 올라온다. 게임 이름으로 묶는다.
const key = (t) => t
  .replace(/\(.*?\)/g, ' ')
  .replace(/\[.*?\]/g, ' ')
  .replace(/끌올|재배포|무료|배포|증정/g, ' ')
  .replace(/[^\wㄱ-힣]/g, '')
  .toLowerCase()
  .slice(0, 22);

const groups = new Map();
for (const r of free) {
  const k = key(r.title);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

const SITE = { ppomppu: '뽐뿌', arca: '아카', ruliweb: '루리웹' };
console.log(`전체 ${rows.length}건 → 무료 게임으로 추린 것 ${free.length}건 (중복 묶으면 ${groups.size}종)`);
console.log(`오늘 ${today.toISOString().slice(0, 10)} · 최근 ${days}일\n`);

const sorted = [...groups.values()].sort((a, b) =>
  String(b[0].date).localeCompare(String(a[0].date)));

const buckets = { 진행중: [], 불명: [], 종료: [] };
for (const g of sorted) {
  const r = g.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const dl = g.map(deadlineOf).find(Boolean) ?? '';
  const st = status(dl, r.date, today);
  buckets[st.state].push({ g, r, dl, st });
}

for (const state of ['진행중', '불명', '종료']) {
  const list = buckets[state];
  if (!list.length) continue;
  const label = { 진행중: '아직 받을 수 있는 것', 불명: '마감일을 못 찾은 것 (직접 확인 필요)', 종료: '이미 끝난 것' }[state];
  console.log(`\n${'━'.repeat(60)}\n${label} — ${list.length}종\n${'━'.repeat(60)}`);
  for (const { g, r, dl, st } of list) {
    const where = [...new Set(g.map((x) => SITE[x.site] ?? x.site))].join('·');
    console.log(`\n${r.title}`);
    if (st.until) console.log(`   마감: ${st.until} (${dl})`);
    console.log(`   올라온 날 ${r.date || '?'} · 출처 ${where} ${g.length}건`);
    console.log(`   ${r.url}`);
    const body = g.map((x) => x.body).find(Boolean);
    if (body) console.log(`   본문: ${body.slice(0, 140)}`);
  }
}
