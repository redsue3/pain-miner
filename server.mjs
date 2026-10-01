// server.mjs — 커뮤니티 검색 서버
//
//   node server.mjs                      http://127.0.0.1:8787
//   PORT=8080 node server.mjs
//   HOST=0.0.0.0 TOKEN=비밀번호 node server.mjs    외부 공개 (VPS 배포용)
//
// ── 무엇을 위한 화면인가 ─────────────────────────────────────────────────
// 검색창에 말을 치면 그때 커뮤니티들을 돌아 관련 글을 찾아온다. 그게 전부다.
// 미리 등록해둔 주제를 쌓아보는 게 아니라, 궁금할 때 쳐서 지금 찾는 것이다.
//
// 검색 한 번이 폴더 하나로 남는다 (다시 보려고):
//   out/searches/<id>/config.json    그때 쓴 설정
//   out/searches/<id>/meta.json      검색어, 시각, 건수
//   out/searches/<id>/results.jsonl  찾은 글
//
// ── 설계 원칙 ────────────────────────────────────────────────────────────
// 수집 로직을 여기 새로 쓰지 않는다. crawl.mjs 를 그대로 실행한다.
// 웹에서 돌린 결과와 터미널에서 돌린 결과가 다르면 둘 다 못 믿게 되기 때문이다.
//
// ── 공개할 때 ────────────────────────────────────────────────────────────
// TOKEN 이 없으면 127.0.0.1 에만 붙는다. HOST 를 열려면 TOKEN 이 필수다.
// 이 서버가 열리면 누구든 내 서버에서 남의 사이트로 요청을 날릴 수 있기 때문이다.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync,
} from 'node:fs';
import { join, extname, resolve, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './adapters/index.mjs';
import { propose, review } from './core/expand.mjs';
import { tagRow, TAGS, OTHER } from './core/tags.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const TOKEN = process.env.TOKEN ?? '';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  console.error('외부에 열려면 TOKEN 을 지정해야 합니다:');
  console.error('  HOST=0.0.0.0 TOKEN=$(openssl rand -hex 16) node server.mjs');
  process.exit(1);
}

// 실행한 폴더가 아니라 이 파일이 있는 폴더 기준. 다른 폴더에서 켜면 화면이 404 였다.
const ROOT = dirname(fileURLToPath(import.meta.url));
const WEB = join(ROOT, 'web');
const SEARCHES = join(ROOT, 'out', 'searches');
mkdirSync(SEARCHES, { recursive: true });

// 검색은 한 번에 하나만. 여러 개를 동시에 돌리면 같은 사이트로 요청이 몰려 차단당한다.
let job = null;

// 커뮤니티별로 어디를 뒤질 수 있는지. 여기 있는 게시판은 전부 실제로 열어 확인한 것이다
// (2026-09-24). 없는 게시판을 넣으면 요청만 버리고 결과가 0건으로 보인다.
//
// 디시와 아카는 '사이트 전체 검색' 을 쓴다. 갤러리·채널 하나만 뒤지면
// 유동량이 가장 많은 두 곳인데도 몇 건 안 나온다 (실측: 디시 programming 갤만 보니
// 개드립 20건 나올 때 4건이었다). 전체 검색은 수천 개 갤러리를 한 번에 본다.
//
// on: true 인 것이 기본으로 켜진다. 너무 많이 켜면 검색이 느려지므로 적게 잡았다.
const CATALOG = {
  dcsearch: {
    wide: true,
    boards: [{ id: '', name: '전체 갤러리', on: true }],
  },
  arca: {
    wide: true,
    boards: [
      { id: 'breaking', name: '전체 채널', on: true },
      { id: 'hotdeal', name: '핫딜' },
      { id: 'live', name: '베스트' },
    ],
  },
  ppomppu: {
    boards: [
      { id: 'ppomppu', name: '뽐뿌게시판', on: true },
      { id: 'freeboard', name: '자유게시판', on: true },
      { id: 'ppomppu4', name: '해외뽐뿌' },
      { id: 'computer', name: '컴퓨터' },
      { id: 'game', name: '게임' },
      { id: 'car', name: '자동차' },
      { id: 'humor', name: '유머' },
      { id: 'baby', name: '육아' },
    ],
  },
  dogdrip: {
    // 개드립은 게시판이 아니라 '어디까지 뒤질지' 를 고른다.
    boards: [
      { id: 'title', name: '제목', on: true },
      { id: 'title_content', name: '제목+본문' },
    ],
  },
  ruliweb: {
    // robots.txt 가 검색 경로를 막아서 목록을 훑는다. 그래서 게시판을 골라야 의미가 있다.
    browse: true,
    boards: [
      { id: 'market/board/1020', name: '핫딜·예판', on: true },
      { id: 'community/board/300143', name: '유머', on: true },
      { id: 'community/board/300136', name: '아케이드 게임' },
      { id: 'community/board/300146', name: '명대사' },
    ],
  },
};

// '끝까지 찾기' 의 쪽수 상한. 실제 끝은 crawl.mjs 가 판단한다
// (빈 쪽·같은 쪽 반복·연속 실패에서 멈춤). 이 값은 안전장치일 뿐이다 —
// 디시 '불편' 검색은 40쪽이 넘게 이어졌다 (실측 2026-10-01).
const DEEP_PAGES = 300;

const defaultBoards = (id) =>
  (CATALOG[id]?.boards ?? []).filter((b) => b.on).map((b) => b.id);

const validBoards = (id, wanted) => {
  const all = new Set((CATALOG[id]?.boards ?? []).map((b) => b.id));
  const picked = (wanted ?? []).filter((b) => all.has(b));
  return picked.length ? picked : defaultBoards(id);
};

/**
 * 검색 폴더 경로. 안전하지 않으면 null.
 * id 에 '../' 를 넣어 폴더 밖을 건드리는 걸 두 겹으로 막는다 —
 * 예전 주제 삭제에서 실제로 바깥 디렉터리가 지워졌다 (2026-09-23 실측).
 */
function searchDir(id) {
  const s = String(id ?? '');
  if (!s || s.length > 60) return null;
  if (/[\\/]/.test(s) || s.includes('..') || s.startsWith('.')) return null;
  const full = resolve(join(SEARCHES, s));
  if (full !== SEARCHES && !full.startsWith(SEARCHES + sep)) return null;
  return full;
}

function readRows(id) {
  const dir = searchDir(id);
  if (!dir) return [];
  const f = join(dir, 'results.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function history(limit = 40) {
  return readdirSync(SEARCHES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SEARCHES, d.name, 'meta.json')))
    .map((d) => {
      try {
        const m = JSON.parse(readFileSync(join(SEARCHES, d.name, 'meta.json'), 'utf8'));
        return { id: d.name, q: m.q ?? '', at: m.at ?? '', count: m.count ?? 0, sites: m.sites ?? [] };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

/** 검색어와 옵션으로 crawl.mjs 설정을 만든다. */
const splitWords = (q) => String(q ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

function buildConfig(opt, words = splitWords(opt.q)) {
  // opt.boards = { 사이트id: [게시판id, …] }. 없으면 그 사이트의 기본값을 쓴다.
  const picked = Array.isArray(opt.sites) && opt.sites.length ? opt.sites : Object.keys(CATALOG);
  // deep = '끝까지 찾기'. 시간이 얼마나 걸리든 결과가 바닥날 때까지 쪽을 넘긴다.
  const deep = !!opt.deep;
  const sites = [];
  for (const id of picked) {
    if (!ADAPTERS[id] || !CATALOG[id]) continue;
    let boards = validBoards(id, opt.boards?.[id]);
    // 개드립 '제목+본문' 은 '제목' 을 포함한다. 둘 다 돌리면 같은 글을 두 번 받으러 간다
    // — 끝까지 찾기에서는 그게 수백 번의 헛요청이 된다.
    if (id === 'dogdrip' && boards.includes('title_content')) boards = ['title_content'];
    if (!boards.length) continue;
    sites.push({
      id, enabled: true, robots: 'enforce', boards,
      // 목록 훑기로 도는 곳(루리웹)은 검색어를 안 쓰므로 쪽수를 따로 준다.
      ...(CATALOG[id].browse ? { listMode: 'browse', browsePages: deep ? DEEP_PAGES : 2 } : {}),
    });
  }
  const bodies = Math.min(Math.max(0, Number(opt.bodies) || 0), 60);
  return {
    keywords: {
      // 검색창에 넣는 말이자, 제목에서 확인할 말이다.
      // '포함할 말' 을 따로 두지 않는다 — 검색창 하나로 끝나야 검색답다.
      any: words, all: [], none: [], regex: [],
      searchQueries: { use: words },
    },
    filters: { sinceDate: opt.since || null, minTitleLength: 3, maxPerSite: deep ? 50000 : 300 },
    engine: {
      mode: 'auto',
      pagesPerQuery: deep ? DEEP_PAGES : Math.min(Math.max(1, Number(opt.pages) || 1), 5),
      headless: true, offscreenWindow: false, keepSession: true, navigationTimeoutMs: 25000,
      fetchBody: bodies > 0, maxBodies: bodies,
    },
    rate: {
      minDelayMs: Math.max(800, Number(opt.delay) || 1200),
      jitterMs: 600, perHostConcurrency: 1,
      backoff: { startMs: 8000, factor: 2, maxMs: 300000, recoverAfterOk: 8 },
    },
    sites,
  };
}

/**
 * 검색 하나 = 세 단계.
 *   1차  Claude 가 비슷한 말 후보를 뽑는다
 *   2차  Claude 가 새로 불려 후보를 하나씩 검수한다
 *   3차  원래 검색어 + 통과한 말로 crawl.mjs 를 돌린다
 * 1·2차가 실패하면 원래 검색어만으로 3차를 한다 — 검색 자체를 못 하게 만들지 않는다.
 *
 * 화면에 보내는 것 중 '단계'·'찾은 글' 은 job.events 에 쌓아둔다.
 * 새로고침하거나 늦게 붙은 화면도 처음부터 같은 그림을 다시 그릴 수 있어야 한다.
 */
function startSearch(opt) {
  const words = splitWords(opt.q);
  if (!words.length) throw new Error('검색어를 넣으세요');
  if (!buildConfig(opt, words).sites.length) throw new Error('찾을 곳을 하나 이상 고르세요');

  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    + '-' + Math.random().toString(36).slice(2, 6);
  const dir = searchDir(id);
  mkdirSync(dir, { recursive: true });

  job = {
    id, q: words.join(', '), proc: null, lines: [], events: [], done: false, code: null,
    listeners: new Set(), startedAt: Date.now(), found: 0, where: '', cancelled: false,
  };
  const me = job;
  const emit = (ev, keep = true) => {
    if (keep) me.events.push(ev);
    for (const l of me.listeners) l(ev);
  };

  const finish = (code) => {
    if (me.done) return;
    me.done = true; me.code = code;
    const rows = readRows(id);
    try {
      const mp = join(dir, 'meta.json');
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      m.count = rows.length;
      writeFileSync(mp, JSON.stringify(m, null, 2), 'utf8');
    } catch { /* 기록 실패가 검색을 무효로 만들지는 않는다 */ }
    emit({ type: 'done', code, id, count: rows.length }, false);
  };

  const writeMeta = (all, expansion) => writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    q: words.join(', '), words: all, expansion,
    at: new Date().toISOString(),
    sites: buildConfig(opt, all).sites.map((s) => s.id),
    deep: !!opt.deep,
    count: 0,
  }, null, 2), 'utf8');
  writeMeta(words, null);

  (async () => {
    let all = words;
    let expansion = null;
    if (opt.expand) {
      try {
        emit({ type: 'stage', stage: 1, text: 'Claude 가 비슷한 말을 찾는 중' });
        const cands = await propose(words);
        emit({ type: 'candidates', words: cands });
        if (me.cancelled) return finish(130);
        emit({ type: 'stage', stage: 2, text: `후보 ${cands.length}개를 검수하는 중` });
        const r = await review(words, cands);
        expansion = { candidates: cands, ...r };
        emit({ type: 'reviewed', keep: r.keep, drop: r.drop });
        all = [...words, ...r.keep.map((x) => x.word)];
      } catch (e) {
        emit({ type: 'warn', text: `비슷한 말 찾기 실패 — 원래 검색어로만 찾습니다 (${e.message})` });
      }
      if (me.cancelled) return finish(130);
    }
    writeMeta(all, expansion);
    emit({ type: 'stage', stage: 3, text: '커뮤니티를 뒤지는 중', words: all });
    runCrawl(me, opt, all, dir, emit, finish);
  })().catch((e) => { emit({ type: 'warn', text: e.message }); finish(-1); });

  return id;
}

function runCrawl(me, opt, words, dir, emit, finish) {
  const cfg = buildConfig(opt, words);
  // 검색은 '지금 뭐가 있나' 를 보는 것이므로 매번 처음부터 찾는다.
  cfg.output = { dir: dir.replace(/\\/g, '/'), resume: false };
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');

  const proc = spawn(process.execPath, ['crawl.mjs', '--config', cfgPath], { cwd: ROOT });
  me.proc = proc;

  // 데이터 조각은 줄 중간에서 끊겨 온다. 마지막 줄 끝 표시 뒤는 다음 조각과 이어 붙인다.
  // crawl.mjs 는 진행 상황을 \n 없이 \r 로만 덮어쓰므로 \r 도 줄 끝으로 본다 —
  // \n 만 기다리면 진행 표시가 검색이 끝날 때까지 한 번도 안 온다 (실측 2026-10-01).
  const tail = { out: '', err: '' };
  const push = (text, which) => {
    const parts = (tail[which] + text).split(/\r\n|\n|\r/);
    tail[which] = parts.pop();
    for (const raw of parts) {
      const line = raw.trimEnd();
      if (!line) continue;
      me.lines.push(line);
      if (me.lines.length > 2000) me.lines.shift();
      // "지금 어디를 뒤지는 중이고 몇 건 찾았는지" 를 그대로 화면으로 보낸다.
      const m = line.match(/^\[([^\]]+)\]\s*"([^"]*)"\s*(\d+)쪽 · 수집 (\d+)/);
      if (m) {
        me.found = Number(m[4]);
        me.where = m[1];
        emit({ type: 'at', where: m[1], q: m[2], page: +m[3], found: me.found }, false);
      }
      emit({ type: 'line', line }, false);
    }
  };
  // 한글이 조각 경계에서 잘려 깨지지 않게 스트림 단에서 UTF-8 로 읽는다.
  proc.stdout.setEncoding('utf8').on('data', (d) => push(d, 'out'));
  proc.stderr.setEncoding('utf8').on('data', (d) => push(d, 'err'));
  proc.on('close', (code) => {
    push('\n', 'out'); push('\n', 'err');
    finish(code);
  });
  proc.on('error', (e) => { push(`실행 실패: ${e.message}\n`, 'err'); finish(-1); });
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
const sendJson = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};
function readBody(req, limit = 256 * 1024) {
  return new Promise((ok, bad) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { bad(new Error('요청이 너무 큽니다')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', bad);
  });
}
const authed = (req, url) => !TOKEN
  || (req.headers.authorization ?? '') === `Bearer ${TOKEN}`
  || url.searchParams.get('token') === TOKEN;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  if (!authed(req, url)) return sendJson(res, 401, { error: '토큰이 필요합니다' });

  try {
    if (req.method === 'GET' && !path.startsWith('/api/')) {
      const rel = path === '/' ? 'index.html' : path.replace(/^\//, '');
      const full = normalize(join(WEB, rel));
      if (!full.startsWith(WEB) || !existsSync(full)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('없는 페이지입니다');
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
      return res.end(readFileSync(full));
    }

    if (path === '/api/sites') {
      return sendJson(res, 200, {
        sites: Object.values(ADAPTERS)
          .filter((a) => !a.futureDates && CATALOG[a.id])   // 전시장 달력은 검색 대상이 아니다
          .map((a) => ({
            id: a.id, label: a.label,
            wide: !!CATALOG[a.id].wide,      // 사이트 전체를 뒤지는 곳
            boards: CATALOG[a.id].boards.map((b) => ({ id: b.id, name: b.name, on: !!b.on })),
          })),
      });
    }

    if (path === '/api/search' && req.method === 'POST') {
      if (job && !job.done) return sendJson(res, 409, { error: '이미 찾고 있습니다', id: job.id });
      let opt;
      try { opt = JSON.parse(await readBody(req)); }
      catch (e) { return sendJson(res, 400, { error: '요청을 읽지 못했습니다: ' + e.message }); }
      try { return sendJson(res, 200, { id: startSearch(opt) }); }
      catch (e) { return sendJson(res, 400, { error: String(e.message ?? e) }); }
    }

    if (path === '/api/search' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      const dir = searchDir(id);
      if (!dir || !existsSync(dir)) return sendJson(res, 404, { error: '없는 검색입니다' });
      if (job && !job.done && job.id === id) return sendJson(res, 409, { error: '찾는 중인 검색은 지울 수 없습니다' });
      rmSync(dir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/stop' && req.method === 'POST') {
      if (!job || job.done) return sendJson(res, 404, { error: '찾고 있는 것이 없습니다' });
      // Windows 에서 SIGINT 는 그냥 죽인다 — 모은 결과가 저장되지 않는다.
      // stdin 으로 'stop' 을 보내 crawl.mjs 가 스스로 저장하고 끝내게 한다.
      // 그래도 안 끝나면 2분 뒤 강제로 끈다 (차단 대기 중이면 그만큼 걸릴 수 있다).
      job.cancelled = true;
      const p = job.proc;
      // 아직 비슷한 말을 찾는 중이면 crawl.mjs 가 없다. 그 단계가 끝나는 대로 멈춘다.
      if (!p) return sendJson(res, 200, { ok: true });
      try { p.stdin.write('stop\n'); } catch { p.kill('SIGINT'); }
      setTimeout(() => { if (p.exitCode === null) p.kill('SIGINT'); }, 120000).unref();
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/stream') {
      if (!job) return sendJson(res, 404, { error: '찾고 있는 것이 없습니다' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive',
      });
      const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const j = job;
      // 단계·찾은 글을 먼저 다시 보내고, 그 다음 기록. 늦게 붙어도 같은 화면이 된다.
      for (const ev of j.events) send(ev);
      for (const line of j.lines) send({ type: 'line', line });
      if (j.done) {
        send({ type: 'done', code: j.code, id: j.id, count: readRows(j.id).length });
        return res.end();
      }
      j.listeners.add(send);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { j.listeners.delete(send); clearInterval(ping); });
      return;
    }

    if (path === '/api/results') {
      const id = url.searchParams.get('id') ?? '';
      const dir = searchDir(id);
      if (!dir || !existsSync(dir)) return sendJson(res, 404, { error: '없는 검색입니다' });
      let meta = {};
      try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { /* 기본값 */ }
      return sendJson(res, 200, {
        id, q: meta.q ?? '', at: meta.at ?? '',
        // 태그는 저장하지 않고 볼 때마다 붙인다. 규칙을 고치면 지난 검색에도 바로 반영된다.
        rows: readRows(id).map((r) => ({ ...r, tags: tagRow(r) })),
        tagOrder: [...TAGS, OTHER],
        words: meta.words ?? null, expansion: meta.expansion ?? null,
      });
    }

    if (path === '/api/history') {
      return sendJson(res, 200, { searches: history(), running: job && !job.done ? job.id : null });
    }

    if (path === '/api/status') {
      return sendJson(res, 200, job
        ? { running: !job.done, id: job.id, q: job.q, found: job.found, where: job.where,
            elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) }
        : { running: false });
    }

    return sendJson(res, 404, { error: '없는 경로입니다' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`커뮤니티 검색  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (TOKEN) console.log('토큰이 필요합니다 (?token=...)');
  else console.log('내 PC 에서만 열립니다 (외부 공개하려면 HOST 와 TOKEN 을 주세요)');
});
