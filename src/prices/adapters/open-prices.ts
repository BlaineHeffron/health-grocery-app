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
 * The API's `lat`/`lon`/`radius_km` filter (open_prices/api/prices/filters.py, PriceFilter) is
 * trusted only as a pre-filter: every row's own location is checked again here (US, inside the
 * radius), so a filter the server ignored can never put a far-away price under a local store.
 */

export const OPEN_PRICES_API = "https://prices.openfoodfacts.org/api/v1";
export const OPEN_PRICES_ATTRIBUTION =
  "Open Prices data © Open Food Facts contributors, ODbL 1.0 (https://prices.openfoodfacts.org)";
/** Downtown Charleston, SC: a public city-centre coordinate standing for the default ZIP. */
export const DEFAULT_CENTER = { lat: 32.7765, lon: -79.9311 };
/** The ZIP that DEFAULT_CENTER stands for (the default of HGA_PRICE_ZIP). */
export const DEFAULT_ZIP = "29401";
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
    osm_address_country_code?: string | null;
    /** DecimalField: serialized as a string. */
    osm_lat?: number | string | null;
    osm_lon?: number | string | null;
  } | null;
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
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

/** A row of the nearby query that passed every check, with its listed store. */
interface Usable {
  item: OpenPricesItem;
  store: string;
  price: number;
  date: string;
  label: string;
}

/** What the run's one nearby query returned and what was kept. */
interface AreaResult {
  pages: number;
  rows: number;
  usable: Usable[];
  outOfRange: number;
  unlisted: number;
  unusable: number;
}

export class OpenPricesAdapter implements StoreAdapter {
  readonly store = "open-prices";
  readonly source = "open-prices";
  readonly datedOffers = true;
  private area: Promise<AreaResult> | undefined;
  private areaKey = "";
  private result: AreaResult | undefined;
  /** Price ids returned as offers in this run (a price can match several terms). */
  private readonly matched = new Set<string>();

  constructor(
    private readonly fetcher: PoliteFetcher,
    /** HGA_PRICE_ZIP as configured; the centre stands for DEFAULT_ZIP only. */
    private readonly zip: string | undefined = undefined,
    private readonly now: () => number = Date.now,
  ) {}

  status(): AdapterStatus {
    return this.zip === undefined || this.zip === DEFAULT_ZIP
      ? { configured: true }
      : {
          configured: false,
          reason: `searches around downtown Charleston (ZIP ${DEFAULT_ZIP}) only; HGA_PRICE_ZIP is set to another ZIP`,
        };
  }

  /** One line on the run's nearby query: rows, offers and what was dropped. */
  note(): string | undefined {
    const r = this.result;
    if (r === undefined) return undefined;
    return (
      `1 nearby query (${r.pages} page${r.pages === 1 ? "" : "s"}): ${r.rows} rows, ` +
      `${this.matched.size} matched a search term at a listed store; dropped ` +
      `${r.outOfRange} out of range, ${r.unlisted} at unlisted stores, ` +
      `${r.unusable} without USD price or date`
    );
  }

  async search(term: string, location: SearchLocation): Promise<Offer[]> {
    if (location.zip !== DEFAULT_ZIP) {
      throw new Error(`Open Prices searches around ZIP ${DEFAULT_ZIP} only`);
    }
    const area = await this.nearby(location);
    const fetchedAt = new Date(this.now()).toISOString();
    const offers: Offer[] = [];
    for (const { item: p, store, price, date, label } of area.usable) {
      if (!matchesTerm(label, term) && !matchesTerm(p.category_tag ?? "", term)) continue;
      this.matched.add(String(p.id));
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

  /** Sorts one row: out of range, unlisted store, unusable, or usable. */
  private classify(p: OpenPricesItem, radiusKm: number, today: string) {
    const lat = num(p.location?.osm_lat);
    const lon = num(p.location?.osm_lon);
    if (
      lat === undefined ||
      lon === undefined ||
      (p.location?.osm_address_country_code ?? "").toUpperCase() !== "US" ||
      distanceKm(DEFAULT_CENTER, { lat, lon }) > radiusKm
    ) {
      return "outOfRange" as const;
    }
    const store = storeForLocation(p.location);
    if (store === undefined) return "unlisted" as const;
    const price = num(p.price);
    const date = p.date ?? "";
    if (
      price === undefined ||
      !(price >= 0) ||
      p.currency !== "USD" ||
      !isDay(date) ||
      date > today
    ) {
      return "unusable" as const;
    }
    const label = p.product?.product_name || p.product_name || p.category_tag || "";
    return { item: p, store, price, date, label };
  }

  /** The run's one nearby query (USD, newest first), checked row by row. */
  private nearby(location: SearchLocation): Promise<AreaResult> {
    const radiusKm = Math.round(location.radiusMiles * KM_PER_MILE * 10) / 10;
    const key = String(radiusKm);
    if (this.area === undefined || this.areaKey !== key) {
      this.areaKey = key;
      this.area = (async () => {
        const today = localDay(this.now());
        const r: AreaResult = {
          pages: 0,
          rows: 0,
          usable: [],
          outOfRange: 0,
          unlisted: 0,
          unusable: 0,
        };
        for (let page = 1; page <= MAX_PAGES; page++) {
          const q = new URLSearchParams({
            lat: String(DEFAULT_CENTER.lat),
            lon: String(DEFAULT_CENTER.lon),
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
          const body = parsePage(res.body);
          r.pages++;
          r.rows += body.items.length;
          for (const p of body.items) {
            const c = this.classify(p, radiusKm, today);
            if (typeof c === "string") r[c]++;
            else r.usable.push(c);
          }
          if (body.items.length === 0 || page >= body.pages) break;
        }
        this.result = r;
        return r;
      })();
      this.area.catch(() => {
        this.area = undefined;
      });
    }
    return this.area;
  }
}

/** The documented page envelope (open_prices/api/pagination.py); anything else is an error. */
function parsePage(text: string): { items: OpenPricesItem[]; pages: number } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Open Prices prices: response is not JSON");
  }
  const b = body as { items?: unknown; pages?: unknown; total?: unknown };
  if (
    body === null ||
    typeof body !== "object" ||
    !Array.isArray(b.items) ||
    !b.items.every((i) => i !== null && typeof i === "object") ||
    typeof b.pages !== "number" ||
    typeof b.total !== "number"
  ) {
    throw new Error("Open Prices prices: unexpected response shape (no items/pages/total)");
  }
  return { items: b.items as OpenPricesItem[], pages: b.pages };
}
