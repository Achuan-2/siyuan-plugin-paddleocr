#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

usage() {
    echo "用法：bash gh_release.sh [--dry-run]"
    echo "--dry-run  只检查、构建和打包，不推送代码或创建 GitHub Release。"
}

dry_run=false
case "${1:-}" in
    "") ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
esac
if (( $# > 1 )); then
    usage
    exit 1
fi

for command in git node pnpm; do
    command -v "$command" >/dev/null || { echo "缺少命令：$command" >&2; exit 1; }
done

node scripts/sync-version.mjs
version=$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync("plugin.json", "utf8")).version);')
repository=$(node --input-type=module -e 'import fs from "node:fs"; const url = new URL(JSON.parse(fs.readFileSync("plugin.json", "utf8")).url); if (url.protocol !== "https:" || url.hostname !== "github.com" || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) throw new Error("plugin.json.url 必须为 GitHub 仓库地址"); console.log(url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, ""));')
tag="v$version"

if ! "$dry_run"; then
    command -v gh >/dev/null || { echo "缺少 GitHub CLI：gh" >&2; exit 1; }
    gh auth status
    if [[ -n "$(git status --porcelain)" ]]; then
        echo "请先提交待发布的改动（包括同步后的 package.json），再运行发布脚本；可用 --dry-run 检查未提交的代码。" >&2
        exit 1
    fi
    current_branch=$(git symbolic-ref --quiet --short HEAD) || { echo "请切换到待发布分支。" >&2; exit 1; }
    origin=$(git remote get-url origin)
    origin=${origin#https://github.com/}
    origin=${origin#git@github.com:}
    origin=${origin#ssh://git@github.com/}
    origin=${origin%/}
    origin=${origin%.git}
    if [[ "$origin" != "$repository" ]]; then
        echo "origin 与 plugin.json.url 指向不同仓库，已停止发布。" >&2
        exit 1
    fi
    remote_tag=$(git ls-remote --tags origin "refs/tags/$tag")
    release_tags=$(gh api "repos/$repository/releases" --paginate --jq '.[].tag_name')
    if git show-ref --verify --quiet "refs/tags/$tag" || [[ -n "$remote_tag" ]] || grep -Fxq "$tag" <<< "$release_tags"; then
        echo "$tag 已存在，请更新版本号；脚本不会覆盖已有标签或 Release。" >&2
        exit 1
    fi
fi

echo "检查并打包 $repository $tag ..."
pnpm run typecheck
pnpm test
pnpm run build:release

if "$dry_run"; then
    echo "发布预检通过：package.zip 已生成，未推送代码或创建 Release。"
    exit 0
fi

# 构建必须保持源码不变，确保发布包对应即将推送的提交。
if [[ -n "$(git status --porcelain)" ]]; then
    echo "构建过程中源码发生变化，已停止发布。" >&2
    exit 1
fi
commit=$(git rev-parse HEAD)
git push origin "HEAD:refs/heads/$current_branch"

# CHANGELOG.md 可选；有当前版本条目时使用该条目，否则由 GitHub 生成说明。
release_notes=""
if [[ -f CHANGELOG.md ]]; then
    release_notes=$(awk -v version="$tag" '
        /^## / { active = ($2 == version || $2 == substr(version, 2)); next }
        active { print }
    ' CHANGELOG.md)
fi
notes_args=(--generate-notes)
if [[ -n "${release_notes//[[:space:]]/}" ]]; then
    notes_args=(--notes "$release_notes")
fi

release_flags=(--latest)
if [[ "$version" == *-* ]]; then
    release_flags=(--prerelease --latest=false)
fi

gh release create "$tag" package.zip \
    --repo "$repository" \
    --target "$commit" \
    --title "$tag / $(date +%Y%m%d)" \
    "${notes_args[@]}" \
    "${release_flags[@]}"

echo "已发布：https://github.com/$repository/releases/tag/$tag"
