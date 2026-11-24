import { MIGRATIONS_DIR, migrate, openDb } from "../db.js";
import type { Command } from "./types.js";

export function createDbCommand(migrationsDir: string = MIGRATIONS_DIR): Command {
  const usage = `Usage: hga db migrate

  migrate   Create the database at HGA_DB_PATH (default data/hga.db) and apply pending migrations`;
  return {
    usage,
    async run(args, ctx) {
      if (args[0] !== "migrate" || args.length !== 1) {
        ctx.err(usage);
        return 2;
      }
      const { dbPath } = ctx.config();
      const db = openDb(dbPath);
      try {
        const applied = migrate(db, migrationsDir);
        ctx.out(
          applied.length === 0
            ? `Database up to date: ${dbPath}`
            : `Applied ${applied.length} migration(s) to ${dbPath}: ${applied.join(", ")}`,
        );
      } finally {
        db.close();
      }
      return 0;
    },
  };
}

export const dbCommand = createDbCommand();
