---
description: Merge synced fork main into dev, keep local changes, build, install
---
This repo is a fork of the original Pi repo. We are on the `dev` branch. I just synced `main` with the original/upstream Pi.

Do this:

1. Fetch remotes. Fast-forward local `main` to `origin/main` (it should match upstream). Stay on `dev`.
2. Merge `origin/main` into `dev`. Do not rebase. Do not reset. Do not stash-drop or overwrite my work.
3. Keep my local `dev` changes without damaging them. Fork customizations that must survive: footer, theme tokens (`footerText`, `assistantMessageText`, `editorBg`), `/clear` context, `/context` skill totals, working indicator, slash-command behavior. When a conflict has both a fork change and an upstream change, keep both if they can coexist. Never take upstream if it deletes those fork features.
4. Resolve every conflict. Build with `npm run build:offline` (or coding-agent build if models fetch fails). Install so `~/.local/bin/pi` is the updated fork (`npm install -g .` from `packages/coding-agent` if the global link needs refresh).
5. Commit the merge on `dev`. Push `dev` to origin. Do not force-push. Do not push to `main`. Do not open an upstream PR.
6. Report only what recently landed from main. Bullet points only. No extra bloat.

Repo path: `/home/utpal/work/osc/pi/pi`.
