import { launch, close } from './browser.mjs';
import { check } from './robots.mjs';
const url = 'https://www.82cook.com/entiz/enti.php?bn=15';
const g = await check(url); console.log('robots:', g.allowed ? '허용' : '거부 '+g.reason);
if (!g.allowed) process.exit(1);
const b = await launch();
const page = await b.newPage();
await page.setExtraHTTPHeaders({ 'Accept-Language': 'ko-KR,ko;q=0.9' });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
const before = (await page.content()).match(/read\.php\?num=\d+/g)?.length ?? 0;
console.log('검색 전 글 수:', before);

// 검색창에 입력하고 폼 제출 — 사이트가 실제로 어떤 URL 을 만드는지 본다.
await page.type('#searchKey', '불편', { delay: 30 });
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => console.log('nav:', e.message.slice(0,50))),
  page.evaluate(() => document.querySelector('#insearch').submit()),
]);
console.log('제출 후 URL:', page.url());
const html = await page.content();
console.log('검색 후 글 수:', (html.match(/read\.php\?num=\d+/g) || []).length);
const titles = [...html.matchAll(/read\.php\?num=\d+"[^>]*title="([^"]{4,})"/g)].map(m => m[1]);
console.log('제목 샘플:'); titles.slice(0, 6).forEach(t => console.log('   •', t));
console.log('제목에 "불편" 포함:', titles.filter(t => t.includes('불편')).length, '/', titles.length);
await close();
