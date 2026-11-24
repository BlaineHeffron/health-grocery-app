import type { BasketLine } from "./catalog.js";
import { daysBetween, type StoredOffer } from "./store.js";
import { normalizePrice } from "./units.js";

/** Bump when the JSON shape changes incompatibly (documented in docs/prices.md). */
export const COMPARE_SCHEMA = "hga.prices.compare/v1";

export interface PricedOffer {
  store: string;
  item: string;
  product: string;
  price: number;
  regularPrice?: number;
  size: number;
  unit: string;
  promo: boolean;
  source: string;
  observedOn: string;
  ageDays: number;
  /** Price per one comparison unit of the line. */
  unitPrice: number;
}

export interface ExcludedOffer extends Omit<PricedOffer, "unitPrice"> {
  reason: string;
}

export interface LineResult {
  line: string;
  entry: string;
  week: number | "every_week";
  seasonal: boolean;
  unit: string;
  alternatives: string[];
  /** Cheapest store's best offer; `item` says which alternative won. */
  best: PricedOffer | null;
  /** Best offer from a different store than `best`. */
  runnerUp: PricedOffer | null;
  /** Best offer per store, cheapest first. */
  byStore: PricedOffer[];
  /** Offers kept visible but not ranked (unconvertible unit, stale). */
  excluded: ExcludedOffer[];
}

export interface StoreBasket {
  store: string;
  /** Sum of one comparison unit of every covered line. */
  total: number;
  covered: number;
  missing: string[];
}

export interface Comparison {
  lines: LineResult[];
  singleStore: { best: StoreBasket | null; ranking: StoreBasket[] };
  split: {
    total: number;
    stores: string[];
    picks: { line: string; store: string; item: string; unitPrice: number }[];
    missing: string[];
  };
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Ranks offers per basket line, picks the cheapest single store for the whole basket and the
 * cheapest split basket. Pure: callers supply the offers and `today`.
 */
export function compare(
  lines: readonly BasketLine[],
  offers: readonly StoredOffer[],
  opts: { today: string; maxAgeDays: number },
): Comparison {
  const byItem = new Map<string, StoredOffer[]>();
  for (const o of offers) byItem.set(o.item, [...(byItem.get(o.item) ?? []), o]);

  const results: LineResult[] = lines.map((line) => {
    const excluded: ExcludedOffer[] = [];
    const bestPerStore = new Map<string, PricedOffer>();
    for (const alt of line.alternatives) {
      for (const o of byItem.get(alt.name) ?? []) {
        const base = {
          store: o.store,
          item: o.item,
          product: o.product,
          price: o.price,
          size: o.size,
          unit: o.unit,
          promo: o.promo,
          source: o.source,
          observedOn: o.observedOn,
          ageDays: daysBetween(o.observedOn, opts.today),
          ...(o.regularPrice === undefined ? {} : { regularPrice: o.regularPrice }),
        };
        if (base.ageDays > opts.maxAgeDays) {
          excluded.push({
            ...base,
            reason: `stale: ${base.ageDays} d old (cutoff ${opts.maxAgeDays} d)`,
          });
          continue;
        }
        const n = normalizePrice(o.price, o.size, o.unit, line.unit);
        if (!n.ok) {
          excluded.push({ ...base, reason: n.reason });
          continue;
        }
        const priced = { ...base, unitPrice: r4(n.unitPrice) };
        const prev = bestPerStore.get(o.store);
        if (prev === undefined || priced.unitPrice < prev.unitPrice)
          bestPerStore.set(o.store, priced);
      }
    }
    const byStore = [...bestPerStore.values()].sort(
      (a, b) => a.unitPrice - b.unitPrice || a.store.localeCompare(b.store),
    );
    return {
      line: line.line,
      entry: line.entry,
      week: line.week,
      seasonal: line.seasonal,
      unit: line.unit,
      alternatives: line.alternatives.map((a) => a.name),
      best: byStore[0] ?? null,
      runnerUp: byStore[1] ?? null,
      byStore,
      excluded,
    };
  });

  const stores = [...new Set(results.flatMap((r) => r.byStore.map((o) => o.store)))];
  const ranking: StoreBasket[] = stores
    .map((store) => {
      let total = 0;
      let covered = 0;
      const missing: string[] = [];
      for (const r of results) {
        const o = r.byStore.find((x) => x.store === store);
        if (o === undefined) missing.push(r.line);
        else {
          total += o.unitPrice;
          covered++;
        }
      }
      return { store, total: r2(total), covered, missing };
    })
    .sort((a, b) => b.covered - a.covered || a.total - b.total || a.store.localeCompare(b.store));

  const picks = results.flatMap((r) =>
    r.best === null
      ? []
      : [{ line: r.line, store: r.best.store, item: r.best.item, unitPrice: r.best.unitPrice }],
  );
  return {
    lines: results,
    singleStore: { best: ranking[0] ?? null, ranking },
    split: {
      total: r2(picks.reduce((sum, p) => sum + p.unitPrice, 0)),
      stores: [...new Set(picks.map((p) => p.store))].sort(),
      picks,
      missing: results.filter((r) => r.best === null).map((r) => r.line),
    },
  };
}
