// searchtest.mjs — 검색이 진짜로 작동하는지 확인한다.
// 존재할 리 없는 문자열로 검색했는데 결과가 0 이 아니면, 그 사이트의 검색은
// 파라미터를 무시하고 기본 목록을 돌려주는 것이다. 그 데이터는 쓰면 안 된다.
import { render, close } from './browser.mjs';
const enc = encodeURIComponent;
const NONSENSE = '쯤햬뷁헗캵';
const CASES = [
  ['82cook',   (k) => `https://www.82cook.com/entiz/enti.php?bn=15&searchType=search&search1=1&keys=${enc(k)}`, /read\.php\?num=\d+/g],
  ['인벤board', (k) => `https://www.inven.co.kr/board/webzine/2097?query=${enc(k)}`, /class="subject-link"/g],
  ['인벤search',(k) => `https://www.inven.co.kr/search/webzine/?query=${enc(k)}`, /inven\.co\.kr\/board\/[a-z]+\/\d+\/\d+/g],
];
for (const [name, mk, re] of CASES) {
  const res = [];
  for (const kw of ['불편', NONSENSE]) {
    const r = await render(mk(kw), { timeout: 30000 });
    res.push(r.ok ? (r.html.match(re) || []).length : `ERR(${r.err?.slice(0, 35)})`);
  }
  const [hit, none] = res;
  const v = (typeof hit === 'number' && typeof none === 'number')
    ? (none === 0 && hit > 0 ? '✓ 정상' : hit === none ? '✗ 검색 무시' : '~ 부분반응')
    : '! 오류';
  console.log(`${name.padEnd(10)} '불편'=${hit}  '무의미'=${none}  → ${v}`);
}
await close();
