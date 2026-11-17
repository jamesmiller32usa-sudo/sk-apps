#!/bin/bash
# SK Inbox Robot: a 24/7 Chromium on this server with Business Suite open for the three pages
# and the SK Inbox Pictures extension in robot mode. Safe to run again (it updates and restarts).
set -e
REPO=https://raw.githubusercontent.com/jamesmiller32usa-sudo/sk-apps/main/tools/chrome-extension
DIR=/opt/sk-robot
PORT=3901

command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

# small servers: add 2 GB swap once so Chromium can never push n8n out of memory
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p $DIR/ext $DIR/config
for f in manifest.json content.js background.js; do curl -fsSL "$REPO/$f?t=$(date +%s)" -o $DIR/ext/$f; done
echo '{"robot":true}' > $DIR/ext/robot.json
chmod -R a+rX $DIR/ext
[ -f $DIR/pass.txt ] || openssl rand -hex 8 > $DIR/pass.txt
PASS=$(cat $DIR/pass.txt)

docker rm -f sk-robot >/dev/null 2>&1 || true
docker run -d --name sk-robot --restart unless-stopped --shm-size=1g --memory=2g --cpus=0.8 \
  --security-opt seccomp=unconfined \
  -e PUID=1000 -e PGID=1000 -e TZ=Asia/Dhaka \
  -e CUSTOM_USER=sk -e PASSWORD="$PASS" \
  -e CHROME_CLI="--load-extension=/ext --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling" \
  -v $DIR/config:/config -v $DIR/ext:/ext:ro \
  -p $PORT:3001 \
  lscr.io/linuxserver/chromium:latest >/dev/null

command -v ufw >/dev/null 2>&1 && ufw status | grep -q active && ufw allow $PORT/tcp >/dev/null || true
IP=$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
echo
echo "SK Inbox Robot is starting (first time takes 1-2 minutes)."
echo "Open:     https://$IP:$PORT   (the browser will warn about the certificate, click Advanced and continue)"
echo "User:     sk"
echo "Password: $PASS"
echo "Memory now:"; free -h | head -2
