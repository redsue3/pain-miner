// test.mjs — 4단계 검수
//
//   node test.mjs                  전체
//   node test.mjs --stage 4        한 단계만
//   node test.mjs --stage 2.2      한 항목만
//   node test.mjs --list           항목 목록만 보기
//
// ─────────────────────────────────────────────────────────────────────────
//  1단계  단위    각 모듈이 혼자서 맞게 도는가                    네트워크 X
//  2단계  파서    저장해둔 실제 HTML 에서 글을 제대로 뽑는가      네트워크 X
//  3단계  오류    망가진 입력·실패한 요청에 어떻게 반응하는가     네트워크 일부
//  4단계  진위    수집한 데이터가 진짜인가 — 지어낸 것은 없는가   네트워크 O
// ─────────────────────────────────────────────────────────────────────────
//
// 4단계가 이 파일의 핵심이다. 크롤러가 '돌았다'는 것과 '맞는 걸 가져왔다'는 것은
// 다른 문제다. 제목을 엉뚱한 URL 에 붙이거나, 없는 날짜를 채워 넣거나, 목록에
// 없던 글이 결과에 섞이면 통계는 멀쩡해 보여도 결과는 거짓이 된다.
// 그래서 4단계는 저장된 행을 들고 원본으로 되돌아가서 대조한다.
//
// 2.2 는 지금까지 실제로 터진 버그를 하나씩 못으로 박아둔 것이다.
// 각 항목 옆의 날짜는 그 버그가 실제로 발견된 날이다.

import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { ADAPTERS, readDate, clean, extractBlock, textOf, openTag } from './adapters/index.mjs';
import { Matcher } from './core/keywords.mjs';
import { tagRow, TAGS, OTHER } from './core/tags.mjs';
import { Limiter } from './core/limiter.mjs';
import { Store } from './core/store.mjs';
import { gate, check } from './core/robots.mjs';
import { grab } from './core/fetch.mjs';
import { launch, close } from './core/browser.mjs';

const argv = process.argv.slice(2);
const flagOf = (n) => { const i = argv.indexOf('--' + n); return i === -1 ? null : argv[i + 1]; };
const only = flagOf('stage');
const listOnly = argv.includes('--list');

let pass = 0, fail = 0, skip = 0;
const failures = [];
let section = '';

const run = (id) => !only || id === only || id.startsWith(only + '.') || only.startsWith(id);

function head(id, title) {
  section = id;
  console.log(`\n${'─'.repeat(64)}\n${id}  ${title}\n${'─'.repeat(64)}`);
}
function ok(name, cond, detail = '') {
  if (listOnly) { console.log(`       ${name}`); return; }
  if (cond) { pass++; console.log('  통과  ' + name); }
  else {
    fail++;
    failures.push(`[${section}] ${name}${detail ? ` — ${detail}` : ''}`);
    console.log('  실패  ' + name + (detail ? `  (${detail})` : ''));
  }
}
function eq(name, got, want) {
  ok(name, got === want, `받음 ${JSON.stringify(got)} / 기대 ${JSON.stringify(want)}`);
}
function note(name, why) {
  if (listOnly) { console.log(`       ${name}`); return; }
  skip++; console.log('  보류  ' + name + (why ? `  (${why})` : ''));
}

const TMP = './out/_test';
const FX = 'tests/fixtures';
const readFx = (f, cs = 'utf-8') =>
  existsSync(`${FX}/${f}`) ? new TextDecoder(cs).decode(readFileSync(`${FX}/${f}`)) : null;

// 비교용 정규화 — 공백/엔티티 차이는 같은 것으로 본다.
const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

// ═══════════════════════════════════════════════════════════════════════════
// 1단계 — 단위
// ═══════════════════════════════════════════════════════════════════════════
if (run('1.1')) {
  head('1.1', '키워드 판정 엔진');
  const m = new Matcher({ any: ['일일이 입력', '매번 까먹'], none: ['공지', '쿠팡'], regex: ['없(나|을까)요?'] });
  ok('any 구절 일치', m.test('가계부 일일이 입력하기 너무 귀찮다').pass);
  ok('띄어쓰기가 달라도 일치', m.test('일일이 다 입력해야 함').pass);
  ok('none 이 any 를 이긴다', !m.test('[공지] 일일이 입력 안내').pass);
  ok('regex 단독 일치', m.test('이런 앱 없나요').pass);
  ok('아무것도 안 맞으면 탈락', !m.test('오늘 점심 뭐 먹지').pass);
  ok('빈 문자열 탈락', !m.test('').pass);
  ok('null 도 안 터진다', !m.test(null).pass);
  ok('undefined 도 안 터진다', !m.test(undefined).pass);

  const mAll = new Matcher({ all: ['엑셀', '관리'], any: [] });
  ok('all 은 전부 있어야 통과', mAll.test('엑셀로 재고 관리 중').pass);
  ok('all 하나 빠지면 탈락', !mAll.test('엑셀로 정리만 함').pass);

  const mBad = new Matcher({ any: ['x'], regex: ['[invalid('] });
  eq('깨진 정규식을 골라낸다', mBad.badRegex.length, 1);
  ok('깨진 정규식이 있어도 나머지는 돈다', mBad.test('x 있음').pass);

  ok('규칙이 없으면 전부 통과', new Matcher({}).test('아무 말').pass);

  // 게임 설정이 쓰는 lookahead(AND) 형태가 실제로 동작하는가.
  // (2026-09-23) '0원' 을 그냥 쓰면 '3,250원' 안의 '0원' 에도 걸려 할인이 무료로 둔갑한다.
  // 그래서 앞에 숫자·쉼표가 오면 안 된다는 조건을 붙인다.
  const FREE = String.raw`(무료|(?<![\d,])0\s*원)`;
  const mLook = new Matcher({ any: [], regex: [`(?=.*(에픽|스팀))(?=.*${FREE})`] });
  ok('lookahead AND — 둘 다 있으면 통과', mLook.test('[스팀] 데드샷 (무료/무료)').pass);
  ok('lookahead AND — 0원 표기도 통과', mLook.test('[에픽] 게임 (0원/무료)').pass);
  ok("lookahead AND — '3,250원' 의 0원에 안 속는다", !mLook.test('[스팀] 데드샷 (3,250원)').pass);
  ok("lookahead AND — '23,100원' 도 마찬가지", !mLook.test('[스팀] 비트세이버 (23,100원)').pass);
  ok('lookahead AND — 플랫폼 없으면 탈락', !mLook.test('치즈 1.8kg (무료배송)').pass);

  // 실제 설정 파일의 정규식이 같은 함정에 빠지지 않는지 직접 확인한다.
  const gcfg = JSON.parse(readFileSync('config.games.json', 'utf8'));
  const mCfg = new Matcher(gcfg.keywords);
  eq('config.games.json 의 정규식이 유효하다', mCfg.badRegex.length, 0);
  ok('config.games.json: 무료 게임을 잡는다', mCfg.test('[에픽게임즈] 쇼군 쇼다운 (무료/무료)').pass);
  ok('config.games.json: 할인 게임에 안 속는다', !mCfg.test('[스팀] Watch_Dogs 2 할인 (3,250원)').pass);

  // (2026-10-01) 검색어를 붙여 쓰면 본문의 띄어 쓴 표현을 전부 버렸다 — 디시 25건 받아 0건.
  const mTight = new Matcher({ any: ['불편한점'] });
  ok('붙여 쓴 검색어가 띄어 쓴 글과도 일치', mTight.test('써보니 불편한 점 이 많네').pass);
  ok('붙여 쓴 검색어 — 상관없는 글은 여전히 탈락', !mTight.test('써보니 편한 점 이 많네').pass);

  const mq = new Matcher({ any: ['가', '나'] });
  eq('searchQueries 기본은 any', mq.searchQueries({ any: ['가', '나'] }).join(','), '가,나');
  eq('searchQueries.use 가 우선', mq.searchQueries({ any: ['가'], searchQueries: { use: ['직접'] } }).join(','), '직접');
}

if (run('1.2')) {
  head('1.2', '날짜 해석');
  const now = new Date('2026-09-23T00:00:00Z');
  eq('절대 — 점 구분', readDate('글 2025.03.14 작성', now), '2025-03-14');
  eq('절대 — 하이픈', readDate('2024-12-01', now), '2024-12-01');
  eq('상대 — 7 일 전', readDate('<i></i> 7 일 전', now), '2026-09-16');
  eq('상대 — 3 시간 전', readDate('3 시간 전', now), '2026-09-23');
  eq('상대 — 2 주 전', readDate('2 주 전', now), '2026-09-09');
  eq('상대 — 3 개월 전', readDate('3 개월 전', now), '2026-06-25');
  eq('어제', readDate('어제 21:30', now), '2026-09-22');
  eq('시:분만 있으면 오늘', readDate('14:24', now), '2026-09-23');
  eq('시:분:초도 오늘', readDate(' 14:24:07 ', now), '2026-09-23');
  eq('못 읽으면 빈 문자열', readDate('댓글 33개'), '');
  eq('빈 입력', readDate(''), '');
  ok('날짜를 지어내지 않는다', readDate('아무 의미 없는 글자') === '');
}

if (run('1.3')) {
  head('1.3', 'HTML 정리·블록 추출');
  eq('태그 제거', clean('<b>굵게</b> 글'), '굵게 글');
  eq('엔티티 복원', clean('A &amp; B &quot;C&quot;'), 'A & B "C"');
  eq('숫자 엔티티', clean('&#49;&#50;'), '12');
  eq('빈 입력', clean(null), '');

  eq('중첩 div 를 끝까지 집는다',
    textOf(extractBlock('<div class="c">겉<div>안</div>끝</div><p>바깥</p>', openTag('div', 'c'))),
    '겉 안 끝');
  eq('작은따옴표 class 도 집는다',
    textOf(extractBlock("<td class='board-contents'>본문</td>", openTag('td', 'board-contents'))),
    '본문');
  eq('여러 class 중 하나만 맞아도 집는다',
    textOf(extractBlock('<div class="fr-view article-content">글</div>', openTag('div', 'article-content'))),
    '글');
  eq('없는 class 는 빈 문자열', extractBlock('<div class="x">a</div>', openTag('div', 'zzz')), '');
  eq('script 는 본문에서 뺀다',
    textOf(extractBlock('<div class="c">보이는글<script>var a=1;</script></div>', openTag('div', 'c'))),
    '보이는글');
  ok('닫는 태그가 없어도 안 터진다',
    typeof extractBlock('<div class="c">열린 채로', openTag('div', 'c')) === 'string');
  ok('본문 길이 상한이 걸린다', textOf('<p>' + 'ㄱ'.repeat(9000) + '</p>', 100).length <= 101);
}

if (run('1.4')) {
  head('1.4', '속도 제어·백오프');
  const lim = new Limiter({
    minDelayMs: 10, jitterMs: 0, perHostConcurrency: 1,
    backoff: { startMs: 1000, factor: 2, maxMs: 8000, recoverAfterOk: 2 },
  });
  const U = 'https://example.com/a';
  eq('처음엔 벌점 없음', lim.penaltyOf(U), 0);
  lim.report(U, { ok: false, status: 429 });
  eq('429 → 벌점 시작', lim.penaltyOf(U), 1000);
  lim.report(U, { ok: false, status: 403 });
  eq('403 → 벌점 2배', lim.penaltyOf(U), 2000);
  lim.report(U, { ok: false, status: 405 });
  eq('405 도 차단으로 본다', lim.penaltyOf(U), 4000);
  for (let i = 0; i < 6; i++) lim.report(U, { ok: false, status: 503 });
  ok('벌점 상한을 안 넘는다', lim.penaltyOf(U) <= 8000, `현재 ${lim.penaltyOf(U)}`);
  lim.report(U, { ok: true, status: 200 });
  lim.report(U, { ok: true, status: 200 });
  ok('연속 성공하면 회복', lim.penaltyOf(U) < 8000, `현재 ${lim.penaltyOf(U)}`);
  eq('404 는 차단이 아니다 — 속도를 늦추지 않는다', lim.penaltyOf('https://other.com/x'), 0);
  lim.report('https://other.com/x', { ok: false, status: 404 });
  eq('404 뒤에도 벌점 없음', lim.penaltyOf('https://other.com/x'), 0);
  eq('호스트마다 벌점이 따로', lim.penaltyOf('https://third.com/x'), 0);

  // 타이머 정밀도 때문에 10ms 로 재면 9ms 가 나와 가끔 헛걸린다. 간격을 넉넉히 잡는다.
  const lim2 = new Limiter({
    minDelayMs: 120, jitterMs: 0, perHostConcurrency: 1,
    backoff: { startMs: 1000, factor: 2, maxMs: 8000, recoverAfterOk: 2 },
  });
  const t0 = Date.now();
  for (const u of ['https://slow.com/1', 'https://slow.com/2']) {
    await lim2.acquire(u); lim2.release(u);
  }
  const spent = Date.now() - t0;
  ok('요청 사이에 실제로 쉰다', spent >= 100, `${spent}ms (120ms 설정)`);
}

if (run('1.5')) {
  head('1.5', 'robots 패턴 해석');
  const src = readFileSync('core/robots.mjs', 'utf8');
  const matches = new Function('return ' + src.match(/function matches[\s\S]*?\n}/)[0])();
  const cases = [
    ['/search', '/search?q=1', true, '단순 접두'],
    ['/search', '/community/board/300143', false, '무관한 경로'],
    // robots.txt 에서 ? 는 특수문자가 아니라 글자 그대로다 (특수문자는 * 와 끝의 $ 뿐).
    // 그래서 '/*?s_type=' 은 '물음표 바로 뒤에 s_type=' 을 요구한다.
    ['/*?s_type=', '/board/lists/?s_type=search', true, '와일드카드 + 물음표'],
    ['/*?s_type=', '/board/lists/?id=a&s_type=search', false, '물음표 위치가 다르면 불일치'],
    // (2026-09-23) ? 를 escape 안 해서 '앞 글자 0~1회'로 읽혔고, 금지 갤러리가 허용으로 샜다.
    ['/board/lists/?id=stock_new2', '/board/lists/?id=stock_new2', true, '디시 금지 갤러리'],
    ['/board/lists/?id=stock_new2', '/board/lists/?id=programming', false, '디시 허용 갤러리'],
    ['/board/view/?id=dog', '/board/view/?id=dog&no=1', true, '디시 금지 갤러리 글보기'],
    ['/*search_type=', '/market/board/1020?search_type=subject', true, '루리웹 실제 규칙'],
    ['/*search_type=', '/market/board/1020?page=1', false, '루리웹 목록은 허용'],
    ['/', '/anything', true, '전체 차단'],
    ['/foo$', '/foo', true, '끝 앵커 일치'],
    ['/foo$', '/foobar', false, '끝 앵커 불일치'],
    ['', '/foo', false, '빈 Disallow 는 허용'],
  ];
  for (const [pat, path, want, why] of cases) {
    eq(`${why}: Disallow:${pat || '(빈칸)'} vs ${path}`, matches(pat, path), want);
  }
}

if (run('1.6')) {
  head('1.6', '저장·중복·이어받기');
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  const s = new Store(TMP, { resume: true });
  ok('처음 보는 URL', s.isNew('https://a.com/1'));
  s.add({ site: 'x', board: 'b', date: '2026-01-01', query: 'q', matched: ['q'], title: '제목', url: 'https://a.com/1' });
  ok('같은 URL 은 두 번 안 받는다', !s.isNew('https://a.com/1'));
  eq('중복 카운트', s.skippedDup, 1);

  s.add({ site: 'x', board: 'b', date: '', query: 'q', matched: [], title: '본문있음', url: 'https://a.com/2', body: 'ㄱ'.repeat(900) });
  const r = s.flush();
  eq('저장 건수', r.count, 2);
  ok('CSV 생성', existsSync(r.csv));
  ok('JSONL 생성', existsSync(r.jsonl));
  const csv = readFileSync(r.csv, 'utf8');
  ok('CSV BOM (엑셀 한글)', csv.charCodeAt(0) === 0xFEFF);
  ok('CSV 헤더에 body 칸', csv.split('\n')[0].includes('body'));
  ok('CSV 헤더에 price 칸', csv.split('\n')[0].includes('price'));
  ok('CSV 본문은 500자로 줄인다', !csv.includes('ㄱ'.repeat(600)));
  const jl = readFileSync(r.jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('JSONL 본문은 안 줄인다', jl.some((x) => (x.body ?? '').length >= 900));
  ok('id 가 중복되지 않는다', new Set(jl.map((x) => x.id)).size === jl.length);

  ok('재시작해도 기억한다', !new Store(TMP, { resume: true }).isNew('https://a.com/1'));
  ok('resume 끄면 처음부터', new Store(TMP + '2', { resume: false }).isNew('https://a.com/1'));

  // (2026-09-23) 본문을 나중에 받도록 2단계로 바꾸면서 add() 가 수집 후에야 불렸고,
  // 그 사이에는 아무것도 '봤다'고 표시되지 않아 같은 글이 계속 통과했다.
  // 결과 파일에 중복이 남았다 (games 84행 중 5행). reserve() 는 확인과 표시를 함께 한다.
  const sr = new Store(TMP + '4', { resume: false });
  ok('reserve: 처음 URL 은 통과', sr.reserve('https://a.com/x') === true);
  ok('reserve: 같은 URL 은 두 번째부터 막힌다', sr.reserve('https://a.com/x') === false);
  ok('reserve: add() 를 안 불러도 막힌다', sr.reserve('https://a.com/x') === false);
  ok('isNew 는 표시하지 않는다 (확인 전용)',
    new Store(TMP + '5', { resume: false }).isNew('https://a.com/y') === true
    && new Store(TMP + '5', { resume: false }).isNew('https://a.com/y') === true);
}

if (run('1.7')) {
  head('1.7', '주제 태그 (규칙)');
  const t = (r) => tagRow({ site: 'dcsearch', board: '', title: '', ...r });
  ok('게임 갤러리 → 게임', t({ board: '메이플랜드(메이플스토리)', title: '보스 후기' }).includes('게임'));
  ok('갤러리가 정하면 제목은 안 본다', t({ board: '메이플랜드(메이플스토리)', title: '자취방 곰팡이' })[0] === '게임');
  ok('갤러리로 못 정하면 제목을 본다', t({ board: '아무말', title: '자취방 곰팡이 어떻게 없앰' }).includes('생활'));
  ok('뽐뿌 게시판 id → 주제', tagRow({ site: 'ppomppu', board: 'car', title: 'x' }).includes('자동차'));
  eq('아무것도 안 걸리면 기타', tagRow({ site: 'dogdrip', board: 'title', title: 'ㅋㅋㅋ' }).join(), OTHER);
  ok('태그는 최대 2개', t({ board: '', title: '게임하다 주식 코인 자동차 운전 병원' }).length <= 2);
  // (2026-10-01) 실제로 잘못 붙었던 것들
  ok("'아이패드' 갤러리가 '패드' 때문에 게임이 되지 않는다", !t({ board: '아이패드' }).includes('게임'));
  ok("'메이드카페' 갤러리가 '카페' 때문에 음식이 되지 않는다", !t({ board: '한국 메이드카페 갤러리' }).includes('음식'));
  ok("'기술' 이 '술' 때문에 음식이 되지 않는다", !t({ board: '기술' }).includes('음식'));
  ok('모든 태그가 TAGS 목록 안에 있다', [t({ board: '야구' }), t({ title: '청소' })].flat().every((x) => [...TAGS, OTHER].includes(x)));
}

// ═══════════════════════════════════════════════════════════════════════════
// 2단계 — 파서
// ═══════════════════════════════════════════════════════════════════════════
const FIXTURES = [
  ['dogdrip', 'dogdrip-results.html', 'title', 15, 'utf-8'],
  ['arca', 'arca-results.html', 'live', 20, 'utf-8'],
  ['arca', 'arca-hotdeal.html', 'hotdeal', 20, 'utf-8'],
  ['ppomppu', 'ppomppu-results.html', 'freeboard', 15, 'utf-8'],
  ['ppomppu', 'ppomppu-hotdeal.html', 'ppomppu', 15, 'euc-kr'],
  ['ruliweb', 'ruliweb-list.html', 'market/board/1020', 25, 'utf-8'],
];

if (run('2.1')) {
  head('2.1', '파서 기본 — 저장해둔 실제 HTML');
  for (const [id, file, board, least, cs] of FIXTURES) {
    const html = readFx(file, cs);
    if (!html) { note(`${file} 없음`, '먼저 수집해서 fixture 를 만드세요'); continue; }
    let posts = [], threw = null;
    try { posts = ADAPTERS[id].parse(html, board); } catch (e) { threw = e.message; }

    const tag = `${id}/${file}`;
    ok(`${tag}: 파서가 안 터진다`, !threw, threw ?? '');
    ok(`${tag}: ${least}건 이상`, posts.length >= least, `${posts.length}건`);
    ok(`${tag}: 제목이 비지 않는다`, posts.every((p) => p.title?.length > 0));
    ok(`${tag}: URL 이 http 로 시작`, posts.every((p) => /^https?:\/\//.test(p.url)));
    ok(`${tag}: URL 중복 없음`, new Set(posts.map((p) => p.url)).size === posts.length);
    ok(`${tag}: 태그 잔여물 없음`, posts.every((p) => !/<\s*\/?[a-zA-Z][^>]*>/.test(p.title)),
       (posts.find((p) => /<\s*\/?[a-zA-Z][^>]*>/.test(p.title)) ?? {}).title ?? '');
    ok(`${tag}: 한글이 안 깨졌다`, posts.some((p) => /[가-힣]/.test(p.title)));
    const dated = posts.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));
    ok(`${tag}: 날짜 형식 ${dated.length}/${posts.length}`, dated.length >= posts.length * 0.8,
       `${dated.length}/${posts.length}`);
  }
}

if (run('2.2')) {
  head('2.2', '회귀 — 지금까지 실제로 터진 버그');

  // (2026-09-23) 개드립: index.php?mid= 형태는 검색어를 무시하고 기본 목록을 준다.
  ok('개드립 검색 URL 이 /dogdrip?search_target= 형태다',
    ADAPTERS.dogdrip.url('title', '앱', 1).startsWith('https://www.dogdrip.net/dogdrip?search_target='),
    ADAPTERS.dogdrip.url('title', '앱', 1));
  ok('개드립 URL 에 index.php 가 없다', !ADAPTERS.dogdrip.url('title', '앱', 1).includes('index.php'));

  // (2026-09-23) 개드립: 사이드바 '인기글' 위젯 링크가 결과에 섞였다.
  const dd = readFx('dogdrip-results.html');
  if (dd) {
    const posts = ADAPTERS.dogdrip.parse(dd, 'title');
    ok('개드립: 사이드바 인기글이 안 섞인다',
      posts.every((p) => !p.url.includes('sort_index=popular')),
      (posts.find((p) => p.url.includes('sort_index=popular')) ?? {}).title ?? '');
    ok('개드립: 상대 날짜("7 일 전")를 읽는다', posts.filter((p) => p.date).length === posts.length);
  } else note('개드립 fixture 없음', '');

  // (2026-09-23) 아카 핫딜: 제목과 <time> 사이가 900자를 넘어 26행 중 1행만 걸렸다.
  const ah = readFx('arca-hotdeal.html');
  if (ah) {
    const posts = ADAPTERS.arca.parse(ah, 'hotdeal');
    ok('아카 핫딜: 행이 부서지지 않는다 (20건 이상)', posts.length >= 20, `${posts.length}건`);
    ok('아카 핫딜: 가격을 뽑는다', posts.filter((p) => p.price).length >= posts.length * 0.5,
       `${posts.filter((p) => p.price).length}/${posts.length}`);
    ok('아카 핫딜: 날짜를 뽑는다', posts.filter((p) => p.date).length >= posts.length * 0.8);
  } else note('아카 핫딜 fixture 없음', '');

  // (2026-09-23) 루리웹: 앵커 안 내용이 252~376자인데 300자에서 끊어 9/35만 걸렸고
  //              제목 대신 댓글수 '(5)' 가 잡혔다.
  const rl = readFx('ruliweb-list.html');
  if (rl) {
    const posts = ADAPTERS.ruliweb.parse(rl, 'market/board/1020');
    ok('루리웹: 행을 거의 다 뽑는다 (25건 이상)', posts.length >= 25, `${posts.length}건`);
    ok('루리웹: 제목이 댓글수가 아니다',
      posts.every((p) => !/^\(\d+\)$/.test(p.title.trim())),
      (posts.find((p) => /^\(\d+\)$/.test(p.title.trim())) ?? {}).title ?? '');
    ok('루리웹: 날짜를 뽑는다 (셀 들여쓰기 70자 넘음)',
      posts.filter((p) => p.date).length >= posts.length * 0.9,
      `${posts.filter((p) => p.date).length}/${posts.length}`);
  } else note('루리웹 fixture 없음', '');

  // (2026-09-23) 뽐뿌 핫딜: 자유게시판과 시각 표기가 달라 날짜가 전부 비었다.
  const ph = readFx('ppomppu-hotdeal.html', 'euc-kr');
  if (ph) {
    const posts = ADAPTERS.ppomppu.parse(ph, 'ppomppu');
    ok('뽐뿌 핫딜: 날짜를 뽑는다 (title 속성이 없는 형식)',
      posts.filter((p) => p.date).length >= posts.length * 0.9,
      `${posts.filter((p) => p.date).length}/${posts.length}`);
    ok('뽐뿌 핫딜: EUC-KR 이 안 깨졌다', posts.some((p) => /[가-힣]/.test(p.title)));
  } else note('뽐뿌 핫딜 fixture 없음', '');

  // (2026-09-23) 뽐뿌 본문: class='board-contents' 작은따옴표라 120건 전부 실패했다.
  const pa = readFx('ppomppu-article.html', 'euc-kr');
  if (pa) {
    const body = ADAPTERS.ppomppu.body(pa);
    ok('뽐뿌 본문: 작은따옴표 class 에서도 추출된다', body.length > 10, `${body.length}자`);
  } else note('뽐뿌 글 fixture 없음', '');

  // (2026-09-23) 디시: 글 링크에 검색어·페이지가 붙어 같은 글이 검색어마다 다른 URL 이 됐고,
  //              중복 제거를 그대로 통과해 한 글이 3번씩 저장됐다.
  const ds = readFx('dcinside-search.html');
  if (ds) {
    const posts = ADAPTERS.dcinside.parse(ds, 'programming');
    ok('디시: 검색 결과를 뽑는다 (15건 이상)', posts.length >= 15, `${posts.length}건`);
    ok('디시: URL 에 검색어가 안 붙는다',
      posts.every((p) => !/s_keyword=|s_type=|[?&]page=/.test(p.url)),
      (posts.find((p) => /s_keyword=/.test(p.url)) ?? {}).url ?? '');
    ok('디시: URL 이 id 와 no 만 가진다',
      posts.every((p) => /\/board\/view\/\?id=[^&]+&no=\d+$/.test(p.url)),
      (posts.find((p) => !/\/board\/view\/\?id=[^&]+&no=\d+$/.test(p.url)) ?? {}).url ?? '');
    ok('디시: 광고·설문 행이 안 섞인다',
      posts.every((p) => /gall\.dcinside\.com\/(mgallery\/)?board\/view/.test(p.url)));
  } else note('디시 검색 fixture 없음', '');

  // 마이너 갤러리는 경로에 /mgallery 가 붙는다 (game_dev, algo, godot 등).
  ok('디시: 마이너갤 검색 URL',
    ADAPTERS.dcinside.url('mgallery/game_dev', '길찾기', 1).includes('/mgallery/board/lists/?id=game_dev'),
    ADAPTERS.dcinside.url('mgallery/game_dev', '길찾기', 1));
  ok('디시: 정식갤 검색 URL',
    ADAPTERS.dcinside.url('programming', '길찾기', 1).includes('gall.dcinside.com/board/lists/?id=programming'));

  // (2026-09-23) 코엑스: 달력 격자는 앞뒤 달 날짜도 같이 보여준다. 그걸 이번 달로 세는 바람에
  //              12/2~4 인 소프트웨이브가 11/2~4 로 기록됐다. 공식 페이지와 대조해 잡았다.
  const cx = readFx('coex-2026-11.html');
  if (cx) {
    const ev = ADAPTERS.coex.parse(cx, '2026-11');
    ok('코엑스: 행사를 뽑는다 (15건 이상)', ev.length >= 15, `${ev.length}건`);
    const sw = ev.find((e) => /소프트웨이브/.test(e.title));
    ok('코엑스: 달을 넘긴 행사의 날짜가 맞다 (소프트웨이브 = 12/2~4)',
      !!sw && sw.date === '2026-12-02' && sw.dateEnd === '2026-12-04',
      sw ? `${sw.date} ~ ${sw.dateEnd}` : '못 찾음');
    ok('코엑스: 앞 달 날짜도 그 달로 적힌다',
      ev.some((e) => e.date.startsWith('2026-10')),
      ev.map((e) => e.date).sort()[0]);
    ok('코엑스: 시작이 끝보다 늦지 않다', ev.every((e) => e.date <= e.dateEnd),
      (ev.find((e) => e.date > e.dateEnd) ?? {}).title ?? '');
    ok('코엑스: 날짜 형식', ev.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)));
    ok('코엑스: 장소가 붙는다', ev.every((e) => e.venue));
  } else note('코엑스 fixture 없음', '');

  // 전시장 캘린더는 미래 날짜가 정상이라는 표시를 달고 있어야 한다.
  ok('코엑스·킨텍스에 futureDates 표시', ADAPTERS.coex.futureDates === true && ADAPTERS.kintex.futureDates === true);
  // (2026-09-23) robots.txt 를 UA 없이 받아 코엑스가 403 을 줬고, 허용 사이트를 스스로 막았다.
  ok('robots: robots.txt 를 받을 때도 UA 를 보낸다', readFileSync('core/robots.mjs', 'utf8').includes('ROBOTS_UA'));
  // 코엑스 robots.txt 의 Crawl-delay: 10 을 지킨다.
  ok('코엑스에 crawlDelayMs 가 설정돼 있다', ADAPTERS.coex.crawlDelayMs >= 10000, String(ADAPTERS.coex.crawlDelayMs));

  // (2026-09-24) 디시·아카를 갤러리/채널 하나씩만 연결해둬서, 유동량이 가장 많은
  //              두 곳인데 결과가 몇 건 안 나왔다. 사이트 전체 검색으로 바꿨다.
  const dcs = readFx('dcinside-search-all.html');
  if (dcs) {
    const ev = ADAPTERS.dcsearch.parse(dcs, '');
    ok('디시 전체검색: 15건 이상', ev.length >= 15, `${ev.length}건`);
    ok('디시 전체검색: 여러 갤러리에서 온다',
      new Set(ev.map((e) => e.board)).size >= 8, `${new Set(ev.map((e) => e.board)).size}종`);
    ok('디시 전체검색: 본문 발췌가 같이 온다', ev.filter((e) => e.body).length >= ev.length * 0.5);
    ok('디시 전체검색: 금지 갤러리를 걸러낸다',
      ev.every((e) => !/[?&]id=(stock_new2|cat|dog|47)(&|$)/.test(e.url)));
    ok('디시 전체검색: URL 이 id 와 no 만', ev.every((e) => /\/board\/view\/\?id=[^&]+&no=\d+$/.test(e.url)));
    ok('디시 전체검색: 날짜를 읽는다', ev.filter((e) => e.date).length >= ev.length * 0.9);
  } else note('디시 전체검색 fixture 없음', '');

  // (2026-09-24) 아카 전체검색(/b/breaking)은 행 모양이 달라 0건이 나왔다.
  //              제목 span 안에 아이콘 span 이 중첩돼 non-greedy 매칭이 빈 문자열을 집었다.
  const ab = readFx('arca-breaking.html');
  if (ab) {
    const ev = ADAPTERS.arca.parse(ab, 'breaking');
    ok('아카 전체검색: 15건 이상', ev.length >= 15, `${ev.length}건`);
    ok('아카 전체검색: 제목이 비지 않는다', ev.every((e) => e.title.length > 1),
      JSON.stringify((ev.find((e) => e.title.length <= 1) ?? {}).title ?? ''));
    ok('아카 전체검색: 날짜를 읽는다', ev.filter((e) => e.date).length >= ev.length * 0.9);
  } else note('아카 전체검색 fixture 없음', '');

  // (2026-09-24) robots.txt 가 4xx 면 규칙이 없다는 뜻이다 (RFC 9309).
  //              '판독 불가 → 거부' 로 처리해서 제한 없는 호스트를 스스로 막고 있었다.
  {
    const rsrc2 = readFileSync('core/robots.mjs', 'utf8');
    ok('robots: 4xx 를 제한 없음으로 본다', rsrc2.includes("cache.set(origin, 'none')"));
    ok('robots: 못 받은 경우는 여전히 거부', /robots\.txt 를 받지 못함/.test(rsrc2));
  }

  // (2026-09-24) 파서가 정한 board(디시 갤러리 이름)를 설정값으로 덮어써서 날렸다.
  {
    const csrc = readFileSync('crawl.mjs', 'utf8');
    ok('crawl: 파서가 정한 board 를 살린다', csrc.includes('board: p.board || board'));
    ok('crawl: 파서가 준 본문을 살린다', /p\.body \? \{ body: p\.body \}/.test(csrc));
    // (2026-09-24) 디시 통합검색은 본문을 뒤지는데 제목만 보고 걸러서,
    //              25건 받아 21건을 버렸다 — 디시가 안 되는 것처럼 보였다.
    ok('crawl: 발췌가 있으면 제목+발췌로 거른다',
      csrc.includes('matcher.test(p.body ? `${p.title} ${p.body}` : p.title)'));
  }

  // 발췌를 함께 보는 판정이 실제로 통하는지 — 디시 검색 결과로 확인한다.
  if (dcs) {
    const ev = ADAPTERS.dcsearch.parse(dcs, '');
    const m2 = new Matcher({ any: ['알고리즘'] });
    const byTitle = ev.filter((e) => m2.test(e.title).pass).length;
    const byBoth = ev.filter((e) => m2.test(e.body ? `${e.title} ${e.body}` : e.title).pass).length;
    ok('디시: 제목만 보면 많이 버려진다 (그래서 발췌가 필요하다)', byTitle < ev.length,
      `${byTitle}/${ev.length}`);
    ok('디시: 발췌까지 보면 대부분 살아난다', byBoth >= ev.length * 0.8,
      `제목만 ${byTitle} → 발췌포함 ${byBoth} / 전체 ${ev.length}`);
  }

  // (2026-09-22) 아카 제목에 '<<' 가 들어간 실제 글이 있었다. 꺾쇠 자체는 금지할 수 없다.
  ok('제목의 꺾쇠는 태그가 아니면 허용', !/<\s*\/?[a-zA-Z][^>]*>/.test('애플폰만 써!<< 딱히'));

  // (2026-09-23) robots: '*' 를 와일드카드로 안 바꿔 전체가 오판정됐다.
  const rsrc = readFileSync('core/robots.mjs', 'utf8');
  ok('robots: * 를 .* 로 바꾼다', rsrc.includes(".replace(/\\*/g, '.*')"));
  // (2026-09-23) robots: '?' 를 escape 안 해 금지 갤러리가 허용으로 샜다.
  ok('robots: ? 를 escape 한다', /\[\.\+\^\$\{\}\(\)\|\[\\\]\\\\\?\]/.test(rsrc));
  // (2026-09-23) robots: ClaudeBot 차단을 호스트 전체 거부로 오해해 디시를 통째로 막았다.
  //              우리는 ClaudeBot 이 아니므로 User-agent: * 가 우리 규칙이다.
  ok('robots: AI 크롤러 차단을 전체 거부로 쓰지 않는다',
    !/robots\.txt 가 \$\{ua\} 를 차단함/.test(rsrc));
  ok('robots: AI 크롤러 차단 사실은 따로 알린다', rsrc.includes('aiBlocked'));

  // (2026-09-23) fetch: --max-time 을 초로 올림해 100ms 타임아웃이 1초가 됐다.
  const fsrc = readFileSync('core/fetch.mjs', 'utf8');
  ok('fetch: --max-time 에 소수점 초를 쓴다', fsrc.includes('toFixed(3)'));
  ok('fetch: status 0 을 실패로 본다', /status === 0/.test(fsrc));
  // (2026-09-22) undici 는 TLS 지문 때문에 403. 전송은 curl 이어야 한다.
  ok('fetch: 전송이 curl 이다', fsrc.includes("execFile('curl'"));
  ok('fetch: 본문 전송에 내장 fetch 를 안 쓴다', !/await fetch\(/.test(fsrc));
}

if (run('2.3')) {
  head('2.3', '견고성 — 깨진 입력');
  const junk = ['', '<html></html>', '<<<>>>깨진 마크업<a href=', '&amp;'.repeat(2000),
                '<div class="vrow ', '<tr><td class="subject">'];
  for (const id of Object.keys(ADAPTERS)) {
    let bad = null;
    try { for (const j of junk) ADAPTERS[id].parse(j, 'x'); }
    catch (e) { bad = e.message; }
    ok(`${id}: 깨진 HTML 에도 안 터진다`, !bad, bad ?? '');

    let badBody = null;
    try { if (ADAPTERS[id].body) for (const j of junk) ADAPTERS[id].body(j); }
    catch (e) { badBody = e.message; }
    ok(`${id}: 깨진 HTML 본문 추출도 안 터진다`, !badBody, badBody ?? '');
  }
  let huge = null;
  try { ADAPTERS.arca.parse('<div class="vrow '.repeat(20000), 'x'); }
  catch (e) { huge = e.message; }
  ok('거대 입력에도 안 터진다', !huge, huge ?? '');
}

if (run('2.4')) {
  head('2.4', '본문 추출기');
  const cases = [
    ['ppomppu', 'ppomppu-article.html', 'euc-kr'],
    ['ruliweb', 'ruliweb-article.html', 'utf-8'],
  ];
  for (const [id, file, cs] of cases) {
    const html = readFx(file, cs);
    if (!html) { note(`${file} 없음`, ''); continue; }
    const body = ADAPTERS[id].body(html);
    ok(`${id}: 본문이 나온다`, body.length > 10, `${body.length}자`);
    ok(`${id}: 태그가 안 남았다`, !/<\s*\/?[a-zA-Z][^>]*>/.test(body));
    ok(`${id}: script 내용이 안 섞였다`, !/function\s*\(|var\s+\w+\s*=/.test(body));
    ok(`${id}: 본문이 페이지 전체가 아니다`, body.length < html.length * 0.5,
       `본문 ${body.length} / 문서 ${html.length}`);
  }
  ok('모든 어댑터에 본문 추출기가 있다',
    Object.values(ADAPTERS).every((a) => typeof a.body === 'function'),
    Object.values(ADAPTERS).filter((a) => !a.body).map((a) => a.id).join(','));
  ok('모든 어댑터에 browseUrl 이 있다',
    Object.values(ADAPTERS).every((a) => typeof a.browseUrl === 'function'));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3단계 — 오류 처리
// ═══════════════════════════════════════════════════════════════════════════
const cli = (args, timeout = 90000) => new Promise((res) => {
  execFile(process.execPath, ['crawl.mjs', ...args], { encoding: 'utf8', timeout },
    (err, so, se) => res({ code: err?.code ?? 0, out: (so || '') + (se || '') }));
});

function writeCfg(name, over = {}) {
  const base = {
    keywords: { any: ['테스트'] }, filters: {},
    engine: { pagesPerQuery: 1, mode: 'http' },
    rate: { minDelayMs: 1, jitterMs: 0, perHostConcurrency: 1, backoff: { startMs: 1, factor: 2, maxMs: 2, recoverAfterOk: 1 } },
    output: { dir: TMP, resume: false },
    sites: [{ id: 'arca', enabled: true, robots: 'enforce', boards: ['live'] }],
  };
  const path = `tests/tmp-${name}.json`;
  writeFileSync(path, JSON.stringify({ ...base, ...over }), 'utf8');
  return path;
}

if (run('3.1')) {
  head('3.1', '설정 오류');
  const r1 = await cli(['--config', writeCfg('nosite', { sites: [] })]);
  ok('사이트가 없으면 안내하고 종료', /수집할 사이트가 없습니다/.test(r1.out), r1.out.slice(0, 70));
  const r2 = await cli(['--config', writeCfg('nokw', { keywords: { any: [] } })]);
  ok('검색어가 없으면 안내하고 종료', /검색어가 없습니다/.test(r2.out), r2.out.slice(0, 70));
  const r3 = await cli(['--config', 'tests/없는파일.json', '--show']);
  ok('없는 설정 파일 → 0 아닌 종료코드', r3.code !== 0);
  const r4 = await cli(['--config', writeCfg('badsite', {
    sites: [{ id: '없는사이트', enabled: true, robots: 'enforce', boards: ['a'] }],
  }), '--show']);
  ok('모르는 사이트 id 를 알려준다', /어댑터 없음/.test(r4.out), r4.out.slice(0, 70));
  const r5 = await cli(['--config', writeCfg('badre', {
    keywords: { any: ['x'], regex: ['[깨짐('] },
  }), '--show']);
  ok('깨진 정규식을 경고한다', /잘못된 정규식/.test(r5.out), r5.out.slice(0, 70));
}

if (run('3.2')) {
  head('3.2', '손상된 상태 파일');
  mkdirSync(TMP, { recursive: true });
  writeFileSync(TMP + '/seen.json', '{{{깨진 JSON', 'utf8');
  let broke = null;
  try { ok('깨진 seen.json 이어도 시작된다', new Store(TMP, { resume: true }).isNew('https://a.com/zzz')); }
  catch (e) { broke = e.message; ok('깨진 seen.json 이어도 시작된다', false, broke); }
  writeFileSync(TMP + '/seen.json', '[]', 'utf8');
}

if (run('3.3')) {
  head('3.3', '네트워크 실패');
  const dead = await grab('https://이런도메인은없다-999.invalid/x', { mode: 'http', timeout: 8000 });
  ok('없는 도메인 → ok:false', dead.ok === false);
  ok('없는 도메인 → 이유를 남긴다', !!dead.err, JSON.stringify(dead));
  const nf = await grab('https://arca.live/b/live/이런글은없다-99999999', { mode: 'http', timeout: 15000 });
  ok('404 → ok:false', nf.ok === false, `status=${nf.status}`);
  const to = await grab('https://arca.live/', { mode: 'http', timeout: 50 });
  ok('타임아웃 → 실패로 반환 (부분응답을 성공으로 안 본다)', to.ok === false, JSON.stringify(to).slice(0, 80));
  ok('타임아웃 → 이유를 남긴다', !!to.err);
  ok('실패해도 html 을 지어내지 않는다', !to.html && !dead.html);
}

if (run('3.4')) {
  head('3.4', 'robots 정책');
  // 디시는 User-agent:* 가 Allow:/ 라 갤러리 전체가 막힌 게 아니다.
  // 실제로 막힌 것은 지목된 갤러리다 (stock_new2 등 14곳).
  const blocked = ADAPTERS.dcinside.url('stock_new2', '테스트', 1);
  const allowed = ADAPTERS.dcinside.url('programming', '테스트', 1);

  const e = await gate(blocked, 'enforce');
  ok('enforce: 금지된 갤러리를 막는다', e.go === false, e.reason);
  const w = await gate(blocked, 'warn');
  ok('warn: 통과시키되 경고를 남긴다', w.go === true && !!w.warn, w.reason);
  const o = await gate(blocked, 'off');
  ok('off: 확인조차 안 한다', o.go === true && o.warn === null);
  const a = await gate(allowed, 'enforce');
  ok('enforce: 허용된 갤러리는 통과시킨다', a.go === true, a.reason);
  ok('잘못된 URL 은 거부', (await gate('이건URL이아니다', 'enforce')).go === false);

  // AI 학습 크롤러 차단은 '알림'이지 '거부'가 아니다.
  const dcChk = await check(allowed);
  ok('디시: 일반 수집은 허용으로 판정', dcChk.allowed === true, dcChk.reason);
  ok('디시: AI 학습 크롤러 차단 사실은 알려준다', dcChk.aiBlocked === true);
  const arcaChk = await check('https://arca.live/b/hotdeal?p=1');
  ok('아카: 허용', arcaChk.allowed === true, arcaChk.reason);
  ok('아카: AI 크롤러 차단 조항 없음', arcaChk.aiBlocked === false);

  const rb = await check('https://bbs.ruliweb.com/market/board/1020?search_type=subject&search_key=x');
  ok('루리웹 검색 경로는 거부된다', rb.allowed === false, rb.reason);
  const rl = await check('https://bbs.ruliweb.com/market/board/1020?page=1');
  ok('루리웹 목록 경로는 허용된다', rl.allowed === true, rl.reason);
}

if (run('3.5')) {
  head('3.5', 'CLI 모드 일관성');
  const cfg = writeCfg('browse', {
    keywords: { any: ['무료'] },
    engine: { pagesPerQuery: 1, mode: 'http', fetchBody: false },
    sites: [{ id: 'ruliweb', enabled: true, robots: 'enforce', listMode: 'browse', browsePages: 2, boards: ['market/board/1020'] }],
  });
  const rb = await cli(['--config', cfg, '--robots']);
  ok('--robots 가 browse 모드 경로로 판정한다', /허용\s+루리웹/.test(rb.out), rb.out.slice(0, 120));
  const sh = await cli(['--config', cfg, '--show']);
  ok('--show 가 browse 를 검색어 수로 안 센다', /목록훑기/.test(sh.out), sh.out.slice(0, 120));
  ok('--show 는 요청을 보내지 않는다', !/robots차단|수집 \d/.test(sh.out));

  const cfg2 = writeCfg('bodyplan', {
    engine: { pagesPerQuery: 1, mode: 'http', fetchBody: true, maxBodies: 33 },
  });
  const sh2 = await cli(['--config', cfg2, '--show']);
  ok('--show 가 본문 요청 수도 알려준다', /본문 최대 33회/.test(sh2.out), sh2.out.slice(0, 160));
}

if (run('3.7')) {
  head('3.7', '웹 서버 — 검색 id 경로 탈출');
  // (2026-09-23) id 에 '../' 를 넣어 주제 폴더 밖을 지울 수 있었다.
  //   DELETE /api/topic?id=..%2FCANARY  →  out/CANARY 가 통째로 삭제됐다 (실측).
  // 삭제가 rmSync 재귀라 특히 위험했다. searchDir() 이 두 겹으로 막는다.
  const src = readFileSync('server.mjs', 'utf8');
  const m = src.match(/function searchDir\(id\)[\s\S]*?\n}/);
  ok('server.mjs 에 searchDir 방어 함수가 있다', !!m);
  if (m) {
    const SEARCHES = resolve('./out/searches');
    // 진짜 path 함수를 넘겨야 한다. 가짜 join 을 쓰면 Windows 에서 구분자가 엇갈려
    // 멀쩡한 id 까지 거부당하는 것처럼 보인다 (테스트 하네스 문제였다).
    const dirOf = new Function('SEARCHES', 'resolve', 'join', 'sep',
      `${m[0]}; return searchDir;`)(SEARCHES, resolve, join, sep);
    const bad = ['../CANARY', '..\\CANARY', '/etc/passwd', '.hidden', '..', 'a/../../b', 'x'.repeat(80)];
    for (const b of bad) {
      ok(`경로 탈출 거부: ${JSON.stringify(b).slice(0, 24)}`, dirOf(b) === null);
    }
    ok('정상 id 는 통과', typeof dirOf('2026-09-23T12-57-25-4hj6') === 'string');
    ok('빈 id 는 거부', dirOf('') === null);
  }
}

if (run('3.6')) {
  head('3.6', '경계 입력');
  const m = new Matcher({ any: ['앱'] });
  ok('아주 긴 제목', m.test('앱' + '가'.repeat(20000)).pass);
  ok('특수문자 제목', typeof m.test('!@#$%^&*()[]{}|\\<>?').pass === 'boolean');
  ok('이모지 제목', typeof m.test('앱 😀🎉').pass === 'boolean');
  ok('개행이 든 제목', m.test('앱\n\n줄바꿈').pass);
  ok('제로폭 문자', typeof m.test('앱​').pass === 'boolean');
  const s = new Store(TMP + '3', { resume: false });
  s.add({ site: 'x', board: 'b', date: '', query: 'q', matched: [], title: '따옴표 " 와 쉼표 , 있음', url: 'https://a.com/q' });
  const r = s.flush();
  const csv = readFileSync(r.csv, 'utf8');
  ok('CSV 가 따옴표·쉼표를 깨지 않는다', csv.includes('따옴표 "" 와 쉼표 , 있음'), csv.split('\n')[1]?.slice(0, 80));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4단계 — 진위 검증
// ═══════════════════════════════════════════════════════════════════════════
const LIVE_DIR = TMP + '-live';
let liveRows = [];

if (run('4')) {
  const liveCfg = {
    keywords: { any: ['무료'], none: [], regex: [] },
    filters: { sinceDate: null, minTitleLength: 2, maxPerSite: 60 },
    engine: {
      mode: 'auto', pagesPerQuery: 1, headless: true, offscreenWindow: false,
      keepSession: true, navigationTimeoutMs: 25000, fetchBody: true, maxBodies: 6,
    },
    rate: { minDelayMs: 1500, jitterMs: 600, perHostConcurrency: 1, backoff: { startMs: 5000, factor: 2, maxMs: 60000, recoverAfterOk: 5 } },
    output: { dir: LIVE_DIR, resume: true },
    sites: [
      { id: 'ppomppu', enabled: true, robots: 'enforce', boards: ['ppomppu'] },
      { id: 'ruliweb', enabled: true, robots: 'enforce', listMode: 'browse', browsePages: 1, boards: ['market/board/1020'] },
    ],
  };
  writeFileSync('tests/tmp-live.json', JSON.stringify(liveCfg), 'utf8');
  rmSync(LIVE_DIR, { recursive: true, force: true });

  if (run('4.1')) {
    head('4.1', '실제 수집이 끝까지 도는가');
    if (listOnly) { note('(네트워크 사용)', ''); }
    else {
      console.log('  (실제 요청 — 1~2분)');
      const r = await cli(['--config', 'tests/tmp-live.json'], 300000);
      const saved = Number((r.out.match(/저장 (\d+)건/) ?? [])[1] ?? -1);
      ok('정상 종료', r.code === 0, `exit=${r.code}`);
      ok('1건 이상 저장', saved > 0, `${saved}건`);
      const req = r.out.match(/요청 \d+ \(성공 (\d+) \/ 실패 (\d+)/);
      ok('성공이 실패보다 많다', req && Number(req[1]) > Number(req[2]),
         (r.out.match(/요청 \d+ \([^)]*\)/) ?? [''])[0]);
      ok('본문 확보 건수를 보고한다', /본문 확보 \d+건/.test(r.out));
      const jl = LIVE_DIR + '/results.jsonl';
      if (existsSync(jl)) liveRows = readFileSync(jl, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      ok('JSONL 을 읽을 수 있다', liveRows.length > 0, `${liveRows.length}행`);
    }
  }

  if (run('4.2')) {
    head('4.2', '출력 형식');
    if (!liveRows.length) note('수집 결과 없음', '4.1 을 먼저 돌리세요');
    else {
      const csv = LIVE_DIR + '/results.csv';
      ok('CSV 생성', existsSync(csv));
      if (existsSync(csv)) {
        const raw = readFileSync(csv, 'utf8');
        ok('CSV BOM', raw.charCodeAt(0) === 0xFEFF);
        ok('CSV 헤더', raw.split('\n')[0].includes('title'));
        ok('CSV 한글 보존', /[가-힣]/.test(raw));
        ok('CSV 행 수가 JSONL 과 맞는다',
          raw.trim().split('\n').length === liveRows.length + 1,
          `CSV ${raw.trim().split('\n').length - 1} / JSONL ${liveRows.length}`);
      }
      ok('모든 행에 제목·URL', liveRows.every((r) => r.title && r.url));
      ok('모든 행에 id', liveRows.every((r) => r.id));
      ok('id 중복 없음', new Set(liveRows.map((r) => r.id)).size === liveRows.length);
      ok('URL 중복 없음', new Set(liveRows.map((r) => r.url)).size === liveRows.length);
      ok('site 값이 실재하는 어댑터', liveRows.every((r) => ADAPTERS[r.site]));
    }
  }

  // ── 여기서부터가 '지어낸 데이터가 없는가' 검증이다 ────────────────────
  if (run('4.3')) {
    head('4.3', '진위 — 제목이 실제로 목록에 있었는가');
    if (!liveRows.length) note('수집 결과 없음', '');
    else {
      // 저장된 제목을 원본 목록 HTML 에서 다시 찾는다.
      // 파서가 제목을 만들어내거나 다른 칸을 제목으로 잡았다면 여기서 걸린다.
      const bySite = {};
      for (const r of liveRows) (bySite[r.site] ??= []).push(r);

      for (const [site, rows] of Object.entries(bySite)) {
        const ad = ADAPTERS[site];
        const listUrl = site === 'ruliweb'
          ? ad.browseUrl(rows[0].board, 1)
          : ad.url(rows[0].board, rows[0].query, 1);
        const res = await grab(listUrl, { charset: ad.charset, referer: ad.referer, mode: 'http', timeout: 25000 });
        if (!res.ok) { note(`${ad.label}: 목록 재조회 실패`, res.err ?? `HTTP ${res.status}`); continue; }

        const src = norm(clean(res.html));
        const sample = rows.slice(0, 8);
        const missing = sample.filter((r) => {
          const t = norm(r.title.replace(/\.{2,}$/, '').replace(/\(\d+\)$/, ''));
          return t.length >= 6 && !src.includes(t.slice(0, Math.min(t.length, 18)));
        });
        ok(`${ad.label}: 저장된 제목이 원본에 실제로 있다 (${sample.length}건 표본)`,
          missing.length === 0,
          missing.map((r) => r.title).slice(0, 2).join(' | '));
      }
    }
  }

  if (run('4.4')) {
    head('4.4', '진위 — 제목과 URL 이 같은 글인가');
    if (!liveRows.length) note('수집 결과 없음', '');
    else {
      // 저장된 URL 로 직접 가서 그 페이지에 저장된 제목이 있는지 본다.
      // 행 단위 파싱이 어긋나 제목과 링크가 엇갈리면 여기서 걸린다 (루리웹에서 실제로 났던 일).
      const seen = new Set();
      const sample = liveRows.filter((r) => { if (seen.has(r.site)) return false; seen.add(r.site); return true; })
        .concat(liveRows.slice(0, 3)).slice(0, 4);
      for (const r of sample) {
        const ad = ADAPTERS[r.site];
        const res = await grab(r.url, { charset: ad.charset, referer: ad.referer, mode: 'http', timeout: 25000 });
        if (!res.ok) { note(`${ad.label}: 글 재조회 실패 — ${r.title.slice(0, 26)}`, res.err ?? `HTTP ${res.status}`); continue; }
        const page = norm(clean(res.html));
        const t = norm(r.title.replace(/\.{2,}$/, '').replace(/\(\d+\)$/, ''));
        const probe = t.slice(0, Math.min(t.length, 16));
        ok(`${ad.label}: URL 이 그 제목의 글을 가리킨다 — ${r.title.slice(0, 26)}`,
          probe.length < 6 || page.includes(probe), r.url);
      }
    }
  }

  if (run('4.5')) {
    head('4.5', '진위 — 날짜를 지어내지 않았는가');
    if (!liveRows.length) note('수집 결과 없음', '');
    else {
      const today = new Date().toISOString().slice(0, 10);
      const dated = liveRows.filter((r) => r.date);
      // 전시장 캘린더는 '행사가 열리는 날'이라 미래 날짜가 정상이다.
      // 커뮤니티 글은 미래에 쓰일 수 없으므로 그쪽만 본다.
      const postRows = dated.filter((r) => !ADAPTERS[r.site]?.futureDates);
      ok('커뮤니티 글에 미래 날짜가 없다', postRows.every((r) => r.date <= today),
        (postRows.find((r) => r.date > today) ?? {}).date ?? '');
      ok('날짜 형식이 전부 YYYY-MM-DD', dated.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)),
        (dated.find((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) ?? {}).date ?? '');
      ok('터무니없이 오래된 날짜가 없다', dated.every((r) => r.date >= '2000-01-01'));
      ok('날짜가 없으면 빈 문자열 (임의값 아님)',
        liveRows.every((r) => r.date === '' || /^\d{4}-\d{2}-\d{2}$/.test(r.date)));

      // 여기가 진짜 검사다. 원본을 다시 받아 다시 파싱했을 때 같은 URL 이 같은 날짜를
      // 내놓아야 한다. 저장 단계에서 날짜를 채워 넣거나 '오늘'로 일괄 도배했다면
      // 재파싱 값과 어긋나서 걸린다.
      //
      // '모든 날짜가 같다'는 것만으로는 판단하지 않는다 — 핫딜 게시판 1쪽은
      // 원래 전부 오늘 글이라 한 값으로 나오는 게 정상이다 (실측 23건 전부 같은 날).
      const bySite = {};
      for (const r of liveRows) (bySite[r.site] ??= []).push(r);
      for (const [site, rows] of Object.entries(bySite)) {
        const ad = ADAPTERS[site];
        const listUrl = site === 'ruliweb'
          ? ad.browseUrl(rows[0].board, 1)
          : ad.url(rows[0].board, rows[0].query, 1);
        const res = await grab(listUrl, { charset: ad.charset, referer: ad.referer, mode: 'http', timeout: 25000 });
        if (!res.ok) { note(`${ad.label}: 날짜 재현 확인 불가`, res.err ?? `HTTP ${res.status}`); continue; }
        const fresh = new Map(ad.parse(res.html, rows[0].board).map((p) => [p.url, p.date]));
        const checkable = rows.filter((r) => fresh.has(r.url));
        const mismatch = checkable.filter((r) => fresh.get(r.url) !== r.date);
        ok(`${ad.label}: 날짜가 원본에서 그대로 재현된다 (${checkable.length}건 대조)`,
          checkable.length === 0 || mismatch.length === 0,
          mismatch.slice(0, 2).map((r) => `${r.title.slice(0, 20)} 저장=${r.date} 재파싱=${fresh.get(r.url)}`).join(' | '));
      }
    }
  }

  if (run('4.6')) {
    head('4.6', '진위 — 키워드 판정이 실제와 맞는가');
    if (!liveRows.length) note('수집 결과 없음', '');
    else {
      const m = new Matcher({ any: ['무료'], none: [], regex: [] });
      ok('저장된 모든 행이 실제로 키워드를 포함한다',
        liveRows.every((r) => m.test(r.title).pass),
        (liveRows.find((r) => !m.test(r.title).pass) ?? {}).title ?? '');
      ok('matched 에 적힌 말이 제목에 실제로 있다',
        liveRows.every((r) => (r.matched ?? []).every((k) =>
          k.split(/\s+/).every((tok) => r.title.toLowerCase().includes(tok.toLowerCase())) ||
          (() => { try { return new RegExp(k, 'i').test(r.title); } catch { return false; } })())),
        (liveRows.find((r) => (r.matched ?? []).some((k) =>
          !k.split(/\s+/).every((tok) => r.title.toLowerCase().includes(tok.toLowerCase())) &&
          !(() => { try { return new RegExp(k, 'i').test(r.title); } catch { return false; } })())) ?? {}).title ?? '');
      ok('matched 가 비어있지 않다', liveRows.every((r) => (r.matched ?? []).length > 0));
    }
  }

  if (run('4.7')) {
    head('4.7', '진위 — 본문이 그 글에서 온 것인가');
    if (!liveRows.length) note('수집 결과 없음', '');
    else {
      const withBody = liveRows.filter((r) => r.body && r.body.length > 20);
      if (!withBody.length) note('본문 있는 행이 없다', '아카 등은 글 페이지가 403 일 수 있습니다');
      else {
        ok('본문에 태그가 안 남았다', withBody.every((r) => !/<\s*\/?[a-zA-Z][^>]*>/.test(r.body)),
          (withBody.find((r) => /<\s*\/?[a-zA-Z][^>]*>/.test(r.body)) ?? {}).title ?? '');
        ok('본문에 스크립트가 안 섞였다',
          withBody.every((r) => !/function\s*\(|var\s+\w+\s*=|\$\(document\)/.test(r.body)));
        ok('본문이 서로 다르다 (한 글을 복제하지 않았다)',
          withBody.length < 2 || new Set(withBody.map((r) => r.body.slice(0, 60))).size > 1,
          `${new Set(withBody.map((r) => r.body.slice(0, 60))).size}종 / ${withBody.length}건`);

        // 한 건만 원본과 대조한다 (요청 수를 아끼기 위해)
        const r = withBody[0];
        const ad = ADAPTERS[r.site];
        const res = await grab(r.url, { charset: ad.charset, referer: ad.referer, mode: 'http', timeout: 25000 });
        if (!res.ok) note(`${ad.label}: 본문 재조회 실패`, res.err ?? `HTTP ${res.status}`);
        else {
          const fresh = norm(ad.body(res.html));
          const stored = norm(r.body);
          ok(`${ad.label}: 저장된 본문이 그 글의 본문과 같다`,
            fresh.includes(stored.slice(0, 40)) || stored.includes(fresh.slice(0, 40)),
            `저장 "${r.body.slice(0, 40)}" / 재조회 "${textOf(ad.body(res.html)).slice(0, 40)}"`);
        }
      }
    }
  }

  if (run('4.8')) {
    head('4.8', '통계 일관성 · 이어받기');
    if (listOnly) note('(네트워크 사용)', '');
    else if (!liveRows.length) note('수집 결과 없음', '');
    else {
      console.log('  (2차 실행 — 이어받기 확인)');
      const second = await cli(['--config', 'tests/tmp-live.json'], 300000);
      const n2 = Number((second.out.match(/저장 (\d+)건/) ?? [])[1] ?? -1);
      ok('2차도 정상 종료', second.code === 0, `exit=${second.code}`);
      ok('이미 본 글은 건너뛴다', n2 < liveRows.length || liveRows.length === 0,
         `1차 ${liveRows.length}건 → 2차 ${n2}건`);
      ok('중복 건너뛴 수를 보고한다', /중복 \d+/.test(second.out));

      const m = second.out.match(/목록에서 읽은 글 (\d+) → 중복 (\d+) · 키워드탈락 (\d+) · 기간밖 (\d+)/);
      ok('통계 줄이 나온다', !!m, second.out.slice(-300));
      if (m) {
        const [, parsed, dup, filtered, old] = m.map(Number);
        ok('읽은 글 수가 버린 수보다 크거나 같다', parsed >= dup + filtered + old,
          `읽음 ${parsed} vs 버림 ${dup + filtered + old}`);
      }
      const after = readFileSync(LIVE_DIR + '/results.jsonl', 'utf8').trim().split('\n').filter(Boolean);
      ok('2차 뒤에도 JSONL 이 안 깨졌다', after.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
await close().catch(() => {});
if (!listOnly) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`통과 ${pass} · 실패 ${fail}${skip ? ` · 보류 ${skip}` : ''}`);
  if (failures.length) {
    console.log('\n실패 목록:');
    for (const f of failures) console.log('  · ' + f);
  }
  console.log('═'.repeat(64));
}
process.exit(fail ? 1 : 0);
