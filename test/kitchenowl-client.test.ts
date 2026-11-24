import assert from "node:assert/strict";
import { test } from "node:test";
import { type Fetch, KitchenOwlClient, KitchenOwlError } from "../src/kitchenowl/client.js";
import { assertDisposableTarget } from "./kitchenowl-target-guard.js";

// Synthetic, built at runtime so no secret-shaped literal sits in the repo.
const TOKEN = ["synthetic", "llt", "value", "for", "tests"].join("-");

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f: Fetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { calls, f };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("requests go to <base>/api with the token header, JSON bodies and a timeout signal", async () => {
  const { calls, f } = fakeFetch((c) =>
    c.url.endsWith("/add-item-by-name") ? json({ id: 41, name: "leeks" }) : json([]),
  );
  for (const baseUrl of [
    "http://127.0.0.1:18849",
    "http://127.0.0.1:18849/",
    "http://127.0.0.1:18849/api",
  ]) {
    const client = new KitchenOwlClient({ baseUrl, token: TOKEN, fetch: f });
    await client.households();
  }
  const client = new KitchenOwlClient({
    baseUrl: "http://127.0.0.1:18849",
    token: TOKEN,
    fetch: f,
  });
  assert.equal(await client.addItem(3, "leeks", "rotation wk1"), 41);
  await client.removeItem(3, 41);
  await client.shoppingLists(7);
  await client.listItems(3);
  assert.deepEqual(
    calls.map((c) => `${c.init.method} ${c.url}`),
    [
      "GET http://127.0.0.1:18849/api/household",
      "GET http://127.0.0.1:18849/api/household",
      "GET http://127.0.0.1:18849/api/household",
      "POST http://127.0.0.1:18849/api/shoppinglist/3/add-item-by-name",
      "DELETE http://127.0.0.1:18849/api/shoppinglist/3/item",
      "GET http://127.0.0.1:18849/api/household/7/shoppinglist",
      "GET http://127.0.0.1:18849/api/shoppinglist/3/items",
    ],
  );
  const add = calls[3]?.init;
  assert.equal(
    (add?.headers as Record<string, string> | undefined)?.authorization,
    `Bearer ${TOKEN}`,
  );
  assert.deepEqual(JSON.parse(String(add?.body)), { name: "leeks", description: "rotation wk1" });
  assert.deepEqual(JSON.parse(String(calls[4]?.init.body)), { item_id: 41 });
  assert.ok(add?.signal instanceof AbortSignal);
});

test("list items map name and description", async () => {
  const { f } = fakeFetch(() =>
    json([
      { id: 1, name: "leeks", description: "rotation wk1", extra: true },
      { id: 2, name: "broccoli", description: null },
    ]),
  );
  const client = new KitchenOwlClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, fetch: f });
  assert.deepEqual(await client.listItems(3), [
    { id: 1, name: "leeks", description: "rotation wk1" },
    { id: 2, name: "broccoli", description: "" },
  ]);
});

test("HTTP errors name method, path and status, never the token or base URL", async () => {
  const { f } = fakeFetch(() => json({ msg: "Unauthorized" }, 401));
  const client = new KitchenOwlClient({
    baseUrl: "http://127.0.0.1:18849",
    token: TOKEN,
    fetch: f,
  });
  const err = await client.households().then(
    () => assert.fail("expected an error"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof KitchenOwlError);
  assert.equal(err.status, 401);
  assert.match(err.message, /^KitchenOwl GET \/api\/household: HTTP 401 \(check KITCHENOWL_TOKEN/);
  assert.ok(!err.message.includes(TOKEN));
  assert.ok(!err.message.includes("127.0.0.1"));
  assert.ok(!(err.stack ?? "").includes(TOKEN));
});

test("network failures and bad JSON are reported without the token", async () => {
  const down = new KitchenOwlClient({
    baseUrl: "http://127.0.0.1:1",
    token: TOKEN,
    fetch: async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  });
  await assert.rejects(down.households(), (e: Error) => {
    assert.equal(e.message, "KitchenOwl GET /api/household: request failed (ECONNREFUSED)");
    return true;
  });
  const html = new KitchenOwlClient({
    baseUrl: "http://127.0.0.1:1",
    token: TOKEN,
    fetch: async () => new Response("<html>", { status: 200 }),
  });
  await assert.rejects(html.households(), /response is not JSON/);
  const shape = new KitchenOwlClient({
    baseUrl: "http://127.0.0.1:1",
    token: TOKEN,
    fetch: async () => json({ not: "a list" }),
  });
  await assert.rejects(shape.households(), /expected a list/);
});

test("requests time out", async () => {
  const client = new KitchenOwlClient({
    baseUrl: "http://127.0.0.1:1",
    token: TOKEN,
    timeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  });
  await assert.rejects(
    client.listItems(3),
    /GET \/api\/shoppinglist\/3\/items: timed out after 20 ms/,
  );
});

test("bad base URLs and ids are rejected before any request", async () => {
  assert.throws(
    () => new KitchenOwlClient({ baseUrl: "not a url", token: TOKEN }),
    /KITCHENOWL_URL is not a valid URL/,
  );
  assert.throws(
    () => new KitchenOwlClient({ baseUrl: "ftp://127.0.0.1", token: TOKEN }),
    /must be http or https/,
  );
  const { calls, f } = fakeFetch(() => json([]));
  const client = new KitchenOwlClient({ baseUrl: "http://127.0.0.1:1", token: TOKEN, fetch: f });
  await assert.rejects(client.listItems(0), /bad KitchenOwl id/);
  assert.equal(calls.length, 0);
});

test("integration guard refuses the real KitchenOwl ports and non-loopback hosts", () => {
  for (const ok of ["http://127.0.0.1:18849", "http://localhost:18849/", "http://[::1]:18849"]) {
    assert.doesNotThrow(() => assertDisposableTarget(ok), ok);
  }
  for (const bad of [
    "http://127.0.0.1:8449",
    "http://127.0.0.1:8450",
    "http://localhost:8449/api",
    "http://192.168.1.10:18849",
    "http://kitchen.example.org:18849",
    "http://127.0.0.1",
    "https://127.0.0.1:18849",
    "not a url",
  ]) {
    assert.throws(() => assertDisposableTarget(bad), /refusing/, bad);
  }
});
