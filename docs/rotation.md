# Weekly rotation push

`hga rotation` adds the next week of the nutrient-variety rotation (`data/rotation.yaml`) to a
KitchenOwl shopping list: that week's items plus the `every_week` staples. It targets KitchenOwl
v0.8.1.

## Setup

1. **Create a long-lived token in KitchenOwl.** Sign in to the KitchenOwl app as the user the
   job should act as, open Settings, then your profile, and add a token under *Long-lived
   tokens* (name it e.g. `hga rotation`). Copy it once; KitchenOwl does not show it again.
   (Equivalent API call, with a normal session: `POST /api/auth/llt` with `{"device": "<name>"}`.)
   The user must be a member of the household that owns the target list.
2. **Fill in `.env`** (untracked; copy `.env.example`). Never commit or paste these values.
   - `KITCHENOWL_URL`: base URL of the KitchenOwl instance (with or without a trailing `/api`).
   - `KITCHENOWL_TOKEN`: the long-lived token.
   - `KITCHENOWL_HOUSEHOLD_ID`, `KITCHENOWL_LIST_ID`: the target household and shopping list.
     Which ones is Blaine's decision. Leave them empty and run `hga rotation push --dry-run`:
     the error lists the available households, then the lists of the chosen household, by id.
   - `HGA_DB_PATH` (optional): SQLite file for the state, default `data/hga.db`.
3. `npm run build`, then `npm run hga -- rotation show` (or `docker compose run --rm hga rotation show`).

## Commands

| Command | What it does |
| --- | --- |
| `hga rotation show [--week N]` | Next week, its item set for this month, the last 5 pushes. Offline; never creates the db. |
| `hga rotation push` | Adds the next week's set to the list, then advances the week (4 wraps to 1). |
| `hga rotation push --week N` | Pushes week N (1-4) instead. Logged, but the next-week pointer does **not** move. |
| `hga rotation push --dry-run` | Prints what would be added or skipped. Reads the list; writes nothing anywhere. |
| `hga rotation clear [--dry-run]` | Removes items this job added that still carry its mark. |

- **Names** go to the list exactly as written in the yaml (`collards or turnip greens` is one
  item).
- **Skip rule:** an item already on the list, compared ignoring case and surrounding or repeated
  whitespace, is skipped and left exactly as it is. Running `push` twice for the same week adds
  nothing the second time.
- **Mark:** every item the job adds gets the description `rotation wkN` (N = rotation week).
- **Clear** removes an item only if it is in the push log as added by this job, has not been
  cleared yet, and still has exactly that description on the list. A marked-looking item the job
  did not add, an added item whose description you edited, and items already on the list before
  the push all stay.
- **Seasonal items** (`seasonal: true`, today "okra or zucchini") are included only in the
  months listed in `seasonal_months` in `data/rotation.yaml`. Default, if the key is missing:
  `4-10` (April to October, suited to Charleston, SC). Edit the key to override; it accepts
  ranges (`4-10`), lists (`5,6,7`) and wrapping ranges (`11-2`). The month is the local month
  when the command runs.
- Invalid `--week` (0, 5, `2.5`) exits 2 before anything is read or written.

## State

The SQLite db (`HGA_DB_PATH`) holds, via `migrations/0002_rotation_state.sql`:

- `rotation_state`: the next rotation week (starts at 1).
- `rotation_push`: one row per push: time, week, whether `--week` was used, household and list,
  status (`running`, `ok`, `failed`) and the error.
- `rotation_push_item`: per item, `added` (with the KitchenOwl item id and mark), `skipped` or
  `failed`, and when `clear` removed it.

`push` creates and migrates the db if needed. The pointer advances only when every add
succeeded and no `--week` was given, in the same transaction that marks the push `ok`. If an add
fails (auth, timeout, server error), the push stops, is logged as `failed` with the items added
so far, the pointer stays, and the command exits 1. Running `push` again converges: the items
already added are skipped, the rest are added, and `clear` still finds the earlier ones through
the log. `--dry-run` and `show` open the db read-only and never create it.

Requests time out after 15 s. Errors name the method, API path and HTTP status, never the token
or the URL.

## Enabling the weekly timer (later)

`deploy/systemd/` has a user service and timer. **They are not installed.** The schedule,
Saturday 08:00 local, is a placeholder: the day and time are Blaine's decision. To enable later:

1. Edit `WorkingDirectory=` in `hga-rotation-push.service` to point at the checkout that holds
   `.env` and `docker-compose.yml`, and `OnCalendar=` in the timer to the chosen time.
2. Check with `npm run hga -- rotation push --dry-run` (or the compose equivalent) first.
3. Install for your user (no sudo):
   ```sh
   mkdir -p ~/.config/systemd/user
   cp deploy/systemd/hga-rotation-push.service deploy/systemd/hga-rotation-push.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now hga-rotation-push.timer
   systemctl --user list-timers 'hga-*'
   ```
   To keep the timer running while logged out, user lingering must be on for the account.
4. Logs: `journalctl --user -u hga-rotation-push.service`.

## Integration test

`npm run it:kitchenowl` builds, starts a disposable `tombursch/kitchenowl:v0.8.1` container
(`hga-kitchenowl-test`, its own volume, published on `127.0.0.1:18849`; override the port with
`HGA_IT_PORT`), onboards a synthetic account, runs `test/kitchenowl.integration.test.ts`, and
removes the container and volume. The test refuses any non-loopback host and ports 8449/8450.
It refuses to start if a container or volume with those names already exists. `npm test` skips
it unless `HGA_IT_KITCHENOWL_URL` is set.
