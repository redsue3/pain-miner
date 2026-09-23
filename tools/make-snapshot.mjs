// make-snapshot.mjs — 주제별 수집 결과를 임시 웹페이지용 JSON 으로 묶는다.
//
//   node tools/make-snapshot.mjs > snapshot.json
//
// 내보낸 값은 전부 results.jsonl 에서 그대로 온다. 여기서 새로 만드는 값은 없다.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TOPICS = './out/topics';
const out = { madeAt: new Date().toISOString(), topics: [] };

for (const d of readdirSync(TOPICS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = join(TOPICS, d.name);
  const jl = join(dir, 'results.jsonl');
  if (!existsSync(jl)) continue;

  let meta = {};
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); } catch { /* 기본값 */ }

  const rows = readFileSync(jl, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    // 페이지가 무거워지지 않게 본문은 앞부분만 싣는다. 전문은 JSONL 에 그대로 있다.
    .map((r) => ({
      site: r.site, board: r.board, date: r.date ?? '', dateEnd: r.dateEnd ?? '',
      title: r.title, url: r.url, price: r.price ?? '', venue: r.venue ?? '',
      body: r.body ? r.body.slice(0, 260) : '',
      matched: r.matched ?? [],
    }));

  if (!rows.length) continue;
  out.topics.push({
    id: d.name,
    name: meta.name ?? d.name,
    lastRunAt: meta.lastRunAt ?? null,
    rows,
  });
}

out.topics.sort((a, b) => b.rows.length - a.rows.length);
process.stdout.write(JSON.stringify(out));
