import type { PoliteFetcher } from "../fetcher.js";
import { parseSize } from "../units.js";
import type { AdapterStatus, Offer, SearchLocation, StoreAdapter } from "./types.js";

/**
 * Harris Teeter prices via the official Kroger public API (developer.kroger.com):
 * OAuth2 client credentials with the `product.compact` scope, a locations lookup near the
 * configured ZIP kept to Harris Teeter stores, then location-scoped product search.
 * The access token lives in memory only; it is never written to disk or logged.
 */

export const KROGER_API = "https://api.kroger.com/v1";
export const KROGER_SCOPE = "product.compact";
const TOKEN_MARGIN_MS = 60_000;
/** Matches the chain by name, or by "HART", a chain code reported (unverified) for Harris Teeter. */
const HARRIS_TEETER = /harris\s*teeter|^hart$/i;

export interface KrogerCredentials {
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
}

interface KrogerLocation {
  locationId?: string;
  chain?: string;
  name?: string;
}

interface KrogerItem {
  price?: { regular?: number; promo?: number };
  size?: string;
  soldBy?: string;
}

interface KrogerProduct {
  productId?: string;
  description?: string;
  brand?: string;
  items?: KrogerItem[];
}

function json<T>(body: string, what: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`Kroger ${what}: response is not JSON`);
  }
}

export class KrogerAdapter implements StoreAdapter {
  readonly store = "harris-teeter";
  readonly source = "kroger-api";
  private token: { value: string; expiresAt: number } | undefined;
  private readonly locations = new Map<string, Promise<string>>();

  constructor(
    private readonly fetcher: PoliteFetcher,
    private readonly credentials: KrogerCredentials | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  status(): AdapterStatus {
    return this.credentials === undefined
      ? {
          configured: false,
          reason: "set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in .env",
        }
      : { configured: true };
  }

  async search(term: string, location: SearchLocation): Promise<Offer[]> {
    const locationId = await this.locationId(location);
    const q = new URLSearchParams({
      "filter.term": term,
      "filter.locationId": locationId,
      "filter.limit": "10",
    });
    const body = await this.get(`/products?${q}`, "products");
    const products = json<{ data?: KrogerProduct[] }>(body, "products").data ?? [];
    const fetchedAt = new Date(this.now()).toISOString();
    const offers: Offer[] = [];
    for (const p of products) {
      const product = [p.brand, p.description].filter(Boolean).join(" ").trim() || "(unnamed)";
      for (const item of p.items ?? []) {
        const regular = item.price?.regular;
        if (typeof regular !== "number" || !(regular > 0)) continue; // not sold at this store
        const promoPrice = item.price?.promo;
        const promo = typeof promoPrice === "number" && promoPrice > 0 && promoPrice < regular;
        // Weight items are priced per pound; unit items carry their package size.
        const size =
          item.soldBy?.toLowerCase() === "weight"
            ? { size: 1, unit: "lb" }
            : (parseSize(item.size ?? "") ?? { size: 1, unit: item.size?.trim() || "?" });
        const offer: Offer = {
          store: this.store,
          term,
          product,
          price: promo ? promoPrice : regular,
          size: size.size,
          unit: size.unit,
          promo,
          source: this.source,
          fetchedAt,
        };
        if (promo) offer.regularPrice = regular;
        offers.push(offer);
      }
    }
    return offers;
  }

  /** Closest Harris Teeter to the ZIP (cached per run). */
  private locationId(location: SearchLocation): Promise<string> {
    const key = `${location.zip}/${location.radiusMiles}`;
    let p = this.locations.get(key);
    if (p === undefined) {
      p = (async () => {
        // No chain filter: the exact chain value is undocumented, so match by name instead.
        const q = new URLSearchParams({
          "filter.zipCode.near": location.zip,
          "filter.radiusInMiles": String(location.radiusMiles),
          "filter.limit": "50",
        });
        const body = await this.get(`/locations?${q}`, "locations");
        const all = json<{ data?: KrogerLocation[] }>(body, "locations").data ?? [];
        const ht = all.find(
          (l) =>
            l.locationId && (HARRIS_TEETER.test(l.chain ?? "") || HARRIS_TEETER.test(l.name ?? "")),
        );
        if (ht?.locationId === undefined) {
          throw new Error(`no Harris Teeter within ${location.radiusMiles} mi of ${location.zip}`);
        }
        return ht.locationId;
      })();
      p.catch(() => this.locations.delete(key));
      this.locations.set(key, p);
    }
    return p;
  }

  private async get(path: string, what: string): Promise<string> {
    const token = await this.accessToken();
    const res = await this.fetcher.request(`${KROGER_API}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) this.token = undefined;
    if (res.status !== 200) throw new Error(`Kroger ${what}: HTTP ${res.status}`);
    return res.body;
  }

  private async accessToken(): Promise<string> {
    if (this.token !== undefined && this.now() < this.token.expiresAt - TOKEN_MARGIN_MS) {
      return this.token.value;
    }
    if (this.credentials === undefined) throw new Error("Kroger adapter is not configured");
    const { clientId, clientSecret } = this.credentials;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await this.fetcher.request(`${KROGER_API}/connect/oauth2/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: KROGER_SCOPE,
      }).toString(),
    });
    // Never include the response body: it would carry the token on success.
    if (res.status !== 200) throw new Error(`Kroger token: HTTP ${res.status}`);
    const t = json<TokenResponse>(res.body, "token");
    if (typeof t.access_token !== "string" || t.access_token === "") {
      throw new Error("Kroger token: response has no access token");
    }
    const ttl = typeof t.expires_in === "number" ? t.expires_in * 1000 : 30 * 60 * 1000;
    this.token = { value: t.access_token, expiresAt: this.now() + ttl };
    return this.token.value;
  }
}
