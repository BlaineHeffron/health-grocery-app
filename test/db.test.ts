import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listMigrations, MIGRATIONS_DIR, migrate, openDb } from "../src/db.js";

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "hga-mig-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

test("applies migrations in filename order, once", () => {
  const dir = fixture({
    "0002_b_second.sql": "INSERT INTO t (v) VALUES ('b');",
    "0001_a_first.sql": "CREATE TABLE t (v TEXT);",
    "0002_a_second.sql": "INSERT INTO t (v) VALUES ('a');",
    "README.md": "ignored",
  });
  const dbPath = join(mkdtempSync(join(tmpdir(), "hga-db-")), "nested", "hga.db");
  const db = openDb(dbPath);
  try {
    assert.ok(existsSync(dbPath));
    assert.deepEqual(migrate(db, dir), [
      "0001_a_first.sql",
      "0002_a_second.sql",
      "0002_b_second.sql",
    ]);
    assert.deepEqual(migrate(db, dir), []);
    const rows = db.prepare("SELECT v FROM t ORDER BY rowid").all();
    assert.deepEqual(
      rows.map((r) => r.v),
      ["a", "b"],
    );
  } finally {
    db.close();
  }
});

test("a failing migration rolls back and is not recorded", () => {
  const dir = fixture({
    "0001_ok.sql": "CREATE TABLE t (v TEXT);",
    "0002_bad.sql": "INSERT INTO t (v) VALUES ('x'); INSERT INTO missing VALUES (1);",
  });
  const db = openDb(":memory:");
  try {
    assert.throws(() => migrate(db, dir), /Migration 0002_bad\.sql failed/);
    assert.deepEqual(
      db
        .prepare("SELECT name FROM schema_migrations")
        .all()
        .map((r) => r.name),
      ["0001_ok.sql"],
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM t").get()?.n, 0);
  } finally {
    db.close();
  }
});

test("rejects badly named migration files", () => {
  const dir = fixture({ "2_init.sql": "SELECT 1;" });
  assert.throws(() => listMigrations(dir), /Bad migration filename: 2_init\.sql/);
});

test("the repo migrations directory resolves and is well formed", () => {
  assert.ok(existsSync(MIGRATIONS_DIR));
  assert.doesNotThrow(() => listMigrations(MIGRATIONS_DIR));
});
