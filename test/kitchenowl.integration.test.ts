/**
 * Integration test against a DISPOSABLE KitchenOwl v0.8.1 container (scripts/kitchenowl-it.sh
 * starts one). Skipped unless HGA_IT_KITCHENOWL_URL is set. The target guard runs before any
 * request: loopback host and a non-KitchenOwl port only. It onboards a synthetic account, so it
 * only works on a fresh instance.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KitchenOwlClient, type ListItem } from "../src/kitchenowl/client.js";
import { itemsForWeek, loadRotation, matchKey } from "../src/rotation/plan.js";
import { assertDisposableTarget } from "./kitchenowl-target-guard.js";

const TARGET = process.env.HGA_IT_KITCHENOWL_URL;
const BIN = fileURLToPath(new URL("../src/bin.js", import.meta.url));

async function post(base: string, path: string, body: unknown, auth?: string): Promise<unknown> {
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth === undefined ? {} : { authorization: ["Bearer", auth].join(" ") }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`setup POST /api${path}: HTTP ${res.status}`);
  return res.json();
}

test("rotation push/clear against a disposable KitchenOwl", {
  skip: TARGET === undefined,
}, async () => {
  const base = assertDisposableTarget(String(TARGET)).origin;

  // Synthetic account, household and long-lived token on the fresh instance.
  const secret = ["it", "synthetic", String(Date.now())].join("-");
  const onboard = (await post(base, "/onboarding", {
    name: "IT Admin",
    username: "itadmin",
    password: secret,
  })) as { access_token: string };
  const household = (await post(
    base,
    "/household",
    { name: "IT Household", language: "en", member: [] },
    onboard.access_token,
  )) as { id: number; default_shopping_list: { id: number } };
  const llt = (
    (await post(base, "/auth/llt", { device: "hga-it" }, onboard.access_token)) as {
      longlived_token: string;
    }
  ).longlived_token;
  const listId = household.default_shopping_list.id;
  const client = new KitchenOwlClient({ baseUrl: base, token: llt });

  // A pre-existing unmarked duplicate, with different case and spacing.
  await client.addItem(listId, " Broccoli ", "");

  const dbPath = join(mkdtempSync(join(tmpdir(), "hga-it-")), "hga.db");
  const env = {
    PATH: process.env.PATH,
    HGA_DB_PATH: dbPath,
    KITCHENOWL_URL: base,
    KITCHENOWL_TOKEN: llt,
    KITCHENOWL_HOUSEHOLD_ID: String(household.id),
    KITCHENOWL_LIST_ID: String(listId),
  };
  const hga = (...args: string[]) => {
    const out = execFileSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", BIN, "rotation", ...args],
      { cwd: tmpdir(), env, encoding: "utf8" },
    );
    console.log(`$ hga rotation ${args.join(" ")}\n${out.trimEnd()}\n`);
    assert.ok(!out.includes(llt), "output never contains the token");
    return out;
  };
  const snapshot = async () =>
    (await client.listItems(listId))
      .map((i: ListItem) => `${i.id}|${i.name}|${i.description}`)
      .sort();

  const month = new Date().getMonth() + 1;
  const expected = itemsForWeek(loadRotation(), 1, month);

  let before = await snapshot();
  hga("push", "--dry-run");
  assert.deepEqual(await snapshot(), before, "dry run changes nothing");

  hga("push");
  const items = await client.listItems(listId);
  for (const name of expected) {
    const found = items.find((i) => matchKey(i.name) === matchKey(name));
    assert.ok(found, `${name} is on the list`);
    assert.equal(found.description, name === "broccoli" ? "" : "rotation wk1", name);
  }
  assert.equal(items.length, expected.length);

  before = await snapshot();
  const rerun = hga("push", "--week", "1");
  assert.match(rerun, /Added 0, skipped \d+\./);
  assert.deepEqual(await snapshot(), before, "re-run of the same week adds nothing");

  // A marked-looking item the job did not add must survive clear.
  await client.addItem(listId, "synthetic decoy", "rotation wk1");
  before = await snapshot();
  hga("clear", "--dry-run");
  assert.deepEqual(await snapshot(), before, "dry-run clear changes nothing");

  hga("clear");
  const left = (await client.listItems(listId)).map((i) => [matchKey(i.name), i.description]);
  assert.deepEqual(left.sort(), [
    ["broccoli", ""],
    ["synthetic decoy", "rotation wk1"],
  ]);
  hga("show");
});
