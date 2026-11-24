import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import {
  distanceKm,
  matchesTerm,
  OpenPricesAdapter,
  rowMatches,
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
  // 9008 is a Publix far outside the radius (a filter the server ignored must not leak it);
  // EUR (9005), undated (9007) and $0 (9010) leeks are dropped; ids count once across terms.
  // 9009 "Example Leek and Potato Soup" at Aldi is usable but is not leeks (its categories).
  await adapter.search("leeks", near);
  assert.equal(
    adapter.note(),
    "1 nearby query (1 page): 10 rows, 3 matched a search term at a listed store; " +
      "dropped 1 out of range, 1 at unlisted stores, 3 without a positive USD price or a date",
  );
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
          location: {
            osm_brand: "Aldi",
            osm_name: "Aldi",
            osm_address_country_code: "US",
            osm_lat: "32.78",
            osm_lon: "-79.93",
          },
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

test("empty coverage: no prices nearby gives no offers, and the note says so", async () => {
  const { adapter } = setup(
    openPricesRoutes({
      "/api/v1/prices": () => ({
        body: JSON.stringify({ items: [], page: 1, pages: 0, size: 100, total: 0 }),
      }),
    }),
  );
  assert.deepEqual(await adapter.search("leeks", near), []);
  assert.equal(
    adapter.note(),
    "1 nearby query (1 page): 0 rows, 0 matched a search term at a listed store; " +
      "dropped 0 out of range, 0 at unlisted stores, 0 without a positive USD price or a date",
  );
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
  assert.ok(matchesTerm("en:leeks", "leek"));
  // Exact tag only: the cost is that terms like these match nothing.
  assert.ok(!matchesTerm("en:leek-soups", "leeks"));
  assert.ok(!matchesTerm("en:sweet-potatoes", "potatoes"));
  assert.ok(!matchesTerm("en:garlic", "garlic bulb"));
  assert.ok(!matchesTerm("en:broccoli", "broccoli crowns"));
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

test("each row's own location is checked: outside the radius or outside the US is dropped", async () => {
  const row = (id: number, lat: string, lon: string, country: string | null) => ({
    id,
    type: "CATEGORY",
    category_tag: "en:leeks",
    price: "0.10",
    price_per: "KILOGRAM",
    currency: "USD",
    date: "2026-11-20",
    location: {
      osm_brand: "Publix",
      osm_name: "Publix",
      osm_address_country_code: country,
      osm_lat: lat,
      osm_lon: lon,
    },
  });
  // As if the server ignored the geo filter and sent prices from anywhere.
  const items = [
    row(1, "27.95", "-82.46", "US"), // Florida
    row(2, "32.78", "-79.93", "CA"), // right place, wrong country code
    row(3, "32.78", "-79.93", null),
    { ...row(4, "0", "0", "US"), location: { osm_brand: "Publix", osm_name: "Publix" } },
    row(5, "32.90", "-79.93", "US"), // 13.8 km north: inside 15 mi
  ];
  const { adapter } = setup(
    openPricesRoutes({
      "/api/v1/prices": () => ({ body: JSON.stringify({ items, page: 1, pages: 1, total: 5 }) }),
    }),
  );
  const offers = await adapter.search("leeks", near);
  assert.deepEqual(
    offers.map((o) => o.product),
    ["en:leeks @ Publix (Open Prices #5)"],
  );
  assert.match(adapter.note() ?? "", /dropped 4 out of range/);
  assert.ok(
    Math.abs(distanceKm({ lat: 32.78, lon: -79.93 }, { lat: 32.9, lon: -79.93 }) - 13.3) < 0.1,
  );
});

test("a 200 that is not the documented page envelope is a source error, not zero offers", async () => {
  for (const body of [
    "[]",
    "{}",
    '{"items":[],"pages":1}',
    '{"items":{},"pages":1,"total":0}',
    '{"items":[null],"pages":1,"total":1}',
    "<html>",
  ]) {
    const { adapter } = setup(openPricesRoutes({ "/api/v1/prices": () => ({ body }) }));
    await assert.rejects(
      adapter.search("leeks", near),
      /Open Prices prices: (unexpected response shape|response is not JSON)/,
      body,
    );
  }
});

test("a ZIP other than the default the centre stands for: not configured, no request", async () => {
  const clock = fakeClock();
  const net = fakeFetch(openPricesRoutes(), clock.now);
  const fetcher = new PoliteFetcher({ fetchImpl: net.impl, now: clock.now, sleep: clock.sleep });
  const other = new OpenPricesAdapter(fetcher, "29464", clock.now);
  assert.deepEqual(other.status(), {
    configured: false,
    reason:
      "searches around downtown Charleston (ZIP 29401) only; HGA_PRICE_ZIP is set to another ZIP",
  });
  assert.deepEqual(new OpenPricesAdapter(fetcher, "29401", clock.now).status(), {
    configured: true,
  });
  const viaConfig = createAdapters(loadConfig({ env: { HGA_PRICE_ZIP: "29464" } }), fetcher).find(
    (a) => a.store === "open-prices",
  );
  assert.equal(viaConfig?.status().configured, false);
  await assert.rejects(other.search("leeks", { zip: "29464", radiusMiles: 15 }), /ZIP 29401 only/);
  assert.equal(net.calls.length, 0);
});

test("PRODUCT rows match by their categories only, never by product name", () => {
  const product = (name: string, categories: string[]) => ({
    type: "PRODUCT",
    product: { product_name: name, categories_tags: categories },
  });
  const soup = product("Broccoli Cheddar Soup", ["en:meals", "en:soups", "en:broccoli-soups"]);
  assert.ok(!rowMatches(soup, "broccoli"));
  // A name that says strawberries on a product whose categories say yogurt.
  const yogurt = product("Chocolate Covered Strawberry", ["en:dairies", "en:greek-style-yogurts"]);
  assert.ok(!rowMatches(yogurt, "strawberries"));
  assert.ok(rowMatches(product("Example Leeks", ["en:vegetables", "en:leeks"]), "leeks"));
  assert.ok(!rowMatches({ type: "PRODUCT", product: { product_name: "Leeks" } }, "leeks"));
  assert.ok(rowMatches({ type: "CATEGORY", category_tag: "en:leeks" }, "leeks"));
  assert.ok(!rowMatches({ type: "CATEGORY", category_tag: "en:leeks" }, "carrots"));
});

test("a $0, empty or negative price is never ranked", async () => {
  const row = (id: number, price: unknown) => ({
    id,
    type: "CATEGORY",
    category_tag: "en:leeks",
    price,
    price_per: "KILOGRAM",
    currency: "USD",
    date: "2026-11-20",
    location: {
      osm_brand: "Publix",
      osm_name: "Publix",
      osm_address_country_code: "US",
      osm_lat: 32.78,
      osm_lon: -79.93,
    },
  });
  // String decimals are tolerated (the live API sends numbers), so "2.5" still counts.
  const items = [row(1, 0), row(2, ""), row(3, -1), row(4, null), row(5, "2.5")];
  const { adapter } = setup(
    openPricesRoutes({
      "/api/v1/prices": () => ({ body: JSON.stringify({ items, page: 1, pages: 1, total: 5 }) }),
    }),
  );
  const offers = await adapter.search("leeks", near);
  assert.deepEqual(
    offers.map((o) => o.price),
    [2.5],
  );
  assert.match(adapter.note() ?? "", /4 without a positive USD price or a date$/);
});

test("the run line says when the 5-page cap cut the query short", async () => {
  const { net, adapter } = setup(
    openPricesRoutes({
      "/api/v1/prices": () => ({
        body: JSON.stringify({ items: [{ id: 1 }], page: 1, pages: 9, size: 1, total: 9 }),
      }),
    }),
  );
  await adapter.search("leeks", near);
  assert.equal(prices(net).length, 5);
  assert.match(adapter.note() ?? "", /^1 nearby query \(first 5 of 9 pages\): 5 rows/);
});
