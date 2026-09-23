// verify.mjs — 보고서에 '지어낸 것'이 섞여 있는지 기계로 검사한다.
//
// 이 파일이 존재하는 이유:
//   이 프로젝트 초반에 내가 실제로 이런 것들을 썼다.
//     · "2위와 격차가 큽니다"        ← 2위 수치가 자료에 아예 없었다. 지어낸 문장이다.
//     · "데이터셋 전체에서 하나뿐"    ← 전체를 세어본 적이 없었다.
//     · K-apt 에 비교 기능이 있다고 자료에 적혀 있는데 '열람'이라고 축소해 썼다.
//   전부 그럴듯해서 읽는 사람이 잡아내기 어려웠다. 그래서 사람이 아니라 코드가 잡는다.
//
// ── 보고서 표기 규칙 ──────────────────────────────────────────────
//   인용    「원문 그대로」[출처:a1b2c3d4e5]
//   수치    [수:설명=값]            예) [수:총건수=412] [수:연도:2026=403]
//   추측    문장 끝에 [추측]
//   외부    [외부:무엇을 어떻게 확인했는지]   ← 증거 저장소 밖에서 확인한 것
//
// ── 검사 항목 ────────────────────────────────────────────────────
//   1. 출처ID 실재     [출처:id] 가 evidence.jsonl 에 있는 id 인가
//   2. 원문 대조       「」 안 문자열이 그 증거의 제목에 글자 그대로 있는가
//   3. 수치 재계산     [수:...] 값을 mined.csv 에서 다시 세어 맞는지 본다
//   4. 미표기 탐지     단정문인데 출처도 [추측]도 없는 문장을 찾아낸다
//   5. 외부근거 분리   [외부:...] 는 기계가 못 재므로 '사람이 확인할 것'으로 따로 뽑는다
//                      — 통과시키는 게 아니라, 검증되지 않았음을 눈에 띄게 남긴다
//
// 사용법:  node verify.mjs report.md

import { readFileSync, existsSync } from 'node:fs';

const file = process.argv[2] ?? 'report.md';
if (!existsSync(file)) { console.error(`보고서 파일이 없습니다: ${file}`); process.exit(1); }
if (!existsSync('./out/evidence.jsonl')) { console.error('out/evidence.jsonl 이 없습니다. mine.mjs 를 먼저 실행하세요.'); process.exit(1); }

const report = readFileSync(file, 'utf8');

// ---------- 증거 적재 ----------
const evidence = new Map();
for (const line of readFileSync('./out/evidence.jsonl', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const e = JSON.parse(line);
  evidence.set(e.id, e);
}

// ---------- CSV 적재 (수치 재계산용) ----------
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
let recs = [];
if (existsSync('./out/mined.csv')) {
  const t = parseCSV(readFileSync('./out/mined.csv', 'utf8').replace(/^﻿/, '')).filter((r) => r.length > 1);
  const h = t[0];
  recs = t.slice(1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

// 지원하는 수치 표현. 여기에 없는 건 '재계산 불가'로 표시된다 — 통과가 아니다.
function recompute(desc) {
  const d = desc.trim();
  if (d === '총건수') return recs.length;
  let m;
  if ((m = d.match(/^소스:(.+)$/)))   return recs.filter((r) => r.source === m[1].trim()).length;
  if ((m = d.match(/^키워드:(.+)$/))) return recs.filter((r) => r.keyword === m[1].trim()).length;
  if ((m = d.match(/^게시판:(.+)$/))) return recs.filter((r) => r.board === m[1].trim()).length;
  if ((m = d.match(/^그룹:(.+)$/)))   return recs.filter((r) => r.group === m[1].trim()).length;
  if ((m = d.match(/^점수(\d+)이상$/))) return recs.filter((r) => Number(r.score) >= Number(m[1])).length;
  if (d === '제목정확매치')           return recs.filter((r) => r.hit === 'title').length;
  if ((m = d.match(/^포함:(.+)$/)))   return recs.filter((r) => r.title.includes(m[1].trim())).length;
  // 날짜 기준. '포함:2026' 은 제목에 2026 이 든 글을 세므로 전혀 다른 값이 나온다.
  if ((m = d.match(/^연도:(\d{4})$/))) return recs.filter((r) => r.date.startsWith(m[1])).length;
  if ((m = d.match(/^연도이후:(\d{4})$/))) return recs.filter((r) => r.date >= m[1]).length;
  return null;
}

const problems = [];
const ok = [];

// ---------- 1. 출처ID 실재 ----------
const cited = [...report.matchAll(/\[출처:([a-f0-9]{6,12})\]/g)].map((m) => m[1]);
for (const id of new Set(cited)) {
  if (evidence.has(id)) ok.push(`출처 ${id} 실재`);
  else problems.push({ kind: '없는출처', detail: `[출처:${id}] — evidence.jsonl 에 없는 ID입니다.` });
}

// ---------- 2. 원문 대조 ----------
const quotes = [...report.matchAll(/「([^」]+)」\s*(?:\[출처:([a-f0-9]{6,12})\])?/g)];
for (const [, text, id] of quotes) {
  if (!id) {
    problems.push({ kind: '출처없는인용', detail: `「${text.slice(0, 50)}」 — 출처 태그가 없습니다.` });
    continue;
  }
  const e = evidence.get(id);
  if (!e) continue;                      // 위에서 이미 잡힘
  const hay = `${e.title}`;
  if (hay.includes(text)) ok.push(`인용 일치 (${id})`);
  else problems.push({
    kind: '원문불일치',
    detail: `[출처:${id}] 의 원문에 없는 인용입니다.\n        인용: 「${text}」\n        원문: 「${e.title}」`,
  });
}

// ---------- 3. 수치 재계산 ----------
const nums = [...report.matchAll(/\[수:([^=\]]+)=([0-9,]+)\]/g)];
for (const [, desc, valRaw] of nums) {
  const claimed = Number(valRaw.replace(/,/g, ''));
  const actual = recompute(desc);
  if (actual === null) {
    problems.push({ kind: '재계산불가', detail: `[수:${desc}=${claimed}] — verify 가 계산할 수 없는 표현입니다. 근거가 검증되지 않았습니다.` });
  } else if (actual !== claimed) {
    problems.push({ kind: '수치불일치', detail: `[수:${desc}] 주장=${claimed} / 실제=${actual}` });
  } else ok.push(`수치 일치 ${desc}=${actual}`);
}

// ---------- 4. 미표기 단정문 ----------
// 표·코드블록·인용부호 줄은 건너뛴다. 단정적 서술어로 끝나는 문장만 본다.
const ASSERTIVE = /(입니다|습니다|이다|한다|된다|없다|있다|였다|했다)[.!]?$/;
const lines = report.split('\n');
let inCode = false;
const untagged = [];
const external = [];   // [외부:...] — 증거 저장소 밖에서 확인한 것. 기계로는 못 재니 사람이 봐야 한다.
for (const [i, raw] of lines.entries()) {
  const line = raw.trim();
  if (line.startsWith('```')) { inCode = !inCode; continue; }
  if (inCode || !line || line.startsWith('|') || line.startsWith('#') || line.startsWith('>')) continue;
  let cursor = 0;
  for (const s of line.split(/(?<=[.!?])\s+/)) {
    const t = s.trim();
    const at = line.indexOf(t, cursor);
    cursor = at < 0 ? cursor : at + t.length;
    if (t.length < 12 || !ASSERTIVE.test(t)) continue;
    // 태그가 문장 뒤에 붙는 경우(「… 보입니다. [추측]」)를 놓치지 않도록
    // 문장 자체가 아니라 '문장 + 뒤따르는 24자' 를 본다.
    // 문장 뒤 40자 + (문장이 줄 끝이면) 다음 줄 앞부분까지 본다.
    // 긴 근거는 「…였습니다.\n[외부:…]」 처럼 태그를 다음 줄에 두는 게 자연스럽기 때문.
    const tail = line.slice(at < 0 ? 0 : at, (at < 0 ? 0 : at) + t.length + 40);
    const spills = (at < 0 || at + t.length >= line.length - 2);
    const window = tail + (spills ? ' ' + (lines[i + 1] ?? '').trim().slice(0, 120) : '');
    if (/\[외부:/.test(window)) { external.push({ line: i + 1, text: t.slice(0, 80) }); continue; }
    if (/\[출처:|\[수:|\[추측\]/.test(window)) continue;
    untagged.push({ line: i + 1, text: t.slice(0, 80) });
  }
}

// ---------- 출력 ----------
console.log(`\n검증 대상 : ${file}`);
console.log(`증거      : ${evidence.size}건 / 수집행 ${recs.length}건\n`);
console.log('='.repeat(72));
console.log(`인용 ${quotes.length}건 · 수치주장 ${nums.length}건 · 출처태그 ${cited.length}건`);
console.log('='.repeat(72));

if (problems.length) {
  console.log(`\n[문제 ${problems.length}건]\n`);
  for (const p of problems) console.log(`  ✗ ${p.kind}\n        ${p.detail}\n`);
} else {
  console.log('\n  ✓ 인용·수치·출처에서 문제 없음\n');
}

if (external.length) {
  console.log(`[기계검증 불가 ${external.length}건] — 증거 저장소 밖의 근거입니다. 사람이 직접 확인해야 합니다.\n`);
  for (const e of external) console.log(`  ! ${String(e.line).padStart(4)}행  ${e.text}`);
  console.log();
}

if (untagged.length) {
  console.log(`[미표기 단정문 ${untagged.length}건] — 출처도 [추측]도 없이 단정하고 있습니다.\n`);
  for (const u of untagged.slice(0, 20)) console.log(`  ? ${String(u.line).padStart(4)}행  ${u.text}`);
  if (untagged.length > 20) console.log(`       ... 외 ${untagged.length - 20}건`);
  console.log();
}

const fatal = problems.filter((p) => p.kind !== '재계산불가').length;
console.log('='.repeat(72));
console.log(`통과 ${ok.length} · 문제 ${problems.length} · 미표기 ${untagged.length} · 기계검증불가 ${external.length}`);
console.log(fatal ? '판정: 실패 — 위 문제를 고치기 전에는 이 보고서를 믿으면 안 됩니다.'
                  : problems.length || untagged.length ? '판정: 조건부 — 미표기/재계산불가 항목을 확인하세요.'
                  : '판정: 통과');
process.exit(fatal ? 1 : 0);
