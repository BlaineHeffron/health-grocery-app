import type { PoliteFetcher } from "../fetcher.js";
import { isDay, localDay } from "../store.js";
import { canonicalUnit } from "../units.js";
import type { AdapterStatus, Offer, SearchLocation, StoreAdapter } from "./types.js";

/**
 * Crowd-sourced prices from Open Prices (Open Food Facts), prices.openfoodfacts.org, via its
 * public read API (no account). Data is ODbL: the output names the source and the licence
 * (OPEN_PRICES_ATTRIBUTION). One source covers many stores: each price's location is mapped
 * to a listed store id by brand or name; prices at other locations are dropped and counted.
 * Each offer keeps the price's own date, so its age is the contributor's observation date.
 * One nearby query per run (paged, at most MAX_PAGES) serves every search term from memory.
 */

export const OPEN_PRICES_API = "https://prices.openfoodfacts.org/api/v1";
export const OPEN_PRICES_ATTRIBUTION =
  "Open Prices data © Open Food Facts contributors, ODbL 1.0 (https://prices.openfoodfacts.org)";
/** Downtown Charleston, SC (public city-centre coordinate): the store list is Charleston-only. */
export const DEFAULT_CENTER = { lat: 32.7765, lon: -79.9311 };
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const KM_PER_MILE = 1.609344;

/** Listed store ids by OpenStreetMap brand or name. */
const STORE_PATTERNS: readonly [string, RegExp][] = [
  ["harris-teeter", /harris\s*teeter/i],
  ["publix", /publix/i],
  ["lowes-foods", /lowes\s*foods/i],
  ["food-lion", /food\s*lion/i],
  ["walmart", /walmart/i],
  ["aldi", /\baldi\b/i],
  ["costco", /costco/i],
  ["trader-joes", /trader\s*joe/i],
  ["whole-foods", /whole\s*foods/i],
];

/** The fields read from one item of GET /api/v1/prices (PriceFullSerializer, nested). */
export interface OpenPricesItem {
  id?: number;
  type?: string;
  product_name?: string | null;
  category_tag?: string | null;
  price?: number | string | null;
  price_is_discounted?: boolean;
  price_without_discount?: number | string | null;
  price_per?: string | null;
  currency?: string | null;
  date?: string | null;
  product?: {
    product_name?: string | null;
    product_quantity?: number | null;
    product_quantity_unit?: string | null;
  } | null;
  location?: {
    osm_name?: string | null;
    osm_brand?: string | null;
    osm_address_city?: string | null;
  } | null;
}

interface Page {
  items?: OpenPricesItem[];
  page?: number;
  pages?: number;
}

export function storeForLocation(loc: OpenPricesItem["location"]): string | undefined {
  for (const text of [loc?.osm_brand, loc?.osm_name]) {
    if (!text) continue;
    const hit = STORE_PATTERNS.find(([, re]) => re.test(text));
    if (hit !== undefined) return hit[0];
  }
  return undefined;
}

/** Lower-case words with a plural "s" dropped, so "en:collard-greens" ~ "collard green". */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/^[a-z]{2}:/, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** True when the term's words appear, in order and adjacent, in the label. */
export function matchesTerm(label: string, term: string): boolean {
  const l = words(label).join(" ");
  const t = words(term).join(" ");
  return t !== "" && ` ${l} `.includes(` ${t} `);
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function sizeOf(p: OpenPricesItem): { size: number; unit: string } {
  if (p.type === "CATEGORY") {
    if (p.price_per === "KILOGRAM") return { size: 1, unit: "kg" };
    if (p.price_per === "LITER") return { size: 1, unit: "l" };
    if (p.price_per === "UNIT") return { size: 1, unit: "each" };
    return { size: 1, unit: "?" };
  }
  const q = num(p.product?.product_quantity);
  const unit = canonicalUnit(p.product?.product_quantity_unit ?? "");
  // Unknown size stays visible as "Not ranked" instead of being ranked with a guess.
  return q !== undefined && q > 0 && unit !== undefined
    ? { size: q, unit }
    : { size: 1, unit: "?" };
}

export class OpenPricesAdapter implements StoreAdapter {
  readonly store = "open-prices";
  readonly source = "open-prices";
  readonly datedOffers = true;
  private area: Promise<OpenPricesItem[]> | undefined;
  private areaKey = "";
  /** Price ids dropped in this run (a price can match several terms; each counts once). */
  private dropped = { otherStore: new Set<string>(), unusable: new Set<string>() };

  constructor(
    private readonly fetcher: PoliteFetcher,
    private readonly center: { lat: number; lon: number } = DEFAULT_CENTER,
    private readonly now: () => number = Date.now,
  ) {}

  status(): AdapterStatus {
    return { configured: true };
  }

  /** Prices dropped in this run: at unlisted stores, or without a USD price or a date. */
  note(): string | undefined {
    const other = this.dropped.otherStore.size;
    const unusable = this.dropped.unusable.size;
    const parts = [
      ...(other > 0 ? [`${other} at unlisted stores`] : []),
      ...(unusable > 0 ? [`${unusable} without USD price or date`] : []),
    ];
    return parts.length === 0 ? undefined : `dropped ${parts.join(", ")}`;
  }

  async search(term: string, location: SearchLocation): Promise<Offer[]> {
    const items = await this.nearby(location);
    const today = localDay(this.now());
    const fetchedAt = new Date(this.now()).toISOString();
    const offers: Offer[] = [];
    for (const p of items) {
      const label = p.product?.product_name || p.product_name || p.category_tag || "";
      if (!matchesTerm(label, term) && !matchesTerm(p.category_tag ?? "", term)) continue;
      const store = storeForLocation(p.location);
      const price = num(p.price);
      const date = p.date ?? "";
      if (store === undefined) {
        this.dropped.otherStore.add(String(p.id));
        continue;
      }
      if (price === undefined || p.currency !== "USD" || !isDay(date) || date > today) {
        this.dropped.unusable.add(String(p.id));
        continue;
      }
      const regular = num(p.price_without_discount);
      const promo = p.price_is_discounted === true && regular !== undefined && regular > price;
      const where = [p.location?.osm_name, p.location?.osm_address_city].filter(Boolean).join(", ");
      const offer: Offer = {
        store,
        term,
        product: `${label || "(unnamed)"}${where ? ` @ ${where}` : ""} (Open Prices #${p.id ?? "?"})`,
        price,
        ...sizeOf(p),
        promo,
        source: this.source,
        fetchedAt,
        observedOn: date,
      };
      if (promo) offer.regularPrice = regular;
      offers.push(offer);
    }
    return offers;
  }

  /** Every USD price within the radius, newest first; fetched once per run. */
  private nearby(location: SearchLocation): Promise<OpenPricesItem[]> {
    const radiusKm = Math.round(location.radiusMiles * KM_PER_MILE * 10) / 10;
    const key = `${this.center.lat},${this.center.lon},${radiusKm}`;
    if (this.area === undefined || this.areaKey !== key) {
      this.areaKey = key;
      this.dropped = { otherStore: new Set(), unusable: new Set() };
      this.area = (async () => {
        const all: OpenPricesItem[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
          const q = new URLSearchParams({
            lat: String(this.center.lat),
            lon: String(this.center.lon),
            radius_km: String(radiusKm),
            currency: "USD",
            order_by: "-date",
            size: String(PAGE_SIZE),
            page: String(page),
          });
          const res = await this.fetcher.request(`${OPEN_PRICES_API}/prices?${q}`, {
            headers: { Accept: "application/json" },
          });
          if (res.status !== 200) throw new Error(`Open Prices prices: HTTP ${res.status}`);
          let body: Page;
          try {
            body = JSON.parse(res.body) as Page;
          } catch {
            throw new Error("Open Prices prices: response is not JSON");
          }
          all.push(...(body.items ?? []));
          if ((body.items ?? []).length === 0 || page >= (body.pages ?? 1)) break;
        }
        return all;
      })();
      this.area.catch(() => {
        this.area = undefined;
      });
    }
    return this.area;
  }
}
