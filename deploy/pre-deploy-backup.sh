#!/usr/bin/env bash
# One-shot safety net before the aicompany-adoption deploy: dump the prod DB
# to the VM operator's home dir (aiwebsite has no backup infra until
# BACKUP_BUCKET is provisioned — §9.4). Reads creds like deploy.sh: literal
# .env values, never sourced.
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
envval() { grep -E "^$1=" "$repo_dir/.env" | head -1 | cut -d= -f2-; }
ssh_ip="$(envval AIWEBSITE_SSH_IP)"
ssh_user="$(envval AIWEBSITE_USER)"
export SSHPASS="$(envval AIWEBSITE_PW)"
sshpass -e ssh -o StrictHostKeyChecking=accept-new "$ssh_user@$ssh_ip" '
  set -e
  f=~/pre-adoption-$(date +%Y%m%d-%H%M).sql.gz
  sudo -u postgres pg_dump aiwebsite | gzip > "$f"
  gunzip -t "$f"
  ls -la "$f"
  echo BACKUP-OK
  echo -n "public brain_memories rows: "
  sudo -u postgres psql -d aiwebsite -tAc "select count(*) from brain_memories where scope='"'"'public'"'"'"
'
