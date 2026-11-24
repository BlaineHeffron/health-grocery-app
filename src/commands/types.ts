import type { Config } from "../config.js";

export interface CommandContext {
  /** Loads config (and .env) on first use, so `--help` never touches it. */
  config(): Config;
  out(line: string): void;
  err(line: string): void;
}

/** What a command module exports. */
export interface Command {
  /** Full usage text for `hga <name> --help`. */
  usage: string;
  /** Receives the args after the command name; returns the process exit code. */
  run(args: string[], ctx: CommandContext): Promise<number>;
}

/** One row of the command table in ./index.ts. */
export interface CommandEntry {
  /** First CLI word, e.g. `db` for `hga db migrate`. */
  name: string;
  /** One line for `hga --help`. */
  summary: string;
  /** Imports the module only when the command runs. */
  load(): Promise<Command>;
}
