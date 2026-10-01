// core/expand.mjs — 검색어를 '비슷한 말' 로 넓힌다. 두 단계다.
//
//   1차  Claude 가 후보를 뽑는다     (커뮤니티 사람들이 실제로 쓰는 표현)
//   2차  Claude 가 따로 검수한다     (뜻이 정말 같은지 하나씩 판정 — 1차 답을 모르는 새 호출)
//
// 왜 두 번인가: 한 번에 '비슷한 말' 을 뽑게 하면 연상어가 섞인다 ("불편" → "개선", "후기").
// 그런 말로 커뮤니티를 뒤지면 엉뚱한 글이 수백 건 쌓인다. 뽑는 쪽과 거르는 쪽을 나눠야
// 거르는 쪽이 자기 답을 변호하지 않는다.
//
// 로그인된 Claude Code(claude -p)를 그대로 쓴다 — API 키가 따로 필요 없다.
// --safe-mode 는 훅을 끈다. 안 끄면 검색할 때마다 회의록 훅이 돌아 Jira·GitHub 에 올라간다.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const MODEL = process.env.PAIN_MINER_MODEL || 'sonnet';
// 검수를 통과한 말이 이보다 많으면 자른다. 말 하나가 늘 때마다 사이트 × 쪽수만큼 요청이 는다.
export const MAX_EXTRA = 10;

// Claude Code 안에서 서버를 켰으면 그 세션 변수가 묻어온다. 자식 claude 가 헷갈리지 않게 지운다.
const PARENT_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

function claudePath() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(local) ? local : 'claude';
}

function ask(prompt, timeoutMs = 3 * 60 * 1000) {
  return new Promise((ok, bad) => {
    const args = ['-p', '--safe-mode', '--output-format', 'json', '--tools', '',
      '--no-session-persistence', '--model', MODEL];
    const env = { ...process.env, MEETING_MINUTES_CHILD: '1' };
    for (const k of PARENT_SESSION_VARS) delete env[k];
    // 이 폴더의 파일을 읽을 일이 없다. 빈 곳에서 돌린다.
    const child = spawn(claudePath(), args, { cwd: tmpdir(), windowsHide: true, env });
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); bad(new Error('Claude 응답 시간 초과')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); bad(new Error('Claude 실행 실패: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j;
      try { j = JSON.parse(out); } catch {
        return bad(new Error(`Claude 출력을 읽을 수 없음 (코드 ${code}): ${(err || out).slice(0, 200)}`));
      }
      if (code !== 0 || j.is_error) return bad(new Error(`Claude 오류: ${String(j.result ?? err).slice(0, 200)}`));
      ok(String(j.result ?? ''));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function json(text) {
  const s = String(text).replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Claude 답에 JSON 이 없습니다');
  return JSON.parse(s.slice(a, b + 1));
}

const tidy = (w) => String(w ?? '').replace(/\s+/g, ' ').trim();
const key = (w) => tidy(w).toLowerCase().replace(/\s+/g, '');

/** 1차: 후보 뽑기 */
export async function propose(words) {
  const prompt = `한국 인터넷 커뮤니티(디시인사이드, 아카라이브, 뽐뿌, 개드립, 루리웹)에서 글을 검색하려고 한다.
사용자가 넣은 검색어: ${words.map((w) => `"${w}"`).join(', ')}

이 검색어와 **같은 뜻**으로 사람들이 실제 글 제목이나 본문에 쓰는 다른 표현을 15개 안팎 뽑아라.
- 동의어, 구어체, 줄임말, 커뮤니티 은어, 띄어쓰기·맞춤법이 다른 흔한 형태를 포함한다.
- 사이트 검색창에 그대로 넣을 말이므로 짧게 (1~4 어절).
- 뜻이 다른 연상어(관련 주제, 반대말, 상위 개념)는 넣지 않는다.
- 원래 검색어와 글자만 같은 것은 넣지 않는다.

JSON 으로만 답하라: {"candidates": ["표현1", "표현2", ...]}`;
  const j = json(await ask(prompt));
  const seen = new Set(words.map(key));
  const out = [];
  for (const c of Array.isArray(j.candidates) ? j.candidates : []) {
    const w = tidy(c);
    if (!w || w.length > 20 || seen.has(key(w))) continue;
    seen.add(key(w));
    out.push(w);
  }
  return out;
}

/** 2차: 검수. 1차와 다른 새 호출이라 1차의 이유를 모른다. */
export async function review(words, candidates) {
  if (!candidates.length) return { keep: [], drop: [] };
  const prompt = `커뮤니티 글 검색용 검색어를 검수한다.
원래 검색어: ${words.map((w) => `"${w}"`).join(', ')}

아래 후보 각각이 원래 검색어와 **같은 뜻이라서, 이 말로 검색하면 원래 사용자가 찾던 글이 나오는지** 판정하라.
엄격하게 판정한다:
- 같은 뜻의 다른 표현 → keep
- 관련은 있지만 뜻이 다름(연상어, 반대말, 너무 넓은 말, 너무 좁은 말, 다른 맥락에서 주로 쓰이는 말) → drop
- 너무 흔해서 상관없는 글이 대부분 걸릴 말 → drop

후보:
${candidates.map((c, i) => `${i + 1}. ${c}`).join('\n')}

JSON 으로만 답하라. 모든 후보를 keep 이나 drop 중 하나에 넣고, why 는 15자 안팎:
{"keep": [{"word": "...", "why": "..."}], "drop": [{"word": "...", "why": "..."}]}`;
  const j = json(await ask(prompt));
  // 후보에 없던 말을 검수가 지어내 넣으면 버린다. 검수는 거르기만 한다.
  const byKey = new Map(candidates.map((c) => [key(c), c]));
  const pick = (list) => (Array.isArray(list) ? list : [])
    .map((x) => ({ word: byKey.get(key(x?.word)), why: tidy(x?.why).slice(0, 40) }))
    .filter((x) => x.word);
  let keep = pick(j.keep);
  const drop = pick(j.drop);
  // 검수가 판정을 빠뜨린 후보는 통과시키지 않는다 — 확인 안 된 말로 뒤지지 않는다.
  const judged = new Set([...keep, ...drop].map((x) => key(x.word)));
  for (const c of candidates) if (!judged.has(key(c))) drop.push({ word: c, why: '검수 답에 없음' });
  if (keep.length > MAX_EXTRA) {
    for (const x of keep.slice(MAX_EXTRA)) drop.push({ word: x.word, why: `상한 ${MAX_EXTRA}개 초과` });
    keep = keep.slice(0, MAX_EXTRA);
  }
  return { keep, drop };
}
