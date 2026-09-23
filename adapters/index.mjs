// adapters/index.mjs — 사이트별 '검색 URL 만들기'와 '목록 파싱'.
//
// 새 커뮤니티를 붙이려면 여기에 객체 하나만 추가하면 된다. 필요한 건 넷이다:
//   url(board, keyword, page)  검색 결과 주소
//   parse(html, board)         → [{title, url, date}]
//   referer                    그 사이트가 기대하는 출처 (403 예방의 핵심)
//   charset                    EUC-KR 사이트만 지정
//
// arca / dogdrip / ppomppu 의 파서는 이전 버전에서 실제 글과 대조해 검증한 것을
// 그대로 가져왔다. dcinside / ruliweb 은 이번에 새로 넣었으므로
// `node crawl.mjs --probe <사이트>` 로 먼저 확인하고 쓰는 것을 권한다.

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&middot;': '·', '&hellip;': '…',
};

export function clean(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 여는 태그를 찾아, 같은 종류의 태그를 세어가며 짝이 맞는 닫는 태그까지 잘라낸다.
 * 본문 div 안에 div 가 또 들어있는 경우가 대부분이라 단순 non-greedy 로는 잘린다.
 * openRe 의 첫 캡처그룹이 태그 이름이어야 한다.
 */
export function extractBlock(html, openRe) {
  const m = openRe.exec(html);
  if (!m) return '';
  const tag = (m[1] ?? 'div').toLowerCase();
  const start = m.index + m[0].length;
  const scan = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
  scan.lastIndex = start;
  let depth = 1, mm;
  while ((mm = scan.exec(html))) {
    if (mm[0][1] === '/') {
      if (--depth === 0) return html.slice(start, mm.index);
    } else depth++;
  }
  return html.slice(start, start + 30000);   // 닫는 태그가 없으면 적당히 끊는다
}

/**
 * class 로 여는 태그를 찾는 정규식을 만든다.
 * 따옴표를 가리지 않는다 — 뽐뿌는 <td class='board-contents'> 처럼 작은따옴표를 쓴다.
 * 큰따옴표만 받다가 뽐뿌 본문을 통째로 놓쳤다 (실측 120건 전부 실패).
 */
export const openTag = (tag, cls) =>
  new RegExp(`<(${tag})\\b[^>]*class\\s*=\\s*["']?[^"'>]*${cls}[^"'>]*["']?[^>]*>`, 'i');

/**
 * 같은 글이 한 목록에 두 번 나오는 것을 하나로 만든다.
 * 파서 버그가 아니다 — 루리웹·아카는 인기글을 목록 위에 한 번 더 고정해서 보여준다
 * (실측 2026-09-23: 루리웹 35건 중 4건, 아카 26건 중 1건이 그랬고 제목·날짜까지 같았다).
 * 어댑터의 약속을 '글 하나당 한 줄'로 맞춰 둔다.
 */
export function uniqByUrl(posts) {
  const seen = new Set();
  return posts.filter((p) => (seen.has(p.url) ? false : (seen.add(p.url), true)));
}

/** 스크립트·스타일을 먼저 걷어낸 뒤 텍스트만 남긴다. */
export function textOf(htmlFragment, limit = 4000) {
  if (!htmlFragment) return '';
  const t = clean(
    htmlFragment
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  );
  return t.length > limit ? t.slice(0, limit) + '…' : t;
}

// ── 아카라이브 ───────────────────────────────────────────────────────────
// target=all 은 제목+본문을 본다. 제목에 검색어가 없는 결과가 섞이는 건 정상이다.
const arca = {
  id: 'arca',
  label: '아카라이브',
  referer: 'https://arca.live/',
  url: (board, kw, page) =>
    `https://arca.live/b/${board}?target=all&keyword=${encodeURIComponent(kw)}&p=${page}`,
  browseUrl: (board, page) => `https://arca.live/b/${board}?p=${page}`,
  body: (html) => textOf(extractBlock(html, openTag('div', 'article-content'))),
  waitFor: 'a.title',
  parse(html, board) {
    const out = [];
    // 행 단위로 쪼갠다. 예전엔 '제목 뒤 900자 안의 <time>' 으로 찾았는데,
    // 핫딜 채널은 제목과 시각 사이에 가격·배송·이미지 태그가 끼어 900자를 넘긴다
    // (실측: 26행 중 1행만 걸렸다). 'vrow ' 뒤의 공백이 vrow-inner/vrow-bottom 과
    // 구분해 주므로 이걸로 자르면 행이 안 부서진다.
    for (const row of html.split(/class="vrow /)) {
      // 아카는 화면에 따라 행 모양이 둘이다.
      //   (가) 채널 목록·핫딜:  <a class="title hybrid-title" href="/b/ch/123">제목</a>
      //   (나) 전체검색(/b/breaking): 행 전체가 앵커고 제목은 안쪽 <span class="title">
      // (나)를 못 읽어서 전체검색 결과가 0건으로 나왔다 (2026-09-24 실측).
      let href = '', title = '';
      const a = row.match(/class="title hybrid-title"\s+href="(\/b\/[^"?]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      if (a) { href = a[1]; title = clean(a[2]); }
      else {
        const b = row.match(/^column[^"]*"\s+href="(\/b\/[^"?]+)[^"]*"/);
        const ti = row.indexOf('<span class="title">');
        if (b && ti >= 0) {
          // 제목 span 안에 아이콘 span 이 또 들어있다. non-greedy 로 첫 </span> 까지만
          // 집으면 아이콘만 잡히고 제목은 빈 문자열이 된다 (실측: 25행 전부 그랬다).
          // 태그 수를 세는 extractBlock 으로 짝이 맞는 곳까지 집는다.
          href = b[1];
          title = clean(extractBlock(row.slice(ti), /<(span) class="title">/));
        }
      }
      if (!href || !title) continue;

      const tm = row.match(/<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/);
      const grab1 = (re) => { const m = row.match(re); return m ? clean(m[1]) : ''; };
      out.push({
        board, title,
        url: 'https://arca.live' + href,
        date: tm ? tm[1] : '',
        // 핫딜 채널에만 있다. '얼마인지'가 이 게시판의 핵심 정보다.
        price: grab1(/class="deal-price"[^>]*>([\s\S]{0,40}?)</),
        delivery: grab1(/class="deal-delivery"[^>]*>([\s\S]{0,40}?)</),
      });
    }
    return uniqByUrl(out);
  },
};

/**
 * 커뮤니티 목록은 최근 글을 "7 일 전", "3 시간 전" 처럼 상대 시각으로 쓰고
 * 오래된 글만 절대 날짜로 쓴다. 둘 다 YYYY-MM-DD 로 맞춰준다.
 * 못 읽으면 빈 문자열 — 없는 날짜를 지어내지 않는다.
 */
export function readDate(win, now = new Date()) {
  const abs = win.match(/(\d{4})[.-](\d{2})[.-](\d{2})/);
  if (abs) return `${abs[1]}-${abs[2]}-${abs[3]}`;

  const iso = (d) => d.toISOString().slice(0, 10);
  if (/어제/.test(win)) return iso(new Date(now.getTime() - 864e5));
  if (/오늘|방금/.test(win)) return iso(now);
  // 목록에서 오늘 올라온 글은 날짜 대신 시:분만 찍는 사이트가 많다.
  if (/(^|\s)\d{1,2}:\d{2}(:\d{2})?(\s|$)/.test(win)) return iso(now);

  const rel = win.match(/(\d+)\s*(분|시간|일|주|개월|달|년)\s*전/);
  if (!rel) return '';
  const n = Number(rel[1]);
  const days = { 분: 0, 시간: 0, 일: 1, 주: 7, 개월: 30, 달: 30, 년: 365 }[rel[2]] ?? 0;
  return iso(new Date(now.getTime() - n * days * 864e5));
}

// ── 개드립 ───────────────────────────────────────────────────────────────
// 2026-09-23 실측: index.php?mid=dogdrip&... 형태는 검색어를 무시하고 기본 목록을 준다.
// /dogdrip?search_target=... 형태라야 실제로 걸러진다
// (없는 단어로 검색 → 결과 0건, '앱' → 20건 으로 확인).
const dogdrip = {
  id: 'dogdrip',
  label: '개드립',
  referer: 'https://www.dogdrip.net/dogdrip',
  url: (mode, kw, page) =>
    `https://www.dogdrip.net/dogdrip?search_target=${mode}` +
    `&search_keyword=${encodeURIComponent(kw)}&page=${page}`,
  browseUrl: (mode, page) => `https://www.dogdrip.net/dogdrip?page=${page}`,
  body: (html) => textOf(extractBlock(html, openTag('div', 'xe_content'))),
  waitFor: 'a.title-link',
  parse(html, mode) {
    const out = [];
    // 사이드바 '인기글' 위젯에도 /dogdrip/숫자 링크가 있다. 그쪽은 class 가 없으므로
    // 'ed title-link' 를 반드시 함께 요구해서 본문 목록만 집는다.
    const re = /<a\s+href="(\/dogdrip\/\d+)[^"]*"\s+class="ed title-link"[^>]*>([\s\S]{0,300}?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) {
      const title = clean(m[2]);
      if (!title) continue;
      const end = m.index + m[0].length;
      out.push({
        board: mode, title,
        url: 'https://www.dogdrip.net' + m[1],
        date: readDate(html.slice(end, end + 1500)),
      });
    }
    return uniqByUrl(out);
  },
};

/**
 * 뽐뿌는 게시판마다 시각 표기가 다르다 (2026-09-23 실측):
 *   자유게시판  <time class="baseList-time" title="25.11.17">   ← title 속성
 *   핫딜게시판  <time class="baseList-time">24/11/14</time>     ← 속성 없이 본문
 *               <time class="baseList-time">14:24:07</time>     ← 시:분:초 = 오늘 글
 * 셋을 다 읽는다. 못 읽으면 빈 문자열 — 없는 날짜를 지어내지 않는다.
 */
function ppomppuDate(row, now = new Date()) {
  const attr = row.match(/<time class="baseList-time"[^>]*title="(\d\d)\.(\d\d)\.(\d\d)/);
  if (attr) return `20${attr[1]}-${attr[2]}-${attr[3]}`;

  const inner = row.match(/<time class="baseList-time"[^>]*>([^<]*)</);
  if (!inner) return '';
  const s = inner[1].trim();
  const ymd = s.match(/^(\d\d)\/(\d\d)\/(\d\d)$/);
  if (ymd) return `20${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  if (/^\d\d:\d\d(:\d\d)?$/.test(s)) return now.toISOString().slice(0, 10);  // 오늘 올라온 글
  return '';
}

// ── 뽐뿌 ─────────────────────────────────────────────────────────────────
// 이 사이트만 EUC-KR 이다. UTF-8 로 읽으면 제목이 전부 깨진다.
const ppomppu = {
  id: 'ppomppu',
  label: '뽐뿌',
  charset: 'euc-kr',
  referer: 'https://www.ppomppu.co.kr/zboard/zboard.php?id=freeboard',
  url: (board, kw, page) =>
    `https://www.ppomppu.co.kr/zboard/zboard.php?id=${board}` +
    `&search_type=sub_memo&keyword=${encodeURIComponent(kw)}&page=${page}`,
  browseUrl: (board, page) =>
    `https://www.ppomppu.co.kr/zboard/zboard.php?id=${board}&page=${page}`,
  body: (html) => textOf(extractBlock(html, openTag('td', 'board-contents'))),
  parse(html, board) {
    const out = [];
    // 반드시 <tr> 단위로 쪼갠 뒤 그 안에서 제목과 날짜를 함께 뽑는다.
    // 제목 목록과 시각 목록을 따로 뽑아 순서대로 짝지으면 공지 행 때문에 전부 밀린다
    // (실측: 5건 중 5건이 엉뚱한 날짜였다).
    for (const row of html.split(/<tr[\s>]/)) {
      const a = row.match(/class="baseList-title[^"]*"\s+href="view\.php\?id=[^"]*?&no=(\d+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const title = clean(a[2]);
      if (!title || title.length < 4) continue;
      out.push({
        board, title,
        date: ppomppuDate(row),
        url: `https://www.ppomppu.co.kr/zboard/view.php?id=${board}&no=${a[1]}`,
      });
    }
    return uniqByUrl(out);
  },
};

// ── 디시인사이드 ─────────────────────────────────────────────────────────
// board 에는 갤러리 id 를 넣는다 (예: 'programming', 'stock_new2').
// robots.txt 가 크롤러를 막고 있으므로 config 의 robots 값을 직접 바꿔야 돈다.
// Referer 를 갤러리 목록으로 정확히 맞추는 것이 403 을 피하는 데 가장 중요하다.
//
// board 표기 (2026-09-23 추가):
//   'programming'         정식 갤러리 → /board/lists/?id=programming
//   'mgallery/game_dev'   마이너 갤러리 → /mgallery/board/lists/?id=game_dev
// 마이너 갤러리는 경로가 하나 더 붙는다. 게임개발·알고리즘처럼 주제가 좁은 곳은
// 대부분 마이너 갤러리에 있다 (game_dev, algo, godot 실측 확인).
const dcSplit = (board) => {
  const i = board.indexOf('/');
  return i === -1 ? { prefix: '', id: board } : { prefix: '/' + board.slice(0, i), id: board.slice(i + 1) };
};

/**
 * 디시는 목록에서 글로 가는 링크에 '어떻게 찾아왔는지'를 붙인다:
 *   /board/view/?id=programming&no=2939877&s_type=...&s_keyword=자료구조&page=1
 * 그래서 같은 글이라도 검색어가 다르면 URL 이 달라지고, 중복 제거가 그대로 통과한다.
 * (실측 2026-09-23: 같은 글이 3번씩 저장돼 95건 중 상당수가 같은 글이었다.)
 * 글을 가리키는 것은 id 와 no 뿐이므로 그 둘만 남긴다.
 */
function dcCanonical(href) {
  const m = href.match(/^(.*\/board\/view\/)\?(.*)$/);
  if (!m) return 'https://gall.dcinside.com' + href;
  const q = new URLSearchParams(m[2]);
  const id = q.get('id'), no = q.get('no');
  if (!id || !no) return 'https://gall.dcinside.com' + href;
  return `https://gall.dcinside.com${m[1]}?id=${id}&no=${no}`;
}

const dcinside = {
  id: 'dcinside',
  label: '디시인사이드',
  referer: 'https://gall.dcinside.com/',
  url: (board, kw, page) => {
    const { prefix, id } = dcSplit(board);
    return `https://gall.dcinside.com${prefix}/board/lists/?id=${id}` +
      `&s_type=search_subject_memo&s_keyword=${encodeURIComponent(kw)}&page=${page}`;
  },
  browseUrl: (board, page) => {
    const { prefix, id } = dcSplit(board);
    return `https://gall.dcinside.com${prefix}/board/lists/?id=${id}&page=${page}`;
  },
  body: (html) => textOf(extractBlock(html, openTag('div', 'write_div'))),
  waitFor: 'tr.ub-content',
  parse(html, board) {
    const out = [];
    for (const row of html.split(/<tr[\s>]/)) {
      if (!/gall_tit/.test(row)) continue;
      // 앵커에 공백이 둘 들어가는 행이 있어 \s+ 로 받는다.
      // 정식/마이너 두 경로를 모두 받되, 광고(link.coupang)·설문(javascript:)은
      // /board/view/ 형태가 아니므로 자연히 걸러진다.
      const a = row.match(/<a\s+href="((?:\/mgallery)?\/board\/view\/\?id=[^"]+?)"[^>]*>([\s\S]{0,400}?)<\/a>/);
      if (!a) continue;
      const title = clean(a[2]);
      if (!title || title.length < 2) continue;
      const d = row.match(/class="gall_date"[^>]*title="(\d{4})-(\d{2})-(\d{2})/);
      out.push({
        board, title,
        date: d ? `${d[1]}-${d[2]}-${d[3]}` : '',
        url: dcCanonical(a[1].replace(/&amp;/g, '&')),
      });
    }
    return uniqByUrl(out);
  },
};

// ── 루리웹 ───────────────────────────────────────────────────────────────
// board 에는 경로를 통째로 넣는다:
//   'market/board/1020'     핫딜/예판
//   'community/board/300143' 유머게시판
//
// robots.txt 가 'Disallow: /*search_type=' 로 검색 경로를 막고 있다.
// 그래서 여기서는 검색을 쓰지 않고 게시판 목록을 순서대로 훑는 browse 방식을 쓴다
// (config 에서 "listMode": "browse"). 키워드는 받아온 제목에 프로그램이 적용한다.
// robots 를 어기지 않으면서 같은 결과를 얻는 길이다.
const ruliweb = {
  id: 'ruliweb',
  label: '루리웹',
  referer: 'https://bbs.ruliweb.com/',
  url: (board, kw, page) =>
    `https://bbs.ruliweb.com/${board}?search_type=subject` +
    `&search_key=${encodeURIComponent(kw)}&page=${page}`,
  browseUrl: (board, page) => `https://bbs.ruliweb.com/${board}?page=${page}`,
  body: (html) => textOf(extractBlock(html, openTag('div', 'view_content'))),
  waitFor: 'td.subject',
  parse(html, board) {
    const out = [];
    for (const row of html.split(/<tr[\s>]/)) {
      // 제목 앵커를 class 로 정확히 집는다. 예전엔 '아무 <a> 중 /read/ 링크'를
      // 300자 제한으로 찾았는데, 루리웹은 들여쓰기가 깊어 앵커 안 내용이 252~376자다.
      // 그래서 35개 중 26개가 잘려나가고, 대신 댓글수 링크가 제목으로 잡혔다 (실측).
      const a = row.match(/<a class="subject_link[^"]*"[^>]*href="(https?:\/\/bbs\.ruliweb\.com\/[^"]*?\/read\/\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const title = clean(a[2]);
      if (!title || title.length < 2) continue;
      // 루리웹은 셀 안 들여쓰기만 70자가 넘는다. 넉넉하게 잡아야 날짜가 안 잘린다.
      const d = row.match(/<td class="time"[^>]*>([\s\S]{0,200}?)<\/td>/);
      out.push({
        board, title,
        date: d ? readDate(d[1]) : '',
        url: a[1].replace(/&amp;/g, '&'),
      });
    }
    return uniqByUrl(out);
  },
};

// ── 디시인사이드 통합검색 ────────────────────────────────────────────────
// 갤러리 하나만 뒤지면 디시를 쓰는 의미가 거의 없다. 갤러리가 수천 개라서
// 'programming' 한 곳만 보면 유동량이 가장 많은 사이트인데도 몇 건 안 나온다
// (실측: 다른 곳에서 20건 나올 때 디시는 4건이었다).
// search.dcinside.com 은 전체 갤러리를 한 번에 뒤지고, 결과에 갤러리 이름과
// 본문 발췌까지 같이 온다.
//
// robots.txt 는 404 다 — 규칙이 없다는 뜻이고, core/robots.mjs 가 그렇게 판정한다.
// 다만 갤러리 단위 금지(47, cat, dog, stock_new2 …)는 gall.dcinside.com 규칙이므로
// 결과에서 그 갤러리 글은 걸러낸다.
const DC_BLOCKED = new Set([
  '47', 'baseball_new8', 'cat', 'd_fighter_new1', 'dog', 'ib_new', 'm_entertainer1',
  'metakr', 'produce48', 'salgoonews', 'singo', 'sportsseoul', 'stock_new', 'stock_new2',
]);

const dcsearch = {
  id: 'dcsearch',
  label: '디시 전체',
  referer: 'https://www.dcinside.com/',
  url: (board, kw, page) =>
    `https://search.dcinside.com/post/p/${page}/q/${encodeURIComponent(kw)}`,
  browseUrl: (board, page) => dcsearch.url(board, '', page),
  body: (html) => textOf(extractBlock(html, openTag('div', 'write_div'))),
  waitFor: '.sch_result_list',
  parse(html, board) {
    const out = [];
    for (const li of html.split(/<li[\s>]/)) {
      const a = li.match(/<a href="(https:\/\/gall\.dcinside\.com\/[^"]*?board\/view\/\?id=([^&"]+)&no=(\d+))[^"]*"[^>]*class="tit_txt"[^>]*>([\s\S]{0,400}?)<\/a>/);
      if (!a) continue;
      const gallery = a[2];
      if (DC_BLOCKED.has(gallery)) continue;   // gall 쪽 robots 가 막아둔 갤러리
      const title = clean(a[4]);
      if (!title) continue;
      const d = li.match(/class="date_time"[^>]*>\s*(\d{4})\.(\d{2})\.(\d{2})/);
      // 검색 결과가 본문 발췌를 같이 준다. 글마다 따로 받을 필요가 없다.
      const dsc = li.match(/class="link_dsc_txt"[^>]*>([\s\S]{0,600}?)<\/p>/);
      const gname = li.match(/class="sub_txt"[^>]*>([\s\S]{0,60}?)<\/a>/);
      out.push({
        board: gname ? clean(gname[1]) : gallery,
        title,
        url: `https://gall.dcinside.com/board/view/?id=${gallery}&no=${a[3]}`,
        date: d ? `${d[1]}-${d[2]}-${d[3]}` : '',
        body: dsc ? clean(dsc[1]).slice(0, 400) : '',
      });
    }
    return uniqByUrl(out);
  },
};

// ══════════════════════════════════════════════════════════════════════════
//  전시장 캘린더
// ══════════════════════════════════════════════════════════════════════════
//
// 커뮤니티 어댑터와 성격이 다르다. 여기서 나오는 date 는 '글을 쓴 날'이 아니라
// '행사가 열리는 날'이라서 **미래 날짜가 정상이다**. 그래서 futureDates: true 를 단다.
// 검사(4.5)와 audit 이 이 값을 보고 미래 날짜를 문제로 잡지 않는다.
//
// board 에는 "YYYY-MM" 을 넣는다. 한 번 요청에 그 달 전체가 온다.
//   "boards": ["2026-10", "2026-11", "2026-12"],  "listMode": "browse", "browsePages": 1
//
// 커뮤니티와 달리 검색 기능을 쓰지 않는다. 달 전체를 받아 키워드로 거른다.

const ymSplit = (ym) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym).trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) };
};
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

// ── 코엑스 ───────────────────────────────────────────────────────────────
// 목록 뷰(full-schedules)는 admin-ajax 로 채워져서 HTML 에 내용이 없다.
// 캘린더 뷰는 서버가 그려서 보내주므로 그쪽을 쓴다 (?cy=연도&cm=월).
// 캘린더는 행사가 걸친 날마다 한 번씩 나오므로, 같은 행사의 날짜를 모아
// 처음과 끝을 구한다 — 그게 곧 행사 기간이다.
//
// robots.txt 가 Crawl-delay: 10 을 명시한다. crawlDelayMs 로 지켜준다.
const coex = {
  id: 'coex',
  label: '코엑스',
  referer: 'https://www.coex.co.kr/',
  futureDates: true,
  crawlDelayMs: 10000,
  browseUrl: (ym) => {
    const p = ymSplit(ym);
    return p ? `https://www.coex.co.kr/event/exhibitions-calendar/?cy=${p.y}&cm=${p.m}`
             : 'https://www.coex.co.kr/event/exhibitions-calendar/';
  },
  url: (ym) => coex.browseUrl(ym),
  body: (html) => textOf(extractBlock(html, openTag('div', 'entry-content'))),
  waitFor: '.PostCalendarTbody',
  parse(html, ym) {
    const p = ymSplit(ym);
    if (!p) return [];

    // 달력 격자는 앞뒤 달의 날짜도 같이 보여준다.
    // 2026-11 은 42칸이고 앞 7칸이 10/25~31, 뒤 5칸이 12/1~5 다 (실측).
    // 칸의 class 로는 구분이 안 되므로(past 여부만 있다) 날짜가 흐르는 순서로 판별한다:
    //   처음 나오는 1 이 이 달의 시작, 그 뒤로 숫자가 줄어들면 다음 달이다.
    // 이걸 안 하면 12/2~4 인 소프트웨이브가 11/2~4 로 기록된다 — 실제로 그랬다.
    const abs = (day, phase) => {
      const t = new Date(Date.UTC(p.y, p.m - 1 + phase, day));
      return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
    };

    const byUrl = new Map();
    let phase = -1, prevDay = 0;
    // 한 칸에 행사가 여럿 있을 수 있다. '날짜 숫자 바로 뒤 앵커 하나'로 찾으면
    // 둘째부터 놓친다 (실측 55개 중 21개만 걸렸다). 그래서 칸 안을 전부 훑는다.
    for (const cell of html.split(/class='PostCalendarTbody-item/)) {
      const d = cell.match(/class='PostCalendarTbody-num'>(\d+)</);
      if (!d) continue;
      const day = Number(d[1]);
      if (phase === -1 && day === 1) phase = 0;
      else if (phase === 0 && day < prevDay) phase = 1;
      prevDay = day;

      for (const a of cell.matchAll(
        /<a href='(https:\/\/www\.coex\.co\.kr\/exhibitions\/[^']+?)'[^>]*class='PostCalendarTbody-txt[^']*'>([^<]+)<\/a>/g)) {
        const url = a[1].split('?')[0].replace(/\/+$/, '/');
        const title = clean(a[2]);
        if (!title) continue;
        if (!byUrl.has(url)) byUrl.set(url, { title, dates: [] });
        byUrl.get(url).dates.push(abs(day, phase));
      }
    }

    // 코엑스는 행사 시리즈마다 페이지 하나를 재사용한다. 그래서 같은 URL 이
    // 10/1~2 와 11/1~2 처럼 떨어진 두 기간에 나타난다 (동아재테크쇼 실측).
    // URL 로만 묶으면 10/1~11/2 라는 한 달짜리 행사가 되어버린다.
    // 날짜가 끊기는 지점에서 잘라 각각을 따로 낸다.
    const DAY = 864e5;
    const out = [];
    for (const [url, v] of byUrl) {
      const days = [...new Set(v.dates)].sort();
      let run = [days[0]];
      const flush = () => {
        out.push({
          board: ym, title: v.title, url,
          date: run[0],
          dateEnd: run[run.length - 1],
          venue: '코엑스',
          // 같은 URL 의 다른 회차를 중복으로 지우지 않기 위한 키.
          dedupKey: `${url}#${run[0]}`,
        });
      };
      for (let i = 1; i < days.length; i++) {
        const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY;
        if (gap > 1) { flush(); run = []; }
        run.push(days[i]);
      }
      flush();
    }
    return out;
  },
};

// ── 킨텍스 ───────────────────────────────────────────────────────────────
// 목록 뷰가 서버 렌더링이고 날짜 범위를 파라미터로 받는다.
// 썸네일 img 의 alt 에 "제목/시작~종료" 가 통째로 들어 있어 거기서 기간을 읽는다.
const kintex = {
  id: 'kintex',
  label: '킨텍스',
  referer: 'https://www.kintex.com/web/ko/event/list.do',
  futureDates: true,
  browseUrl: (ym) => {
    const p = ymSplit(ym);
    if (!p) return 'https://www.kintex.com/web/ko/event/list.do';
    const s = `${p.y}-${pad(p.m)}-01`;
    const e = `${p.y}-${pad(p.m)}-${pad(lastDay(p.y, p.m))}`;
    return 'https://www.kintex.com/web/ko/event/list.do'
      + `?searchStartDt=${s}&searchEndDt=${e}&pageUnit=100&pageIndex=1`;
  },
  url: (ym) => kintex.browseUrl(ym),
  body: (html) => textOf(extractBlock(html, openTag('div', 'view-content'))),
  waitFor: '.schedule-board-list',
  parse(html, ym) {
    const out = [];
    for (const block of html.split(/class="btn-square-item/)) {
      const seq = block.match(/fnView\('\.\/view\.do',\s*(\d+)\)/);
      if (!seq) continue;
      const subj = block.match(/class="item-subject"[^>]*>([\s\S]{0,300}?)<\/div>/);
      const title = clean(subj?.[1] ?? '');
      if (!title) continue;
      // alt="제목/2026.09.30~2026.10.02//"
      const d = block.match(/alt="[^"]*?(\d{4})\.(\d{2})\.(\d{2})~(\d{4})\.(\d{2})\.(\d{2})/);
      const hall = clean((block.match(/class="item-client"[^>]*>([\s\S]{0,200}?)<\/div>/) ?? [])[1] ?? '');
      const kind = clean((block.match(/class="event-label-ko"[^>]*>([^<]{0,20})</) ?? [])[1] ?? '');
      out.push({
        board: ym, title,
        url: `https://www.kintex.com/web/ko/event/view.do?seq=${seq[1]}`,
        date: d ? `${d[1]}-${d[2]}-${d[3]}` : '',
        dateEnd: d ? `${d[4]}-${d[5]}-${d[6]}` : '',
        venue: ['킨텍스', hall, kind].filter(Boolean).join(' · '),
      });
    }
    return uniqByUrl(out);
  },
};

export const ADAPTERS = { arca, dogdrip, ppomppu, dcinside, dcsearch, ruliweb, coex, kintex };
