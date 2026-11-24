import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { KrogerAdapter } from "../src/prices/adapters/kroger.js";
import { createAdapters } from "../src/prices/adapters/registry.js";
import { PoliteFetcher } from "../src/prices/fetcher.js";
import { fakeClock, fakeFetch, krogerRoutes } from "./prices-helpers.js";

// Synthetic credentials, assembled at runtime so no secret-shaped literal is committed.
const creds = {
  clientId: ["synthetic", "client"].join("-"),
  clientSecret: ["synthetic", "value"].join("-"),
};
const near = { zip: "29401", radiusMiles: 15 };

function setup(routes = krogerRoutes()) {
  const clock = fakeClock();
  const net = fakeFetch(routes, clock.now);
  const fetcher = new PoliteFetcher({ fetchImpl: net.impl, now: clock.now, sleep: clock.sleep });
  return { clock, net, adapter: new KrogerAdapter(fetcher, creds, clock.now) };
}

test("token, Harris Teeter location and location-scoped search against fixtures", async () => {
  const { net, adapter } = setup();
  assert.deepEqual(adapter.status(), { configured: true });
  const offers = await adapter.search("leeks", near);

  const [robots, token, locations, products] = net.calls;
  assert.equal(new URL(robots?.url ?? "").pathname, "/robots.txt");
  assert.equal(token?.method, "POST");
  assert.equal(token?.url, "https://api.kroger.com/v1/connect/oauth2/token");
  assert.equal(
    token?.headers.Authorization,
    `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
  );
  assert.equal(token?.body, "grant_type=client_credentials&scope=product.compact");
  const loc = new URL(locations?.url ?? "");
  assert.equal(loc.searchParams.get("filter.zipCode.near"), "29401");
  assert.equal(loc.searchParams.get("filter.radiusInMiles"), "15");
  const prod = new URL(products?.url ?? "");
  assert.equal(prod.searchParams.get("filter.term"), "leeks");
  assert.equal(prod.searchParams.get("filter.locationId"), "09700123"); // the Harris Teeter, not the Kroger
  assert.equal(products?.headers.Authorization, `Bearer ${"synthetic-access-value"}`);

  assert.deepEqual(
    offers.map((o) => [o.product, o.price, o.regularPrice, o.size, o.unit, o.promo]),
    [
      ["Example Farms Leeks", 1.99, 2.49, 1, "lb", true],
      ["Example Kitchen Leek Soup", 3.29, undefined, 16, "fl oz", false],
      ["Example Farms Baby Leeks", 3, undefined, 12, "oz", false],
    ],
  );
  for (const o of offers) {
    assert.equal(o.store, "harris-teeter");
    assert.equal(o.source, "kroger-api");
    assert.equal(o.term, "leeks");
    assert.match(o.fetchedAt, /^2026-11-24T/);
  }
});

test("the token and location are reused in memory until the token nears expiry", async () => {
  const { clock, net, adapter } = setup();
  await adapter.search("leeks", near);
  await adapter.search("carrots", near);
  const count = (path: string) => net.calls.filter((c) => new URL(c.url).pathname === path).length;
  assert.equal(count("/v1/connect/oauth2/token"), 1);
  assert.equal(count("/v1/locations"), 1);
  clock.t += 1800 * 1000;
  await adapter.search("chard", near);
  assert.equal(count("/v1/connect/oauth2/token"), 2);
});

test("errors never include the token response body", async () => {
  const { adapter } = setup(
    krogerRoutes({ "/v1/connect/oauth2/token": () => ({ status: 400, body: "SENSITIVE-BODY" }) }),
  );
  const err = (await adapter.search("leeks", near).catch((e: unknown) => e)) as Error;
  assert.equal(err.message, "Kroger token: HTTP 400");
});

test("no Harris Teeter nearby is an error", async () => {
  const { adapter } = setup(
    krogerRoutes({
      "/v1/locations": () => ({
        body: JSON.stringify({ data: [{ locationId: "1", chain: "KROGER" }] }),
      }),
    }),
  );
  await assert.rejects(adapter.search("leeks", near), /no Harris Teeter within 15 mi of 29401/);
});

test("without credentials the adapter reports not configured and makes no requests", () => {
  const net = fakeFetch({});
  const [adapter] = createAdapters(
    loadConfig({ env: {} }),
    new PoliteFetcher({ fetchImpl: net.impl }),
  );
  assert.deepEqual(adapter?.status(), {
    configured: false,
    reason: "set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in .env",
  });
  assert.equal(net.calls.length, 0);
});
