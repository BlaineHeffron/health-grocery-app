import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import {
  matchesTerm,
  OpenPricesAdapter,
  storeForLocation,
} from "../src/prices/adapters/open-prices.js";
import { createAdapters, SOURCES } from "../src/prices/adapters/registry.js";
import { BackoffError, PoliteFetcher, USER_AGENT } from "../src/prices/fetcher.js";
import { fakeClock, fakeFetch, openPricesRoutes } from "./prices-helpers.js";

// Offline only: every request goes to a fake fetch over synthetic, API-shaped fixtures.
const near = { zip: "29401", radiusMiles: 15 };

function setup(routes = openPricesRoutes()) {
  const clock = fakeClock();
  const net = fakeFetch(routes, clock.now);
  const fetcher = new PoliteFetcher({ fetchImpl: net.impl, now: clock.now, sleep: clock.sleep });
  return { clock, net, adapter: new OpenPricesAdapter(fetcher, undefined, clock.now) };
}

const prices = (net: ReturnType<typeof setup>["net"]) =>
  net.calls.filter((c) => new URL(c.url).pathname === "/api/v1/prices");

test("robots.txt first, then one nearby query with the documented filters", async () => {
  const { net, adapter } = setup();
  assert.deepEqual(adapter.status(), { configured: true });
  await adapter.search("leeks", near);
  const [robots, query] = net.calls;
  assert.equal(robots?.url, "https://prices.openfoodfacts.org/robots.txt");
  const u = new URL(query?.url ?? "");
  assert.equal(u.origin + u.pathname, "https://prices.openfoodfacts.org/api/v1/prices");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    lat: "32.7765",
    lon: "-79.9311",
    radius_km: "24.1", // 15 mi
    currency: "USD",
    order_by: "-date",
    size: "100",
    page: "1",
  });
  assert.equal(query?.method, "GET");
  assert.equal(query?.headers.Accept, "application/json");
  assert.equal(query?.headers["User-Agent"], USER_AGENT);
  assert.equal(query?.headers.Authorization, undefined, "no account, no token");
});

test("prices map to listed stores with their own date, size and promo", async () => {
  const { adapter } = setup();
  const leeks = await adapter.search("leeks", near);
  assert.deepEqual(
    leeks.map((o) => [
      o.store,
      o.price,
      o.regularPrice,
      o.size,
      o.unit,
      o.promo,
      o.observedOn,
      o.source,
    ]),
    [
      ["publix", 4.4, undefined, 1, "kg", false, "2026-11-20", "open-prices"],
      ["harris-teeter", 2.99, 3.49, 454, "g", true, "2026-11-22", "open-prices"],
    ],
  );
  assert.equal(leeks[0]?.product, "en:leeks @ Publix, Example City (Open Prices #9001)");
  assert.equal(leeks[0]?.term, "leeks");
  assert.match(leeks[0]?.fetchedAt ?? "", /^2026-11-24T/);

  const collards = await adapter.search("collard greens", near);
  // 9003 is at an unlisted store (dropped); 9004 has no package size: kept, unit "?".
  assert.deepEqual(
    collards.map((o) => [o.store, o.size, o.unit]),
    [["food-lion", 1, "?"]],
  );
  // EUR (9005) and undated (9007) leeks are dropped, each id counted once across terms.
  await adapter.search("leeks", near);
  assert.equal(adapter.note(), "dropped 1 at unlisted stores, 2 without USD price or date");
});

test("one nearby fetch serves every term in a run; pages are spaced by the fetcher", async () => {
  const page = (n: number) =>
    JSON.stringify({
      items: [
        {
          id: n,
          type: "CATEGORY",
          category_tag: n === 1 ? "en:leeks" : "en:carrots",
          price: "2.00",
          price_per: "KILOGRAM",
          currency: "USD",
          date: "2026-11-20",
          location: { osm_brand: "Aldi", osm_name: "Aldi" },
        },
      ],
      page: n,
      pages: 2,
      size: 1,
      total: 2,
    });
  const { clock, net, adapter } = setup(
    openPricesRoutes({
      "/api/v1/prices": (u) => ({ body: page(Number(u.searchParams.get("page"))) }),
    }),
  );
  assert.equal((await adapter.search("leeks", near)).length, 1);
  assert.equal((await adapter.search("carrots", near)).length, 1);
  assert.equal((await adapter.search("chard", near)).length, 0);
  assert.deepEqual(
    prices(net).map((c) => new URL(c.url).searchParams.get("page")),
    ["1", "2"],
  );
  const [a, b] = prices(net);
  assert.ok((b?.at ?? 0) - (a?.at ?? 0) >= 3000, "at least 3 s between requests to the host");
  assert.ok(clock.sleeps.every((ms) => ms <= 3000));
});

test("empty coverage: no prices nearby gives no offers and no note", async () => {
  const { adapter } = setup(
    openPricesRoutes({
      "/api/v1/prices": () => ({
        body: JSON.stringify({ items: [], page: 1, pages: 0, size: 100, total: 0 }),
      }),
    }),
  );
  assert.deepEqual(await adapter.search("leeks", near), []);
  assert.equal(adapter.note(), undefined);
});

test("a 504 is an error without back-off; a 429 backs off; robots.txt is obeyed", async () => {
  const gateway = setup(openPricesRoutes({ "/api/v1/prices": () => ({ status: 504 }) }));
  await assert.rejects(gateway.adapter.search("leeks", near), /Open Prices prices: HTTP 504/);

  const limited = setup(
    openPricesRoutes({
      "/api/v1/prices": () => ({ status: 429, headers: { "Retry-After": "120" } }),
    }),
  );
  await assert.rejects(limited.adapter.search("leeks", near), BackoffError);
  await assert.rejects(limited.adapter.search("leeks", near), /in back-off/);
  assert.equal(prices(limited.net).length, 1, "no retry while backing off");

  const refused = setup(
    openPricesRoutes({ "/robots.txt": () => ({ body: "User-agent: *\nDisallow: /api/" }) }),
  );
  await assert.rejects(refused.adapter.search("leeks", near), /disallows \/api\/v1\/prices/);
  assert.equal(prices(refused.net).length, 0);
});

test("location brand/name and term matching", () => {
  assert.equal(
    storeForLocation({ osm_brand: "Harris Teeter", osm_name: "HT #1" }),
    "harris-teeter",
  );
  assert.equal(
    storeForLocation({ osm_brand: null, osm_name: "Whole Foods Market" }),
    "whole-foods",
  );
  assert.equal(storeForLocation({ osm_brand: "Earth Fare", osm_name: "Earth Fare" }), undefined);
  assert.equal(storeForLocation(null), undefined);
  assert.ok(matchesTerm("en:collard-greens", "collard greens"));
  assert.ok(matchesTerm("Example Organic Leeks", "leeks"));
  assert.ok(matchesTerm("en:leeks", "leek"));
  assert.ok(!matchesTerm("en:leek-soups", "leeks soup bowl"));
  assert.ok(!matchesTerm("en:garlic", "garlic bulb"));
});

test("the registry builds the Open Prices adapter and lists it as a source", () => {
  const adapters = createAdapters(loadConfig({ env: {} }), new PoliteFetcher());
  const op = adapters.find((a) => a.store === "open-prices");
  assert.ok(op instanceof OpenPricesAdapter);
  assert.equal(op.datedOffers, true);
  assert.deepEqual(
    SOURCES.map((s) => [s.id, s.kind]),
    [["open-prices", "aggregator"]],
  );
  assert.match(SOURCES[0]?.attribution ?? "", /Open Food Facts contributors, ODbL/);
});
