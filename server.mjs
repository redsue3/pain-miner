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
import { join, extname, resolve, normalize, sep } from 'node:path';
import { ADAPTERS } from './adapters/index.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const TOKEN = process.env.TOKEN ?? '';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  console.error('외부에 열려면 TOKEN 을 지정해야 합니다:');
  console.error('  HOST=0.0.0.0 TOKEN=$(openssl rand -hex 16) node server.mjs');
  process.exit(1);
}

const WEB = resolve('./web');
const SEARCHES = resolve('./out/searches');
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
function buildConfig(opt) {
  const words = String(opt.q ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  // opt.boards = { 사이트id: [게시판id, …] }. 없으면 그 사이트의 기본값을 쓴다.
  const picked = Array.isArray(opt.sites) && opt.sites.length ? opt.sites : Object.keys(CATALOG);
  const sites = [];
  for (const id of picked) {
    if (!ADAPTERS[id] || !CATALOG[id]) continue;
    const boards = validBoards(id, opt.boards?.[id]);
    if (!boards.length) continue;
    sites.push({
      id, enabled: true, robots: 'enforce', boards,
      // 목록 훑기로 도는 곳(루리웹)은 검색어를 안 쓰므로 쪽수를 따로 준다.
      ...(CATALOG[id].browse ? { listMode: 'browse', browsePages: 2 } : {}),
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
    filters: { sinceDate: opt.since || null, minTitleLength: 3, maxPerSite: 300 },
    engine: {
      mode: 'auto',
      pagesPerQuery: Math.min(Math.max(1, Number(opt.pages) || 1), 5),
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

function startSearch(opt) {
  const cfg = buildConfig(opt);
  if (!cfg.keywords.any.length) throw new Error('검색어를 넣으세요');
  if (!cfg.sites.length) throw new Error('찾을 곳을 하나 이상 고르세요');

  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    + '-' + Math.random().toString(36).slice(2, 6);
  const dir = searchDir(id);
  mkdirSync(dir, { recursive: true });

  // 검색은 '지금 뭐가 있나' 를 보는 것이므로 매번 처음부터 찾는다.
  cfg.output = { dir: dir.replace(/\\/g, '/'), resume: false };
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    q: cfg.keywords.any.join(', '),
    at: new Date().toISOString(),
    sites: cfg.sites.map((s) => s.id),
    count: 0,
  }, null, 2), 'utf8');

  const proc = spawn(process.execPath, ['crawl.mjs', '--config', cfgPath], { cwd: resolve('.') });
  job = {
    id, q: cfg.keywords.any.join(', '), proc, lines: [], done: false, code: null,
    listeners: new Set(), startedAt: Date.now(), found: 0, where: '',
  };

  const push = (text) => {
    // crawl.mjs 는 진행 상황을 \r 로 덮어쓴다. 줄로 쪼개 마지막 것만 본다.
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.split('\r').pop().trimEnd();
      if (!line) continue;
      job.lines.push(line);
      if (job.lines.length > 2000) job.lines.shift();
      // "지금 어디를 뒤지는 중이고 몇 건 찾았는지" 를 그대로 화면으로 보낸다.
      const m = line.match(/^\[([^\]]+)\]\s*"([^"]*)"\s*(\d+)쪽 · 수집 (\d+)/);
      if (m) {
        job.found = Number(m[4]);
        job.where = m[1];
        for (const l of job.listeners) l({ type: 'at', where: m[1], q: m[2], page: +m[3], found: job.found });
      }
      for (const l of job.listeners) l({ type: 'line', line });
    }
  };
  proc.stdout.on('data', (d) => push(d.toString('utf8')));
  proc.stderr.on('data', (d) => push(d.toString('utf8')));

  const finish = (code) => {
    job.done = true; job.code = code;
    const rows = readRows(id);
    try {
      const mp = join(dir, 'meta.json');
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      m.count = rows.length;
      writeFileSync(mp, JSON.stringify(m, null, 2), 'utf8');
    } catch { /* 기록 실패가 검색을 무효로 만들지는 않는다 */ }
    for (const l of job.listeners) l({ type: 'done', code, id, count: rows.length });
  };
  proc.on('close', finish);
  proc.on('error', (e) => { push(`실행 실패: ${e.message}`); finish(-1); });

  return id;
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
      job.proc.kill('SIGINT');
      return sendJson(res, 200, { ok: true });
    }

    if (path === '/api/stream') {
      if (!job) return sendJson(res, 404, { error: '찾고 있는 것이 없습니다' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache', Connection: 'keep-alive',
      });
      const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      for (const line of job.lines) send({ type: 'line', line });
      if (job.done) {
        send({ type: 'done', code: job.code, id: job.id, count: readRows(job.id).length });
        return res.end();
      }
      job.listeners.add(send);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { job?.listeners.delete(send); clearInterval(ping); });
      return;
    }

    if (path === '/api/results') {
      const id = url.searchParams.get('id') ?? '';
      const dir = searchDir(id);
      if (!dir || !existsSync(dir)) return sendJson(res, 404, { error: '없는 검색입니다' });
      let meta = {};
      try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { /* 기본값 */ }
      return sendJson(res, 200, { id, q: meta.q ?? '', at: meta.at ?? '', rows: readRows(id) });
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
