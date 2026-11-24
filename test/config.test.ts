import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, DEFAULT_DB_PATH, loadConfig } from "../src/config.js";

test("dbPath defaults under data/ and treats an empty HGA_DB_PATH as unset", () => {
  const cwd = "/srv/app";
  assert.equal(loadConfig({ env: {}, cwd }).dbPath, join(cwd, DEFAULT_DB_PATH));
  assert.equal(loadConfig({ env: { HGA_DB_PATH: "  " }, cwd }).dbPath, join(cwd, DEFAULT_DB_PATH));
  assert.equal(loadConfig({ env: { HGA_DB_PATH: "/x/y.db" }, cwd }).dbPath, "/x/y.db");
});

test("require names the missing variable and never echoes values", () => {
  const sentinel = "s3ntinel-value-should-not-appear";
  const config = loadConfig({ env: { KROGER_CLIENT_ID: sentinel, KITCHENOWL_TOKEN: "" } });
  assert.equal(config.require("KROGER_CLIENT_ID"), sentinel);
  assert.throws(
    () => config.require("KITCHENOWL_TOKEN"),
    (err: unknown) =>
      err instanceof ConfigError &&
      err.message.includes("KITCHENOWL_TOKEN") &&
      !err.message.includes(sentinel),
  );
  assert.equal(config.optional("KITCHENOWL_URL"), undefined);
});

test("loads .env from cwd without overriding variables already set", () => {
  const dir = mkdtempSync(join(tmpdir(), "hga-config-"));
  writeFileSync(join(dir, ".env"), "HGA_DB_PATH=from-dotenv.db\nKITCHENOWL_LIST_ID=7\n");
  const saved = { db: process.env.HGA_DB_PATH, list: process.env.KITCHENOWL_LIST_ID };
  process.env.HGA_DB_PATH = "/preset.db";
  delete process.env.KITCHENOWL_LIST_ID;
  try {
    const config = loadConfig({ cwd: dir });
    assert.equal(config.dbPath, "/preset.db");
    assert.equal(config.require("KITCHENOWL_LIST_ID"), "7");
  } finally {
    for (const [key, value] of [
      ["HGA_DB_PATH", saved.db],
      ["KITCHENOWL_LIST_ID", saved.list],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
