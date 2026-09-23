#!/bin/sh
# ip-check.sh — 이 기계의 IP 에서 대상 사이트들이 어떻게 응답하는지 잰다.
#
# 쓰는 이유: 같은 코드라도 어디서 나가느냐에 따라 결과가 달라진다.
# 가정·학교망에서 200 이 나와도 데이터센터 IP 에서는 403 이 나오는 일이 흔하다.
# 크롤러를 서버로 옮기기 전에 그걸 먼저 확인한다.
#
#   sh ip-check.sh          단발 확인
#   sh ip-check.sh --burst  연속 요청까지 확인 (속도 제한이 걸리는지)
#
# curl 만 있으면 된다. 결과를 그대로 복사해서 다른 기계 것과 비교하면 된다.

BURST=0
[ "$1" = "--burst" ] && BURST=1

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
TMP=$(mktemp -d 2>/dev/null || echo /tmp/ipcheck$$)
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "════════════════════════════════════════════════════════════════"
echo " 나가는 IP"
echo "════════════════════════════════════════════════════════════════"
curl -s --max-time 15 https://ipinfo.io/json > "$TMP/ip.json" 2>/dev/null
if [ -s "$TMP/ip.json" ]; then
  tr ',' '\n' < "$TMP/ip.json" | grep -E '"(ip|city|region|country|org)"' | sed 's/^[[:space:]]*/  /'
else
  echo "  조회 실패 (ipinfo.io 접근 불가)"
fi
echo "  시각: $(date -u '+%Y-%m-%d %H:%M UTC')"
echo ""

# 대상: 이름|URL|리퍼러|본문이 맞다는 증거|비고
TARGETS="
arca목록|https://arca.live/b/hotdeal?p=1|https://arca.live/|vrow
arca글|https://arca.live/b/hotdeal/183843238|https://arca.live/b/hotdeal|article-content
뽐뿌목록|https://www.ppomppu.co.kr/zboard/zboard.php?id=ppomppu&page=1|https://www.ppomppu.co.kr/|baseList-title
뽐뿌글|https://www.ppomppu.co.kr/zboard/view.php?id=ppomppu&no=735514|https://www.ppomppu.co.kr/zboard/zboard.php?id=ppomppu|board-contents
루리웹목록|https://bbs.ruliweb.com/market/board/1020?page=1|https://bbs.ruliweb.com/|subject_link
루리웹글|https://bbs.ruliweb.com/market/board/1020/read/107375|https://bbs.ruliweb.com/market/board/1020|view_content
개드립목록|https://www.dogdrip.net/dogdrip?page=1|https://www.dogdrip.net/|title-link
"

# 봇 검증 화면의 흔적
CHALLENGE='잠시만 기다|Just a moment|Checking your browser|cf-browser-verification|cf_chl|Attention Required|DDoS protection'

echo "════════════════════════════════════════════════════════════════"
echo " 사이트별 응답"
echo "════════════════════════════════════════════════════════════════"
printf "%-12s %6s %9s  %s\n" "대상" "상태" "크기" "판정"
echo "----------------------------------------------------------------"

PASS=0; FAILN=0; CHAL=0
echo "$TARGETS" | while IFS='|' read -r name url ref marker; do
  [ -z "$name" ] && continue
  out="$TMP/body"
  code=$(curl -sL --compressed --max-time 25 \
    -A "$UA" \
    -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
    -H "Accept-Language: ko-KR,ko;q=0.9,en;q=0.8" \
    -H "Upgrade-Insecure-Requests: 1" \
    -H "Sec-Fetch-Dest: document" \
    -H "Sec-Fetch-Mode: navigate" \
    -H "Sec-Fetch-Site: same-origin" \
    -H "Referer: $ref" \
    -o "$out" -w "%{http_code}" "$url" 2>/dev/null)
  size=$(wc -c < "$out" 2>/dev/null | tr -d ' ')
  [ -z "$size" ] && size=0

  if grep -qiE "$CHALLENGE" "$out" 2>/dev/null; then
    verdict="봇검증화면"
  elif [ "$code" = "200" ] && grep -q "$marker" "$out" 2>/dev/null; then
    verdict="정상 ($marker 확인)"
  elif [ "$code" = "200" ]; then
    verdict="200 인데 내용이 다름 ($marker 없음)"
  elif [ "$code" = "000" ]; then
    verdict="연결 실패/타임아웃"
  else
    verdict="차단 또는 오류"
  fi

  printf "%-12s %6s %8sB  %s\n" "$name" "$code" "$size" "$verdict"
  sleep 2
done

echo ""
if [ "$BURST" = "1" ]; then
  echo "════════════════════════════════════════════════════════════════"
  echo " 연속 요청 (1초 간격 6회) — 속도 제한이 걸리는지"
  echo "════════════════════════════════════════════════════════════════"
  for host in "https://arca.live/b/hotdeal?p=" "https://www.ppomppu.co.kr/zboard/zboard.php?id=ppomppu&page="; do
    label=$(echo "$host" | sed 's|https://||;s|/.*||')
    printf "%-22s " "$label"
    i=1
    while [ $i -le 6 ]; do
      c=$(curl -sL --compressed --max-time 20 -A "$UA" \
        -H "Accept-Language: ko-KR,ko;q=0.9" \
        -o /dev/null -w "%{http_code}" "${host}${i}" 2>/dev/null)
      printf "%s " "$c"
      i=$((i + 1))
      sleep 1
    done
    echo ""
  done
  echo ""
  echo "  전부 200 이면 이 IP 에서는 이 속도가 통한다는 뜻이다."
  echo "  뒤로 갈수록 403/429 가 나오면 속도 제한에 걸린 것이다."
  echo ""
fi

echo "════════════════════════════════════════════════════════════════"
echo " 이 출력을 통째로 복사해서 다른 기계 결과와 나란히 두고 비교하세요."
echo "════════════════════════════════════════════════════════════════"
