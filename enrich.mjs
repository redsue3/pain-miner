// enrich.mjs — 수집한 지식iN 행의 '본문'을 가져온다.
//
// 왜 필요한가: 지식iN 검색 목록의 제목은 잘린다.
//   "이런 앱 없나요? 사람살린다 생각하고 한번만...."  ← 정작 뭐가 불편한지는 본문에 있다.
//
// 사용법:
//   node enrich.mjs                    out/ 의 최신 mined_*.csv 를 처리
//   node enrich.mjs out/mined_x.csv    파일 지정
//   node enrich.mjs --limit 200        상위 N행만 (점수순, 기본 300)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { CURL_ARGS, clean } from './sources.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};
const LIMIT = Number(flag('limit', 300));

let file = argv.find((a) => a.endsWith('.csv'));
if (!file) {
  const cands = readdirSync('./out').filter((f) => /^mined_.*\.csv$/.test(f)).sort();
  if (!cands.length) { console.error('out/ 에 mined_*.csv 가 없습니다.'); process.exit(1); }
  file = './out/' + cands.at(-1);
}
console.log('입력:', file);

// ---------- CSV 파싱 (따옴표 안의 콤마/개행 처리) ----------
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
const table = parseCSV(text).filter((r) => r.length > 1);
const header = table[0];
const recs = table.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));

const targets = recs
  .filter((r) => r.source === 'kin')
  .sort((a, b) => Number(b.score) - Number(a.score))
  .slice(0, LIMIT);

console.log(`지식iN 행 ${recs.filter((r) => r.source === 'kin').length}건 중 상위 ${targets.length}건 본문 수집\n`);

// ---------- 본문 수집 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function curl(url) {
  return new Promise((resolve) => {
    execFile('curl', [...CURL_ARGS, '-H', 'Referer: https://kin.naver.com/', url],
      { maxBuffer: 20e6, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

let ok = 0, fail = 0;
for (const [i, r] of targets.entries()) {
  const html = await curl(r.url);
  await sleep(500);
  if (!html) { fail++; continue; }

  const b = html.match(/class="questionDetail[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  const tag = html.match(/questionDetail[^>]*data-tag="([^"]*)"/);
  r.body = b ? clean(b[1].replace(/<br\s*\/?>/gi, ' ')).slice(0, 1200) : '';
  r.tags = tag ? decodeURIComponent(tag[1]) : '';
  if (r.body) ok++; else fail++;

  process.stdout.write(`\r  ${i + 1}/${targets.length} · 본문확보 ${ok} · 실패 ${fail}   `);
}

// ---------- 저장 ----------
const outHeader = [...header, 'body', 'tags'];
const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = '﻿' + outHeader.join(',') + '\n' +
  targets.map((r) => outHeader.map((h) => cell(r[h])).join(',')).join('\n');

const out = file.replace(/mined_/, 'enriched_');
writeFileSync(out, csv, 'utf8');
console.log(`\n\n본문 ${ok}건 확보 / 실패 ${fail}건\n→ ${out}`);

// ---------- 미리보기 ----------
const good = targets.filter((r) => r.body && r.body.length > 40);
console.log(`\n--- 본문 있는 것 중 앞 12건 ---`);
for (const r of good.slice(0, 12)) {
  console.log(`\n[${r.score}] ${r.title}`);
  console.log(`      ${r.body.slice(0, 160)}`);
  if (r.tags) console.log(`      #${r.tags.split(',').slice(0, 5).join(' #')}`);
}
