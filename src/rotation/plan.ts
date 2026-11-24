import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/** Repo-level `data/rotation.yaml` (works from src/ via tsc output in dist/src/). */
export const ROTATION_FILE = fileURLToPath(new URL("../../../data/rotation.yaml", import.meta.url));

/**
 * Months (1-12) in which seasonal entries ("okra or zucchini") are on the list, used when the
 * yaml has no `seasonal_months`. Suited to Charleston, SC: zucchini from about April, okra
 * through October.
 */
export const DEFAULT_SEASONAL_MONTHS: readonly number[] = [4, 5, 6, 7, 8, 9, 10];

export interface RotationEntry {
  name: string;
  seasonal: boolean;
}

export interface Rotation {
  /** weeks[0] is rotation week 1. */
  weeks: RotationEntry[][];
  everyWeek: RotationEntry[];
  /** Months (1-12) when seasonal entries are included. */
  seasonalMonths: number[];
}

function entry(raw: unknown, where: string): RotationEntry {
  if (typeof raw === "string" && raw.trim()) return { name: raw.trim(), seasonal: false };
  if (raw !== null && typeof raw === "object" && "item" in raw) {
    const { item, seasonal } = raw as { item: unknown; seasonal?: unknown };
    if (
      typeof item === "string" &&
      item.trim() &&
      (seasonal === undefined || typeof seasonal === "boolean")
    ) {
      return { name: item.trim(), seasonal: seasonal === true };
    }
  }
  throw new Error(`rotation: bad entry in ${where}: ${JSON.stringify(raw)}`);
}

/**
 * Parses rotation yaml text: `weeks: {1: [...], ..., N: [...]}`, `every_week: [...]` and an
 * optional `seasonal_months` (see parseMonths).
 */
export function parseRotation(text: string): Rotation {
  const doc = parse(text) as {
    weeks?: unknown;
    every_week?: unknown;
    seasonal_months?: unknown;
  } | null;
  const weeksRaw = doc?.weeks;
  if (weeksRaw === null || typeof weeksRaw !== "object" || Array.isArray(weeksRaw)) {
    throw new Error("rotation: `weeks` must map week numbers to lists");
  }
  const keys = Object.keys(weeksRaw).sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0 || keys.some((k, i) => k !== String(i + 1))) {
    throw new Error("rotation: `weeks` must be numbered 1..N with no gaps");
  }
  const weeks = keys.map((k) => {
    const list = (weeksRaw as Record<string, unknown>)[k];
    if (!Array.isArray(list)) throw new Error(`rotation: week ${k} must be a list`);
    return list.map((raw) => entry(raw, `week ${k}`));
  });
  const everyRaw = doc?.every_week ?? [];
  if (!Array.isArray(everyRaw)) throw new Error("rotation: `every_week` must be a list");
  const monthsRaw = doc?.seasonal_months;
  if (monthsRaw !== undefined && typeof monthsRaw !== "string" && typeof monthsRaw !== "number") {
    throw new Error('rotation: `seasonal_months` must be a string such as "4-10"');
  }
  return {
    weeks,
    everyWeek: everyRaw.map((raw) => entry(raw, "every_week")),
    seasonalMonths:
      monthsRaw === undefined ? [...DEFAULT_SEASONAL_MONTHS] : parseMonths(String(monthsRaw)),
  };
}

export function loadRotation(path: string = ROTATION_FILE): Rotation {
  return parseRotation(readFileSync(path, "utf8"));
}

/** Parses a month list such as "4-10", "4,5,6" or "11-2" (wraps over the new year). */
export function parseMonths(spec: string): number[] {
  const months = new Set<number>();
  const month = (s: string): number => {
    if (!/^\d{1,2}$/.test(s) || Number(s) < 1 || Number(s) > 12) {
      throw new Error(`rotation: seasonal_months: bad month "${s}" (use 1-12, e.g. 4-10 or 5,6,7)`);
    }
    return Number(s);
  };
  for (const part of spec.split(",").map((p) => p.trim())) {
    const range = part.split("-").map((p) => p.trim());
    if (range.length === 1) months.add(month(part));
    else if (range.length === 2) {
      const from = month(range[0] ?? "");
      const to = month(range[1] ?? "");
      for (let m = from; ; m = (m % 12) + 1) {
        months.add(m);
        if (m === to) break;
      }
    } else throw new Error(`rotation: seasonal_months: bad range "${part}"`);
  }
  return [...months].sort((a, b) => a - b);
}

/** Week after `week` in a rotation of `count` weeks, wrapping count -> 1. */
export function nextWeek(week: number, count: number): number {
  return (week % count) + 1;
}

/**
 * The list items for rotation week `week` (1-based) in calendar month `month` (1-12): the
 * week's entries, then the every-week staples, with seasonal entries kept only in season.
 * Names are as written in the yaml; duplicates (by matchKey) keep the first.
 */
export function itemsForWeek(
  rotation: Rotation,
  week: number,
  month: number,
  seasonalMonths: readonly number[] = rotation.seasonalMonths,
): string[] {
  const entries = rotation.weeks[week - 1];
  if (!Number.isInteger(week) || entries === undefined) {
    throw new Error(`rotation week must be 1-${rotation.weeks.length}, got ${week}`);
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const e of [...entries, ...rotation.everyWeek]) {
    if (e.seasonal && !seasonalMonths.includes(month)) continue;
    const key = matchKey(e.name);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(e.name);
  }
  return items;
}

/** Name comparison key: case-insensitive, surrounding and repeated whitespace ignored. */
export function matchKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Mark put in the description of every item the push adds. */
export function markFor(week: number): string {
  return `rotation wk${week}`;
}
