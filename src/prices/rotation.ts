import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * Minimal reader for data/rotation.yaml, local to the prices feature. The rotation room owns
 * the full loader (src/rotation/**); this one only needs entry names and can be swapped for
 * theirs once both have merged.
 */

export const ROTATION_FILE = fileURLToPath(new URL("../../../data/rotation.yaml", import.meta.url));

export interface RotationEntry {
  name: string;
  /** Week number 1..N, or "every_week" for the staples. */
  week: number | "every_week";
  seasonal: boolean;
}

export interface Rotation {
  weeks: number[];
  entries: RotationEntry[];
}

function entryOf(raw: unknown, week: RotationEntry["week"]): RotationEntry {
  if (typeof raw === "string") return { name: raw.trim(), week, seasonal: false };
  if (
    raw !== null &&
    typeof raw === "object" &&
    typeof (raw as { item?: unknown }).item === "string"
  ) {
    const r = raw as { item: string; seasonal?: unknown };
    return { name: r.item.trim(), week, seasonal: r.seasonal === true };
  }
  throw new Error(`rotation: bad entry in ${week}: ${JSON.stringify(raw)}`);
}

export function parseRotation(text: string): Rotation {
  const doc = parse(text) as { weeks?: unknown; every_week?: unknown } | null;
  if (doc?.weeks === null || typeof doc?.weeks !== "object") {
    throw new Error("rotation: missing `weeks` map");
  }
  const entries: RotationEntry[] = [];
  const weeks: number[] = [];
  for (const [key, list] of Object.entries(doc.weeks as Record<string, unknown>)) {
    const week = Number(key);
    if (!Number.isInteger(week) || week < 1 || !Array.isArray(list)) {
      throw new Error(`rotation: bad week ${key}`);
    }
    weeks.push(week);
    for (const raw of list) entries.push(entryOf(raw, week));
  }
  if (!Array.isArray(doc.every_week)) throw new Error("rotation: missing `every_week` list");
  for (const raw of doc.every_week) entries.push(entryOf(raw, "every_week"));
  return { weeks: weeks.sort((a, b) => a - b), entries };
}

export function loadRotation(path: string = ROTATION_FILE): Rotation {
  return parseRotation(readFileSync(path, "utf8"));
}
