import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { helpText, main } from "../src/cli.js";
import { createDbCommand } from "../src/commands/db.js";
import { commands } from "../src/commands/index.js";
import { loadConfig } from "../src/config.js";

const BIN = fileURLToPath(new URL("../src/bin.js", import.meta.url));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

test("--help lists every command in the table", async () => {
  const c = capture();
  assert.equal(await main(["--help"], c.io), 0);
  const text = c.out.join("\n");
  assert.equal(text, helpText());
  for (const command of commands) assert.match(text, new RegExp(`^  ${command.name}\\s+`, "m"));
});

test("unknown command and missing command exit 2 with help on stderr", async () => {
  const c = capture();
  assert.equal(await main(["nope"], c.io), 2);
  assert.match(c.err.join("\n"), /Unknown command: nope/);
  assert.equal(await main([], c.io), 2);
});

test("db migrate creates the db at the configured path and is a no-op the second time", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "hga-cli-"));
  writeFileSync(join(tmp, "0001_test_init.sql"), "CREATE TABLE t (v TEXT);");
  const table = [{ name: "db", summary: "db", load: async () => createDbCommand(tmp) }];
  const dbPath = join(tmp, "sub", "hga.db");
  const c = capture();
  const io = { ...c.io, loadConfig: () => loadConfig({ env: { HGA_DB_PATH: dbPath } }) };
  assert.equal(await main(["db", "migrate"], io, table), 0);
  assert.ok(existsSync(dbPath));
  assert.equal(c.out.at(-1), `Applied 1 migration(s) to ${dbPath}: 0001_test_init.sql`);
  assert.equal(await main(["db", "migrate"], io, table), 0);
  assert.equal(c.out.at(-1), `Database up to date: ${dbPath}`);
  assert.equal(await main(["db", "bogus"], io, table), 2);
});

test("config errors name the variable and exit 1", async () => {
  const c = capture();
  const command = {
    name: "needs",
    summary: "needs a token",
    load: async () => ({
      usage: "hga needs",
      run: async (_args: string[], ctx: { config(): ReturnType<typeof loadConfig> }) => {
        ctx.config().require("KITCHENOWL_TOKEN");
        return 0;
      },
    }),
  };
  const io = { ...c.io, loadConfig: () => loadConfig({ env: {} }) };
  assert.equal(await main(["needs"], io, [command]), 1);
  assert.match(c.err.join("\n"), /Missing required config: KITCHENOWL_TOKEN/);
});

test("the built bin runs db migrate end to end via HGA_DB_PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "hga-bin-"));
  const dbPath = join(dir, "e2e.db");
  const run = () =>
    execFileSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", BIN, "db", "migrate"],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, HGA_DB_PATH: dbPath },
        encoding: "utf8",
      },
    );
  run();
  assert.ok(existsSync(dbPath));
  assert.equal(run().trim(), `Database up to date: ${dbPath}`);
});
