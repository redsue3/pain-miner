// audit-claims.mjs — 코드와 문서에 '지어낸 값'이 박혀 있는지 검사한다.
//
//   node tools/audit-claims.mjs
//
// 무엇을 찾나:
//   1. 소스에 박힌 가짜 샘플 데이터 (foo/bar/테스트용 더미가 결과로 샐 수 있는 것)
//   2. 결과 파일에 들어간 값 중 원본 근거 없이 만들어진 것
//   3. 문서(README)가 주장하는 수치가 실제 코드/테스트와 맞는지
//   4. 날짜·건수를 코드가 임의로 채우는 자리가 있는지
//
// 이 검사는 '없음'을 증명하지 못한다. 흔한 패턴을 훑을 뿐이다.
// 확정적인 검증은 test.mjs 4단계(원본 대조)가 한다.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { ADAPTERS } from '../adapters/index.mjs';

let flags = 0;
const hit = (level, where, what) => {
  flags++;
  console.log(`  ${level === 'high' ? '★' : '·'} [${where}] ${what}`);
};

const SRC = [
  'crawl.mjs', 'test.mjs', 'report.mjs', 'free.mjs',
  'core/fetch.mjs', 'core/browser.mjs', 'core/keywords.mjs',
  'core/limiter.mjs', 'core/robots.mjs', 'core/store.mjs',
  'adapters/index.mjs',
].filter(existsSync);

console.log('═'.repeat(64));
console.log(' 1) 소스에 박힌 가짜 데이터가 결과로 샐 수 있는가');
console.log('═'.repeat(64));

// 결과 행을 만드는 자리(push/add)에 리터럴 제목·URL 이 박혀 있으면 위험하다.
for (const f of SRC) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');
  lines.forEach((ln, i) => {
    const n = i + 1;
    // store.add / pending.push 에 문자열 리터럴 제목이 들어가는 경우
    if (/(store\.add|pending\.push)\s*\(\s*\{/.test(ln)) {
      const win = lines.slice(i, i + 8).join(' ');
      if (/title:\s*['"`][^'"`$]/.test(win) && !f.startsWith('test')) {
        hit('high', `${f}:${n}`, '결과 행에 제목 문자열이 직접 박혀 있음');
      }
    }
    // 날짜를 '오늘'로 무조건 채우는 자리 (조건 없이)
    if (/date:\s*new Date\(\)/.test(ln) && !/fetchedAt/.test(ln)) {
      hit('high', `${f}:${n}`, '날짜를 현재 시각으로 채움 — 원본 근거 없음');
    }
    // 흔한 더미 값
    if (/['"`](lorem|foo|bar|baz|dummy|샘플|예시데이터|테스트제목)['"`]/i.test(ln) && !f.startsWith('test')) {
      hit('low', `${f}:${n}`, `더미 문자열: ${ln.trim().slice(0, 60)}`);
    }
  });
}
if (!flags) console.log('  결과를 만드는 경로에 박힌 가짜 값 없음');

console.log('');
console.log('═'.repeat(64));
console.log(' 2) 값이 없을 때 무엇을 넣는가 (빈 값인가, 지어낸 값인가)');
console.log('═'.repeat(64));

const ad = readFileSync('adapters/index.mjs', 'utf8');
const checks = [
  ["날짜를 못 읽으면 빈 문자열", /return '';\s*$/m.test(ad) && /readDate/.test(ad)],
  ["date 기본값이 '' 다", /date:\s*d\s*\?\s*`[^`]*`\s*:\s*''/.test(ad) || /date:\s*t\s*\?\s*t\[1\]\s*:\s*''/.test(ad)],
  ["제목이 비면 그 행을 버린다", /if\s*\(!title\)\s*continue/.test(ad)],
];
for (const [what, good] of checks) {
  console.log(`  ${good ? '확인' : '미확인'}  ${what}`);
  if (!good) flags++;
}

console.log('');
console.log('═'.repeat(64));
console.log(' 3) 수집 결과에 근거 없는 값이 있는가');
console.log('═'.repeat(64));

const dirs = existsSync('out') ? readdirSync('out', { withFileTypes: true })
  .filter((d) => d.isDirectory() || d.name.endsWith('.jsonl')) : [];
const files = [];
if (existsSync('out/results.jsonl')) files.push('out/results.jsonl');
for (const d of dirs) {
  // _test* 는 테스트가 만든 인위적 데이터다. 검사 대상이 아니다.
  if (d.name.startsWith('_test')) continue;
  if (d.isDirectory() && existsSync(`out/${d.name}/results.jsonl`)) files.push(`out/${d.name}/results.jsonl`);
}

const today = new Date().toISOString().slice(0, 10);
for (const f of files) {
  const rows = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  console.log(`\n  ${f} — ${rows.length}행`);
  // 전시장 캘린더는 '행사가 열리는 날'이라 미래 날짜가 정상이다.
  const future = rows.filter((r) => r.date && r.date > today && !ADAPTERS[r.site]?.futureDates);
  const badFmt = rows.filter((r) => r.date && !/^\d{4}-\d{2}-\d{2}$/.test(r.date));
  const noSrc = rows.filter((r) => !r.url || !/^https?:\/\//.test(r.url));
  const noTitle = rows.filter((r) => !r.title || !r.title.trim());
  // 같은 URL 이 회차만 다르게 두 번 열리는 행사가 있다 (코엑스는 시리즈마다 페이지 하나).
  // 그래서 URL 만으로 재면 정상인 것을 중복으로 잡는다. URL+날짜로 센다.
  const dupUrl = rows.length - new Set(rows.map((r) => r.url + '#' + (r.date ?? ''))).size;
  const noMatch = rows.filter((r) => !(r.matched ?? []).length);
  const noFetched = rows.filter((r) => !r.fetchedAt);

  const line = (n, what) => console.log(`    ${n === 0 ? '없음 ' : String(n).padStart(4)} ${what}`);
  line(future.length, '미래 날짜');
  line(badFmt.length, '형식이 틀린 날짜');
  line(noSrc.length, 'URL 없음/형식 오류');
  line(noTitle.length, '제목 없음');
  line(dupUrl, '중복 URL');
  line(noMatch.length, 'matched 비어있음');
  line(noFetched.length, '수집 시각 없음');
  flags += future.length + badFmt.length + noSrc.length + noTitle.length + dupUrl + noMatch.length;

  // matched 가 제목에 실제로 있는지
  const bogus = rows.filter((r) => (r.matched ?? []).some((k) => {
    const tokens = k.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.every((t) => r.title.toLowerCase().includes(t))) return false;
    try { return !new RegExp(k, 'i').test(r.title); } catch { return true; }
  }));
  line(bogus.length, 'matched 가 제목에 실제로 없음');
  if (bogus.length) {
    for (const b of bogus.slice(0, 3)) console.log(`         "${b.title.slice(0, 40)}" ← ${b.matched.join(',')}`);
  }
  flags += bogus.length;

  // 날짜가 한 값으로 뭉쳐 있는지 (참고용)
  const dates = new Set(rows.filter((r) => r.date).map((r) => r.date));
  console.log(`    참고  날짜 ${dates.size}종 / ${rows.filter((r) => r.date).length}건`);
  const bodies = rows.filter((r) => r.body);
  if (bodies.length) {
    const uniq = new Set(bodies.map((r) => r.body.slice(0, 80))).size;
    console.log(`    참고  본문 ${uniq}종 / ${bodies.length}건 ${uniq === 1 && bodies.length > 1 ? '← 전부 같음. 의심' : ''}`);
    if (uniq === 1 && bodies.length > 1) flags++;
  }
}
if (!files.length) console.log('  수집 결과 파일이 없습니다');

console.log('');
console.log('═'.repeat(64));
console.log(' 4) README 가 주장하는 수치가 실제와 맞는가');
console.log('═'.repeat(64));

if (existsSync('README.md')) {
  const rd = readFileSync('README.md', 'utf8');
  const claimed = rd.match(/(\d+)개 검사/);
  if (claimed) {
    console.log(`    README 주장: ${claimed[1]}개 검사`);
    console.log('    실제 수치는 `node test.mjs` 를 돌려 마지막 줄과 대조하세요.');
    console.log('    (이 스크립트는 네트워크 검사를 돌리지 않으므로 여기서 단정하지 않습니다)');
  }
  // 어댑터 목록이 README 와 코드에서 일치하는지
  const inCode = Object.keys(JSON.parse('{}')); // placeholder
}

console.log('');
console.log('═'.repeat(64));
console.log(flags === 0
  ? ' 결과: 훑어본 범위에서 지어낸 값 없음'
  : ` 결과: 확인이 필요한 항목 ${flags}건 (위 ★ 표시 우선)`);
console.log(' ※ 이 검사는 흔한 패턴만 본다. 확정 검증은 test.mjs 4단계(원본 대조)다.');
console.log('═'.repeat(64));
