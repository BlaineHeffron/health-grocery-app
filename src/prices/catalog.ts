import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Rotation, RotationEntry } from "./rotation.js";
import { COMPARISON_UNITS, type ComparisonUnit } from "./units.js";

export const CATALOG_FILE = fileURLToPath(
  new URL("../../../data/price-catalog.yaml", import.meta.url),
);

export interface CatalogItem {
  /** Concrete item name, e.g. "collards". Offers are stored against this name. */
  name: string;
  unit: ComparisonUnit;
  terms: string[];
}

export interface CatalogEntry {
  /** The rotation entry text, e.g. "collards or turnip greens". */
  entry: string;
  pick: "any" | "all";
  items: CatalogItem[];
}

export type Catalog = Map<string, CatalogEntry>;

/** One row of the comparison basket: a set of alternatives, the cheapest of which wins. */
export interface BasketLine {
  /** Display/id label: the entry, or "entry / item" for each part of a `pick: all` entry. */
  line: string;
  entry: string;
  week: RotationEntry["week"];
  seasonal: boolean;
  unit: ComparisonUnit;
  alternatives: CatalogItem[];
}

function unitOf(raw: unknown, where: string): ComparisonUnit {
  if (typeof raw === "string" && (COMPARISON_UNITS as readonly string[]).includes(raw)) {
    return raw as ComparisonUnit;
  }
  throw new Error(`catalog: ${where}: unit must be one of ${COMPARISON_UNITS.join(", ")}`);
}

function termsOf(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((t) => typeof t === "string")) {
    throw new Error(`catalog: ${where}: terms must be a non-empty list of strings`);
  }
  return raw.map((t: string) => t.trim());
}

export function parseCatalog(text: string): Catalog {
  const doc = parse(text) as { entries?: Record<string, unknown> } | null;
  if (doc?.entries === null || typeof doc?.entries !== "object") {
    throw new Error("catalog: missing `entries` map");
  }
  const catalog: Catalog = new Map();
  for (const [entry, raw] of Object.entries(doc.entries)) {
    const r = (raw ?? {}) as { pick?: unknown; unit?: unknown; terms?: unknown; items?: unknown };
    let parsed: CatalogEntry;
    if (r.items === undefined) {
      parsed = {
        entry,
        pick: "any",
        items: [{ name: entry, unit: unitOf(r.unit, entry), terms: termsOf(r.terms, entry) }],
      };
    } else {
      if (r.pick !== "any" && r.pick !== "all") {
        throw new Error(`catalog: ${entry}: pick must be "any" or "all"`);
      }
      if (r.items === null || typeof r.items !== "object" || Array.isArray(r.items)) {
        throw new Error(`catalog: ${entry}: items must be a map`);
      }
      const pick = r.pick;
      const items = Object.entries(r.items as Record<string, unknown>).map(([name, v]) => {
        const where = `${entry} / ${name}`;
        if (pick === "any") return { name, unit: unitOf(r.unit, entry), terms: termsOf(v, where) };
        const item = (v ?? {}) as { unit?: unknown; terms?: unknown };
        return { name, unit: unitOf(item.unit, where), terms: termsOf(item.terms, where) };
      });
      if (items.length === 0) throw new Error(`catalog: ${entry}: items is empty`);
      parsed = { entry, pick, items };
    }
    catalog.set(entry, parsed);
  }
  const names = new Map<string, string>();
  for (const e of catalog.values()) {
    for (const item of e.items) {
      const key = item.name.toLowerCase();
      const other = names.get(key);
      if (other !== undefined && other !== e.entry) {
        throw new Error(`catalog: item name "${item.name}" is used by "${other}" and "${e.entry}"`);
      }
      names.set(key, e.entry);
    }
  }
  return catalog;
}

export function loadCatalog(path: string = CATALOG_FILE): Catalog {
  return parseCatalog(readFileSync(path, "utf8"));
}

/** Throws unless the catalog covers exactly the rotation's entries. */
export function checkCoverage(catalog: Catalog, rotation: Rotation): void {
  const wanted = new Set(rotation.entries.map((e) => e.name));
  const missing = [...wanted].filter((n) => !catalog.has(n));
  const extra = [...catalog.keys()].filter((n) => !wanted.has(n));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `catalog does not match rotation: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
    );
  }
}

/** Basket lines for the given rotation entries (in order). */
export function basketLines(catalog: Catalog, entries: readonly RotationEntry[]): BasketLine[] {
  const lines: BasketLine[] = [];
  for (const e of entries) {
    const c = catalog.get(e.name);
    if (c === undefined) throw new Error(`catalog has no entry for rotation item "${e.name}"`);
    const base = { entry: e.name, week: e.week, seasonal: e.seasonal };
    const first = c.items[0];
    if (c.pick === "any" && first !== undefined) {
      lines.push({ ...base, line: e.name, unit: first.unit, alternatives: c.items });
    } else {
      for (const item of c.items) {
        lines.push({
          ...base,
          line: `${e.name} / ${item.name}`,
          unit: item.unit,
          alternatives: [item],
        });
      }
    }
  }
  return lines;
}

/** Resolves `--item` (an entry name or an item name, case-insensitive) to one catalog item. */
export function resolveItem(catalog: Catalog, name: string): CatalogItem {
  const key = name.trim().toLowerCase();
  const matches: CatalogItem[] = [];
  for (const e of catalog.values()) {
    if (e.entry.toLowerCase() === key && e.items.length === 1 && e.items[0]) {
      matches.push(e.items[0]);
      continue;
    }
    for (const item of e.items) if (item.name.toLowerCase() === key) matches.push(item);
  }
  const [only] = matches;
  if (only !== undefined) return only;
  for (const e of catalog.values()) {
    if (e.entry.toLowerCase() === key) {
      throw new Error(
        `"${name}" has several items; use one of: ${e.items.map((i) => i.name).join(", ")}`,
      );
    }
  }
  throw new Error(`unknown item "${name}" (see data/price-catalog.yaml)`);
}
