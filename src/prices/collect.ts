import type { DatabaseSync } from "node:sqlite";
import type { SearchLocation, StoreAdapter } from "./adapters/types.js";
import type { BasketLine } from "./catalog.js";
import { BackoffError } from "./fetcher.js";
import { getFetch, saveFetch } from "./store.js";

export interface AdapterRun {
  store: string;
  status: "ok" | "not-configured" | "error";
  detail?: string;
  /** Searches answered from today's cache vs. sent to the adapter. */
  cached: number;
  fetched: number;
}

/**
 * Fills today's cache for every configured adapter and every search term in `lines`.
 * A (store, term) already fetched today is skipped unless `refresh`. The first error stops
 * that adapter for this run (no retries); other adapters and manual prices are unaffected.
 */
export async function collectOffers(
  db: DatabaseSync,
  adapters: readonly StoreAdapter[],
  lines: readonly BasketLine[],
  opts: { day: string; location: SearchLocation; refresh: boolean; now?: () => number },
): Promise<AdapterRun[]> {
  const now = opts.now ?? Date.now;
  const searches = new Map<string, string>(); // term -> item
  for (const line of lines) {
    for (const alt of line.alternatives) for (const t of alt.terms) searches.set(t, alt.name);
  }
  const runs: AdapterRun[] = [];
  for (const adapter of adapters) {
    const status = adapter.status();
    const run: AdapterRun = { store: adapter.store, status: "ok", cached: 0, fetched: 0 };
    runs.push(run);
    if (!status.configured) {
      run.status = "not-configured";
      run.detail = status.reason;
      continue;
    }
    for (const [term, item] of searches) {
      const prior = getFetch(db, adapter.store, term, opts.day);
      if (prior !== undefined && !opts.refresh) {
        run.cached++;
        if (prior.status === "backoff") {
          run.status = "error";
          run.detail = `backed off earlier today: ${prior.detail ?? ""}`.trim();
          break;
        }
        continue;
      }
      const key = { store: adapter.store, source: adapter.source, item, term, day: opts.day };
      try {
        run.fetched++;
        const offers = await adapter.search(term, opts.location);
        saveFetch(db, { ...key, fetchedAt: new Date(now()).toISOString() }, { offers });
      } catch (err) {
        run.status = "error";
        run.detail = (err as Error).message;
        if (err instanceof BackoffError) {
          saveFetch(
            db,
            { ...key, fetchedAt: new Date(now()).toISOString() },
            { backoff: run.detail },
          );
        }
        break;
      }
    }
  }
  return runs;
}
