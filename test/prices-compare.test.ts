import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { createPricesCommand } from "../src/commands/prices.js";
import { loadConfig } from "../src/config.js";
import { migrate, openDb } from "../src/db.js";
import { KrogerAdapter } from "../src/prices/adapters/kroger.js";
import type { StoreAdapter } from "../src/prices/adapters/types.js";
import { basketLines, parseCatalog } from "../src/prices/catalog.js";
import { collectOffers } from "../src/prices/collect.js";
import { compare } from "../src/prices/compare.js";
import { PoliteFetcher } from "../src/prices/fetcher.js";
import { importCsv } from "../src/prices/manual.js";
import { parseRotation } from "../src/prices/rotation.js";
import { latestOffers } from "../src/prices/store.js";
import { fakeClock, fakeFetch, krogerRoutes } from "./prices-helpers.js";

const ROTATION = `weeks:
  1: [leeks, collards or turnip greens]
  2: [fennel]
every_week:
  - shallots and garlic
`;
const CATALOG = `entries:
  leeks: { unit: lb, terms: [leeks] }
  collards or turnip greens:
    pick: any
    unit: bunch
    items:
      collards: [collard greens]
      turnip greens: [turnip greens]
  fennel: { unit: each, terms: [fennel bulb] }
  shallots and garlic:
    pick: all
    items:
      shallots: { unit: lb, terms: [shallots] }
      garlic: { unit: each, terms: [garlic bulb] }
`;
// Synthetic prices only.
const CSV = `store,item,price,size,unit,date,promo,product
aldi,leeks,1.50,1,lb,2026-11-20,,
publix,leeks,3.00,16,oz,2026-11-22,yes,"Leeks, loose"
publix,collards,2.49,1,bunch,2026-11-22,,
aldi,turnip greens,1.79,1,bunch,2026-11-20,,
aldi,collards,1.99,1,bunch,2026-11-20,,
food-lion,collards,2.00,32,fl oz,2026-11-23,,Collards in a jar
publix,shallots,2.00,8,oz,2026-11-22,,
aldi,shallots,4.00,1,lb,2026-11-20,,
publix,garlic,1.50,3,ct,2026-11-22,,
whole-foods,fennel,2.50,1,each,2026-09-01,,
`;
const TODAY = "2026-11-24";
const NOW = Date.parse("2026-11-24T15:00:00");

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "hga-prices-"));
  writeFileSync(join(dir, "rotation.yaml"), ROTATION);
  writeFileSync(join(dir, "catalog.yaml"), CATALOG);
  writeFileSync(join(dir, "prices.csv"), CSV);
  const dbPath = join(dir, "hga.db");
  return { dir, dbPath, rotation: parseRotation(ROTATION), catalog: parseCatalog(CATALOG) };
}

function cli(
  ws: ReturnType<typeof workspace>,
  adapters: (c: unknown) => StoreAdapter[] = () => [],
) {
  const out: string[] = [];
  const err: string[] = [];
  const table = [
    {
      name: "prices",
      summary: "",
      load: async () =>
        createPricesCommand({
          rotationFile: join(ws.dir, "rotation.yaml"),
          catalogFile: join(ws.dir, "catalog.yaml"),
          now: () => NOW,
          adapters,
        }),
    },
  ];
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    loadConfig: () => loadConfig({ env: { HGA_DB_PATH: ws.dbPath } }),
  };
  return { out, err, run: (...args: string[]) => main(["prices", ...args], io, table) };
}

function seededDb(ws: ReturnType<typeof workspace>) {
  const db = openDb(ws.dbPath);
  migrate(db);
  importCsv(db, ws.catalog, CSV, TODAY, new Date(NOW));
  return db;
}

test("per-item best and runner-up, alternatives, single-store and split baskets", () => {
  const ws = workspace();
  const db = seededDb(ws);
  const lines = basketLines(ws.catalog, ws.rotation.entries);
  const items = lines.flatMap((l) => l.alternatives.map((a) => a.name));
  const r = compare(lines, latestOffers(db, items), { today: TODAY, maxAgeDays: 30 });
  db.close();

  const line = (name: string) => r.lines.find((l) => l.line === name);
  assert.deepEqual(
    [line("leeks")?.best?.store, line("leeks")?.best?.unitPrice, line("leeks")?.best?.ageDays],
    ["aldi", 1.5, 4],
  );
  assert.deepEqual(
    [line("leeks")?.runnerUp?.store, line("leeks")?.runnerUp?.unitPrice],
    ["publix", 3],
  );
  assert.equal(line("leeks")?.runnerUp?.promo, true);
  // The cheaper alternative represents the entry, and says which one won.
  const greens = line("collards or turnip greens");
  assert.deepEqual(
    [greens?.best?.store, greens?.best?.item, greens?.best?.unitPrice],
    ["aldi", "turnip greens", 1.79],
  );
  assert.deepEqual([greens?.runnerUp?.store, greens?.runnerUp?.item], ["publix", "collards"]);
  // Unconvertible (fl oz for a bunch) stays visible but unranked.
  assert.deepEqual(
    greens?.excluded.map((e) => [e.store, e.reason]),
    [["food-lion", "cannot convert fl oz to bunch"]],
  );
  // Stale (84 d > 30 d): excluded with a reason; the line has no price.
  assert.equal(line("fennel")?.best, null);
  assert.match(line("fennel")?.excluded[0]?.reason ?? "", /^stale: 84 d old \(cutoff 30 d\)$/);
  // Packs: 3 ct garlic at 1.50 -> 0.50 each; 8 oz shallots at 2.00 -> 4.00/lb (ties aldi; store name breaks it).
  assert.equal(line("shallots and garlic / garlic")?.best?.unitPrice, 0.5);
  assert.deepEqual(
    line("shallots and garlic / shallots")?.byStore.map((o) => o.store),
    ["aldi", "publix"],
  );

  // Single store: coverage first, then total. Publix covers 4 of 5 (3.00 + 2.49 + 4.00 + 0.50).
  assert.deepEqual(r.singleStore.best, {
    store: "publix",
    total: 9.99,
    covered: 4,
    missing: ["fennel"],
  });
  assert.deepEqual(
    r.singleStore.ranking.map((s) => [s.store, s.covered, s.total, s.missing]),
    [
      ["publix", 4, 9.99, ["fennel"]],
      ["aldi", 3, 7.29, ["fennel", "shallots and garlic / garlic"]],
    ],
  );
  // Split: aldi leeks 1.50 + aldi turnip greens 1.79 + aldi shallots 4.00 + publix garlic 0.50.
  assert.equal(r.split.total, 7.79);
  assert.deepEqual(r.split.stores, ["aldi", "publix"]);
  assert.deepEqual(r.split.missing, ["fennel"]);
});

test("staleness cutoff is configurable", () => {
  const ws = workspace();
  const db = seededDb(ws);
  const lines = basketLines(ws.catalog, ws.rotation.entries);
  const offers = latestOffers(db, ["fennel", "leeks"]);
  db.close();
  const loose = compare(lines, offers, { today: TODAY, maxAgeDays: 90 });
  assert.equal(loose.lines.find((l) => l.line === "fennel")?.best?.store, "whole-foods");
  const strict = compare(lines, offers, { today: TODAY, maxAgeDays: 3 });
  // aldi leeks (4 d) is now stale; publix (2 d) wins.
  assert.equal(strict.lines.find((l) => l.line === "leeks")?.best?.store, "publix");
});

test("CSV import validates every row first and writes nothing on error", () => {
  const ws = workspace();
  const db = openDb(ws.dbPath);
  migrate(db);
  const bad = [
    "store,item,price,size,unit,date",
    "aldi,leeks,1.5,1,lb,",
    "nowhere,leeks,1,1,lb,",
    "aldi,leeks,abc,1,lb,",
    "aldi,onions,1,1,lb,",
    "aldi,leeks,1.2,1,lb,2027-03-01",
  ].join("\n");
  assert.throws(
    () => importCsv(db, ws.catalog, bad, TODAY, new Date(NOW)),
    (e: Error) =>
      /row 3: unknown store "nowhere"/.test(e.message) &&
      /row 4: bad price "abc"/.test(e.message) &&
      /row 5: unknown item "onions"/.test(e.message) &&
      /row 6: date 2027-03-01 is in the future/.test(e.message),
  );
  assert.deepEqual(latestOffers(db, ["leeks"]), []);
  assert.throws(
    () => importCsv(db, ws.catalog, "store,item,cost\n", TODAY, new Date(NOW)),
    /unknown \[cost\]/,
  );
  assert.equal(
    importCsv(
      db,
      ws.catalog,
      "store,item,price,size,unit\naldi,Leeks,1.5,1,LBS\n",
      TODAY,
      new Date(NOW),
    ),
    1,
  );
  const [row] = latestOffers(db, ["leeks"]);
  assert.deepEqual([row?.source, row?.unit, row?.observedOn], ["manual", "lb", TODAY]);
  db.close();
});

test("prices add stores a manual price used by compare, with its age", async () => {
  const ws = workspace();
  const c = cli(ws);
  assert.equal(
    await c.run(
      "add",
      "--store",
      "lowes-foods",
      "--item",
      "turnip greens",
      "--price",
      "1.25",
      "--size",
      "1",
      "--unit",
      "bunch",
      "--date",
      "2026-11-21",
    ),
    0,
  );
  assert.equal(c.out.at(-1), "Added lowes-foods turnip greens: $1.25 for 1 bunch on 2026-11-21");
  assert.equal(
    await c.run(
      "add",
      "--store",
      "lowes-foods",
      "--item",
      "collards or turnip greens",
      "--price",
      "1",
      "--size",
      "1",
      "--unit",
      "bunch",
    ),
    1,
  );
  assert.match(c.err.at(-1) ?? "", /several items; use one of: collards, turnip greens/);
  assert.equal(
    await c.run(
      "add",
      "--store",
      "lowes-foods",
      "--item",
      "leeks",
      "--price",
      "1",
      "--size",
      "1",
      "--unit",
      "lb",
      "--date",
      "2026-02-30",
    ),
    1,
  );
  assert.equal(
    await c.run(
      "add",
      "--store",
      "aldi",
      "--item",
      "leeks",
      "--price",
      "1.2",
      "--size",
      "1",
      "--unit",
      "lb",
      "--date",
      "2026-11-25",
    ),
    1,
  );
  assert.match(c.err.at(-1) ?? "", /date 2026-11-25 is in the future \(today is 2026-11-24\)/);
  assert.equal(await c.run("compare", "--week", "1", "--json", "--offline"), 0);
  const json = JSON.parse(c.out.at(-1) ?? "{}");
  const greens = json.lines.find((l: { line: string }) => l.line === "collards or turnip greens");
  assert.deepEqual(
    [greens.best.store, greens.best.item, greens.best.source, greens.best.ageDays],
    ["lowes-foods", "turnip greens", "manual", 3],
  );
});

test("compare --json has the documented shape and --week scopes the basket", async () => {
  const ws = workspace();
  seededDb(ws).close();
  const c = cli(ws);
  assert.equal(await c.run("compare", "--week", "1", "--json", "--offline"), 0);
  const json = JSON.parse(c.out.join("\n"));
  assert.deepEqual(Object.keys(json), [
    "schema",
    "today",
    "scope",
    "maxAgeDays",
    "stores",
    "lines",
    "singleStore",
    "split",
  ]);
  assert.equal(json.schema, "hga.prices.compare/v1");
  assert.deepEqual(json.scope, { week: 1, everyWeek: true });
  assert.equal(json.stores.length, 9);
  assert.deepEqual(json.stores[0], {
    id: "harris-teeter",
    name: "Harris Teeter",
    kind: "api",
    status: "offline",
  });
  assert.deepEqual(
    json.lines.map((l: { line: string }) => l.line),
    [
      "leeks",
      "collards or turnip greens",
      "shallots and garlic / shallots",
      "shallots and garlic / garlic",
    ],
  );
  const human = cli(ws);
  assert.equal(await human.run("compare", "--week", "1", "--offline"), 0);
  const text = human.out.join("\n");
  assert.match(text, /^ {2}harris-teeter: offline \(stored prices only\)$/m);
  assert.match(text, /^leeks\s+\$1\.50\/lb aldi, 4 d\s+\$3\.00\/lb publix promo, 2 d$/m);
  assert.match(text, /collards or turnip greens\s+\$1\.79\/bunch aldi \(turnip greens\), 4 d/);
  assert.match(
    text,
    /food-lion Collards in a jar, \$2\.00 for 32 fl oz, 1 d: cannot convert fl oz to bunch/,
  );
  assert.match(text, /Single store: publix \$9\.99 for 4\/4 items/);
  assert.match(text, /Split basket: \$7\.79 across aldi, publix/);
  assert.equal(await human.run("compare", "--week", "9"), 1);
});

test("adapter offers are cached per store, term and day; --refresh refetches", async () => {
  const ws = workspace();
  const clock = fakeClock(NOW);
  const net = fakeFetch(krogerRoutes(), clock.now);
  const creds = {
    clientId: ["synthetic", "id"].join("-"),
    clientSecret: ["synthetic", "pw"].join("-"),
  };
  const adapters = () => [
    new KrogerAdapter(
      new PoliteFetcher({ fetchImpl: net.impl, now: clock.now, sleep: clock.sleep }),
      creds,
      clock.now,
    ),
  ];
  const c = cli(ws, adapters);
  assert.equal(await c.run("compare", "--week", "1", "--json"), 0);
  const searches = () => net.calls.filter((x) => x.url.includes("/v1/products")).length;
  // leeks, collard greens, turnip greens, shallots, garlic bulb
  assert.equal(searches(), 5);
  const first = JSON.parse(c.out.join("\n"));
  assert.equal(first.stores[0].status, "ok");
  const leeks = first.lines[0];
  // Fixture: promo leeks 1.99/lb win; the soup (fl oz) is unconvertible.
  assert.deepEqual(
    [leeks.best.store, leeks.best.unitPrice, leeks.best.promo],
    ["harris-teeter", 1.99, true],
  );
  assert.ok(
    leeks.excluded.some((e: { reason: string }) => e.reason === "cannot convert fl oz to lb"),
  );

  const sent = net.calls.length;
  const again = cli(ws, adapters);
  assert.equal(await again.run("compare", "--week", "1"), 0);
  assert.equal(net.calls.length, sent, "same-day re-run makes no network calls");
  assert.match(again.out.join("\n"), /harris-teeter: ok \(0 fetched, 5 cached\)/);

  const fresh = cli(ws, adapters);
  assert.equal(await fresh.run("compare", "--week", "1", "--refresh"), 0);
  assert.equal(searches(), 10);
  const db = openDb(ws.dbPath);
  assert.equal(latestOffers(db, ["leeks"]).filter((o) => o.source === "kroger-api").length, 3);
  db.close();
});

test("a 429 back-off persists across runs, --refresh and weeks; manual prices still compare", async () => {
  const ws = workspace();
  seededDb(ws).close();
  const clock = fakeClock(NOW);
  const net = fakeFetch(
    krogerRoutes({ "/v1/products": () => ({ status: 429, headers: { "Retry-After": "3600" } }) }),
    clock.now,
  );
  const creds = { clientId: "a", clientSecret: "b" };
  // A new fetcher and adapter per run, like a new CLI process (in-memory back-off is gone).
  const freshAdapter = () =>
    new KrogerAdapter(
      new PoliteFetcher({ fetchImpl: net.impl, now: clock.now, sleep: clock.sleep }),
      creds,
      clock.now,
    );
  const db = openDb(ws.dbPath);
  const week = (n: number) =>
    basketLines(
      ws.catalog,
      ws.rotation.entries.filter((e) => e.week === n),
    );
  const opts = (refresh: boolean) => ({
    day: TODAY,
    location: { zip: "29401", radiusMiles: 15 },
    refresh,
    now: clock.now,
  });
  const products = () => net.calls.filter((x) => x.url.includes("/v1/products")).length;
  const [run] = await collectOffers(db, [freshAdapter()], week(1), opts(false));
  assert.equal(run?.status, "error");
  assert.match(run?.detail ?? "", /answered 429; backing off/);
  assert.equal(products(), 1);
  const sent = net.calls.length;
  clock.t += 60_000;
  for (const [lines, refresh] of [
    [week(1), false],
    [week(1), true],
    [week(2), false],
  ] as const) {
    const [later] = await collectOffers(db, [freshAdapter()], lines, opts(refresh));
    assert.equal(later?.status, "error");
    assert.match(later?.detail ?? "", /^backing off until 2026-11-24T\S+Z: .*answered 429/);
  }
  assert.equal(net.calls.length, sent, "no request of any kind while backing off");
  clock.t += 60 * 60 * 1000; // past Retry-After
  await collectOffers(db, [freshAdapter()], week(2), opts(false));
  assert.equal(products(), 2);
  db.close();

  const c = cli(ws, () => [
    new KrogerAdapter(new PoliteFetcher({ fetchImpl: net.impl }), undefined),
  ]);
  assert.equal(await c.run("compare", "--week", "1"), 0);
  assert.match(
    c.out.join("\n"),
    /harris-teeter: not configured \(set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET in \.env\)/,
  );
  assert.match(c.out.join("\n"), /Split basket: \$7\.79/);
});
