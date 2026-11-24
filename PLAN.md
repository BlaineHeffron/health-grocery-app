# PLAN: health-grocery-app

## Architecture (proposal)
KitchenOwl stays the system of record for **recipes, the shopping list and the household**. This app is a small companion service on Dueno that adds what KitchenOwl lacks.

```
Phone (GrapheneOS, tailnet) ──> KitchenOwl web/app (:8449)          recipes, shopping list
          └──────────────────> companion web UI (tailnet-only port)  macros, rotation, prices
                                     │
                     companion service (Docker on Dueno, compose next to KitchenOwl)
                       ├─ KitchenOwl API client (token in .env)
                       ├─ SQLite db (own Docker volume): meal log, macro totals, rotation state, price cache
                       ├─ nutrition lookup: USDA FoodData Central (generic foods, no personal data sent)
                       ├─ weekly rotation job (systemd timer or in-app cron): pushes next week's items
                       └─ price adapters (per store), cached, rate-limited
```

- **Stack (proposed):** TypeScript/Node with a small HTTP API, server-rendered or light SPA UI, and SQLite. Docker Compose, `restart: unless-stopped`, bound to 127.0.0.1 and exposed only through `tailscale serve` like KitchenOwl.
- **Meal logging:** pick a KitchenOwl recipe (via its API) or a quick-add food, then choose servings. Macros come from per-ingredient USDA FDC matches cached locally, with manual overrides. Daily and weekly totals go against targets Blaine sets in the app (targets stay local).
- **Rotation:** `data/rotation.yaml` is the source of truth. The state is which week is current. The weekly job adds that week's items plus the "every week" staples to the KitchenOwl list, tagged so they can be cleared or skipped, and skips anything already on the list. Seasonal items (okra or zucchini) are gated by month.
- **Price comparison:** adapters per store near Charleston (candidates: Publix, Harris Teeter, Lowes Foods, Food Lion, Walmart, Costco, Aldi, Trader Joe's, Whole Foods), using official APIs or feeds where they exist (e.g. Kroger/Harris Teeter's public API) and manual or receipt entry otherwise. Results are cached daily, normalized per unit ($/lb, $/each), and shown as cheapest store per item and per basket.

## Phases
1. **MVP:** rotation file plus the weekly push to the KitchenOwl list (no UI needed), then the KitchenOwl API client and its tests.
2. Meal log plus macros (USDA FDC) and a minimal UI.
3. Price adapters (start with 1–2 stores that have real APIs), then a basket comparison view.
4. Polish: the phone home-screen web app, the weekly summary.

## Open questions
1. App name, and whether to create a private GitHub repo (`BlaineHeffron/<name>`).
2. Macro targets: set manually in the app, or none at first?
3. Which stores matter most around Charleston (and which are actually shopped)? Is Costco membership relevant?
4. Is scraping retail sites acceptable where no API exists, or only official APIs and manual entry?
5. Rotation push day and time (e.g. Saturday morning), and which KitchenOwl household or list?
6. Should the rotation also generate recipe suggestions from KitchenOwl recipes that use that week's vegetables?
7. Logging UX: phone-first web app is enough, or a KitchenOwl-native feel?
8. USDA FoodData Central API key (free) is OK to request? Only generic food names are sent.

## Development
See `AGENTS.md` for setup, checks and repo rules.
