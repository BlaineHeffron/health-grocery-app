import assert from "node:assert/strict";
import { test } from "node:test";
import {
  basketLines,
  checkCoverage,
  loadCatalog,
  parseCatalog,
  resolveItem,
} from "../src/prices/catalog.js";
import { loadRotation, parseRotation } from "../src/prices/rotation.js";
import { canonicalUnit, normalizePrice, parseSize } from "../src/prices/units.js";

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

function unitPrice(
  price: number,
  size: number,
  unit: string,
  target: Parameters<typeof normalizePrice>[3],
) {
  const n = normalizePrice(price, size, unit, target);
  assert.ok(n.ok, `expected convertible: ${JSON.stringify(n)}`);
  return n.unitPrice;
}

test("normalizes weights, counts, packs and bunches to the comparison unit", () => {
  close(unitPrice(4, 16, "oz", "lb"), 4);
  close(unitPrice(2, 8, "ounces", "lb"), 4);
  close(unitPrice(5, 1, "kg", "lb"), 5 * 0.45359237);
  close(unitPrice(3, 500, "g", "lb"), 3 / (500 / 453.59237));
  close(unitPrice(4.5, 2, "lbs", "oz"), 4.5 / 32);
  close(unitPrice(3, 3, "ct", "each"), 1);
  close(unitPrice(2.5, 1, "head", "each"), 2.5);
  close(unitPrice(1.99, 1, "bunch", "bunch"), 1.99);
});

test("unconvertible offers carry a reason instead of a price", () => {
  assert.deepEqual(normalizePrice(3.29, 32, "fl oz", "lb"), {
    ok: false,
    reason: "cannot convert fl oz to lb",
  });
  assert.deepEqual(normalizePrice(1.5, 1, "bunch", "lb"), {
    ok: false,
    reason: "cannot convert bunch to lb",
  });
  assert.deepEqual(normalizePrice(1, 1, "crate", "lb"), {
    ok: false,
    reason: 'unknown unit "crate"',
  });
  assert.equal(normalizePrice(1, 0, "lb", "lb").ok, false);
  assert.equal(canonicalUnit("constructor"), undefined);
});

test("parses package sizes", () => {
  assert.deepEqual(parseSize("16 oz"), { size: 16, unit: "oz" });
  assert.deepEqual(parseSize("1.5 lb bag"), { size: 1.5, unit: "lb" });
  assert.deepEqual(parseSize("32 fl oz"), { size: 32, unit: "fl oz" });
  assert.deepEqual(parseSize("3 ct"), { size: 3, unit: "each" });
  assert.deepEqual(parseSize("each"), { size: 1, unit: "each" });
  assert.deepEqual(parseSize("per lb"), { size: 1, unit: "lb" });
  assert.equal(parseSize("large"), undefined);
});

test("the committed catalog covers every rotation entry, all weeks plus every_week", () => {
  const rotation = loadRotation();
  const catalog = loadCatalog();
  checkCoverage(catalog, rotation);
  assert.equal(rotation.entries.filter((e) => e.week === "every_week").length, 5);
  assert.ok(rotation.entries.find((e) => e.name === "okra or zucchini")?.seasonal);
  const lines = basketLines(catalog, rotation.entries);
  const collards = lines.find((l) => l.line === "collards or turnip greens");
  assert.deepEqual(
    collards?.alternatives.map((a) => a.name),
    ["collards", "turnip greens"],
  );
  // "and" entries become one line per part.
  assert.deepEqual(
    lines.filter((l) => l.entry === "shallots and garlic").map((l) => [l.line, l.unit]),
    [
      ["shallots and garlic / shallots", "lb"],
      ["shallots and garlic / garlic", "each"],
    ],
  );
});

test("catalog validation and item resolution", () => {
  const rotation = parseRotation("weeks:\n  1: [kale]\nevery_week: [onions]\n");
  const catalog = parseCatalog(
    "entries:\n  kale: { unit: bunch, terms: [kale] }\n  onions:\n    pick: any\n    unit: lb\n    items:\n      yellow onion: [yellow onions]\n      red onion: [red onions]\n",
  );
  checkCoverage(catalog, rotation);
  assert.equal(resolveItem(catalog, "Kale").name, "kale");
  assert.equal(resolveItem(catalog, "red onion").name, "red onion");
  assert.throws(
    () => resolveItem(catalog, "onions"),
    /several items; use one of: yellow onion, red onion/,
  );
  assert.throws(() => resolveItem(catalog, "durian"), /unknown item/);
  assert.throws(
    () =>
      checkCoverage(parseCatalog("entries:\n  kale: { unit: bunch, terms: [kale] }\n"), rotation),
    /missing \[onions\]/,
  );
  assert.throws(
    () => parseCatalog("entries:\n  kale: { unit: pallet, terms: [kale] }\n"),
    /unit must be/,
  );
});
