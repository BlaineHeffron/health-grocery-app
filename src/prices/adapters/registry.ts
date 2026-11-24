import type { Config } from "../../config.js";
import type { PoliteFetcher } from "../fetcher.js";
import { KrogerAdapter } from "./kroger.js";
import { OPEN_PRICES_ATTRIBUTION, OpenPricesAdapter } from "./open-prices.js";
import type { StoreAdapter } from "./types.js";

export interface StoreInfo {
  id: string;
  name: string;
  /** "api" when an adapter exists; "manual" when prices come only from `hga prices add/import`. */
  kind: "api" | "manual";
}

/** Charleston, SC area stores. See docs/stores.md for why each is api or manual. */
export const STORES: readonly StoreInfo[] = [
  { id: "harris-teeter", name: "Harris Teeter", kind: "api" },
  { id: "publix", name: "Publix", kind: "manual" },
  { id: "lowes-foods", name: "Lowes Foods", kind: "manual" },
  { id: "food-lion", name: "Food Lion", kind: "manual" },
  { id: "walmart", name: "Walmart", kind: "manual" },
  { id: "aldi", name: "Aldi", kind: "manual" },
  { id: "costco", name: "Costco", kind: "manual" },
  { id: "trader-joes", name: "Trader Joe's", kind: "manual" },
  { id: "whole-foods", name: "Whole Foods Market", kind: "manual" },
];

/** Sources that cover many stores; their offers name a listed store. See docs/stores.md. */
export interface SourceInfo {
  id: string;
  name: string;
  kind: "aggregator";
  /** Licence notice shown with any of its prices (required by the source's licence). */
  attribution: string;
}

export const SOURCES: readonly SourceInfo[] = [
  {
    id: "open-prices",
    name: "Open Prices (Open Food Facts)",
    kind: "aggregator",
    attribution: OPEN_PRICES_ATTRIBUTION,
  },
];

export function storeById(id: string): StoreInfo {
  const store = STORES.find((s) => s.id === id);
  if (store === undefined) {
    throw new Error(`unknown store "${id}" (one of: ${STORES.map((s) => s.id).join(", ")})`);
  }
  return store;
}

/**
 * Builds the adapters for every `api` store and every aggregator source from config
 * (credentials stay in memory).
 */
export function createAdapters(config: Config, fetcher: PoliteFetcher): StoreAdapter[] {
  const clientId = config.optional("KROGER_CLIENT_ID");
  const clientSecret = config.optional("KROGER_CLIENT_SECRET");
  const credentials =
    clientId !== undefined && clientSecret !== undefined ? { clientId, clientSecret } : undefined;
  return [
    new KrogerAdapter(fetcher, credentials),
    new OpenPricesAdapter(fetcher, config.optional("HGA_PRICE_ZIP")),
  ];
}
