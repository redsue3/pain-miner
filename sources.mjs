// sources.mjs — 수집 대상과 파서.
//
// 여기 있는 사이트는 전부 sourcecheck.mjs 를 통과한 것만이다 (2026-09-21 실측):
//   · robots.txt 게이트 통과
//   · 존재할 수 없는 문자열로 검색했을 때 결과 0건  (= 검색이 실제로 작동)
//
// 탈락한 곳과 이유 — 다시 넣으려는 사람을 위해 남겨둔다:
//   지식iN·디시·네이트판·웃대·에펨  robots.txt 가 ClaudeBot 을 이름으로 차단
//   루리웹·인벤                      Disallow: /search
//   SLR클럽                          Disallow: /  (전체)
//   클리앙·더쿠·오유·쿨엔조이        robots.txt 없음 → 기본 거부
//   82cook                           비로그인 상태에서 검색 파라미터를 무시함
//                                    (사이트 자체 UI 로 제출해도 결과 동일, 실측)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const CURL_ARGS = [
  '-sL', '--compressed', '--max-time', '25',
  '-A', UA,
  '-H', 'Accept-Language: ko-KR,ko;q=0.9,en;q=0.8',
];

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

// ---------- 아카라이브 ----------
// target=all 은 제목+본문을 본다. 그래서 제목에 검색어가 없는 결과가 많이 나온다 (정상).
const arca = {
  name: 'arca',
  boards: ['live'],              // 베스트 라이브 = 채널 통합 피드
  url: (board, kw, page) =>
    `https://arca.live/b/${board}?target=all&keyword=${encodeURIComponent(kw)}&p=${page}`,
  parse(html, board) {
    const out = [];
    // 'vrow' 로 쪼개면 vrow-inner / vrow-top 같은 중첩 요소까지 걸려 행이 잘게 부서진다.
    // 제목 앵커 바로 뒤에 처음 나오는 <time> 을 쓴다 (실제 글과 대조해 4/4 일치 확인).
    const re =
      /class="title hybrid-title"\s+href="(\/b\/[^"?]+)[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,900}?<time[^>]*datetime="(\d{4}-\d{2}-\d{2})/g;
    let m;
    while ((m = re.exec(html))) {
      const title = clean(m[2]);
      if (!title) continue;
      out.push({ board, title, url: 'https://arca.live' + m[1], date: m[3] });
    }
    return out;
  },
};

// ---------- 개드립 ----------
const dogdrip = {
  name: 'dogdrip',
  boards: ['title', 'title_content'],     // 제목만 / 제목+본문
  url: (mode, kw, page) =>
    `https://www.dogdrip.net/index.php?mid=dogdrip&search_target=${mode}` +
    `&search_keyword=${encodeURIComponent(kw)}&page=${page}`,
  parse(html, mode) {
    const out = [];
    const re =
      /<a\s+href="(\/dogdrip\/\d+)[^"]*"\s+class="ed title-link"[^>]*>([\s\S]{0,300}?)<\/a>([\s\S]{0,1600}?)(\d{4}\.\d{2}\.\d{2})/g;
    let m;
    while ((m = re.exec(html))) {
      const title = clean(m[2]);
      if (!title) continue;
      out.push({
        board: mode,
        title,
        url: 'https://www.dogdrip.net' + m[1],
        date: m[4].replace(/\./g, '-'),
      });
    }
    return out;
  },
};

// ---------- 뽐뿌 ----------
// sub_memo = 제목+본문. 자유게시판이 일상 불편 밀도가 가장 높다.
// 주의: 이 사이트만 EUC-KR 이다. UTF-8 로 읽으면 제목이 전부 깨진다.
const ppomppu = {
  name: 'ppomppu',
  charset: 'euc-kr',
  // 실측으로 검색이 되는 게시판만 (2026-09-21). mobile/cook/housewife 등은 이 id 로 존재하지 않는다.
  boards: ['freeboard', 'computer', 'car', 'baby', 'humor'],
  url: (board, kw, page) =>
    `https://www.ppomppu.co.kr/zboard/zboard.php?id=${board}` +
    `&search_type=sub_memo&keyword=${encodeURIComponent(kw)}&page=${page}`,
  parse(html, board) {
    const out = [];
    // 반드시 <tr> 단위로 쪼갠 뒤 그 안에서 제목과 날짜를 함께 뽑는다.
    // 문서 전체에서 제목 목록과 시각 목록을 따로 뽑아 순서대로 짝지으면
    // 공지 행의 시각이 끼어들어 전부 밀린다 (실측: 5건 중 5건이 엉뚱한 날짜였다).
    for (const row of html.split(/<tr[\s>]/)) {
      const a = row.match(
        /class="baseList-title[^"]*"\s+href="view\.php\?id=[^"]*?&no=(\d+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!a) continue;
      const title = clean(a[2]);
      if (!title || title.length < 4) continue;
      const t = row.match(/<time class="baseList-time"\s+title="(\d\d)\.(\d\d)\.(\d\d)/);
      out.push({
        board, title,
        date: t ? `20${t[1]}-${t[2]}-${t[3]}` : '',
        url: 'https://www.ppomppu.co.kr/zboard/view.php?id=' + board + '&no=' + a[1],
      });
    }
    return out;
  },
};

export const SOURCES = { arca, dogdrip, ppomppu };

// ---------- 검색어 ----------
// 목표: '일상에서 애매하게 불편한 것'.
// seeking 이 핵심 — 이미 해결책을 찾아 헤맸다는 증거가 문장 안에 들어있다.
// 1차 수집(1,092건) 결과를 보고 고쳤다:
//   · '방법 없을까'/'누가 만들어' 는 연애·정치 상담을 대량으로 끌어와 결과를 덮었다 → 뺐다
//   · 대신 '손으로 해야 하는 반복 작업'을 직접 가리키는 표현을 넣었다
export const KEYWORDS = {
  // 해결책을 찾아 헤맨 흔적
  seeking: ['이런 앱 없나', '이런 기능 없나', '자동으로 안되나', '자동으로 해주는', '알림 오게'],
  // 손으로 반복하고 있다는 진술
  manual: ['일일이 입력', '매번 입력', '따로 적어', '수동으로 해야', '엑셀로 관리', '하나하나 확인'],
  // 잊어버려서 생기는 손해
  forgetting: ['매번 까먹', '맨날 까먹', '까먹어서 못', '기한 지나'],
  // 대조군
  general: ['불편한데', '귀찮은데', '번거로운데'],
};
