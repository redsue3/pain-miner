// crawl.mjs — 진입점
//
//   node crawl.mjs                    config.json 대로 수집
//   node crawl.mjs --site arca        한 사이트만
//   node crawl.mjs --pages 5          검색어당 페이지 수 덮어쓰기
//   node crawl.mjs --probe arca       한 번만 요청해서 연결·파서가 맞는지 확인
//   node crawl.mjs --robots           대상 사이트들의 robots.txt 판정만 출력
//   node crawl.mjs --show             지금 설정으로 무엇을 수집할지 미리보기 (요청 안 함)
//   node crawl.mjs --head             창을 띄워서 실행 (셀렉터 디버깅용)
//   node crawl.mjs --max-minutes 20   이 시간이 지나면 멈추고 그때까지 받은 것을 저장
//
// 무엇을 건질지는 config.json 의 keywords 가 정한다. 이 파일은 그 규칙을 집행만 한다.

import { readFileSync } from 'node:fs';
import { ADAPTERS } from './adapters/index.mjs';
import { Matcher } from './core/keywords.mjs';
import { Limiter } from './core/limiter.mjs';
import { Store } from './core/store.mjs';
import { gate, check } from './core/robots.mjs';
import { grab, saveCookies } from './core/fetch.mjs';
import { launch, close } from './core/browser.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const flag = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  if (i === -1) return d;
  const v = argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
};

const cfg = JSON.parse(readFileSync(flag('config', './config.json'), 'utf8'));
if (has('head')) { cfg.engine.headless = false; cfg.engine.offscreenWindow = false; }
if (flag('pages')) cfg.engine.pagesPerQuery = Number(flag('pages'));
if (flag('mode')) cfg.engine.mode = flag('mode');

const onlySite = flag('site');
const sites = cfg.sites
  .filter((s) => (onlySite ? s.id === onlySite : s.enabled))
  .filter((s) => {
    if (!ADAPTERS[s.id]) { console.log(`! 어댑터 없음: ${s.id}`); return false; }
    return true;
  });

const matcher = new Matcher(cfg.keywords);
if (matcher.badRegex.length) {
  console.log(`! 잘못된 정규식 무시됨: ${matcher.badRegex.join(', ')}`);
}
const queries = matcher.searchQueries(cfg.keywords);

// ── --robots : 판정만 보기 ───────────────────────────────────────────────
if (has('robots')) {
  // 무엇을 켤지 판단하는 명령이므로 enabled 와 무관하게 전부 보여준다.
  for (const s of (onlySite ? cfg.sites.filter((x) => x.id === onlySite) : cfg.sites)) {
    const ad = ADAPTERS[s.id];
    if (!ad) continue;
    if (!s.enabled) process.stdout.write('(꺼짐) ');
    // 실제로 요청할 주소로 판정해야 한다. browse 모드는 검색 파라미터를 안 붙이므로
    // 검색 URL 로 재면 멀쩡히 허용되는 경로를 거부라고 잘못 보고하게 된다.
    const u = s.listMode === 'browse' ? ad.browseUrl(s.boards[0], 1) : ad.url(s.boards[0], '테스트', 1);
    const r = await check(u);
    console.log(`${(r.allowed ? '허용' : '거부').padEnd(3)} ${ad.label.padEnd(10)} 정책=${s.robots}`);
    console.log(`      ${r.reason}`);
    if (!r.allowed && s.robots === 'enforce') {
      console.log('      → 지금 설정으로는 요청하지 않습니다.');
    }
  }
  process.exit(0);
}

// ── --show : 계획 미리보기 ───────────────────────────────────────────────
if (has('show')) {
  console.log(`검색어 ${queries.length}개:`);
  for (const q of queries) console.log(`   · ${q}`);
  console.log(`\n제외어: ${(cfg.keywords.none ?? []).join(', ') || '없음'}`);
  console.log(`필수어: ${(cfg.keywords.all ?? []).join(', ') || '없음'}`);
  console.log(`정규식: ${(cfg.keywords.regex ?? []).join(', ') || '없음'}\n`);
  let total = 0;
  for (const s of sites) {
    const browsing = s.listMode === 'browse';
    const nq = browsing ? 1 : queries.length;
    const np = browsing ? (s.browsePages ?? cfg.engine.pagesPerQuery) : cfg.engine.pagesPerQuery;
    const n = s.boards.length * nq * np;
    total += n;
    const how = browsing ? '목록훑기' : `검색어 ${queries.length}`;
    console.log(`${ADAPTERS[s.id].label.padEnd(10)} 게시판 ${s.boards.length} × ${how} × ${np}쪽 = ${n}회 요청`);
  }
  if (cfg.engine.fetchBody) {
    console.log(`  + 본문 최대 ${cfg.engine.maxBodies ?? 200}회 (걸러낸 글에만)`);
  }
  const sec = Math.round(total * (cfg.rate.minDelayMs + cfg.rate.jitterMs / 2) / 1000);
  console.log(`\n합계 ${total}회 · 예상 소요 약 ${Math.floor(sec / 60)}분 ${sec % 60}초`);
  process.exit(0);
}

if (!sites.length) {
  console.log('수집할 사이트가 없습니다. config.json 의 enabled 를 확인하세요.');
  process.exit(1);
}
if (!queries.length) {
  console.log('검색어가 없습니다. config.json 의 keywords.any 를 채우세요.');
  process.exit(1);
}

const limiter = new Limiter(cfg.rate);
const store = new Store(cfg.output.dir, { resume: cfg.output.resume });


const st = { req: 0, ok: 0, blocked: 0, robots: 0, fail: 0, parsed: 0, kept: 0, filtered: 0, old: 0, bodies: 0, bodyFail: 0 };
const notes = new Set();
// 목록에서 걸러낸 글. 본문은 목록을 다 훑은 뒤에 따로 받는다.
const pending = [];

// 브라우저는 '막혔을 때만' 쓰는 폴백이다. 그런데 예전엔 시작하자마자 무조건 띄웠고,
// Chrome 실행이 한 번 실패하면 (프로필 잠김, 업데이트 중 등) 수집 전체가 죽었다.
// curl 로 전부 되는 상황에서도 그랬다 (실측 2026-09-23). 그래서 실패해도 넘어간다 —
// 정말 필요해지는 순간 render() 가 알아서 띄우고, 그때 실패하면 그 요청 하나만 실패한다.
if (cfg.engine.mode !== 'http') {
  try {
    await launch(cfg.engine);
  } catch (e) {
    notes.add(`브라우저를 띄우지 못했습니다 — HTTP 로만 진행합니다 (${String(e.message ?? e).split('\n')[0]})`);
  }
}

async function fetchList(ad, site, board, q, page) {
  // q 가 null 이면 browse 모드 — 검색어 없이 게시판 목록만 받는다.
  const url = q === null ? ad.browseUrl(board, page) : ad.url(board, q, page);
  const g = await gate(url, site.robots ?? 'enforce');
  if (!g.go) {
    st.robots++;
    notes.add(`${ad.label}: robots 거부 — ${g.reason}`);
    return false;   // 요청 자체를 안 했다 — 실패(null)와 구분해서 '연속 실패' 로 세지 않는다
  }
  if (g.warn) {
    notes.add(`${ad.label}: robots 가 거부하지만 정책이 warn 이라 진행함 — ${g.warn}`);
  }

  await limiter.acquire(url, ad.crawlDelayMs);
  st.req++;
  let r;
  try {
    r = await grab(url, {
      charset: ad.charset,
      referer: ad.referer,
      waitFor: ad.waitFor,
      mode: cfg.engine.mode,
      timeout: cfg.engine.navigationTimeoutMs,
    });
  } finally {
    limiter.release(url);
  }

  const adj = limiter.report(url, { ok: r.ok, status: r.status });
  if (adj?.slowedTo) {
    notes.add(`${ad.label}: 차단 신호(HTTP ${r.status}) → 대기 ${Math.round(adj.slowedTo / 1000)}초로 늦춤`);
  }

  if (!r.ok) {
    st.fail++;
    if ([403, 405, 429, 503].includes(r.status)) st.blocked++;
    notes.add(`${ad.label}: ${r.err ?? 'HTTP ' + r.status} (${r.via})`);
    return null;
  }
  st.ok++;
  return { html: r.html, url, via: r.via };
}

// ── --probe : 한 번만 요청해서 진단 ──────────────────────────────────────
if (flag('probe')) {
  const id = flag('probe');
  const site = cfg.sites.find((s) => s.id === id);
  if (!site) { console.log(`config.json 에 '${id}' 사이트가 없습니다.`); process.exit(1); }
  const ad = ADAPTERS[id];
  // browse 모드면 검색어를 쓰지 않는다. 진단도 실제 수집과 같은 경로로 해야 의미가 있다.
  const q = site.listMode === 'browse' ? null : queries[0];
  console.log(`${ad.label} 진단 — ${q === null ? '목록 훑기 (검색 안 씀)' : `검색어 "${q}"`}\n`);
  const r = await fetchList(ad, site, site.boards[0], q, 1);
  if (!r) {
    console.log('가져오기 실패:');
    for (const n of notes) console.log('  ' + n);
    await close();
    process.exit(1);
  }
  console.log(`경로: ${r.via}   HTML ${r.html.length.toLocaleString()}바이트`);
  const posts = ad.parse(r.html, site.boards[0]);
  console.log(`파서가 뽑은 글: ${posts.length}건\n`);
  for (const p of posts.slice(0, 8)) {
    console.log(`  [${p.date || '날짜없음'}] ${p.title.slice(0, 60)}`);
  }
  if (!posts.length) {
    console.log('  → 0건입니다. 연결은 됐지만 파서가 안 맞습니다.');
    console.log(`    node crawl.mjs --probe ${id} --head  로 창을 띄워 실제 화면을 보세요.`);
  }
  saveCookies();
  await close();
  process.exit(0);
}

// ── 본 수집 ──────────────────────────────────────────────────────────────
let stop = false;
process.on('SIGINT', () => {
  console.log('\n중단 요청 — 지금까지 받은 것을 저장합니다.');
  stop = true;
});
// 웹 화면의 '중단' 은 stdin 으로 'stop' 을 보낸다. Windows 에서는 SIGINT 를 보내면
// 핸들러가 돌기 전에 프로세스가 죽어서, 몇 시간 모은 결과가 통째로 사라진다.
if (!process.stdin.isTTY) {
  process.stdin.on('data', (d) => {
    if (/stop/.test(String(d)) && !stop) {
      console.log('\n중단 요청 — 지금까지 받은 것을 저장합니다.');
      stop = true;
    }
  });
  process.stdin.on('error', () => {});
  process.stdin.unref?.();   // 수집이 끝났는데 stdin 때문에 프로세스가 안 끝나는 일을 막는다
}

// 시간 상한. GitHub Actions 는 timeout-minutes 를 넘기면 작업을 죽여서, 그때까지 받은 것도
// 저장·커밋되지 않는다 (실측 2026-09-25~10-02: 매일 30분에 cancelled, 결과 0).
// 상한이 되면 '중단' 과 똑같이 멈추고 저장한다. 차단 대기는 최대 5분이므로 여유를 두고 잡을 것.
const maxMin = Number(flag('max-minutes', 0));
if (maxMin > 0) {
  setTimeout(() => {
    if (stop) return;
    console.log(`
시간 상한 ${maxMin}분 — 지금까지 받은 것을 저장합니다.`);
    notes.add(`시간 상한 ${maxMin}분에 멈춤 — 다 못 돌았습니다`);
    stop = true;
  }, maxMin * 60_000).unref();
}

const since = cfg.filters.sinceDate ?? null;
const minLen = cfg.filters.minTitleLength ?? 0;
const maxPer = cfg.filters.maxPerSite ?? Infinity;

console.log(`사이트 ${sites.length} · 검색어 ${queries.length} · 페이지 ${cfg.engine.pagesPerQuery} · 모드 ${cfg.engine.mode}`);
console.log(`브라우저: ${cfg.engine.headless ? '헤드리스(창 없음)' : cfg.engine.offscreenWindow ? '창 띄우되 화면 밖' : '창 보임'}\n`);

// 사이트들은 동시에 돈다. 예전엔 한 곳씩 차례로 돌아서, 한 사이트가 차단 대기(429 → 수십 초)에
// 걸리면 나머지가 전부 그 뒤에 줄을 섰다 (실측 2026-10-01: 아카에서 3분 넘게 멈춤).
// 속도 제한은 호스트마다 따로 걸리므로(limiter) 동시에 돌아도 한 사이트에 몰리지 않는다.
await Promise.all(sites.map(crawlSite));

async function crawlSite(site) {
  const ad = ADAPTERS[site.id];
  let perSite = 0;
  // 사이트 전체에서 연속으로 못 받은 횟수. 검색어마다 새로 세면, 막힌 사이트를
  // 검색어 수만큼 계속 두드리며 매번 벌점 대기(최대 5분)를 치른다.
  let siteFailRun = 0;
  // browse 모드: 검색을 쓰지 않고 게시판 목록을 훑는다. 키워드는 받아온 제목에 적용한다.
  // 검색 경로를 robots.txt 가 막아둔 사이트(루리웹)를 규칙 안에서 수집하는 길이다.
  const browsing = site.listMode === 'browse';
  const qs = browsing ? [null] : queries;
  const pages = browsing ? (site.browsePages ?? cfg.engine.pagesPerQuery) : cfg.engine.pagesPerQuery;

  for (const board of site.boards) {
    for (const q of qs) {
      // '끝까지 찾기' 는 쪽수를 수백으로 준다. 결과가 그보다 먼저 끝나면 거기서 멈춘다:
      //   - 목록이 비었다            → 마지막 쪽을 넘었다
      //   - 이번 쪽 글을 이 검색에서 전부 이미 봤다 → 끝 쪽을 계속 다시 보여주는 사이트
      //   - 연속으로 3번 못 받았다    → 막혔거나 끊겼다. 남은 쪽도 안 될 것이다
      const seenHere = new Set();
      let failRun = 0;
      for (let page = 1; page <= pages; page++) {
        if (stop) return;
        if (perSite >= maxPer) break;

        const r = await fetchList(ad, site, board, q, page);
        process.stdout.write(`\r[${ad.label}/${board}] "${q ?? '목록 훑기'}" ${page}쪽 · 수집 ${st.kept} · 실패 ${st.fail} · robots차단 ${st.robots}          `);
        // robots 가 이 경로를 막았다 — 이 검색어의 다음 쪽도 같은 경로라 넘긴다.
        // 실패로 세면, 막힌 게시판 하나 때문에 멀쩡한 나머지 게시판까지 사이트째 빠진다.
        if (r === false) break;
        if (!r) {
          if (++siteFailRun >= 6) {
            notes.add(`${ad.label}: 연속 ${siteFailRun}번 실패 — 이 사이트는 이번 수집에서 뺌`);
            return;
          }
          if (++failRun >= 3) { notes.add(`${ad.label}/${board}: 연속 실패로 ${page}쪽에서 멈춤`); break; }
          continue;
        }
        failRun = 0;
        siteFailRun = 0;

        let posts = [];
        try {
          posts = ad.parse(r.html, board);
        } catch (e) {
          st.fail++;
          notes.add(`${ad.label}: 파서 오류 ${e.message}`);
          continue;
        }
        st.parsed += posts.length;
        if (!posts.length) break;
        const before = seenHere.size;
        for (const p of posts) seenHere.add(p.dedupKey ?? p.url);
        if (seenHere.size === before) break;

        for (const p of posts) {
          // 같은 URL 인데 회차가 다른 행사가 있다 (코엑스). 어댑터가 dedupKey 를 주면 그걸 쓴다.
          if (!store.reserve(p.dedupKey ?? p.url)) continue;
          if (p.title.length < minLen) { st.filtered++; continue; }
          if (since && p.date && p.date < since) { st.old++; continue; }
          // 목록이 본문 발췌를 함께 준 경우(디시 통합검색)에는 그것까지 보고 판정한다.
          //
          // 왜: 디시 통합검색은 본문을 뒤지므로 제목에 검색어가 없는 결과가 대부분이다.
          // 제목만 보고 거르면 25건 받아 21건을 버렸다 (실측 2026-09-24) — 디시에서
          // 사실상 아무것도 안 나오는 것처럼 보였다. 발췌는 이미 받아둔 것이라
          // 추가 요청도 들지 않는다. 발췌가 없는 사이트는 예전과 똑같이 제목만 본다.
          const v = matcher.test(p.body ? `${p.title} ${p.body}` : p.title);
          if (!v.pass) { st.filtered++; continue; }
          pending.push({
            // 파서가 board 를 직접 정하는 경우가 있다 — 디시 통합검색은 글마다
            // 갤러리가 달라서 파서가 갤러리 이름을 넣어준다. 설정값으로 덮으면
            // 그 정보가 통째로 사라진다 (실측: 갤러리 칸이 전부 빈칸으로 나왔다).
            site: site.id, board: p.board || board, date: p.date ?? '',
            query: q ?? '(목록훑기)', matched: v.matched, title: p.title, url: p.url,
            // 핫딜 게시판에만 있는 값. 없는 사이트에서는 빈칸으로 나간다.
            ...(p.price ? { price: p.price } : {}),
            ...(p.delivery ? { delivery: p.delivery } : {}),
            // 전시장 캘린더에만 있는 값 — 행사 기간과 장소.
            ...(p.dateEnd ? { dateEnd: p.dateEnd } : {}),
            ...(p.venue ? { venue: p.venue } : {}),
            // 검색 결과가 본문 발췌를 함께 주는 경우(디시 통합검색). 따로 받을 필요가 없다.
            ...(p.body ? { body: p.body } : {}),
          });
          st.kept++;
          perSite++;
        }
      }
    }
  }
}

// ── 본문 받기 ────────────────────────────────────────────────────────────
// 목록을 다 훑은 뒤에 한다. 목록 한 쪽당 글이 20개씩 나오므로, 본문까지 그때그때
// 받으면 요청이 20배로 튀어 사이트가 먼저 반응한다. 걸러낸 것만, 상한을 두고 받는다.
if (cfg.engine.fetchBody && pending.length && !stop) {
  const cap = cfg.engine.maxBodies ?? 200;
  // 그냥 앞에서 N개를 자르면 먼저 수집된 사이트가 상한을 독식한다
  // (실측: 120건 전부 뽐뿌였고, 그 사이트 추출기가 깨져 있어서 전멸했다).
  // 사이트별로 한 개씩 번갈아 뽑아 어디가 되고 어디가 안 되는지 함께 드러나게 한다.
  const byId = new Map();
  for (const r of pending) {
    if (!byId.has(r.site)) byId.set(r.site, []);
    byId.get(r.site).push(r);
  }
  const targets = [];
  for (let i = 0; targets.length < cap; i++) {
    let added = false;
    for (const list of byId.values()) {
      if (i < list.length && targets.length < cap) { targets.push(list[i]); added = true; }
    }
    if (!added) break;
  }
  console.log(`\n\n본문 ${targets.length}건 받는 중 (전체 ${pending.length}건 중)...`);

  for (let i = 0; i < targets.length; i++) {
    if (stop) break;
    const row = targets[i];
    const ad = ADAPTERS[row.site];
    const site = sites.find((s) => s.id === row.site);
    if (!ad?.body) { notes.add(`${ad?.label ?? row.site}: 본문 추출기가 없습니다`); continue; }

    const g = await gate(row.url, site?.robots ?? 'enforce');
    if (!g.go) { st.robots++; continue; }

    await limiter.acquire(row.url, ad.crawlDelayMs);
    st.req++;
    let r;
    try {
      r = await grab(row.url, {
        charset: ad.charset, referer: ad.referer,
        mode: cfg.engine.mode, timeout: cfg.engine.navigationTimeoutMs,
      });
    } finally { limiter.release(row.url); }

    limiter.report(row.url, { ok: r.ok, status: r.status });
    if (!r.ok) { st.bodyFail++; notes.add(`${ad.label} 본문: ${r.err ?? 'HTTP ' + r.status}`); }
    else {
      try {
        row.body = ad.body(r.html);
        if (row.body) st.bodies++; else st.bodyFail++;
      } catch (e) { st.bodyFail++; notes.add(`${ad.label} 본문 추출 오류: ${e.message}`); }
    }
    process.stdout.write(`\r  ${i + 1}/${targets.length} · 성공 ${st.bodies} · 실패 ${st.bodyFail}      `);
  }
  console.log('');
}

for (const row of pending) store.add(row);

saveCookies();
await close();
const res = store.flush();

console.log('\n\n── 결과 ──────────────────────────────────');
console.log(`요청 ${st.req} (성공 ${st.ok} / 실패 ${st.fail} / 차단응답 ${st.blocked} / robots거부 ${st.robots})`);
console.log(`목록에서 읽은 글 ${st.parsed} → 중복 ${store.skippedDup} · 키워드탈락 ${st.filtered} · 기간밖 ${st.old} 제외`);
if (cfg.engine.fetchBody) console.log(`본문 확보 ${st.bodies}건 (실패 ${st.bodyFail})`);
console.log(`저장 ${res.count}건`);
console.log(`   ${res.csv}`);
console.log(`   ${res.jsonl}`);

console.log('\n── 호스트별 ──────────────────────────────');
for (const [h, s] of Object.entries(limiter.summary())) {
  console.log(`${h.padEnd(26)} 요청 ${String(s.sent).padStart(4)} · 차단 ${s.blocked} · 대기 ${s.waitedSec}초${s.penaltyMs ? ` · 현재 벌점 ${Math.round(s.penaltyMs / 1000)}초` : ''}`);
}

if (notes.size) {
  console.log('\n── 알림 ──────────────────────────────────');
  for (const n of notes) console.log('  ' + n);
}
