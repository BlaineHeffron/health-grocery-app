import type { CommandEntry } from "./types.js";

/**
 * The command table. To add `hga <name> ...`: create src/commands/<name>.ts exporting a
 * Command, then add one line here. Keep one entry per line.
 */
// biome-ignore format: one entry per line keeps additions to a single line each
export const commands: readonly CommandEntry[] = [
  { name: "db", summary: "Database tasks (migrate)", load: async () => (await import("./db.js")).dbCommand },
  { name: "prices", summary: "Grocery price comparison (compare, add, import, stores)", load: async () => (await import("./prices.js")).pricesCommand },
];
