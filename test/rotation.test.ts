import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { createRotationCommand } from "../src/commands/rotation.js";
import { loadConfig } from "../src/config.js";
import {
  DEFAULT_SEASONAL_MONTHS,
  itemsForWeek,
  loadRotation,
  markFor,
  matchKey,
  nextWeek,
  parseMonths,
  parseRotation,
} from "../src/rotation/plan.js";
import { RotationState } from "../src/rotation/state.js";
import { FakeKitchenOwl } from "./fake-kitchenowl.js";

const JULY = () => new Date(2026, 6, 15);
const JANUARY = () => new Date(2026, 0, 15);

const rotation = loadRotation();
const WEEK1 = ["leeks", "carrots", "chard", "mushrooms"];
const STAPLES = [
  "broccoli",
  "winter squash",
  "okra or zucchini",
  "lettuce and arugula",
  "a legume",
];

function setup(opts: { now?: () => Date; dbPath?: string; env?: Record<string, string> } = {}) {
  const fake = new FakeKitchenOwl();
  const dbPath = opts.dbPath ?? join(mkdtempSync(join(tmpdir(), "hga-rot-")), "hga.db");
  const out: string[] = [];
  const err: string[] = [];
  const env = {
    HGA_DB_PATH: dbPath,
    KITCHENOWL_URL: "http://127.0.0.1:1",
    KITCHENOWL_TOKEN: "synthetic",
    KITCHENOWL_HOUSEHOLD_ID: String(fake.household.id),
    KITCHENOWL_LIST_ID: String(fake.list.id),
    ...opts.env,
  };
  const table = [
    {
      name: "rotation",
      summary: "rotation",
      load: async () => createRotationCommand({ now: opts.now ?? JULY, client: () => fake }),
    },
  ];
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    loadConfig: () => loadConfig({ env }),
  };
  const run = (...args: string[]) => main(["rotation", ...args], io, table);
  const pointer = () => {
    const s = RotationState.openReadOnly(dbPath);
    try {
      return s.nextWeek();
    } finally {
      s.close();
    }
  };
  return { fake, dbPath, out, err, run, pointer };
}

test("rotation.yaml parses: 4 weeks, staples, one seasonal entry, months 4-10", () => {
  assert.equal(rotation.weeks.length, 4);
  assert.deepEqual(
    rotation.weeks[0]?.map((e) => e.name),
    WEEK1,
  );
  assert.deepEqual(
    rotation.everyWeek.filter((e) => e.seasonal).map((e) => e.name),
    ["okra or zucchini"],
  );
  assert.deepEqual(rotation.seasonalMonths, [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(rotation.seasonalMonths, DEFAULT_SEASONAL_MONTHS);
});

test("week item set = week entries + staples, names as written in the yaml", () => {
  assert.deepEqual(itemsForWeek(rotation, 1, 7), [...WEEK1, ...STAPLES]);
  const week2 = itemsForWeek(rotation, 2, 7);
  assert.ok(week2.includes("collards or turnip greens"));
  assert.ok(week2.includes("sweet potato (cooked then chilled)"));
  assert.throws(() => itemsForWeek(rotation, 5, 7), /rotation week must be 1-4/);
  assert.throws(() => itemsForWeek(rotation, 0, 7), /rotation week must be 1-4/);
});

test("seasonal gate: in season includes okra or zucchini, out of season drops it", () => {
  assert.ok(itemsForWeek(rotation, 1, 4).includes("okra or zucchini"));
  assert.ok(itemsForWeek(rotation, 1, 10).includes("okra or zucchini"));
  assert.ok(!itemsForWeek(rotation, 1, 3).includes("okra or zucchini"));
  assert.ok(!itemsForWeek(rotation, 1, 1).includes("okra or zucchini"));
  assert.ok(!itemsForWeek(rotation, 1, 11).includes("okra or zucchini"));
  assert.equal(itemsForWeek(rotation, 1, 1).length, WEEK1.length + STAPLES.length - 1);
});

test("seasonal_months is overridable in the yaml, with wrapping ranges and lists", () => {
  const custom = parseRotation(
    "weeks: {1: [a]}\nevery_week: [{item: s, seasonal: true}]\nseasonal_months: '11-2'\n",
  );
  assert.deepEqual(custom.seasonalMonths, [1, 2, 11, 12]);
  assert.deepEqual(itemsForWeek(custom, 1, 12), ["a", "s"]);
  assert.deepEqual(itemsForWeek(custom, 1, 6), ["a"]);
  assert.deepEqual(parseRotation("weeks: {1: [a]}\n").seasonalMonths, DEFAULT_SEASONAL_MONTHS);
  assert.deepEqual(parseMonths("5, 6,7"), [5, 6, 7]);
  assert.throws(() => parseMonths("13"), /bad month/);
  assert.throws(() => parseMonths("4-"), /bad month/);
  assert.throws(() => parseRotation("weeks: {1: [a], 3: [b]}\n"), /numbered 1..N/);
  assert.throws(() => parseRotation("weeks: {1: [{seasonal: true}]}\n"), /bad entry/);
});

test("week selection wraps 4 -> 1", () => {
  assert.equal(nextWeek(1, 4), 2);
  assert.equal(nextWeek(3, 4), 4);
  assert.equal(nextWeek(4, 4), 1);
});

test("name matching ignores case and whitespace", () => {
  assert.equal(matchKey("  Collards   OR turnip\tgreens "), "collards or turnip greens");
  assert.equal(matchKey("Broccoli"), matchKey(" broccoli "));
  assert.notEqual(matchKey("broccoli rabe"), matchKey("broccoli"));
  assert.equal(markFor(2), "rotation wk2");
});

test("push adds the week's set with the mark and advances; a re-run of that week adds nothing", async () => {
  const t = setup();
  assert.equal(await t.run("push"), 0);
  assert.deepEqual(
    t.fake.items.map((i) => [i.name, i.description]),
    [...WEEK1, ...STAPLES].map((n) => [n, "rotation wk1"]),
  );
  assert.equal(t.pointer(), 2);
  const writes = t.fake.writes;
  assert.equal(await t.run("push", "--week", "1"), 0);
  assert.equal(t.fake.writes, writes, "second run of the same week writes nothing");
  assert.match(t.out.join("\n"), /Added 0, skipped 9\./);
  assert.equal(t.pointer(), 2, "--week does not move the pointer");
});

test("a pre-existing unmarked duplicate is skipped and left unmarked", async () => {
  const t = setup();
  const own = t.fake.seed("  BROCCOLI ", "from the farmers market");
  assert.equal(await t.run("push"), 0);
  assert.equal(t.fake.items.filter((i) => matchKey(i.name) === "broccoli").length, 1);
  assert.equal(t.fake.items.find((i) => i.id === own.id)?.description, "from the farmers market");
  assert.match(t.out.join("\n"), /skip {2}broccoli {2}\(already on list as " {2}BROCCOLI "\)/);
});

test("four pushes cycle through weeks 1-4 and wrap back to 1", async () => {
  const t = setup();
  for (const week of [1, 2, 3, 4]) {
    assert.equal(t.pointer(), week);
    assert.equal(await t.run("push"), 0);
    assert.ok(t.fake.items.some((i) => i.description === `rotation wk${week}`));
  }
  assert.equal(t.pointer(), 1);
});

test("--week N pushes week N, logs it and leaves the pointer", async () => {
  const t = setup();
  assert.equal(await t.run("push", "--week", "3"), 0);
  assert.ok(t.fake.items.some((i) => i.name === "spinach" && i.description === "rotation wk3"));
  assert.equal(t.pointer(), 1);
  const s = RotationState.openReadOnly(t.dbPath);
  assert.deepEqual(
    s.recentPushes(1).map((p) => [p.week, p.override, p.status]),
    [[3, true, "ok"]],
  );
  s.close();
});

test("invalid --week (0, 5, non-integer, missing) exits 2 with no writes", async () => {
  for (const bad of [["0"], ["5"], ["2.5"], ["x"], []]) {
    const t = setup();
    assert.equal(await t.run("push", "--week", ...bad), 2, `--week ${bad.join(" ")}`);
    assert.equal(t.fake.writes + t.fake.reads, 0);
    assert.ok(!existsSync(t.dbPath));
  }
});

test("--dry-run push and clear write nothing and create no db file", async () => {
  const t = setup();
  assert.equal(await t.run("push", "--dry-run"), 0);
  assert.equal(await t.run("clear", "--dry-run"), 0);
  assert.equal(await t.run("show"), 0);
  assert.equal(t.fake.writes, 0);
  assert.ok(!existsSync(t.dbPath));
  assert.match(t.out.join("\n"), /\[dry run\] Pushing rotation week 1/);
  assert.match(t.out.join("\n"), /\[dry run\] Next week would become 2\./);
});

test("--dry-run on an existing db leaves state and list untouched", async () => {
  const t = setup();
  assert.equal(await t.run("push"), 0);
  const before = JSON.stringify(t.fake.items);
  const writes = t.fake.writes;
  assert.equal(await t.run("push", "--dry-run"), 0);
  assert.equal(await t.run("clear", "--dry-run"), 0);
  assert.equal(t.fake.writes, writes);
  assert.equal(JSON.stringify(t.fake.items), before);
  assert.equal(t.pointer(), 2);
  const s = RotationState.openReadOnly(t.dbPath);
  assert.equal(s.recentPushes(10).length, 1);
  s.close();
});

test("a failed push does not advance; the re-run converges via the skip rule", async () => {
  const t = setup();
  t.fake.failOnAdd = 3;
  assert.equal(await t.run("push"), 1);
  assert.match(t.err.join("\n"), /failed adding "chard".*next week stays 1/);
  assert.equal(t.pointer(), 1);
  assert.equal(t.fake.items.length, 2);
  const s = RotationState.openReadOnly(t.dbPath);
  assert.equal(s.recentPushes(1)[0]?.status, "failed");
  assert.deepEqual(
    s.outstandingAdded(t.fake.list.id).map((r) => r.name),
    ["carrots", "leeks"],
  );
  s.close();

  t.fake.failOnAdd = undefined;
  assert.equal(await t.run("push"), 0);
  assert.equal(t.pointer(), 2);
  assert.equal(t.fake.items.length, 9);
  assert.match(t.out.join("\n"), /Added 7, skipped 2\./);
  // Items from the failed run are in the log, so clear still finds them.
  assert.equal(await t.run("clear"), 0);
  assert.equal(t.fake.items.length, 0);
});

test("a list read failure before any add writes no push row and does not advance", async () => {
  const t = setup();
  t.fake.listItems = async () => {
    throw new Error("KitchenOwl GET /api/shoppinglist/3/items: HTTP 401");
  };
  assert.equal(await t.run("push"), 1);
  assert.equal(t.pointer(), 1);
  const s = RotationState.openReadOnly(t.dbPath);
  assert.equal(s.recentPushes(5).length, 0);
  s.close();
});

test("clear removes only items in the push log that still carry the mark", async () => {
  const t = setup();
  const unmarked = t.fake.seed("broccoli");
  assert.equal(await t.run("push"), 0);
  const decoy = t.fake.seed("radishes", "rotation wk1"); // marked-looking, not added by the job
  const edited = t.fake.items.find((i) => i.name === "carrots");
  assert.ok(edited);
  edited.description = "rotation wk1, 2 lb";
  assert.equal(await t.run("clear", "--dry-run"), 0);
  assert.equal(t.fake.items.length, 10);
  assert.equal(await t.run("clear"), 0);
  assert.deepEqual(t.fake.items.map((i) => i.id).sort(), [unmarked.id, decoy.id, edited.id].sort());
  assert.match(t.out.join("\n"), /Removed 7 item\(s\)\./);
  // Nothing left to clear; a second clear writes nothing.
  const writes = t.fake.writes;
  assert.equal(await t.run("clear"), 0);
  assert.equal(t.fake.writes, writes);
});

test("unset household or list fails listing the available ids", async () => {
  const noHousehold = setup({ env: { KITCHENOWL_HOUSEHOLD_ID: "" } });
  assert.equal(await noHousehold.run("push", "--dry-run"), 1);
  assert.match(
    noHousehold.err.join("\n"),
    /KITCHENOWL_HOUSEHOLD_ID is not set\. Available households: 7 \(Synthetic Household\)/,
  );
  const noList = setup({ env: { KITCHENOWL_LIST_ID: "" } });
  assert.equal(await noList.run("push"), 1);
  assert.match(noList.err.join("\n"), /KITCHENOWL_LIST_ID is not set\. .*: 3 \(Synthetic List\)/);
  const wrongList = setup({ env: { KITCHENOWL_LIST_ID: "99" } });
  assert.equal(await wrongList.run("clear"), 1);
  assert.match(wrongList.err.join("\n"), /KITCHENOWL_LIST_ID 99 is not a list in household 7/);
  for (const t of [noHousehold, noList, wrongList]) assert.equal(t.fake.writes, 0);
});

test("show prints the next week and its set offline, out of season", async () => {
  const t = setup({ now: JANUARY });
  assert.equal(await t.run("show", "--week", "2"), 0);
  const text = t.out.join("\n");
  assert.match(text, /Next rotation week: 1 of 4/);
  assert.match(text, /Items for week 2 \(month 1; seasonal months 4,5,6,7,8,9,10\)/);
  assert.match(text, /^ {2}collards or turnip greens$/m);
  assert.doesNotMatch(text, /okra/);
  assert.equal(t.fake.reads + t.fake.writes, 0);
  assert.ok(!existsSync(t.dbPath));
});

test("bad arguments exit 2", async () => {
  const t = setup();
  assert.equal(await t.run("bogus"), 2);
  assert.equal(await t.run("show", "--dry-run"), 2);
  assert.equal(await t.run("clear", "--week", "1"), 2);
  assert.equal(await t.run("push", "--force"), 2);
});
