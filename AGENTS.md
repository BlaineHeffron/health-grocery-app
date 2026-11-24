# AGENTS.md: rules for every room working in this repo

This repo is **public**. Read README.md (privacy rules) and PLAN.md first.

## Setup and gates
- Node 22 (>= 22.13; `node:sqlite` is built in). `npm ci` installs the dev tools; there are no runtime dependencies.
- `npm run check`: typecheck (`tsc`) plus lint/format (`biome check`). `npx biome check --write .` fixes formatting.
- `npm test`: builds to `dist/` and runs `node --test` over `dist/test/`.
- CLI: `npm run build && npm run hga -- --help`, or with Docker: `docker compose run --rm hga --help`.
  Remove containers and volumes you create for testing (`docker compose -p <name> down -v`).

## Adding code (parallel rooms)
- Subcommand: add `src/commands/<name>.ts` exporting a `Command` (`usage`, `run`), then add one
  line to the table in `src/commands/index.ts`.
- Schema: add `migrations/NNNN_<feature>_<what>.sql`. Never edit an applied migration. Two
  branches may use the same number; the filename is the id (see `migrations/README.md`).
- Config: add any new variable to `CONFIG_KEYS` in `src/config.ts` and to `.env.example` (empty
  value). Read it with `config.require(...)` / `config.optional(...)`; never print or log values.

## Privacy (binding; see README.md)
- Nothing from the private health folder, no personal or health data, no secrets.
- Secrets live only in the untracked `.env`. Never commit, print or log them.
- Never write real hostnames, tailnet addresses or absolute local paths into tracked files: refer
  to `KITCHENOWL_URL` and "the private health folder", and use synthetic examples in tests.
- Never write to or restart the real KitchenOwl or touch its volume unless your task says so.
- Published ports bind to `127.0.0.1` only. No `0.0.0.0`, no host networking.

## Before every push
Run `scripts/prepush-check.sh` (base `origin/main`, override with `PREPUSH_BASE`) and push only
when it prints OK. It is deliberately not a git hook: run it yourself, every time.

## Git and PRs
- Branch from `origin/main`; open PRs to `main`.
- The reviewer merges with a merge commit, only after posting APPROVED for the exact head SHA.
- No force-push, no squash, no history rewrites of pushed branches.
- GitHub Actions failures are expected (no billing) and are not a blocker. Do not add or fix CI.
- No sudo, no global installs, no system changes (systemd units, host config), no deploys.
