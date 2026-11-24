import type { KitchenOwlClient, ListItem } from "../kitchenowl/client.js";
import { matchKey } from "./plan.js";
import type { RotationState } from "./state.js";

/** The client calls the push and clear jobs use (a fake implements this in tests). */
export type ListClient = Pick<
  KitchenOwlClient,
  "households" | "shoppingLists" | "listItems" | "addItem" | "removeItem"
>;

export interface Target {
  householdId: number;
  listId: number;
}

function parseId(name: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

/**
 * Resolves the household and shopping list from KITCHENOWL_HOUSEHOLD_ID / KITCHENOWL_LIST_ID.
 * When one is unset or unknown, fails with a message listing the ids that are available.
 */
export async function resolveTarget(
  client: ListClient,
  householdVar: string | undefined,
  listVar: string | undefined,
): Promise<Target> {
  if (householdVar === undefined) {
    const hs = await client.households();
    throw new Error(
      `KITCHENOWL_HOUSEHOLD_ID is not set. Available households: ${describe(hs)}. Set it in .env.`,
    );
  }
  const householdId = parseId("KITCHENOWL_HOUSEHOLD_ID", householdVar);
  const lists = await client.shoppingLists(householdId);
  if (listVar === undefined) {
    throw new Error(
      `KITCHENOWL_LIST_ID is not set. Shopping lists in household ${householdId}: ${describe(lists)}. Set it in .env.`,
    );
  }
  const listId = parseId("KITCHENOWL_LIST_ID", listVar);
  if (!lists.some((l) => l.id === listId)) {
    throw new Error(
      `KITCHENOWL_LIST_ID ${listId} is not a list in household ${householdId}. Available: ${describe(lists)}.`,
    );
  }
  return { householdId, listId };
}

function describe(rows: { id: number; name: string }[]): string {
  return rows.length === 0 ? "(none)" : rows.map((r) => `${r.id} (${r.name})`).join(", ");
}

export interface PlannedItem {
  name: string;
  action: "add" | "skip";
  /** For skips: the name already on the list. */
  existing?: string;
}

/** Splits the week's items into adds and skips (already on the list, by matchKey). */
export function planPush(items: readonly string[], onList: readonly ListItem[]): PlannedItem[] {
  const present = new Map(onList.map((i) => [matchKey(i.name), i.name]));
  return items.map((name) => {
    const existing = present.get(matchKey(name));
    return existing === undefined ? { name, action: "add" } : { name, action: "skip", existing };
  });
}

export interface PushResult {
  added: string[];
  skipped: string[];
  /** Set when an add failed; the push stops there and next_week does not move. */
  error?: string;
}

/**
 * Adds the planned items with `mark` as description, logging each one as it goes. The push row
 * ends 'ok' (moving next_week to `advanceTo` when given) or 'failed' (next_week unchanged).
 */
export async function executePush(
  client: ListClient,
  state: RotationState,
  target: Target,
  plan: readonly PlannedItem[],
  p: { week: number; override: boolean; mark: string; advanceTo?: number },
): Promise<PushResult> {
  const pushId = state.startPush({ week: p.week, override: p.override, ...target });
  const result: PushResult = { added: [], skipped: [] };
  for (const item of plan) {
    if (item.action === "skip") {
      state.logItem(pushId, item.name, "skipped");
      result.skipped.push(item.name);
      continue;
    }
    try {
      const id = await client.addItem(target.listId, item.name, p.mark);
      state.logItem(pushId, item.name, "added", { kitchenowlItemId: id, mark: p.mark });
      result.added.push(item.name);
    } catch (err) {
      state.logItem(pushId, item.name, "failed");
      result.error = `adding "${item.name}": ${(err as Error).message}`;
      break;
    }
  }
  state.finishPush(
    pushId,
    result.error === undefined
      ? { ok: true, ...(p.advanceTo === undefined ? {} : { nextWeek: p.advanceTo }) }
      : { ok: false, error: result.error },
  );
  return result;
}

export interface ClearCandidate {
  item: ListItem;
  /** Log rows this list item satisfies (same KitchenOwl id, still carrying the mark). */
  rows: { pushId: number; name: string }[];
}

/**
 * Items `clear` may remove: on the list now, added by this job (in the push log, not yet
 * cleared) and still carrying exactly the mark the job wrote. Anything else stays.
 */
export function planClear(state: RotationState, listId: number, onList: readonly ListItem[]) {
  const byId = new Map(onList.map((i) => [i.id, i]));
  const candidates = new Map<number, ClearCandidate>();
  for (const row of state.outstandingAdded(listId)) {
    const item = byId.get(row.kitchenowlItemId);
    if (item === undefined || item.description !== row.mark) continue;
    if (matchKey(item.name) !== matchKey(row.name)) continue;
    const c = candidates.get(item.id) ?? { item, rows: [] };
    c.rows.push({ pushId: row.pushId, name: row.name });
    candidates.set(item.id, c);
  }
  return [...candidates.values()];
}

export async function executeClear(
  client: ListClient,
  state: RotationState,
  listId: number,
  candidates: readonly ClearCandidate[],
): Promise<{ removed: string[]; error?: string }> {
  const removed: string[] = [];
  for (const c of candidates) {
    try {
      await client.removeItem(listId, c.item.id);
    } catch (err) {
      return { removed, error: `removing "${c.item.name}": ${(err as Error).message}` };
    }
    for (const r of c.rows) state.markCleared(r.pushId, r.name);
    removed.push(c.item.name);
  }
  return { removed };
}
