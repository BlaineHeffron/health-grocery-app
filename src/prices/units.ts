/** Unit parsing and conversion to a catalog comparison unit. */

/** Units a catalog entry can be compared in. */
export const COMPARISON_UNITS = ["lb", "oz", "kg", "g", "each", "bunch"] as const;
export type ComparisonUnit = (typeof COMPARISON_UNITS)[number];

type Dimension = "weight" | "count" | "bunch" | "volume";

interface UnitInfo {
  dimension: Dimension;
  /** Size of one of this unit in the dimension's base (grams, items, bunches, millilitres). */
  base: number;
}

const UNITS: Record<string, UnitInfo> = {
  g: { dimension: "weight", base: 1 },
  kg: { dimension: "weight", base: 1000 },
  oz: { dimension: "weight", base: 28.349523125 },
  lb: { dimension: "weight", base: 453.59237 },
  each: { dimension: "count", base: 1 },
  bunch: { dimension: "bunch", base: 1 },
  ml: { dimension: "volume", base: 1 },
  l: { dimension: "volume", base: 1000 },
  "fl oz": { dimension: "volume", base: 29.5735295625 },
  pt: { dimension: "volume", base: 473.176473 },
  qt: { dimension: "volume", base: 946.352946 },
  gal: { dimension: "volume", base: 3785.411784 },
};

const ALIASES: Record<string, string> = {
  gram: "g",
  grams: "g",
  gm: "g",
  kgs: "kg",
  kilogram: "kg",
  kilograms: "kg",
  ounce: "oz",
  ounces: "oz",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  ea: "each",
  ct: "each",
  count: "each",
  pc: "each",
  pcs: "each",
  piece: "each",
  pieces: "each",
  head: "each",
  heads: "each",
  unit: "each",
  bunches: "bunch",
  bn: "bunch",
  floz: "fl oz",
  "fl. oz": "fl oz",
  "fl. oz.": "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  pint: "pt",
  quart: "qt",
  gallon: "gal",
};

/** Canonical unit name for a free-form unit (e.g. "Lbs" -> "lb"), or undefined if unknown. */
export function canonicalUnit(raw: string): string | undefined {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
  const name = (Object.hasOwn(ALIASES, key) ? ALIASES[key] : undefined) ?? key;
  return Object.hasOwn(UNITS, name) ? name : undefined;
}

export interface ParsedSize {
  size: number;
  unit: string;
}

/**
 * Parses a package size such as "16 oz", "1.5 lb bag", "3 ct", "each" or "32 fl oz".
 * Returns undefined when no known unit is found.
 */
export function parseSize(text: string): ParsedSize | undefined {
  const s = text.trim().toLowerCase();
  const m = /(\d+(?:\.\d+)?|\.\d+)\s*(fl\.?\s*oz\.?|[a-z]+)/.exec(s);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const unit = canonicalUnit(m[2].replace(/\s+/g, " ").replace("fl. oz", "fl oz"));
    if (unit !== undefined) return { size: Number(m[1]), unit };
  }
  const bare = canonicalUnit(s.replace(/^(per|1)\s+/, ""));
  return bare === undefined ? undefined : { size: 1, unit: bare };
}

export type Normalized = { ok: true; unitPrice: number } | { ok: false; reason: string };

/** Price per one `target` unit for an offer of `size` `unit` at `price`. */
export function normalizePrice(
  price: number,
  size: number,
  unit: string,
  target: ComparisonUnit,
): Normalized {
  if (!(price >= 0) || !Number.isFinite(price)) return { ok: false, reason: "invalid price" };
  if (!(size > 0) || !Number.isFinite(size)) return { ok: false, reason: "invalid size" };
  const from = canonicalUnit(unit);
  if (from === undefined) return { ok: false, reason: `unknown unit "${unit}"` };
  const a = UNITS[from];
  const b = UNITS[target];
  if (a === undefined || b === undefined || a.dimension !== b.dimension) {
    return { ok: false, reason: `cannot convert ${from} to ${target}` };
  }
  const targetsInOffer = (size * a.base) / b.base;
  return { ok: true, unitPrice: price / targetsInOffer };
}
