// core/keywords.mjs — 키워드 판정 엔진
//
// 요구사항: 무엇을 건질지는 '프로그램'이 정한다. 모델이 그때그때 고르는 게 아니라
// config.json 에 적힌 규칙을 코드가 그대로 집행한다. 같은 설정이면 같은 결과가 나온다.
//
// 규칙 (config.keywords):
//   any    : 하나라도 포함되면 통과 (OR).  비어 있으면 이 조건은 건너뛴다.
//   all    : 전부 포함돼야 통과 (AND)
//   none   : 하나라도 있으면 탈락 (NOT) — all/any 보다 우선한다
//   regex  : 정규식. "/패턴/플래그" 형식도 되고 그냥 패턴만 써도 된다.
//
// 한 구절 안의 띄어쓰기는 AND 로 본다: "일일이 입력" 은 제목에 '일일이' 와 '입력'이
// 둘 다 있으면 맞는 것으로 친다. 커뮤니티 글 제목은 띄어쓰기가 제각각이기 때문이다.

function toRegex(src) {
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(src);
  try {
    return m ? new RegExp(m[1], m[2].replace('g', '')) : new RegExp(src, 'i');
  } catch {
    return null;   // 잘못된 정규식은 조용히 무시하지 않고 로더가 경고한다
  }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** "일일이 입력" 처럼 띄어쓴 구절 → 모든 토큰이 들어있는지 */
function phraseHit(hay, phrase) {
  const tokens = norm(phrase).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  return tokens.every((t) => hay.includes(t));
}

export class Matcher {
  constructor(kw = {}) {
    this.any = (kw.any ?? []).filter(Boolean);
    this.all = (kw.all ?? []).filter(Boolean);
    this.none = (kw.none ?? []).filter(Boolean);
    this.badRegex = [];
    this.regex = (kw.regex ?? []).filter(Boolean).map((r) => {
      const rx = toRegex(r);
      if (!rx) this.badRegex.push(r);
      return rx;
    }).filter(Boolean);
  }

  /** 사이트 검색창에 넣을 질의어 목록 */
  searchQueries(kw = {}) {
    const explicit = kw.searchQueries?.use ?? [];
    if (explicit.length) return explicit;
    return this.any.length ? this.any : this.all;
  }

  /**
   * @returns {{pass:boolean, why:string, matched:string[]}}
   */
  test(text) {
    const hay = norm(text);
    if (!hay) return { pass: false, why: '빈 문자열', matched: [] };

    for (const n of this.none) {
      if (phraseHit(hay, n)) return { pass: false, why: `제외어 '${n}'`, matched: [] };
    }

    const matched = [];
    for (const a of this.all) {
      if (!phraseHit(hay, a)) return { pass: false, why: `필수어 '${a}' 없음`, matched: [] };
      matched.push(a);
    }

    if (this.any.length) {
      const hits = this.any.filter((a) => phraseHit(hay, a));
      const rxHits = this.regex.filter((r) => r.test(text)).map((r) => r.source);
      if (!hits.length && !rxHits.length) {
        return { pass: false, why: 'any/regex 어느 것도 맞지 않음', matched: [] };
      }
      matched.push(...hits, ...rxHits);
    } else if (this.regex.length) {
      const rxHits = this.regex.filter((r) => r.test(text)).map((r) => r.source);
      if (!rxHits.length) return { pass: false, why: 'regex 불일치', matched: [] };
      matched.push(...rxHits);
    }

    return { pass: true, why: 'ok', matched: [...new Set(matched)] };
  }
}
