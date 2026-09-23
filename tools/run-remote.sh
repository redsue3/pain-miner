#!/bin/sh
# run-remote.sh — 원격 서버에서 ip-check.sh 를 돌리고 결과를 가져온다.
#
#   sh tools/run-remote.sh <ssh대상> [키파일]
#
# 예)
#   sh tools/run-remote.sh ubuntu@123.45.67.89 ~/.ssh/vps_key
#   sh tools/run-remote.sh myvps                  (~/.ssh/config 에 등록해둔 경우)
#
# 스크립트를 서버에 복사하지 않는다. stdin 으로 흘려보내고 그 자리에서 실행한다.
# 서버에는 아무것도 남지 않는다.

TARGET="$1"
KEY="$2"

if [ -z "$TARGET" ]; then
  echo "사용법: sh tools/run-remote.sh <ssh대상> [키파일]" >&2
  exit 1
fi

HERE=$(dirname "$0")
SCRIPT="$HERE/ip-check.sh"
[ -f "$SCRIPT" ] || { echo "ip-check.sh 를 찾을 수 없습니다: $SCRIPT" >&2; exit 1; }

SSHOPT="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o BatchMode=yes"
[ -n "$KEY" ] && SSHOPT="$SSHOPT -i $KEY"

echo "접속 확인: $TARGET"
# shellcheck disable=SC2086
ssh $SSHOPT "$TARGET" 'echo "  접속 성공: $(hostname) / $(uname -sm)"' || {
  echo "접속 실패. 호스트·사용자·키를 확인하세요." >&2
  exit 1
}

echo "curl 확인"
# shellcheck disable=SC2086
ssh $SSHOPT "$TARGET" 'command -v curl >/dev/null 2>&1 && echo "  curl 있음" || {
  echo "  curl 설치 중...";
  (command -v apt-get >/dev/null && sudo apt-get update -qq && sudo apt-get install -y -qq curl) ||
  (command -v dnf >/dev/null && sudo dnf install -y -q curl) ||
  (command -v yum >/dev/null && sudo yum install -y -q curl) ||
  echo "  curl 설치 실패 — 수동으로 설치해 주세요";
}'

echo ""
echo "검사 시작 (약 2분)"
echo ""
# shellcheck disable=SC2086
ssh $SSHOPT "$TARGET" 'sh -s -- --burst' < "$SCRIPT"
