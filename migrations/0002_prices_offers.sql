-- Price comparison (hga prices): offers from store adapters (cached per store, term and day)
-- and from manual or receipt entry (source 'manual'). Generic product prices only.
CREATE TABLE price_offers (
  id INTEGER PRIMARY KEY,
  store TEXT NOT NULL,
  item TEXT NOT NULL,            -- catalog item name (data/price-catalog.yaml)
  term TEXT NOT NULL,            -- search term (adapter) or the item name (manual)
  product TEXT NOT NULL,
  price REAL NOT NULL,           -- price paid: promo price when promo = 1
  regular_price REAL,
  size REAL NOT NULL,
  unit TEXT NOT NULL,
  promo INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,          -- 'kroger-api' or 'manual'
  observed_on TEXT NOT NULL,     -- YYYY-MM-DD: fetch day, or the receipt/shelf date
  fetched_at TEXT NOT NULL       -- ISO timestamp the row was fetched or entered
);
CREATE INDEX price_offers_store_item ON price_offers (store, item, observed_on);

-- One row per successful adapter search per day: a same-day re-run reads price_offers instead
-- of the network unless --refresh.
CREATE TABLE price_fetches (
  store TEXT NOT NULL,
  term TEXT NOT NULL,
  day TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (store, term, day)
);

-- A store's source answered 429/403: no run sends it anything before until_ms (epoch ms),
-- whatever the terms or flags.
CREATE TABLE price_backoffs (
  store TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL,
  detail TEXT NOT NULL
);
