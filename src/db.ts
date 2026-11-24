import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** Repo-level `migrations/` directory (works from src/ via tsc output in dist/src/). */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

/** Migration files in apply order (lexicographic by filename). */
export function listMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      if (!MIGRATION_FILE.test(name)) {
        throw new Error(`Bad migration filename: ${name} (expected NNNN_name.sql)`);
      }
      return name;
    })
    .sort();
}

/**
 * Applies every migration in `dir` not yet recorded in schema_migrations, each in its own
 * transaction. Returns the filenames applied (empty when already up to date).
 */
export function migrate(db: DatabaseSync, dir: string = MIGRATIONS_DIR): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     )`,
  );
  const done = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((row) => String(row.name)),
  );
  const record = db.prepare("INSERT INTO schema_migrations (name) VALUES (?)");
  const applied: string[] = [];
  for (const name of listMigrations(dir)) {
    if (done.has(name)) continue;
    const sql = readFileSync(join(dir, name), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      record.run(name);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
    }
    applied.push(name);
  }
  return applied;
}
