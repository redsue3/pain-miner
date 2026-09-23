// sourcecheck.mjs — 어떤 사이트를 수집해도 되는지, 그리고 수집이 의미가 있는지 검사한다.
//
// 이 프로젝트에서 실제로 두 번 당한 함정을 자동으로 잡기 위한 도구다:
//
//   함정 1  "긁어도 되는 줄 알았다"
//           → 디시·지식iN·루리웹은 robots.txt 에서 거부하고 있었다.
//             지식iN 은 ClaudeBot 을 이름으로 지목해 전면 차단한다.
//
//   함정 2  "검색이 되는 줄 알았다"
//           → 디시는 리다이렉트를 안 따라가면 검색을 무시하고 기본 목록 50건을 준다.
//             82cook·인벤은 비로그인 상태에서 검색 파라미터를 통째로 무시한다.
//             이걸 모르고 모으면 '기본 게시판 글'에 '불편 신호' 라벨이 붙는다.
//
// 검사 방법:
//   A. robots 게이트 통과 여부
//   B. 존재할 리 없는 문자열로 검색  →  결과가 0 이어야 한다
//   C. 진짜 검색어로 검색            →  결과가 나와야 하고, 제목에 그 단어가 들어야 한다
//
//   B 와 C 가 같은 건수면 그 사이트의 검색은 작동하지 않는 것이다.
//
// 사용법:  node sourcecheck.mjs            전체 후보 검사
//          node sourcecheck.mjs arca       이름에 arca 가 든 것만

import { execFile } from 'node:child_process';
import { check } from './robots.mjs';

const NONSENSE = '쯤햬뷁헗캵';       // 한국어 커뮤니티에 존재할 수 없는 글자 조합
const REAL = '불편';
const enc = encodeURIComponent;

// 후보 목록. url(kw) 는 검색 URL, re 는 '글 하나'를 세는 정규식.
const CANDIDATES = [
  { name: 'arca.live',    url: (k) => `https://arca.live/b/live?target=all&keyword=${enc(k)}`,
    re: /class="title hybrid-title"/g,
    title: /class="title hybrid-title"[^>]*>([\s\S]*?)<\/a>/g },

  { name: '82cook',       url: (k) => `https://www.82cook.com/entiz/enti.php?bn=15&searchType=search&search1=1&keys=${enc(k)}`,
    re: /read\.php\?num=\d+/g,
    title: /read\.php\?num=\d+"[^>]*title="([^"]+)"/g },

  { name: 'inven',        url: (k) => `https://www.inven.co.kr/search/webzine/?query=${enc(k)}`,
    re: /inven\.co\.kr\/board\/[a-z]+\/\d+\/\d+/g, title: null },

  { name: 'pann.nate',    url: (k) => `https://pann.nate.com/search/talk?q=${enc(k)}`,
    re: /pann\.nate\.com\/talk\/\d+/g,
    title: /pann\.nate\.com\/talk\/\d+"[^>]*>([\s\S]{0,120}?)<\//g },

  { name: 'dogdrip',      url: (k) => `https://www.dogdrip.net/index.php?mid=dogdrip&search_target=title&search_keyword=${enc(k)}`,
    re: /class="ed title-link"/g,
    title: /class="ed title-link"[^>]*>([\s\S]{0,140}?)<\/a>/g },

  { name: 'dogdrip_all',  url: (k) => `https://www.dogdrip.net/index.php?mid=dogdrip&search_target=title_content&search_keyword=${enc(k)}`,
    re: /class="ed title-link"/g,
    title: /class="ed title-link"[^>]*>([\s\S]{0,140}?)<\/a>/g },

  { name: 'instiz',       url: (k) => `https://www.instiz.net/name?srchtype=3&srchword=${enc(k)}`,
    re: /name\?no=\d+/g, title: null },

  { name: 'coolenjoy',    url: (k) => `https://coolenjoy.net/bbs/board.php?bo_table=38&sfl=wr_subject&stx=${enc(k)}`,
    re: /wr_id=\d+/g, title: null },

  { name: 'ppomppu_free', url: (k) => `https://www.ppomppu.co.kr/zboard/zboard.php?id=freeboard&search_type=sub_memo&keyword=${enc(k)}`,
    re: /view\.php\?id=freeboard&no=\d+/g, title: null },

  { name: 'todayhumor',   url: (k) => `https://www.todayhumor.co.kr/board/list.php?table=bestofbest&search_type=sub_memo&keyword=${enc(k)}`,
    re: /view\.php\?table=[a-z]+&no=\d+/g, title: null },

  { name: 'theqoo',       url: (k) => `https://theqoo.net/index.php?mid=square&search_target=title&search_keyword=${enc(k)}`,
    re: /class="hx"/g, title: null },

  { name: 'slrclub',      url: (k) => `https://www.slrclub.com/bbs/zboard.php?id=free&sn=on&ss=on&keyword=${enc(k)}`,
    re: /zboard\.php\?id=free&no=\d+/g, title: null },

  { name: 'humoruniv',    url: (k) => `https://web.humoruniv.com/board/humor/list.html?table=pds&st=subject&sw=${enc(k)}`,
    re: /read\.html\?table=[a-z]+&number=\d+/g, title: null },

  { name: 'fmkorea',      url: (k) => `https://www.fmkorea.com/index.php?mid=best&search_target=title&search_keyword=${enc(k)}`,
    re: /class="hotdeal_var8"|li class="li"/g, title: null },
];

function curl(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-sL', '--compressed', '--max-time', '20',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '-H', 'Accept-Language: ko-KR,ko;q=0.9',
      '-w', '\n@@%{http_code}', url],
      { maxBuffer: 20e6, encoding: 'utf8' },
      (err, out) => {
        if (err) return resolve({ code: 0, html: '' });
        const i = out.lastIndexOf('\n@@');
        resolve({ code: Number(out.slice(i + 3).trim()), html: out.slice(0, i) });
      });
  });
}

const count = (html, re) => (html.match(new RegExp(re.source, 'g')) || []).length;

const only = process.argv[2];
const list = only ? CANDIDATES.filter((c) => c.name.includes(only)) : CANDIDATES;
const results = [];

for (const c of list) {
  const row = { name: c.name, robots: '', http: '', real: '', none: '', titleHit: '', verdict: '' };

  // A. robots
  const g = await check(c.url(REAL));
  row.robots = g.allowed ? '허용' : '거부';
  if (!g.allowed) {
    row.verdict = '사용불가';
    row.note = g.reason;
    results.push(row);
    console.log(`  ${c.name.padEnd(12)} robots 거부 — ${g.reason}`);
    continue;
  }

  // B/C. 검색이 실제로 작동하나
  const a = await curl(c.url(REAL));
  const b = await curl(c.url(NONSENSE));
  row.http = a.code;

  if (a.code !== 200) {
    row.verdict = '사용불가'; row.note = `HTTP ${a.code}`;
  } else {
    row.real = count(a.html, c.re);
    row.none = count(b.html, c.re);

    if (c.title) {
      const t = [...a.html.matchAll(c.title)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
      row.titleHit = t.length ? `${t.filter((x) => x.includes(REAL)).length}/${t.length}` : '-';
    } else row.titleHit = '-';

    if (row.real === 0) { row.verdict = '결과없음'; row.note = '검색어로 아무것도 안 나옴'; }
    else if (row.real === row.none) { row.verdict = '검색무시'; row.note = '무의미 문자열과 결과 동일 → 기본목록'; }
    else if (row.none > 0) { row.verdict = '의심'; row.note = '무의미 문자열에도 결과가 나옴'; }
    else { row.verdict = '사용가능'; }
  }
  results.push(row);
  console.log(`  ${c.name.padEnd(12)} ${row.verdict.padEnd(6)} 실검색=${row.real} 무의미=${row.none} 제목일치=${row.titleHit}${row.note ? '  (' + row.note + ')' : ''}`);
}

console.log('\n' + '='.repeat(74));
console.log('판정  사이트         robots  실검색  무의미  제목일치');
console.log('='.repeat(74));
for (const r of results.sort((a, b) => (a.verdict === '사용가능' ? -1 : 1))) {
  console.log(
    `${(r.verdict === '사용가능' ? '✓' : '✗').padEnd(4)}  ${r.name.padEnd(14)} ${String(r.robots).padEnd(7)} ` +
    `${String(r.real).padEnd(7)} ${String(r.none).padEnd(7)} ${String(r.titleHit).padEnd(8)}`
  );
}
const usable = results.filter((r) => r.verdict === '사용가능').map((r) => r.name);
console.log('='.repeat(74));
console.log(`사용 가능: ${usable.length ? usable.join(', ') : '없음'}`);
