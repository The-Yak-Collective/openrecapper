# OpenRecapper repo guidance

This checkout may contain both the public OpenRecapper repository and legacy/private deployment history. Be explicit about which branch base you use.

## Remotes

- `origin` is the public GitHub repo: `The-Yak-Collective/openrecapper`.
- `private` is legacy/archived YC deployment history. Treat it as read-only unless the user explicitly asks otherwise.

## Branching rules

- For normal feature work or PRs to GitHub, always branch from current public main:
  ```bash
  git fetch origin
  git switch -c <feature-branch> origin/main
  ```
- For deployed YC bot hotfixes only, branch from `deploy/openrecapper-yc`, and make the branch name clearly deployment-scoped, e.g. `yc/<name>`.
- Do not create public feature branches from `deploy/openrecapper-yc`.
- Before pushing, verify the base with:
  ```bash
  git branch -vv
  git merge-base --is-ancestor origin/main HEAD && echo "contains origin/main"
  git log --oneline --decorate --graph --max-count=8
  ```

## Deployment note

The Hetzner bot can be deployed from built `dist/`, but deployment does not imply the source branch is suitable for a public PR. Keep public repo branches based on `origin/main`.
