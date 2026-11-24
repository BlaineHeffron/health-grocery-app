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
  /** "kroger-api" for adapter data, "manual" for entered or imported prices. */
  source: string;
  /** ISO timestamp the price was fetched or observed. */
  fetchedAt: string;
}

export interface SearchLocation {
  zip: string;
  radiusMiles: number;
}

export type AdapterStatus = { configured: true } | { configured: false; reason: string };

/** One automated store source. Stores without an allowed source have no adapter (manual). */
export interface StoreAdapter {
  readonly store: string;
  readonly source: string;
  status(): AdapterStatus;
  /** Offers for `term` at the store near `location`. Every request goes through the fetcher. */
  search(term: string, location: SearchLocation): Promise<Offer[]>;
}
