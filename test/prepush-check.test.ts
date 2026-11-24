import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/prepush-check.sh", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Fixture strings are split so this test file never trips the guard itself.
const j = (...parts: string[]) => parts.join("");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

/** A repo whose origin/main is one clean commit, with HEAD on a branch. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hga-prepush-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "checkout", "-q", "-b", "feat");
  return dir;
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function commit(dir: string, files: Record<string, string>, message = "change"): void {
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  git(dir, "add", "-f", ".");
  git(dir, "commit", "-q", "-m", message);
}

function check(cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT], { cwd, env: { ...gitEnv, ...env }, encoding: "utf8" });
  return { status: r.status, output: r.stdout + r.stderr };
}

test("passes on a clean change set, including .env.example placeholders and env reads", () => {
  const dir = repo();
  commit(dir, {
    ".env.example": j("KITCHENOWL_", "TOKEN=\n", "KROGER_CLIENT_", "SECRET=\n"),
    "src/client.ts":
      "const token = process.env.KITCHENOWL_TOKEN;\n" +
      j("const h = { Authorization: `Bearer $", "{token}` };\n"),
    "notes.md":
      "Use KITCHENOWL_URL; bind 127.0.0.1 and 10.0.0.5 or 100.63.1.1 or 100.128.0.1 are fine; see docs/home/x and /srv/app.\n",
  });
  const r = check(dir);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /prepush-check: OK/);
});

test("passes on this repository's own head", () => {
  const r = check(REPO_ROOT);
  assert.equal(r.status, 0, r.output);
});

const failing: Array<[string, Record<string, string>, RegExp]> = [
  ["tracked .env", { ".env": "X=1\n" }, /env file: \.env/],
  ["nested .env.local", { "app/.env.local": "X=1\n" }, /env file: app\/\.env\.local/],
  ["db file", { "data/hga.db": "SQLite format 3\n" }, /database file: data\/hga\.db/],
  ["db WAL file", { "data/hga.db-wal": "x" }, /database file: data\/hga\.db-wal/],
  ["key file", { "deploy.pem": "x" }, /key file: deploy\.pem/],
  ["agent bus", { ".agent_bus/log.json": "{}" }, /agent bus content/],
  [
    "private key block",
    { "k.txt": j("-----BEGIN ", "OPENSSH PRIVATE", " KEY-----\nabc\n") },
    /private key block in k\.txt/,
  ],
  [
    "bearer token literal",
    { "c.sh": j("curl -H 'Authorization: Bear", "er abcDEF123456ghiJKL'\n") },
    /bearer token in c\.sh/,
  ],
  [
    "KROGER_CLIENT_SECRET value",
    { "env.txt": j("KROGER_CLIENT_", "SECRET=hunter2\n") },
    /KROGER_CLIENT_SECRET value in env\.txt/,
  ],
  [
    "KITCHENOWL_TOKEN value",
    { "env.txt": j("KITCHENOWL_", "TOKEN = 'abc'\n") },
    /KITCHENOWL_TOKEN value in env\.txt/,
  ],
  [
    "generic high-entropy assignment",
    { "cfg.ts": j('const apiKey = "', "zz9Q", "x8Rw7Lm6Kp5Jn4Hb3Gv2", '";\n') },
    /high-entropy secret assignment in cfg\.ts/,
  ],
  [
    "tailnet hostname",
    { "doc.md": j("open https://box-1.example-tail.", "ts.net:8443/\n") },
    /tailnet hostname in doc\.md/,
  ],
  [
    "tailnet address (low end)",
    { "a.txt": j("http://100.", "64.0.1:80\n") },
    /tailnet address in a\.txt/,
  ],
  [
    "tailnet address (high end)",
    { "a.txt": j("host=100.", "127.255.9\n") },
    /tailnet address in a\.txt/,
  ],
  [
    "absolute home path",
    { "doc.md": j("compose lives in /", "home/someone/docker/app\n") },
    /absolute local path in doc\.md/,
  ],
  [
    "absolute media path",
    { "doc.md": j("copied from /", "media/someone/Drive/notes.txt\n") },
    /absolute local path in doc\.md/,
  ],
];

for (const [name, files, expected] of failing) {
  test(`fails on ${name}`, () => {
    const dir = repo();
    commit(dir, files);
    const r = check(dir);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, expected);
  });
}

test("fails on a secret added then removed within the outgoing range", () => {
  const dir = repo();
  commit(dir, { "env.txt": j("KITCHENOWL_", "TOKEN=abc\n") });
  commit(dir, { "env.txt": j("KITCHENOWL_", "TOKEN=\n") });
  const r = check(dir);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /KITCHENOWL_TOKEN value in env\.txt/);
});

test("fails on a secret that exists only in a merge conflict resolution", () => {
  const dir = repo();
  commit(dir, { "f.txt": "feat side\n" });
  git(dir, "checkout", "-q", "-b", "side", "main");
  commit(dir, { "f.txt": "other side\n" });
  git(dir, "checkout", "-q", "feat");
  const merge = spawnSync("git", ["merge", "-q", "side"], { cwd: dir, env: gitEnv });
  assert.notEqual(merge.status, 0, "expected a merge conflict");
  write(dir, "f.txt", j("KITCHENOWL_", "TOKEN=resolved\n"));
  git(dir, "add", "f.txt");
  git(dir, "commit", "-q", "--no-edit");
  const r = check(dir);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /KITCHENOWL_TOKEN value in f\.txt/);
});

test("fails on an added line that itself starts with '++ '", () => {
  const dir = repo();
  commit(dir, { "plus.txt": j("++ KITCHENOWL_", "TOKEN=abc\n") });
  const r = check(dir);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /KITCHENOWL_TOKEN value in plus\.txt/);
});

test("fails on secrets or tailnet hosts in an outgoing commit message", () => {
  const dir = repo();
  commit(
    dir,
    { "clean.txt": "clean\n" },
    j("deploy to box.example-tail.", "ts.net\n\nKITCHENOWL_", "TOKEN=abc"),
  );
  const r = check(dir);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /tailnet hostname in commit message [0-9a-f]+/);
  assert.match(r.output, /KITCHENOWL_TOKEN value in commit message [0-9a-f]+/);
});

test("scans files git treats as binary", () => {
  const dir = repo();
  commit(dir, { "blob.bin": j("\u0000\n", "KITCHENOWL_", "TOKEN=abc\n") });
  const r = check(dir);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /KITCHENOWL_TOKEN value in blob\.bin/);
});

test("fails on staged-but-uncommitted secrets", () => {
  const dir = repo();
  write(dir, "s.txt", j("KROGER_CLIENT_", "SECRET=x\n"));
  git(dir, "add", "s.txt");
  const r = check(dir);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /KROGER_CLIENT_SECRET value in s\.txt/);
});

test("never prints matched values", () => {
  const dir = repo();
  commit(dir, { "env.txt": j("KROGER_CLIENT_", "SECRET=supersecretvalue\n") });
  const r = check(dir);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.output, /supersecretvalue/);
});

test("fails when HEAD shares no history with the base (unrelated history)", () => {
  const dir = repo();
  git(dir, "checkout", "-q", "--orphan", "fresh");
  commit(dir, { "x.txt": "clean\n" });
  const r = check(dir);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /unrelated history/);
});

test("exits 2 when the base ref is missing", () => {
  const dir = repo();
  const r = check(dir, { PREPUSH_BASE: "origin/nope" });
  assert.equal(r.status, 2, r.output);
});
