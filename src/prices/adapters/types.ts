/** A price observation from an adapter or manual entry, before unit normalization. */
export interface Offer {
  store: string;
  /** Search term (adapter) or the item name (manual). */
  term: string;
  /** Product description as the source names it. */
  product: string;
  /** Price paid: the promo price when there is one, else the regular price. */
  price: number;
  /** Regular price when `promo` is true. */
  regularPrice?: number;
  size: number;
  unit: string;
  promo: boolean;
  /** "kroger-api" or "open-prices" for adapter data, "manual" for entered or imported prices. */
  source: string;
  /** ISO timestamp the price was fetched or observed. */
  fetchedAt: string;
  /** YYYY-MM-DD the price was observed, when the source dates it (default: the fetch day). */
  observedOn?: string;
}

export interface SearchLocation {
  zip: string;
  radiusMiles: number;
}

export type AdapterStatus = { configured: true } | { configured: false; reason: string };

/** One automated store source. Stores without an allowed source have no adapter (manual). */
export interface StoreAdapter {
  /** The listed store id, or the source id for an aggregator whose offers name their stores. */
  readonly store: string;
  readonly source: string;
  /**
   * True when offers carry their own `observedOn`: a refetch then replaces every earlier row
   * of (source, term), whatever its day or store.
   */
  readonly datedOffers?: boolean;
  status(): AdapterStatus;
  /** Optional summary of this run (e.g. dropped prices), shown with the run status. */
  note?(): string | undefined;
  /** Offers for `term` at the store near `location`. Every request goes through the fetcher. */
  search(term: string, location: SearchLocation): Promise<Offer[]>;
}
