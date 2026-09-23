// report.mjs — 수집 결과를 사람이 읽기 좋게 정리한다.
//
//   node report.mjs                        out/games 를 읽어 날짜순으로 출력
//   node report.mjs --dir out --days 14    다른 폴더 / 기간
//
// 본문에서 '언제까지'로 보이는 문구를 함께 뽑아준다. 기간이 남았는지 판단하는 근거다.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };
const dir = flag('dir', './out/games');
const days = Number(flag('days', 30));

const file = join(dir, 'results.jsonl');
if (!existsSync(file)) { console.log('결과 파일이 없습니다:', file); process.exit(1); }

const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const today = new Date();
const cutoff = new Date(today.getTime() - days * 864e5).toISOString().slice(0, 10);

// 본문·제목에서 마감 단서를 찾는다. 없으면 빈 문자열 — 지어내지 않는다.
const DEADLINE = [
  /(\d{1,2}\s*월\s*\d{1,2}\s*일[^.]{0,12}(까지|마감|종료))/,
  /(~\s*\d{1,2}\s*[./월]\s*\d{1,2})/,
  /((\d{4}[.\-/])?\d{1,2}[.\-/]\d{1,2}\s*(까지|마감|종료))/,
  /(다음\s*주\s*목요일|목요일\s*까지|매주\s*목)/,
  /((\d+)\s*일\s*(남음|남았))/,
  /(기간\s*[:：]\s*[^\n]{0,40})/,
  /(종료\s*[:：]\s*[^\n]{0,30})/,
];

function deadlineOf(r) {
  const hay = `${r.title} ${r.body ?? ''}`;
  for (const re of DEADLINE) {
    const m = hay.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim().slice(0, 44);
  }
  return '';
}

const recent = rows
  .filter((r) => !r.date || r.date >= cutoff)
  .sort((a, b) => String(b.date).localeCompare(String(a.date)));

console.log(`${dir} · 전체 ${rows.length}건 · 최근 ${days}일 ${recent.length}건`);
console.log(`오늘 ${today.toISOString().slice(0, 10)} 기준\n`);

const withBody = recent.filter((r) => r.body).length;
console.log(`본문 확보 ${withBody}/${recent.length}건\n`);

const SITE = { ppomppu: '뽐뿌', arca: '아카', ruliweb: '루리웹', dogdrip: '개드립', dcinside: '디시' };

for (const r of recent) {
  const dl = deadlineOf(r);
  console.log(`[${r.date || '날짜?'}] ${(SITE[r.site] ?? r.site).padEnd(4)} ${r.title}`);
  if (r.price) console.log(`             가격: ${r.price}${r.delivery ? ` / 배송 ${r.delivery}` : ''}`);
  if (dl) console.log(`             마감단서: ${dl}`);
  console.log(`             ${r.url}`);
}
