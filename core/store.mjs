// core/store.mjs — 결과 저장, 중복 제거, 이어서 수집
//
// resume 이 켜져 있으면 이미 본 글의 URL 해시를 out/seen.json 에 남긴다.
// 다음 실행 때 그 글은 건너뛴다. 매일 돌려서 '새로 올라온 것만' 받을 수 있고,
// 같은 글을 다시 요청하지 않으니 사이트 부담도 준다.

import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export class Store {
  constructor(dir, { resume = true } = {}) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.seenPath = join(dir, 'seen.json');
    this.jsonlPath = join(dir, 'results.jsonl');
    this.csvPath = join(dir, 'results.csv');
    this.resume = resume;

    this.seen = new Set();
    if (resume && existsSync(this.seenPath)) {
      try { this.seen = new Set(JSON.parse(readFileSync(this.seenPath, 'utf8'))); }
      catch { /* 깨졌으면 처음부터 */ }
    }
    this.sessionSeen = new Set();
    this.rows = [];
    this.skippedDup = 0;
  }

  /** 이미 수집한 글인가 (이전 실행 포함). 확인만 하고 표시하지 않는다. */
  isNew(url) {
    const k = sha(url);
    if (this.seen.has(k) || this.sessionSeen.has(k)) { this.skippedDup++; return false; }
    return true;
  }

  /**
   * 수집 대상으로 찜한다. 확인과 동시에 표시까지 한다.
   *
   * 왜 따로 있나 (2026-09-23): 본문을 나중에 받도록 2단계로 바꾸면서 add() 가
   * 수집이 다 끝난 뒤에야 불리게 됐다. 그 사이에는 아무것도 '봤다'고 표시되지 않아
   * 같은 글이 검색어마다 계속 통과했고, 결과 파일에 중복이 남았다
   * (실측: games 84행 중 5행이 같은 URL). 목록을 훑는 단계에서는 이걸 쓴다.
   */
  reserve(url) {
    const k = sha(url);
    if (this.seen.has(k) || this.sessionSeen.has(k)) { this.skippedDup++; return false; }
    this.sessionSeen.add(k);
    return true;
  }

  add(row) {
    const k = sha(row.url);
    this.sessionSeen.add(k);
    this.seen.add(k);
    const rec = { ...row, id: k, fetchedAt: new Date().toISOString() };
    this.rows.push(rec);
    appendFileSync(this.jsonlPath, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  flush() {
    if (this.resume) {
      writeFileSync(this.seenPath, JSON.stringify([...this.seen]), 'utf8');
    }
    const H = ['id', 'site', 'board', 'date', 'dateEnd', 'venue', 'query', 'matched', 'title', 'price', 'delivery', 'url', 'body', 'fetchedAt'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // CSV 의 본문은 엑셀에서 셀이 터지지 않게 줄인다. 전문은 JSONL 에 그대로 있다.
    const short = (r, h) => (h === 'body' && r.body ? r.body.slice(0, 500) : r[h]);
    const body = this.rows
      .map((r) => H.map((h) => cell(Array.isArray(r[h]) ? r[h].join('|') : short(r, h))).join(','))
      .join('\n');
    // BOM 을 붙여야 엑셀에서 한글이 안 깨진다.
    writeFileSync(this.csvPath, '﻿' + H.join(',') + '\n' + body, 'utf8');
    return { csv: this.csvPath, jsonl: this.jsonlPath, count: this.rows.length };
  }
}
