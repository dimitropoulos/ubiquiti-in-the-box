#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/purge-pdf-only-commits.sh [--apply] [--include-root]

Lists commits that changed PDFs and nothing else. With --apply, drops those
commits using a root rebase after creating a recovery branch.
EOF
}

apply=false
include_root=false

for argument in "$@"; do
  case "$argument" in
    --apply) apply=true ;;
    --include-root) include_root=true ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $argument" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The worktree must be clean before rewriting history." >&2
  git status --short >&2
  exit 1
fi

branch=$(git branch --show-current)
if [[ -z "$branch" ]]; then
  echo "Detached HEAD is not supported; check out the branch to rewrite first." >&2
  exit 1
fi

mapfile -t commits < <(git rev-list --reverse --no-merges HEAD)
pdf_only_commits=()

for commit in "${commits[@]}"; do
  if ! git rev-parse --verify "$commit^" >/dev/null 2>&1 && [[ "$include_root" != true ]]; then
    echo "Skipping root commit $commit (use --include-root only after verifying it is safe)." >&2
    continue
  fi

  mapfile -t files < <(git diff-tree --root --no-commit-id --name-only -r "$commit")
  [[ "${#files[@]}" -gt 0 ]] || continue

  pdf_only=true
  for file in "${files[@]}"; do
    if [[ "$file" != *.pdf ]]; then
      pdf_only=false
      break
    fi
  done

  if [[ "$pdf_only" == true ]]; then
    pdf_only_commits+=("$commit")
    printf '%s %s\n' "$commit" "$(git show -s --format=%s "$commit")"
  fi
done

if [[ "${#pdf_only_commits[@]}" -eq 0 ]]; then
  echo "No PDF-only commits found."
  exit 0
fi

if [[ "$apply" != true ]]; then
  echo
  echo "Dry run only. Re-run with --apply after reviewing these commits."
  exit 0
fi

printf '\nThis will rewrite %s and drop %s commit(s). Continue? [y/N] ' "$branch" "${#pdf_only_commits[@]}"
read -r confirmation
if [[ "$confirmation" != [yY] ]]; then
  echo "Aborted."
  exit 0
fi

backup_branch="backup-before-pdf-purge-$(date +%Y%m%d-%H%M%S)"
git branch "$backup_branch"
echo "Created recovery branch: $backup_branch"

hash_file=$(mktemp)
editor=$(mktemp)
trap 'rm -f "$hash_file" "$editor"' EXIT
printf '%s\n' "${pdf_only_commits[@]}" > "$hash_file"

cat > "$editor" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

todo=$1
while IFS= read -r hash; do
  temporary="$todo.tmp"
  awk -v hash="$hash" '
    $1 == "pick" && substr(hash, 1, length($2)) == $2 { $1 = "drop" }
    { print }
  ' "$todo" > "$temporary"
  mv "$temporary" "$todo"
done < "$PDF_PURGE_HASHES"
EOF
chmod +x "$editor"

export PDF_PURGE_HASHES="$hash_file"
# Later catalog commits contain the desired versions of files touched by a
# dropped PDF-only commit. Prefer those later versions if replay conflicts.
GIT_SEQUENCE_EDITOR="$editor" git rebase -i --rebase-merges --strategy-option=theirs --root

echo
echo "Rewrite complete. Review the result before pushing:"
echo "  git log --oneline --decorate --graph -30"
echo "  git diff --stat $backup_branch..HEAD"
echo "  git push --force-with-lease origin $branch"