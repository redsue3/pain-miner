// 세 소스 모두: 목록에서 뽑은 날짜가 실제 글의 날짜와 맞는지 대조한다.
import { SOURCES, CURL_ARGS } from './sources.mjs';
import { execFileSync } from 'node:child_process';
const raw = (u, cs) => new TextDecoder(cs ?? 'utf-8')
  .decode(execFileSync('curl', [...CURL_ARGS, u], { maxBuffer: 20e6, encoding: 'buffer' }));
const DATE = /(20\d\d)[-.\/](\d\d)[-.\/](\d\d)/;

for (const s of Object.values(SOURCES)) {
  const posts = s.parse(raw(s.url(s.boards[0], '귀찮은데', 1), s.charset), s.boards[0]);
  const withDate = posts.filter((p) => p.date).length;
  let ok = 0, bad = 0;
  for (const p of posts.slice(0, 4)) {
    const m = raw(p.url, s.charset).match(DATE);
    const real = m ? `${m[1]}-${m[2]}-${m[3]}` : '??';
    if (real === p.date) ok++; else { bad++; console.log(`   어긋남 ${s.name}: 목록=${p.date} 실제=${real} ${p.title.slice(0,36)}`); }
  }
  console.log(`■ ${s.name.padEnd(8)} ${posts.length}건 / 날짜확보 ${withDate}건 / 대조 ${ok}건일치 ${bad}건어긋남`);
}
