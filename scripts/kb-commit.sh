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

# 应用侧拼在提交信息前面的固定前缀（见 src/lark/kbCards.ts 的 COMMIT_PREFIX）。
PREFIX="chore(kb): "

log() { printf '%s [kb-commit] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# 只认普通文件。容器对 data/ 有写权限，而 `-f` 会跟随软链——一个指向宿主文件的软链
# 就能把那个文件的前 120 字符读进提交信息，再随 push 发到远端。请求文件名是固定的，
# 出现软链一定是被做过手脚，直接丢弃。
if [ -L "$REQ" ]; then
  log "提交请求是符号链接，拒绝处理：$REQ"
  rm -f "$REQ"
  exit 1
fi
[ -f "$REQ" ] || exit 0
[ -d "$REPO/.git" ] || { log "不是 git 仓库：$REPO"; exit 1; }

# 防并发：同一时刻只跑一份。没有 flock 就靠触发粒度兜底。
if command -v flock >/dev/null 2>&1; then
  exec 9>"$REPO/.git/kb-commit.lock"
  flock -n 9 || exit 0
fi

# 提交信息：限读 + 单行化 + 去首尾空白 + 限长，避免有人用换行/超长在提交信息里做手脚。
MSG="$(head -c 4096 "$REQ" | tr '\n' ' ' | tr -s ' ' | sed 's/^ *//; s/ *$//' | cut -c1-120)"
if [ -z "$MSG" ]; then
  rm -f "$REQ"
  log "提交说明为空，丢弃请求"
  exit 0
fi

# 必须带约定前缀：否则任何能写 data/ 的东西都能伪造 `fix:` / `revert:` 这类提交，
# 在仓库历史里冒充别的改动类型。
case "$MSG" in
  "$PREFIX"*) ;;
  *)
    rm -f "$REQ"
    log "提交说明缺少「${PREFIX}」前缀，丢弃请求：$MSG"
    exit 1
    ;;
esac

cd "$REPO"
# 同理只提交普通文件：kb/ 是容器可写的挂载，软链会被 git 记成 120000 推上远端
# （线上 kb.yaml 变成指向别处的软链），目录则会被整棵加进来。
if [ -L "$FILE" ] || [ ! -f "$FILE" ]; then
  rm -f "$REQ"
  log "$FILE 不是普通文件，拒绝提交"
  exit 1
fi
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
