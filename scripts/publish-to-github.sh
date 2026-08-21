#!/usr/bin/env bash
# =============================================================================
# publish-to-github.sh
# -----------------------------------------------------------------------------
# 将本仓库（immortalwrt-25.12 + BeeconMini SEED AC5S 本地文件）重建为
# "单提交快照"并推送到个人 GitHub 仓库。
#
# 背景：本仓库从本地仓库 A (origin) 克隆，A 是 GitHub 的 blobless 部分克隆，
#       本地缺少历史 blob，无法(也不应)推送全量历史。因此每次发布都生成一个
#       无历史根提交（含当前完整代码树 + 被 gitignore 的 AC5S 本地文件），
#       以强制推送方式覆盖 GitHub 上的 main 分支。
#
# 用法：
#   ./scripts/publish-to-github.sh          # 正常发布
#   DRY_RUN=1 ./scripts/publish-to-github.sh # 只重建快照，不推送（安全检查）
#
# 注意：AC5S 本地文件（dts/驱动包/MERGE-NOTES.md）只在 publish 分支被跟踪，
#       在 openwrt-25.12 分支靠 .gitignore 保护。因此请勿手动执行
#       "git checkout publish" 来回切换——切回时 git 会删除这些工作区文件，
#       本脚本已内置自动恢复；需要查看快照内容请用:
#       git show publish:<文件路径>  或直接在 GitHub 上查看。
#
# 依赖：
#   - 远端 origin 指向本地仓库 A（默认 ~/immortalwrt-25.12）
#   - 远端 github 指向个人 GitHub 仓库
#   - GitHub 认证方式（SSH key 或 PAT）已配置
# =============================================================================
set -euo pipefail

TOPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TOPDIR"

WORK_BRANCH="openwrt-25.12"     # 日常开发分支（从 A 拉取更新）
PUBLISH_BRANCH="publish"        # 单提交快照分支（推送到 GitHub）
GH_REMOTE="github"              # GitHub 远端名
TMP_BRANCH="_publish_new_$$"    # 重建快照用的临时分支
DRY_RUN="${DRY_RUN:-0}"

# --- 0. 更新上游仓库 A（若 origin 是本地路径） -------------------------------
ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
if [[ "$ORIGIN_URL" == /* && -d "$ORIGIN_URL" ]]; then
    echo "==> [1/4] 更新上游仓库 A（$ORIGIN_URL）..."
    if git -C "$ORIGIN_URL" pull --ff-only 2>&1 | tail -2; then
        echo "     A 已是最新/更新完成。"
    else
        echo "     !! A 更新失败，继续执行（若需可稍后手动更新 A）"
    fi
else
    echo "==> [1/4] 跳过更新 A（origin 不是本地路径或目录不存在）"
fi

# --- 1. 确保位于工作分支并拉取 A 的最新代码 ----------------------------------
echo "==> [2/4] 从本地 A 拉取更新到 $WORK_BRANCH ..."
git checkout -q "$WORK_BRANCH" || { echo "!! 无法切到 $WORK_BRANCH（可能有未提交改动）"; exit 1; }
if ! git pull origin "$WORK_BRANCH"; then
    echo "!! git pull 失败（可能有冲突）。请先手动解决后重试本脚本。"
    exit 1
fi

# --- 2. 检查 AC5S 关键文件齐全后重建单提交快照 -------------------------------
echo "==> [3/4] 重建 $PUBLISH_BRANCH 单提交快照 ..."

# AC5S 文件在本分支不被跟踪（gitignore 保护）。若缺失（例如上次切分支被 git 清理），
# 从已有的 publish 快照恢复；若连 publish 都没有则报错退出。
AC5S_PATHS=(
    package/kernel/rtl8373n-ac5s
    target/linux/mediatek/dts/mt7987a-beeconmini-seed-ac5s.dts
    target/linux/mediatek/dts/mt7987a-beeconmini-seed-ac5s-nor.dts
    MERGE-NOTES.md
)
if [ ! -f package/kernel/rtl8373n-ac5s/Makefile ]; then
    if git rev-parse --verify "$PUBLISH_BRANCH" >/dev/null 2>&1; then
        echo "     AC5S 本地文件缺失，从 $PUBLISH_BRANCH 恢复..."
        git restore --source="$PUBLISH_BRANCH" --worktree -- "${AC5S_PATHS[@]}"
    else
        echo "!! 缺少关键文件且 $PUBLISH_BRANCH 分支不存在，无法恢复。"
        exit 1
    fi
fi
for f in \
    package/kernel/rtl8373n-ac5s/Makefile \
    package/kernel/rtl8373n-ac5s/src/rtl8373n.ko \
    target/linux/mediatek/dts/mt7987a-beeconmini-seed-ac5s.dts \
    target/linux/mediatek/dts/mt7987a-beeconmini-seed-ac5s-nor.dts; do
    [ -f "$f" ] || { echo "!! 缺少关键文件: $f"; exit 1; }
done

BASE_COMMIT="$(git rev-parse --short origin/$WORK_BRANCH 2>/dev/null || echo unknown)"
git checkout -q --orphan "$TMP_BRANCH"
git rm -r -q --cached . 2>/dev/null || true
# 正常添加（遵循 .gitignore，编译产物 *.o/conf 等不会进入快照）
git add -A
# 仅对被 gitignore 保护的 AC5S 本地文件强制添加
git add -f "${AC5S_PATHS[@]}"
git commit -q -m "ImmortalWrt 25.12 + BeeconMini SEED AC5S support (snapshot @ $BASE_COMMIT)"
git branch -q -D "$PUBLISH_BRANCH" 2>/dev/null || true
git branch -q -m "$TMP_BRANCH" "$PUBLISH_BRANCH"

FILES="$(git ls-files | wc -l)"
echo "     快照已重建：$FILES 个文件，基线 $BASE_COMMIT"
git checkout -q "$WORK_BRANCH"

# 切回工作分支时，git 会删除 publish 中跟踪、但本分支不跟踪的 AC5S 文件，
# 这里从刚重建的快照把它们恢复为本地未跟踪文件（gitignore 保护不变）。
git restore --source="$PUBLISH_BRANCH" --worktree -- "${AC5S_PATHS[@]}" 2>/dev/null || \
    { echo "!! 快照恢复 AC5S 文件失败，请手动执行:"; echo "   git restore --source=$PUBLISH_BRANCH --worktree -- ${AC5S_PATHS[*]}"; }

# --- 3. 推送到 GitHub ---------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
    echo "==> [4/4] DRY_RUN=1：跳过推送。"
    echo "     确认无误后执行: ./scripts/publish-to-github.sh"
else
    echo "==> [4/4] 推送到 GitHub（$GH_REMOTE）..."
    if ! git remote get-url "$GH_REMOTE" >/dev/null 2>&1; then
        echo "!! 不存在名为 $GH_REMOTE 的远端，请先执行:"
        echo "   git remote add $GH_REMOTE git@github.com:<用户名>/<仓库名>.git"
        exit 1
    fi
    git push -f "$GH_REMOTE" "$PUBLISH_BRANCH:main"
    echo "==> 完成！$(git remote get-url "$GH_REMOTE")"
fi

echo "==> 本地已回到 $WORK_BRANCH 分支，工作流不受影响。"
