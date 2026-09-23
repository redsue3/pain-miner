// analyze.mjs — 수집 결과를 사람이 읽을 수 있게 꺼내 본다.
//
// 이 스크립트는 판단하지 않는다. 묶고, 정렬하고, 원문을 그대로 보여줄 뿐이다.
// "어떤 아이디어가 좋다"는 결론은 여기서 나오지 않는다 — 사람이 읽고 정해야 한다.
//
// 사용법:
//   node analyze.mjs                  최신 mined/enriched 자동 선택
//   node analyze.mjs --min 5          최소 점수 (기본 5)
//   node analyze.mjs --topic 돈       특정 단어가 든 것만
//   node analyze.mjs --all            loose 매치까지 포함 (기본은 title 정확매치만)

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const MIN = Number(flag('min', 5));
const TOPIC = flag('topic', null);
const ALL = argv.includes('--all');

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function load(f) {
  const t = readFileSync(f, 'utf8').replace(/^﻿/, '');
  const tb = parseCSV(t).filter((r) => r.length > 1);
  const h = tb[0];
  return tb.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

const files = readdirSync('./out').filter((f) => f.endsWith('.csv')).sort();
const mined = files.filter((f) => f.startsWith('mined_')).at(-1);
const enriched = files.filter((f) => f.startsWith('enriched_')).at(-1);
if (!mined) { console.error('out/ 에 mined_*.csv 가 없습니다.'); process.exit(1); }

let recs = load('./out/' + mined);
if (enriched) {
  const bodies = new Map(load('./out/' + enriched).map((r) => [r.url, r]));
  recs = recs.map((r) => ({ ...r, ...(bodies.get(r.url) ?? {}) }));
  console.log(`입력: ${mined} + ${enriched}`);
} else {
  console.log(`입력: ${mined} (본문 없음 — enrich.mjs 먼저 실행 권장)`);
}

// ---------- 필터 ----------
let rows = recs.filter((r) => Number(r.score) >= MIN);
if (!ALL) rows = rows.filter((r) => r.hit === 'title');
if (TOPIC) rows = rows.filter((r) => (r.title + ' ' + (r.body ?? '')).includes(TOPIC));

// 제목 거의 같은 것 접기 (지식iN 은 "이런 앱 없나요?" 가 수십 개씩 나온다)
const norm = (s) => s.replace(/[\s?!.…,~]/g, '').slice(0, 20);
const byShape = new Map();
for (const r of rows) {
  const k = norm(r.title);
  if (!byShape.has(k)) byShape.set(k, []);
  byShape.get(k).push(r);
}

// ---------- 영역 분류 ----------
// 제목+본문에 뭐가 들어있나로 거칠게 나눈다. 정확한 분류가 아니라 읽는 순서를 만들기 위한 것.
const DOMAINS = {
  '돈·결제':   /결제|정산|영수증|카드|계좌|송금|가계부|할부|청구|요금|환불|적립|포인트/,
  '약·건강':   /약|복용|영양제|병원|진료|처방|검진|알레르기|혈압|당뇨/,
  '일정·기억': /까먹|알림|리마인|일정|캘린더|기념일|유통기한|주기|반복/,
  '집안일':    /청소|빨래|설거지|냉장고|장보기|식재료|재고|유통기한|분리수거/,
  '아이·반려': /아이|육아|기저귀|분유|등원|어린이집|강아지|고양이|산책|사료/,
  '차·이동':   /주차|주유|차량|정비|대중교통|버스|지하철|기차|톨게이트|하이패스/,
  '문서·행정': /서류|증명서|신청|접수|민원|보험|연말정산|세금|계약서|등본/,
  '사진·파일': /사진|파일|스캔|백업|용량|정리|이름|폴더|캡처/,
  '쇼핑':      /배송|택배|주문|반품|교환|최저가|쿠폰|장바구니/,
};
function domainOf(r) {
  const t = r.title + ' ' + (r.body ?? '');
  for (const [d, re] of Object.entries(DOMAINS)) if (re.test(t)) return d;
  return '기타';
}

// ---------- 출력 ----------
const groups = new Map();
for (const [, arr] of byShape) {
  const rep = arr.sort((a, b) => (b.body?.length ?? 0) - (a.body?.length ?? 0))[0];
  const d = domainOf(rep);
  if (!groups.has(d)) groups.set(d, []);
  groups.get(d).push({ ...rep, dupes: arr.length });
}

const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
const lines = [];
const say = (s = '') => { console.log(s); lines.push(s); };

say(`\n조건: 점수 ${MIN}+ ${ALL ? '(loose 포함)' : '(제목 정확매치만)'}${TOPIC ? ` / "${TOPIC}" 포함` : ''}`);
say(`대상 ${rows.length}건 → 유사제목 접은 뒤 ${[...byShape.keys()].length}건\n`);

for (const [domain, arr] of order) {
  arr.sort((a, b) => Number(b.score) - Number(a.score));
  say(`\n${'='.repeat(70)}`);
  say(`■ ${domain}  (${arr.length}건)`);
  say('='.repeat(70));
  for (const r of arr.slice(0, 15)) {
    say(`\n[${r.score}] ${r.source}/${r.board}${r.dupes > 1 ? ` ·같은제목 ${r.dupes}건` : ''}`);
    say(`  ${r.title}`);
    if (r.body) {
      const b = r.body.replace(/\s+/g, ' ').slice(0, 220);
      say(`  └ ${b}${r.body.length > 220 ? '…' : ''}`);
    }
    say(`  ${r.url}`);
  }
}

writeFileSync('./out/report.txt', lines.join('\n'), 'utf8');
say(`\n\n→ out/report.txt 에도 저장했습니다.`);
