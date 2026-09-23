# VPS 배포

내 PC 에서 먼저 돌려보고, 그 다음 서버로 옮긴다. 순서를 바꾸지 말 것 —
서버에서 처음 돌리면 무엇이 문제인지(코드인지 IP인지) 가릴 수 없다.

## 0단계 · 내 PC 에서 확인

```bash
node server.mjs
```

브라우저에서 http://127.0.0.1:8787 . 토큰 없이 열리지만 **내 PC 에서만** 열린다.

확인할 것:
- 사이트 옆에 robots 판정이 뜨는가
- 수집이 끝까지 도는가
- 결과가 나오고 CSV 가 받아지는가

여기서 안 되면 서버에서도 안 된다.

## 1단계 · 서버 만들기

| 항목 | 값 | 이유 |
|---|---|---|
| 리전 | **서울** | 대상 사이트가 전부 한국. 해외 IP 변수를 뺀다 |
| 사양 | 1vCPU / 1GB | 수집은 대부분 대기 시간이라 CPU 를 안 쓴다 |
| 이미지 | Ubuntu 24.04 | |
| 열 포트 | 22(SSH) 만 | 웹은 80/443 을 쓰되 Caddy 가 받는다 (4단계) |

1GB 를 권하는 이유: 헤드리스 Chrome 이 폴백으로 뜰 때 200~300MB 를 쓴다.
512MB 면 그때 죽는다.

## 2단계 · 서버 기본 설치

```bash
ssh root@<서버IP>

# Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs git curl

# 수집기를 돌릴 전용 사용자 (root 로 돌리지 않는다)
adduser --system --group --home /opt/miner miner
```

## 3단계 · 코드 올리기

내 PC 에서:

```bash
cd ~/pain-miner
tar czf miner.tar.gz --exclude=node_modules --exclude=out --exclude=.session \
  *.mjs *.json web core adapters tools README.md DEPLOY.md
scp miner.tar.gz root@<서버IP>:/tmp/
```

서버에서:

```bash
mkdir -p /opt/miner && tar xzf /tmp/miner.tar.gz -C /opt/miner
cd /opt/miner && npm install --omit=dev
chown -R miner:miner /opt/miner

# 브라우저 폴백을 쓸 거라면 (안 쓸 거면 건너뛰어도 된다)
apt-get install -y chromium-browser
```

Chromium 을 설치하면 `core/browser.mjs` 의 CHROME_CANDIDATES 에
`/usr/bin/chromium-browser` 가 이미 들어 있어 그대로 잡힌다.

먼저 확인:

```bash
sudo -u miner node /opt/miner/crawl.mjs --config /opt/miner/config.json --robots
sudo -u miner node /opt/miner/crawl.mjs --config /opt/miner/config.json --probe dcinside
```

**여기서 막히면 IP 문제다.** 내 PC 결과와 다르면 그게 답이다.
`tools/ip-check.sh` 를 돌려 어디가 어떻게 다른지 본다.

## 4단계 · 서비스로 올리기

토큰을 만든다. 이 토큰이 없으면 아무도 못 연다.

```bash
openssl rand -hex 24
```

`/etc/systemd/system/miner.service`:

```ini
[Unit]
Description=커뮤니티 수집기
After=network.target

[Service]
Type=simple
User=miner
WorkingDirectory=/opt/miner
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=TOKEN=여기에_만든_토큰
ExecStart=/usr/bin/node /opt/miner/server.mjs
Restart=on-failure
RestartSec=5

# 이 서비스가 건드릴 수 있는 범위를 좁힌다
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/miner/out /opt/miner/.session

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now miner
systemctl status miner
journalctl -u miner -f
```

`HOST=127.0.0.1` 인 점이 중요하다. 서버 자신만 접속할 수 있고,
바깥에는 다음 단계의 Caddy 가 HTTPS 로 열어준다.

## 5단계 · HTTPS 붙이기

도메인이 있다면 Caddy 가 인증서까지 자동으로 처리한다.

```bash
apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
miner.내도메인.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
systemctl reload caddy
```

접속: `https://miner.내도메인.com/?token=만든토큰`

도메인이 없으면 SSH 터널이 더 안전하고 간단하다 — 아무것도 공개하지 않는다:

```bash
ssh -L 8787:127.0.0.1:8787 root@<서버IP>
# 그리고 내 PC 브라우저에서 http://127.0.0.1:8787
```

이 경우 4단계의 TOKEN 도 필요 없다.

## 6단계 · 자동 수집 (선택)

매일 아침 한 번 돌리려면:

```bash
sudo -u miner crontab -e
```

```
0 7 * * * cd /opt/miner && /usr/bin/node crawl.mjs --config config.json >> out/cron.log 2>&1
```

`output.resume` 을 `true` 로 두면 이미 본 글은 건너뛰므로
매일 새 글만 쌓인다. 상대 서버 부담도 그만큼 준다.

---

## 배포 전 점검

- [ ] `node test.mjs` 가 전부 통과하는가
- [ ] `node tools/audit-claims.mjs` 에 걸리는 것이 없는가
- [ ] `TOKEN` 을 설정했는가 (외부 공개 시 필수 — 없으면 서버가 시작을 거부한다)
- [ ] `HOST=127.0.0.1` + 리버스 프록시인가 (서버를 직접 노출하지 않았는가)
- [ ] `rate.minDelayMs` 를 내 PC 보다 **느리게** 잡았는가

마지막 항목이 중요하다. 서버는 24시간 돌고 IP 하나로 나간다.
내 PC 에서 쓰던 속도를 그대로 쓰면 차단당하기 쉽다.

## 알아둘 것

**이 서버를 공개하면 누구든 내 서버에서 남의 사이트로 요청을 날릴 수 있다.**
`server.mjs` 는 TOKEN 없이 `HOST=0.0.0.0` 으로 시작하면 아예 거부한다.
이건 불편이 아니라 의도된 안전장치다.

**개인 도구와 서비스는 법적 위치가 다르다.** 혼자 쓰는 것과, 남들이 쓰게
열어두는 것은 다른 이야기다 (README 의 robots 정책 항목 참고).
