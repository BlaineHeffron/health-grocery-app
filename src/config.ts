import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Every variable the app reads. Values are never printed or logged. */
export const CONFIG_KEYS = [
  "KITCHENOWL_URL",
  "KITCHENOWL_TOKEN",
  "KITCHENOWL_HOUSEHOLD_ID",
  "KITCHENOWL_LIST_ID",
  "KROGER_CLIENT_ID",
  "KROGER_CLIENT_SECRET",
  "HGA_DB_PATH",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export const DEFAULT_DB_PATH = "data/hga.db";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config {
  /** Absolute path of the SQLite database file. */
  readonly dbPath: string;
  /** Returns the variable's value, or throws a ConfigError naming it (never its value). */
  require(key: ConfigKey): string;
  /** Returns the variable's value, or undefined when unset or empty. */
  optional(key: ConfigKey): string | undefined;
}

/**
 * Loads `.env` (if present) into process.env without overriding variables already set,
 * then builds a Config. Pass `env` to build from an explicit map instead (tests).
 */
export function loadConfig(
  options: { env?: NodeJS.ProcessEnv; envFile?: string; cwd?: string } = {},
): Config {
  const cwd = options.cwd ?? process.cwd();
  let env = options.env;
  if (env === undefined) {
    const envFile = resolve(cwd, options.envFile ?? ".env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    env = process.env;
  }
  const source = env;

  const optional = (key: ConfigKey): string | undefined => {
    const value = source[key]?.trim();
    return value ? value : undefined;
  };
  const require = (key: ConfigKey): string => {
    const value = optional(key);
    if (value === undefined) {
      throw new ConfigError(`Missing required config: ${key} (set it in .env; see .env.example)`);
    }
    return value;
  };

  return {
    dbPath: resolve(cwd, optional("HGA_DB_PATH") ?? DEFAULT_DB_PATH),
    require,
    optional,
  };
}
