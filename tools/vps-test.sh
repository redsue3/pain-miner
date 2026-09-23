#!/bin/sh
# vps-test.sh — 서울 리전에 VPS 를 잠깐 띄워 IP 검사를 돌리고 지운다.
#
#   sh tools/vps-test.sh            띄우고 → 검사 → 삭제 (기본)
#   sh tools/vps-test.sh --keep     삭제하지 않고 남겨둠
#   sh tools/vps-test.sh --cleanup  이전에 남은 것만 지움
#
# 토큰은 인자로 받지 않는다. 명령줄 인자는 프로세스 목록에 보이기 때문이다.
# 아래 파일에서 읽는다:
#   ~/.config/pain-miner/do_token     (DigitalOcean)
#
# 비용: 서울 s-1vcpu-512mb-10gb 기준 시간당 약 $0.006 (10원 미만).
#       검사는 2~3분이면 끝나고 곧바로 지운다.

set -e

TOKEN_FILE="$HOME/.config/pain-miner/do_token"
KEY="$HOME/.ssh/vps_test_key"
NAME="pain-miner-iptest"
REGION="sgp1"          # 아래에서 서울(seoul) 가용 여부를 확인해 덮어쓴다
SIZE="s-1vcpu-512mb-10gb"
IMAGE="ubuntu-24-04-x64"
API="https://api.digitalocean.com/v2"

HERE=$(dirname "$0")

die() { echo "오류: $*" >&2; exit 1; }

[ -f "$TOKEN_FILE" ] || die "토큰 파일이 없습니다: $TOKEN_FILE
  DigitalOcean → API → Generate New Token (쓰기 권한) 후:
  mkdir -p ~/.config/pain-miner && printf '%s' '토큰값' > $TOKEN_FILE"
TOKEN=$(tr -d ' \n\r' < "$TOKEN_FILE")
[ -n "$TOKEN" ] || die "토큰 파일이 비어 있습니다"
[ -f "$KEY" ] || die "SSH 키가 없습니다: $KEY"

api() {
  method="$1"; path="$2"; body="$3"
  if [ -n "$body" ]; then
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" -d "$body" "$API$path"
  else
    curl -s -X "$method" -H "Authorization: Bearer $TOKEN" "$API$path"
  fi
}

# JSON 에서 값 하나 뽑기 (jq 없이)
jget() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\).*/\1/p" <<EOF | head -1
$1
EOF
}

cleanup_old() {
  echo "남아있는 테스트 서버 확인"
  list=$(api GET "/droplets?tag_name=$NAME")
  ids=$(echo "$list" | tr '{' '\n' | grep -o '"id":[0-9]*' | cut -d: -f2 | head -20)
  if [ -z "$ids" ]; then echo "  없음"; return; fi
  for id in $ids; do
    echo "  삭제: droplet $id"
    api DELETE "/droplets/$id" >/dev/null
  done
}

if [ "$1" = "--cleanup" ]; then cleanup_old; echo "정리 완료"; exit 0; fi

echo "════════════════════════════════════════════════════════════"
echo " 1) 계정 확인"
echo "════════════════════════════════════════════════════════════"
acct=$(api GET "/account")
echo "$acct" | grep -q '"account"' || die "토큰이 유효하지 않습니다. 응답: $(echo "$acct" | head -c 200)"
echo "  토큰 정상"

echo ""
echo "════════════════════════════════════════════════════════════"
echo " 2) 서울 리전 확인"
echo "════════════════════════════════════════════════════════════"
regions=$(api GET "/regions")
if echo "$regions" | grep -q '"slug":"seo1"'; then
  REGION="seo1"; echo "  서울(seo1) 사용"
else
  echo "  서울 리전을 쓸 수 없습니다. 싱가포르(sgp1)로 진행합니다."
  echo "  ※ 해외 IP 변수가 섞이므로 결과 해석에 주의가 필요합니다."
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo " 3) SSH 키 등록"
echo "════════════════════════════════════════════════════════════"
PUB=$(cat "$KEY.pub")
FP=$(ssh-keygen -lf "$KEY.pub" -E md5 | awk '{print $2}' | sed 's/^MD5://')
keys=$(api GET "/account/keys")
if echo "$keys" | grep -q "$FP"; then
  echo "  이미 등록됨"
  KEYID=$(echo "$keys" | tr '{' '\n' | grep -B2 -A8 "$FP" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
else
  resp=$(api POST "/account/keys" "{\"name\":\"$NAME\",\"public_key\":\"$PUB\"}")
  KEYID=$(echo "$resp" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  echo "  등록 완료 (id=$KEYID)"
fi
[ -n "$KEYID" ] || die "SSH 키 id 를 얻지 못했습니다"

echo ""
echo "════════════════════════════════════════════════════════════"
echo " 4) 서버 생성 ($REGION / $SIZE)"
echo "════════════════════════════════════════════════════════════"
body="{\"name\":\"$NAME\",\"region\":\"$REGION\",\"size\":\"$SIZE\",\"image\":\"$IMAGE\",\"ssh_keys\":[$KEYID],\"tags\":[\"$NAME\"]}"
resp=$(api POST "/droplets" "$body")
DID=$(echo "$resp" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
[ -n "$DID" ] || die "생성 실패: $(echo "$resp" | head -c 300)"
echo "  droplet id=$DID"

# 끝나면 무조건 지운다 (--keep 이 아니면)
if [ "$1" != "--keep" ]; then
  trap 'echo ""; echo "서버 삭제 중 (id=$DID)"; api DELETE "/droplets/$DID" >/dev/null; echo "삭제 완료"' EXIT INT TERM
fi

echo "  IP 할당 대기"
IP=""
i=0
while [ $i -lt 40 ]; do
  sleep 6
  d=$(api GET "/droplets/$DID")
  IP=$(echo "$d" | tr '{' '\n' | grep -A4 '"type":"public"' | grep -o '"ip_address":"[0-9.]*"' | head -1 | cut -d'"' -f4)
  [ -n "$IP" ] && break
  i=$((i + 1))
done
[ -n "$IP" ] || die "IP 를 받지 못했습니다"
echo "  IP: $IP"

echo "  SSH 대기"
i=0
while [ $i -lt 40 ]; do
  if ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
       -o ConnectTimeout=8 -o BatchMode=yes root@"$IP" 'true' 2>/dev/null; then
    echo "  접속 가능"
    break
  fi
  sleep 6
  i=$((i + 1))
done
[ $i -lt 40 ] || die "SSH 접속이 안 됩니다"

echo ""
echo "════════════════════════════════════════════════════════════"
echo " 5) 검사 실행"
echo "════════════════════════════════════════════════════════════"
echo ""
ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=15 root@"$IP" 'sh -s -- --burst' < "$HERE/ip-check.sh"

echo ""
[ "$1" = "--keep" ] && echo "서버를 남겨뒀습니다: root@$IP  (지울 때: sh tools/vps-test.sh --cleanup)"
