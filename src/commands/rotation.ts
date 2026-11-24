import type { Config } from "../config.js";
import { KitchenOwlClient } from "../kitchenowl/client.js";
import { itemsForWeek, loadRotation, markFor, nextWeek, ROTATION_FILE } from "../rotation/plan.js";
import {
  executeClear,
  executePush,
  type ListClient,
  planClear,
  planPush,
  resolveTarget,
} from "../rotation/push.js";
import { RotationState } from "../rotation/state.js";
import type { Command } from "./types.js";

const usage = `Usage: hga rotation <show|push|clear> [--week N] [--dry-run]

  show              Print the next rotation week, its item set and recent pushes (offline)
  push              Add the next week's items plus the every-week staples to the KitchenOwl
                    shopping list. Items already on the list are skipped; added items get the
                    description "rotation wkN". On success the next week advances (4 -> 1).
  clear             Remove items this job added that still carry its mark

  --week N          push/show: use week N instead of the next week; does not move the pointer
  --dry-run         push/clear: print the plan; writes nothing (no list changes, no db writes)

Config: KITCHENOWL_URL, KITCHENOWL_TOKEN, KITCHENOWL_HOUSEHOLD_ID, KITCHENOWL_LIST_ID,
HGA_DB_PATH. In-season months: seasonal_months in data/rotation.yaml. See docs/rotation.md.`;

export interface RotationCommandOptions {
  now?: () => Date;
  /** Builds the KitchenOwl client (tests pass a fake). */
  client?: (config: Config) => ListClient;
}

interface Args {
  sub: "show" | "push" | "clear";
  week?: number;
  dryRun: boolean;
}

class UsageError extends Error {}

function parseArgs(args: string[]): Args {
  const [sub, ...rest] = args;
  if (sub !== "show" && sub !== "push" && sub !== "clear") throw new UsageError(usage);
  const parsed: Args = { sub, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--dry-run" && sub !== "show") parsed.dryRun = true;
    else if (a === "--week" && sub !== "clear") {
      const v = rest[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new UsageError("--week needs a week number");
      parsed.week = Number(v);
    } else throw new UsageError(`Unknown argument for rotation ${sub}: ${a}\n\n${usage}`);
  }
  return parsed;
}

export function createRotationCommand(options: RotationCommandOptions = {}): Command {
  const now = options.now ?? (() => new Date());
  const makeClient =
    options.client ??
    ((config: Config) =>
      new KitchenOwlClient({
        baseUrl: config.require("KITCHENOWL_URL"),
        token: config.require("KITCHENOWL_TOKEN"),
      }));

  return {
    usage,
    async run(argv, ctx) {
      let args: Args;
      try {
        args = parseArgs(argv);
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        ctx.err(err.message);
        return 2;
      }
      const config = ctx.config();
      const rotation = loadRotation(ROTATION_FILE);
      const count = rotation.weeks.length;
      if (args.week !== undefined && (args.week < 1 || args.week > count)) {
        ctx.err(`--week must be 1-${count}, got ${args.week}`);
        return 2;
      }
      const seasonal = rotation.seasonalMonths;
      const month = now().getMonth() + 1;
      const writes = args.sub !== "show" && !args.dryRun;
      // Build the client first so missing KitchenOwl config fails before any db file is created.
      const client = args.sub === "show" ? undefined : makeClient(config);
      const state = writes
        ? RotationState.openForWrite(config.dbPath)
        : RotationState.openReadOnly(config.dbPath);
      try {
        const pointer = ((state.nextWeek() - 1) % count) + 1;
        const week = args.week ?? pointer;
        const items = itemsForWeek(rotation, week, month);
        const mark = markFor(week);
        const seasonNote = `month ${month}; seasonal months ${seasonal.join(",")}`;

        if (args.sub === "show") {
          ctx.out(`Next rotation week: ${pointer} of ${count}`);
          ctx.out(`Items for week ${week} (${seasonNote}):`);
          for (const name of items) ctx.out(`  ${name}`);
          const pushes = state.recentPushes(5);
          ctx.out(pushes.length === 0 ? "No pushes yet." : "Recent pushes:");
          for (const p of pushes) {
            ctx.out(
              `  #${p.id} ${p.pushedAt} week ${p.week}${p.override ? " (--week)" : ""} list ${p.listId}: ${p.status}, ${p.added} added, ${p.skipped} skipped${p.error ? ` (${p.error})` : ""}`,
            );
          }
          return 0;
        }

        if (client === undefined) throw new Error("unreachable: no client");
        const target = await resolveTarget(
          client,
          config.optional("KITCHENOWL_HOUSEHOLD_ID"),
          config.optional("KITCHENOWL_LIST_ID"),
        );
        const onList = await client.listItems(target.listId);
        const dry = args.dryRun ? "[dry run] " : "";

        if (args.sub === "clear") {
          const candidates = planClear(state, target.listId, onList);
          ctx.out(`${dry}Clearing ${candidates.length} marked item(s) from list ${target.listId}`);
          for (const c of candidates) ctx.out(`  remove  ${c.item.name} (${c.item.description})`);
          if (args.dryRun) return 0;
          const r = await executeClear(client, state, target.listId, candidates);
          ctx.out(`Removed ${r.removed.length} item(s).`);
          if (r.error !== undefined) {
            ctx.err(`hga rotation clear: ${r.error}`);
            return 1;
          }
          return 0;
        }

        const plan = planPush(items, onList);
        const override = args.week !== undefined;
        const advanceTo = override ? undefined : nextWeek(week, count);
        ctx.out(
          `${dry}Pushing rotation week ${week}${override ? " (--week override)" : ""} to list ${target.listId} (${seasonNote})`,
        );
        for (const p of plan) {
          ctx.out(
            p.action === "add"
              ? `  add   ${p.name}  [${mark}]`
              : `  skip  ${p.name}  (already on list as "${p.existing}")`,
          );
        }
        if (args.dryRun) {
          ctx.out(
            override
              ? `[dry run] Next week would stay ${pointer}.`
              : `[dry run] Next week would become ${advanceTo}.`,
          );
          return 0;
        }
        const r = await executePush(client, state, target, plan, {
          week,
          override,
          mark,
          ...(advanceTo === undefined ? {} : { advanceTo }),
        });
        ctx.out(`Added ${r.added.length}, skipped ${r.skipped.length}.`);
        if (r.error !== undefined) {
          ctx.err(`hga rotation push: failed ${r.error}; next week stays ${pointer}.`);
          return 1;
        }
        ctx.out(`Next week: ${state.nextWeek()}.`);
        return 0;
      } finally {
        state.close();
      }
    },
  };
}

export const rotationCommand = createRotationCommand();
