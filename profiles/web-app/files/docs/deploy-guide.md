# Deploy guide

## Hosting

Cloudflare Pages, building from the `main` branch. Build command `npm run build`, output directory `dist/`.

## Environment configuration

Set every server-side value in the Pages project (Settings → Environment variables), for both Production and Preview. Mirror the *names* — never the values — into `.env.example` and `.dev.vars.example` in the same PR that introduces them.

## Release flow

1. `/ship` — bumps the version, updates `CHANGELOG.md`, opens the PR.
2. Squash-merge to `main`; Pages builds automatically.
3. `/land-and-deploy` verifies the build landed and the deployed commit matches `main`.
4. `/canary` — check the live site for the specific behavior that changed, plus the home page, before calling it done.

## Rollback

Pages keeps prior deployments: Deployments → the last good build → *Rollback*. Do the rollback first, then fix forward; a revert PR is not the emergency path.
