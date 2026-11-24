import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BackoffError,
  MIN_INTERVAL_MS,
  PoliteFetcher,
  RobotsDisallowedError,
  USER_AGENT,
} from "../src/prices/fetcher.js";
import { parseRobots } from "../src/prices/robots.js";
import { fakeClock, fakeFetch } from "./prices-helpers.js";

const ROBOTS =
  "User-agent: *\nDisallow: /search\nAllow: /search/help\n\nUser-agent: OtherBot\nDisallow: /\n";

function setup(routes: Parameters<typeof fakeFetch>[0], minIntervalMs?: number) {
  const clock = fakeClock();
  const net = fakeFetch(routes, clock.now);
  const fetcher = new PoliteFetcher({
    fetchImpl: net.impl,
    now: clock.now,
    sleep: clock.sleep,
    ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
  });
  return { clock, net, fetcher };
}

test("robots.txt rules: own group, * group, longest match, wildcards", () => {
  const r = parseRobots(ROBOTS, "health-grocery-app");
  assert.equal(r.isAllowed("/search?q=leeks"), false);
  assert.equal(r.isAllowed("/search/help"), true);
  assert.equal(r.isAllowed("/products"), true);
  const own = parseRobots(
    "User-agent: health-grocery-app\nDisallow: /api/*.json$\n",
    "health-grocery-app",
  );
  assert.equal(own.isAllowed("/api/x.json"), false);
  assert.equal(own.isAllowed("/api/x.json?v=1"), true);
});

test("refuses paths robots.txt disallows, and fetches robots.txt once per host", async () => {
  const { net, fetcher } = setup({
    "/robots.txt": () => ({ body: ROBOTS }),
    "/products": () => ({ body: "ok" }),
  });
  await assert.rejects(
    fetcher.request("https://shop.example/search?q=leeks"),
    RobotsDisallowedError,
  );
  assert.equal((await fetcher.request("https://shop.example/products")).body, "ok");
  assert.deepEqual(
    net.calls.map((c) => new URL(c.url).pathname),
    ["/robots.txt", "/products"],
  );
  for (const c of net.calls) assert.equal(c.headers["User-Agent"], USER_AGENT);
  assert.doesNotMatch(USER_AGENT, /mozilla|chrome|safari|@/i);
});

test("a robots.txt that fails with 5xx or 403 blocks the host; 404 means no rules", async () => {
  const blocked = setup({ "/robots.txt": () => ({ status: 503 }) });
  await assert.rejects(blocked.fetcher.request("https://a.example/x"), RobotsDisallowedError);
  const forbidden = setup({ "/robots.txt": () => ({ status: 403 }) });
  await assert.rejects(forbidden.fetcher.request("https://a.example/x"), RobotsDisallowedError);
  const open = setup({ "/x": () => ({ body: "fine" }) });
  assert.equal((await open.fetcher.request("https://a.example/x")).body, "fine");
});

test("rate-limits per host to at least one request per 3 s, configurable slower", async () => {
  const routes = { "/a": () => ({ body: "a" }), "/b": () => ({ body: "b" }) };
  const fast = setup(routes, 500);
  assert.equal(fast.fetcher.minIntervalMs, MIN_INTERVAL_MS);
  await Promise.all([
    fast.fetcher.request("https://one.example/a"),
    fast.fetcher.request("https://one.example/b"),
  ]);
  const one = fast.net.calls.filter((c) => c.url.startsWith("https://one.example"));
  // robots.txt, /a, /b: each at least 3 s after the previous one.
  for (let i = 1; i < one.length; i++) {
    assert.ok((one[i]?.at ?? 0) - (one[i - 1]?.at ?? 0) >= MIN_INTERVAL_MS);
  }
  const slow = setup(routes, 10_000);
  await slow.fetcher.request("https://two.example/a");
  await slow.fetcher.request("https://two.example/b");
  const [, a, b] = slow.net.calls;
  assert.equal((b?.at ?? 0) - (a?.at ?? 0), 10_000);
});

test("caches GET responses within the TTL", async () => {
  const { net, fetcher } = setup({ "/p": () => ({ body: "p" }) });
  await fetcher.request("https://c.example/p");
  await fetcher.request("https://c.example/p");
  assert.equal(net.calls.filter((c) => c.url.endsWith("/p")).length, 1);
});

test("429 backs off the host (Retry-After) without retrying; later calls skip the network", async () => {
  let hits = 0;
  const { clock, net, fetcher } = setup({
    "/p": () => {
      hits++;
      return hits === 1 ? { status: 429, headers: { "Retry-After": "120" } } : { body: "ok" };
    },
  });
  const err = await fetcher.request("https://d.example/p").catch((e: unknown) => e);
  assert.ok(err instanceof BackoffError);
  assert.equal(err.until, clock.now() + 120_000);
  assert.equal(hits, 1);
  await assert.rejects(fetcher.request("https://d.example/p"), BackoffError);
  assert.equal(net.calls.length, 2); // robots.txt + the one 429
  clock.t += 121_000;
  assert.equal((await fetcher.request("https://d.example/p")).body, "ok");
});

test("403 backs off with a doubling default when there is no Retry-After", async () => {
  const { clock, fetcher } = setup({ "/p": () => ({ status: 403 }) });
  const first = (await fetcher
    .request("https://e.example/p")
    .catch((e: unknown) => e)) as BackoffError;
  assert.equal(first.until - clock.now(), 15 * 60 * 1000);
  clock.t = first.until;
  const second = (await fetcher
    .request("https://e.example/p")
    .catch((e: unknown) => e)) as BackoffError;
  assert.equal(second.until - clock.now(), 30 * 60 * 1000);
});

test("refuses plain http", async () => {
  const { fetcher } = setup({});
  await assert.rejects(fetcher.request("http://f.example/p"), /non-https/);
});

test("robots.txt: an empty user-agent is not ours, and the token must match exactly", () => {
  const token = "health-grocery-app";
  const empty = parseRobots("User-agent:\nAllow: /\n\nUser-agent: *\nDisallow: /search\n", token);
  assert.equal(empty.isAllowed("/search?q=x"), false);
  const prefix = parseRobots("User-agent: he\nAllow: /\n\nUser-agent: *\nDisallow: /\n", token);
  assert.equal(prefix.isAllowed("/search"), false);
  const exact = parseRobots(
    "User-agent: Health-Grocery-App\nDisallow: /x\n\nUser-agent: *\nDisallow: /\n",
    token,
  );
  assert.equal(exact.isAllowed("/search"), true);
  assert.equal(exact.isAllowed("/x"), false);
});

test("robots.txt: only allow/disallow lines end a group's user-agent list", () => {
  const r = parseRobots(
    "User-agent: *\nSitemap: https://a.example/s.xml\nUser-agent: foo\nDisallow: /\n",
    "health-grocery-app",
  );
  assert.equal(r.isAllowed("/search"), false);
  const crawl = parseRobots(
    "User-agent: foo\nCrawl-delay: 5\nUser-agent: *\nDisallow: /p\n",
    "health-grocery-app",
  );
  assert.equal(crawl.isAllowed("/p"), false);
});
