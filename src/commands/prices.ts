import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Config } from "../config.js";
import { MIGRATIONS_DIR, migrate, openDb } from "../db.js";
import { createAdapters, STORES } from "../prices/adapters/registry.js";
import type { StoreAdapter } from "../prices/adapters/types.js";
import { basketLines, CATALOG_FILE, checkCoverage, loadCatalog } from "../prices/catalog.js";
import { type AdapterRun, collectOffers } from "../prices/collect.js";
import { COMPARE_SCHEMA, type Comparison, compare, type PricedOffer } from "../prices/compare.js";
import { PoliteFetcher } from "../prices/fetcher.js";
import { importCsv, manualOffer } from "../prices/manual.js";
import { loadRotation, ROTATION_FILE } from "../prices/rotation.js";
import { insertOffer, latestOffers, localDay } from "../prices/store.js";
import type { Command, CommandContext } from "./types.js";

const usage = `Usage: hga prices <subcommand>

  compare [--week N | --all] [--json] [--refresh] [--offline] [--max-age-days N]
      Cheapest store per rotation item (with runner-up), cheapest single store for the
      basket, and the cheapest split basket. Default scope: --all (every week + every_week).
      Adapter results are cached per store, term and day; --refresh refetches today's,
      --offline uses only stored prices.
  add --store <id> --item <entry|item> --price <p> --size <n> --unit <u> [--date YYYY-MM-DD]
      [--promo] [--product <text>]
      Record a manual or receipt price (source "manual").
  import <file.csv>
      Import manual prices; columns: store,item,price,size,unit[,date,promo,product].
  stores
      List stores, their source (api or manual) and whether each adapter is configured.

Stores: ${STORES.map((s) => s.id).join(", ")}
Config (optional): HGA_PRICE_ZIP (default 29401), HGA_PRICE_RADIUS_MILES (15),
  HGA_PRICE_MAX_AGE_DAYS (30), HGA_PRICE_MIN_INTERVAL_SECONDS (3, never lower),
  KROGER_CLIENT_ID and KROGER_CLIENT_SECRET for Harris Teeter. See docs/prices.md.`;

export interface PricesDeps {
  migrationsDir?: string;
  catalogFile?: string;
  rotationFile?: string;
  now?: () => number;
  /** Builds the adapters; defaults to the registry with a real PoliteFetcher. */
  adapters?: (config: Config) => StoreAdapter[];
}

function numberSetting(config: Config, key: Parameters<Config["optional"]>[0], fallback: number) {
  const raw = config.optional(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function describe(o: PricedOffer | null, line: { alternatives: string[]; unit: string }): string {
  if (o === null) return "-";
  const alt = line.alternatives.length > 1 ? ` (${o.item})` : "";
  const promo = o.promo ? " promo" : "";
  return `${money(o.unitPrice)}/${line.unit} ${o.store}${alt}${promo}, ${o.ageDays} d`;
}

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

export function renderHuman(
  result: Comparison,
  meta: { scope: string; today: string; maxAgeDays: number; runs: AdapterRun[] },
): string[] {
  const out: string[] = [];
  out.push(
    `Prices for ${meta.scope} on ${meta.today} (prices older than ${meta.maxAgeDays} d are excluded)`,
  );
  for (const run of meta.runs) {
    const counts =
      run.status === "not-configured" ? "" : ` (${run.fetched} fetched, ${run.cached} cached)`;
    out.push(
      `  ${run.store}: ${run.status.replace("-", " ")}${run.detail ? ` (${run.detail})` : ""}${counts}`,
    );
  }
  for (const s of STORES) {
    if (s.kind === "api" && !meta.runs.some((r) => r.store === s.id)) {
      out.push(`  ${s.id}: offline (stored prices only)`);
    }
  }
  out.push(
    `  manual stores: ${STORES.filter((s) => s.kind === "manual")
      .map((s) => s.id)
      .join(", ")}`,
  );
  out.push("");
  out.push(
    ...table([
      ["Item", "Best", "Runner-up"],
      ...result.lines.map((l) => [
        `${l.line}${l.seasonal ? " (seasonal)" : ""}`,
        describe(l.best, l),
        describe(l.runnerUp, l),
      ]),
    ]),
  );
  const excluded = result.lines.flatMap((l) =>
    l.excluded.map(
      (e) =>
        `  ${l.line}: ${e.store} ${e.product}, ${money(e.price)} for ${e.size} ${e.unit}, ${e.ageDays} d: ${e.reason}`,
    ),
  );
  if (excluded.length > 0) out.push("", "Not ranked:", ...excluded);
  out.push("");
  const best = result.singleStore.best;
  if (best === null)
    out.push("Single store: no prices yet (add some with `hga prices add` or `import`).");
  else {
    out.push(
      `Single store: ${best.store} ${money(best.total)} for ${best.covered}/${result.lines.length} items` +
        (best.missing.length > 0 ? `; lacks: ${best.missing.join(", ")}` : ""),
    );
    for (const s of result.singleStore.ranking.slice(1)) {
      out.push(`  then ${s.store} ${money(s.total)} for ${s.covered}/${result.lines.length}`);
    }
  }
  const split = result.split;
  if (split.picks.length > 0) {
    out.push(`Split basket: ${money(split.total)} across ${split.stores.join(", ")}`);
    if (split.missing.length > 0) out.push(`  no price for: ${split.missing.join(", ")}`);
  }
  out.push("Totals add one comparison unit of each item.");
  return out;
}

export function createPricesCommand(deps: PricesDeps = {}): Command {
  const now = deps.now ?? Date.now;
  const withDb = async <T>(
    ctx: CommandContext,
    fn: (db: ReturnType<typeof openDb>) => Promise<T>,
  ) => {
    const db = openDb(ctx.config().dbPath);
    try {
      migrate(db, deps.migrationsDir ?? MIGRATIONS_DIR);
      return await fn(db);
    } finally {
      db.close();
    }
  };

  async function compareCmd(args: string[], ctx: CommandContext): Promise<number> {
    const { values } = parseArgs({
      args,
      options: {
        week: { type: "string" },
        all: { type: "boolean" },
        json: { type: "boolean" },
        refresh: { type: "boolean" },
        offline: { type: "boolean" },
        "max-age-days": { type: "string" },
      },
    });
    if (values.week !== undefined && values.all) throw new Error("use --week N or --all, not both");
    if (values.refresh && values.offline) throw new Error("use --refresh or --offline, not both");
    const config = ctx.config();
    const rotation = loadRotation(deps.rotationFile ?? ROTATION_FILE);
    const catalog = loadCatalog(deps.catalogFile ?? CATALOG_FILE);
    checkCoverage(catalog, rotation);
    let entries = rotation.entries;
    let scope = "all weeks + every week";
    if (values.week !== undefined) {
      const week = Number(values.week);
      if (!rotation.weeks.includes(week)) {
        throw new Error(`--week must be one of ${rotation.weeks.join(", ")}`);
      }
      entries = entries.filter((e) => e.week === week || e.week === "every_week");
      scope = `week ${week} + every week`;
    }
    const maxAgeDays =
      values["max-age-days"] !== undefined
        ? Number(values["max-age-days"])
        : numberSetting(config, "HGA_PRICE_MAX_AGE_DAYS", 30);
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
      throw new Error("max age must be a whole number of days");
    }
    const lines = basketLines(catalog, entries);
    const today = localDay(now());
    return withDb(ctx, async (db) => {
      let runs: AdapterRun[] = [];
      if (!values.offline) {
        const adapters =
          deps.adapters?.(config) ??
          createAdapters(
            config,
            new PoliteFetcher({
              minIntervalMs: numberSetting(config, "HGA_PRICE_MIN_INTERVAL_SECONDS", 3) * 1000,
            }),
          );
        runs = await collectOffers(db, adapters, lines, {
          day: today,
          location: {
            zip: config.optional("HGA_PRICE_ZIP") ?? "29401",
            radiusMiles: numberSetting(config, "HGA_PRICE_RADIUS_MILES", 15),
          },
          refresh: values.refresh === true,
          now,
        });
      }
      const offers = latestOffers(db, [
        ...new Set(lines.flatMap((l) => l.alternatives.map((a) => a.name))),
      ]);
      const result = compare(lines, offers, { today, maxAgeDays });
      if (values.json) {
        ctx.out(
          JSON.stringify(
            {
              schema: COMPARE_SCHEMA,
              today,
              scope: {
                week: values.week === undefined ? null : Number(values.week),
                everyWeek: true,
              },
              maxAgeDays,
              stores: STORES.map((s) => {
                const run = runs.find((r) => r.store === s.id);
                return {
                  id: s.id,
                  name: s.name,
                  kind: s.kind,
                  status: s.kind === "manual" ? "manual" : (run?.status ?? "offline"),
                  ...(run?.detail ? { detail: run.detail } : {}),
                };
              }),
              ...result,
            },
            null,
            2,
          ),
        );
      } else {
        for (const line of renderHuman(result, { scope, today, maxAgeDays, runs })) ctx.out(line);
      }
      return 0;
    });
  }

  async function addCmd(args: string[], ctx: CommandContext): Promise<number> {
    const { values } = parseArgs({
      args,
      options: {
        store: { type: "string" },
        item: { type: "string" },
        price: { type: "string" },
        size: { type: "string" },
        unit: { type: "string" },
        date: { type: "string" },
        promo: { type: "boolean" },
        product: { type: "string" },
      },
    });
    for (const k of ["store", "item", "price", "size", "unit"] as const) {
      if (values[k] === undefined) throw new Error(`--${k} is required`);
    }
    const catalog = loadCatalog(deps.catalogFile ?? CATALOG_FILE);
    const offer = manualOffer(
      catalog,
      {
        store: values.store ?? "",
        item: values.item ?? "",
        price: values.price ?? "",
        size: values.size ?? "",
        unit: values.unit ?? "",
        date: values.date,
        promo: values.promo ? "yes" : "",
        product: values.product,
      },
      localDay(now()),
      new Date(now()),
    );
    await withDb(ctx, async (db) => insertOffer(db, offer));
    ctx.out(
      `Added ${offer.store} ${offer.item}: ${money(offer.price)} for ${offer.size} ${offer.unit} on ${offer.observedOn}`,
    );
    return 0;
  }

  async function importCmd(args: string[], ctx: CommandContext): Promise<number> {
    const [file, ...extra] = args;
    if (file === undefined || extra.length > 0) {
      ctx.err(usage);
      return 2;
    }
    const catalog = loadCatalog(deps.catalogFile ?? CATALOG_FILE);
    const text = readFileSync(file, "utf8");
    const count = await withDb(ctx, async (db) =>
      importCsv(db, catalog, text, localDay(now()), new Date(now())),
    );
    ctx.out(`Imported ${count} price(s) from ${file}`);
    return 0;
  }

  async function storesCmd(ctx: CommandContext): Promise<number> {
    const config = ctx.config();
    const adapters = deps.adapters?.(config) ?? createAdapters(config, new PoliteFetcher());
    const rows = STORES.map((s) => {
      const a = adapters.find((x) => x.store === s.id);
      const status = a === undefined ? "manual entry only" : a.status();
      const text =
        typeof status === "string" ? status : status.configured ? "configured" : status.reason;
      return [s.id, s.name, a?.source ?? "manual", text];
    });
    for (const line of table([["Store", "Name", "Source", "Status"], ...rows])) ctx.out(line);
    return 0;
  }

  return {
    usage,
    async run(args, ctx) {
      const [sub, ...rest] = args;
      switch (sub) {
        case "compare":
          return compareCmd(rest, ctx);
        case "add":
          return addCmd(rest, ctx);
        case "import":
          return importCmd(rest, ctx);
        case "stores":
          if (rest.length > 0) break;
          return storesCmd(ctx);
      }
      ctx.err(usage);
      return 2;
    },
  };
}

export const pricesCommand = createPricesCommand();
