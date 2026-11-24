import { readFileSync } from "node:fs";
import type { FetchImpl } from "../src/prices/fetcher.js";

/** Synthetic Kroger API response bodies (shaped like developer.kroger.com docs). */
export function krogerFixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/kroger/${name}`, import.meta.url), "utf8");
}

/** A fake clock: sleep() advances time instantly and records each wait. */
export function fakeClock(start = Date.parse("2026-11-24T15:00:00Z")) {
  const clock = {
    t: start,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  at: number;
}

type Route = (
  url: URL,
  init: RequestInit,
) => { status?: number; body?: string; headers?: Record<string, string> };

/** Fake fetch over routes keyed by pathname; records every request. Unrouted paths 404. */
export function fakeFetch(routes: Record<string, Route>, now: () => number = Date.now) {
  const calls: Recorded[] = [];
  const impl: FetchImpl = async (url, init) => {
    const u = new URL(url);
    const rec: Recorded = {
      url,
      method: init.method ?? "GET",
      headers: { ...(init.headers as Record<string, string>) },
      at: now(),
    };
    if (typeof init.body === "string") rec.body = init.body;
    calls.push(rec);
    const route = routes[u.pathname];
    const r = route ? route(u, init) : { status: 404, body: "" };
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { impl, calls };
}

/** Kroger routes over the fixtures; robots.txt answers 404 (no rules). */
export function krogerRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    "/v1/connect/oauth2/token": () => ({ body: krogerFixture("token.json") }),
    "/v1/locations": () => ({ body: krogerFixture("locations.json") }),
    "/v1/products": () => ({ body: krogerFixture("products-leeks.json") }),
    ...overrides,
  };
}

/** Synthetic Open Prices API bodies (shaped like GET /api/v1/prices, PriceFullSerializer). */
export function openPricesFixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/open-prices/${name}`, import.meta.url), "utf8");
}

/** Open Prices routes over the fixture; robots.txt answers 200 with an empty body (no rules). */
export function openPricesRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    "/robots.txt": () => ({ body: "" }),
    "/api/v1/prices": () => ({ body: openPricesFixture("prices-nearby.json") }),
    ...overrides,
  };
}
