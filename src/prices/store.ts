import type { DatabaseSync } from "node:sqlite";
import type { Offer } from "./adapters/types.js";

/** An offer as stored: tied to a catalog item and the day it was observed. */
export interface StoredOffer extends Offer {
  item: string;
  /** YYYY-MM-DD */
  observedOn: string;
}

/** Local calendar date as YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isDay(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t) && new Date(t).toISOString().startsWith(s)
  );
}

export function insertOffer(db: DatabaseSync, o: StoredOffer): void {
  db.prepare(
    `INSERT INTO price_offers
       (store, item, term, product, price, regular_price, size, unit, promo, source, observed_on, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.store,
    o.item,
    o.term,
    o.product,
    o.price,
    o.regularPrice ?? null,
    o.size,
    o.unit,
    o.promo ? 1 : 0,
    o.source,
    o.observedOn,
    o.fetchedAt,
  );
}

export interface FetchRecord {
  status: "ok" | "backoff";
  detail: string | null;
}

export function getFetch(
  db: DatabaseSync,
  store: string,
  term: string,
  day: string,
): FetchRecord | undefined {
  const row = db
    .prepare("SELECT status, detail FROM price_fetches WHERE store = ? AND term = ? AND day = ?")
    .get(store, term, day);
  return row === undefined
    ? undefined
    : {
        status: row.status as FetchRecord["status"],
        detail: (row.detail as string | null) ?? null,
      };
}

/** Replaces the day's adapter offers for (store, term) and records the fetch, atomically. */
export function saveFetch(
  db: DatabaseSync,
  args: {
    store: string;
    source: string;
    item: string;
    term: string;
    day: string;
    fetchedAt: string;
  },
  result: { offers: Offer[] } | { backoff: string },
): void {
  db.exec("BEGIN");
  try {
    if ("offers" in result) {
      db.prepare(
        "DELETE FROM price_offers WHERE store = ? AND term = ? AND observed_on = ? AND source = ?",
      ).run(args.store, args.term, args.day, args.source);
      for (const o of result.offers) {
        insertOffer(db, { ...o, item: args.item, observedOn: args.day });
      }
    }
    db.prepare(
      `INSERT INTO price_fetches (store, term, day, fetched_at, status, detail) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (store, term, day) DO UPDATE SET
         fetched_at = excluded.fetched_at, status = excluded.status, detail = excluded.detail`,
    ).run(
      args.store,
      args.term,
      args.day,
      args.fetchedAt,
      "offers" in result ? "ok" : "backoff",
      "offers" in result ? null : result.backoff,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Offers for the given items: for each (store, item, source) only the rows of the most recent
 * observed day, so an older fetch or receipt is superseded by a newer one.
 */
export function latestOffers(db: DatabaseSync, items: readonly string[]): StoredOffer[] {
  if (items.length === 0) return [];
  const marks = items.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT o.* FROM price_offers o
       JOIN (SELECT store, item, source, MAX(observed_on) AS day FROM price_offers
             WHERE item IN (${marks}) GROUP BY store, item, source) m
         ON o.store = m.store AND o.item = m.item AND o.source = m.source AND o.observed_on = m.day
       ORDER BY o.store, o.item, o.id`,
    )
    .all(...items);
  return rows.map((r) => {
    const o: StoredOffer = {
      store: String(r.store),
      item: String(r.item),
      term: String(r.term),
      product: String(r.product),
      price: Number(r.price),
      size: Number(r.size),
      unit: String(r.unit),
      promo: Number(r.promo) === 1,
      source: String(r.source),
      observedOn: String(r.observed_on),
      fetchedAt: String(r.fetched_at),
    };
    if (r.regular_price !== null && r.regular_price !== undefined) {
      o.regularPrice = Number(r.regular_price);
    }
    return o;
  });
}
