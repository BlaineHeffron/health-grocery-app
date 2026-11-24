import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrate, openDb } from "../db.js";

export type ItemAction = "added" | "skipped" | "failed";

export interface PushRow {
  id: number;
  pushedAt: string;
  week: number;
  override: boolean;
  listId: number;
  status: "running" | "ok" | "failed";
  error: string | null;
  added: number;
  skipped: number;
}

export interface AddedItem {
  pushId: number;
  name: string;
  kitchenowlItemId: number;
  mark: string;
}

/**
 * Rotation state over the SQLite db. Reads work on a missing or unmigrated db (defaults);
 * writes need a store opened with `openForWrite`.
 */
export class RotationState {
  private constructor(
    private readonly db: DatabaseSync | undefined,
    private readonly writable: boolean,
  ) {}

  /** Opens the db, creating and migrating it if needed. */
  static openForWrite(dbPath: string): RotationState {
    const db = openDb(dbPath);
    try {
      migrate(db);
    } catch (err) {
      db.close();
      throw err;
    }
    return new RotationState(db, true);
  }

  /** Opens read-only; never creates, migrates or writes the db file (for show and --dry-run). */
  static openReadOnly(dbPath: string): RotationState {
    if (!existsSync(dbPath)) return new RotationState(undefined, false);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const has = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rotation_state'")
      .get();
    if (has === undefined) {
      db.close();
      return new RotationState(undefined, false);
    }
    return new RotationState(db, false);
  }

  close(): void {
    this.db?.close();
  }

  private rw(): DatabaseSync {
    if (this.db === undefined || !this.writable) throw new Error("rotation state is read-only");
    return this.db;
  }

  nextWeek(): number {
    const row = this.db?.prepare("SELECT next_week FROM rotation_state WHERE id = 1").get();
    return row === undefined ? 1 : Number(row.next_week);
  }

  setNextWeek(week: number): void {
    this.rw()
      .prepare(
        "UPDATE rotation_state SET next_week = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 1",
      )
      .run(week);
  }

  startPush(p: { week: number; override: boolean; householdId: number; listId: number }): number {
    const r = this.rw()
      .prepare(
        "INSERT INTO rotation_push (week, override, household_id, list_id, status) VALUES (?, ?, ?, ?, 'running')",
      )
      .run(p.week, p.override ? 1 : 0, p.householdId, p.listId);
    return Number(r.lastInsertRowid);
  }

  logItem(
    pushId: number,
    name: string,
    action: ItemAction,
    added?: { kitchenowlItemId: number; mark: string },
  ): void {
    this.rw()
      .prepare(
        "INSERT INTO rotation_push_item (push_id, name, action, kitchenowl_item_id, mark) VALUES (?, ?, ?, ?, ?)",
      )
      .run(pushId, name, action, added?.kitchenowlItemId ?? null, added?.mark ?? null);
  }

  /** Marks the push finished; on success also moves next_week (if given), atomically. */
  finishPush(
    pushId: number,
    result: { ok: true; nextWeek?: number } | { ok: false; error: string },
  ) {
    const db = this.rw();
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE rotation_push SET status = ?, error = ? WHERE id = ?").run(
        result.ok ? "ok" : "failed",
        result.ok ? null : result.error,
        pushId,
      );
      if (result.ok && result.nextWeek !== undefined) this.setNextWeek(result.nextWeek);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Items this job added to `listId` that `clear` has not removed yet. */
  outstandingAdded(listId: number): AddedItem[] {
    if (this.db === undefined) return [];
    return this.db
      .prepare(
        `SELECT i.push_id, i.name, i.kitchenowl_item_id, i.mark
           FROM rotation_push_item i JOIN rotation_push p ON p.id = i.push_id
          WHERE p.list_id = ? AND i.action = 'added' AND i.cleared_at IS NULL
          ORDER BY i.push_id, i.name`,
      )
      .all(listId)
      .map((r) => ({
        pushId: Number(r.push_id),
        name: String(r.name),
        kitchenowlItemId: Number(r.kitchenowl_item_id),
        mark: String(r.mark),
      }));
  }

  markCleared(pushId: number, name: string): void {
    this.rw()
      .prepare(
        "UPDATE rotation_push_item SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE push_id = ? AND name = ?",
      )
      .run(pushId, name);
  }

  recentPushes(limit: number): PushRow[] {
    if (this.db === undefined) return [];
    return this.db
      .prepare(
        `SELECT p.id, p.pushed_at, p.week, p.override, p.list_id, p.status, p.error,
                (SELECT count(*) FROM rotation_push_item i WHERE i.push_id = p.id AND i.action = 'added') AS added,
                (SELECT count(*) FROM rotation_push_item i WHERE i.push_id = p.id AND i.action = 'skipped') AS skipped
           FROM rotation_push p ORDER BY p.id DESC LIMIT ?`,
      )
      .all(limit)
      .map((r) => ({
        id: Number(r.id),
        pushedAt: String(r.pushed_at),
        week: Number(r.week),
        override: Number(r.override) === 1,
        listId: Number(r.list_id),
        status: String(r.status) as PushRow["status"],
        error: r.error === null ? null : String(r.error),
        added: Number(r.added),
        skipped: Number(r.skipped),
      }));
  }
}
