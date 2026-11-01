#!/usr/bin/env bash
# Pushes a folder of screenshots as the only commit of a new branch, so a
# machine that can reach git but not the run's artifacts can fetch them:
#
#   bash scripts/screenshots/publish-branch.sh <folder> <name>
#   git fetch origin ci/screenshots/<run id>/<name>
#   git archive FETCH_HEAD | tar -x -C <dir>
#
# .github/workflows/screenshots.yml runs it after each job, with GITHUB_TOKEN,
# GITHUB_REPOSITORY and GITHUB_RUN_ID set. Every run gets its own branch, so
# nothing is overwritten, and the same job's branches from older runs are
# deleted once the new one is up: only the newest set stays.
set -euo pipefail

src=$1
branch="ci/screenshots/$GITHUB_RUN_ID/$2"
if [ ! -d "$src" ] || [ -z "$(ls -A "$src")" ]; then
  echo "publish: nothing in $src"
  exit 0
fi
dir=$(mktemp -d)
cp -R "$src"/. "$dir"/
cd "$dir"
git init -q
git checkout -q -b screenshots
git add -A
git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -q -m "Screenshots from run $GITHUB_RUN_ID ($2)"
remote="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
git push -q "$remote" "HEAD:refs/heads/$branch"
echo "publish: $(git ls-files | wc -l | tr -d ' ') files on $branch"

# older runs of this job: only ci/screenshots/<run id>/<name>, never another branch
git ls-remote --heads "$remote" "refs/heads/ci/screenshots/*/$2" | awk '{print $2}' | while read -r ref; do
  [ "$ref" = "refs/heads/$branch" ] && continue
  git push -q "$remote" --delete "$ref" && echo "publish: deleted ${ref#refs/heads/}"
done
