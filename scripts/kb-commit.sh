#!/usr/bin/env bash
#
# 把容器写下的「正式知识库提交请求」落成一次 git 提交并推送。
#
# 容器不挂 .git、也没有 SSH 凭据，所以提交与推送都在宿主完成：
#   容器改 kb/kb.yaml → 写 data/kb-commit-request.txt（提交信息）
#   → 本脚本（cron 或 systemd timer 触发）git add/commit/push → 删掉请求文件
#
# 环境变量（都有默认值）：
#   KB_REPO              仓库目录（默认本脚本所在仓库的根）
#   KB_FILE              要提交的文件（默认 kb/kb.yaml）
#   KB_GIT_REMOTE        push 的远端（默认 origin）
#   KB_GIT_PUSH          是否推送（默认 true；设 false 只提交）
#   KB_GIT_AUTHOR_NAME   / KB_GIT_AUTHOR_EMAIL   提交者身份
#
set -euo pipefail

REPO="${KB_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
FILE="${KB_FILE:-kb/kb.yaml}"
REQ="$REPO/data/kb-commit-request.txt"
REMOTE="${KB_GIT_REMOTE:-origin}"
PUSH="${KB_GIT_PUSH:-true}"
AUTHOR_NAME="${KB_GIT_AUTHOR_NAME:-kb-bot}"
AUTHOR_EMAIL="${KB_GIT_AUTHOR_EMAIL:-kb-bot@localhost}"

log() { printf '%s [kb-commit] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

[ -f "$REQ" ] || exit 0
[ -d "$REPO/.git" ] || { log "不是 git 仓库：$REPO"; exit 1; }

# 防并发：同一时刻只跑一份。没有 flock 就靠触发粒度兜底。
if command -v flock >/dev/null 2>&1; then
  exec 9>"$REPO/.git/kb-commit.lock"
  flock -n 9 || exit 0
fi

# 提交信息：单行化 + 去首尾空白 + 限长，避免有人用换行/超长在提交信息里做手脚。
MSG="$(tr '\n' ' ' < "$REQ" | tr -s ' ' | sed 's/^ *//; s/ *$//' | cut -c1-120)"
if [ -z "$MSG" ]; then
  rm -f "$REQ"
  log "提交说明为空，丢弃请求"
  exit 0
fi

cd "$REPO"
git add -- "$FILE"
if git diff --cached --quiet -- "$FILE"; then
  rm -f "$REQ"
  log "$FILE 无变化，丢弃请求"
  exit 0
fi

git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" -c commit.gpgsign=false \
  commit -m "$MSG" -- "$FILE"
rm -f "$REQ"

if [ "$PUSH" = "true" ]; then
  git push "$REMOTE" HEAD
  log "已提交并推送：$MSG"
else
  log "已提交（未推送）：$MSG"
fi
