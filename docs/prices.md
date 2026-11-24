# Price comparison (`hga prices`)

Compares Charleston, SC grocery prices for the rotation items. Stores and their sources:
`docs/stores.md`. Harris Teeter comes from the Kroger API (`docs/kroger-signup.md`); every other
store is manual entry.

```
hga prices compare [--week N | --all] [--json] [--refresh] [--offline] [--max-age-days N]
hga prices add --store <id> --item <entry|item> --price <p> --size <n> --unit <u> [--date YYYY-MM-DD] [--promo] [--product <text>]
hga prices import <file.csv>
hga prices stores
```

Store ids: `harris-teeter`, `publix`, `lowes-foods`, `food-lion`, `walmart`, `aldi`, `costco`,
`trader-joes`, `whole-foods`.

## Catalog
`data/price-catalog.yaml` maps every `data/rotation.yaml` entry (all weeks plus `every_week`) to
items, search terms and a comparison unit (`lb`, `oz`, `kg`, `g`, `each`, `bunch`). `compare`
refuses to run if the two files disagree.

- `pick: any` entries ("collards or turnip greens") list alternatives sharing one unit; the
  cheapest alternative represents the entry and the output names it.
- `pick: all` entries ("shallots and garlic") become one basket line per part.
- `--item` takes an item name (`turnip greens`) or a single-item entry name (`leeks`).

## Units
Offers are converted to the line's unit: weights (lb, oz, kg, g), counts (`each`, `ct`, `head`,
`pc`; a 3 ct pack at $1.50 is $0.50 each) and bunches. An offer that cannot be converted (e.g.
`fl oz` for a `lb` line, or an unknown unit) stays visible under "Not ranked" with the reason.

## Freshness and cache
- Adapter results are stored per store, search term and day. A same-day re-run reads them from
  SQLite and makes no network calls; `--refresh` refetches today's; `--offline` skips adapters.
- A 429/403 is recorded for the day and the adapter stops for that day (no retries).
- For each store and item, only the most recent day's prices count (a newer receipt supersedes
  an older one). Prices older than `--max-age-days` (default `HGA_PRICE_MAX_AGE_DAYS`, 30) are
  shown as stale and not ranked. Every price shows its age in days.

## Manual entry and CSV import
`add` stores one price with source `manual`; `--date` is the receipt or shelf date (default
today). `import` reads a CSV with a header row:

| column | required | meaning |
|---|---|---|
| `store` | yes | store id |
| `item` | yes | item or single-item entry name (case-insensitive) |
| `price` | yes | price paid, e.g. `2.49` |
| `size` | yes | package size, e.g. `16` |
| `unit` | yes | `lb`, `oz`, `kg`, `g`, `each`/`ct`, `bunch`, ... |
| `date` | no | `YYYY-MM-DD`, default today |
| `promo` | no | `yes`/`no` |
| `product` | no | label, e.g. the receipt line |

Fields may be double-quoted (RFC 4180). Every row is validated first; if any row is bad,
nothing is imported and each bad row is listed.

```csv
store,item,price,size,unit,date,promo,product
aldi,leeks,1.50,1,lb,2026-11-20,,
publix,turnip greens,1.99,1,bunch,2026-11-22,yes,"Turnip greens, bunch"
```

## Baskets
Each basket line counts one comparison unit (1 lb, 1 each, 1 bunch...), so totals are a relative
price index, not a shopping bill.
- **Single store:** stores ranked by lines covered, then total; the lines a store lacks are listed.
- **Split basket:** the cheapest store for every line, the total and the stores used.

## JSON (`--json`), schema `hga.prices.compare/v1`
Keys appear in this order; new optional keys may be added without a schema bump.

```jsonc
{
  "schema": "hga.prices.compare/v1",
  "today": "2026-11-24",
  "scope": { "week": 1, "everyWeek": true },     // week: null for --all
  "maxAgeDays": 30,
  "stores": [                                      // all nine stores
    { "id": "harris-teeter", "name": "Harris Teeter", "kind": "api",
      "status": "ok | not-configured | error | offline", "detail": "..." },   // detail optional
    { "id": "publix", "name": "Publix", "kind": "manual", "status": "manual" }
  ],
  "lines": [{
    "line": "collards or turnip greens",          // "entry / item" for pick: all parts
    "entry": "collards or turnip greens",
    "week": 2,                                     // or "every_week"
    "seasonal": false,
    "unit": "bunch",
    "alternatives": ["collards", "turnip greens"],
    "best": Offer | null,                          // cheapest store; .item = winning alternative
    "runnerUp": Offer | null,                      // best offer from another store
    "byStore": [Offer],                            // best offer per store, cheapest first
    "excluded": [Offer without unitPrice, plus "reason"]
  }],
  "singleStore": {
    "best": { "store": "aldi", "total": 7.29, "covered": 3, "missing": ["fennel"] } | null,
    "ranking": [ /* same shape, every store with a ranked price */ ]
  },
  "split": {
    "total": 7.79, "stores": ["aldi", "publix"],
    "picks": [{ "line": "leeks", "store": "aldi", "item": "leeks", "unitPrice": 1.5 }],
    "missing": ["fennel"]                          // lines with no ranked price anywhere
  }
}
```

`Offer`: `store`, `item`, `product`, `price` (paid; promo price when `promo`), `regularPrice`
(only when `promo`), `size`, `unit`, `promo`, `source` (`kroger-api` or `manual`), `observedOn`
(`YYYY-MM-DD`), `ageDays`, `unitPrice` (per line unit, 4 decimals). Totals have 2 decimals.

## Settings (`.env`, all optional)
`HGA_PRICE_ZIP` (29401), `HGA_PRICE_RADIUS_MILES` (15), `HGA_PRICE_MAX_AGE_DAYS` (30),
`HGA_PRICE_MIN_INTERVAL_SECONDS` (3; lower values are raised to 3), `KROGER_CLIENT_ID`,
`KROGER_CLIENT_SECRET`.
