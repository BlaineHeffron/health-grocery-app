import { commands as defaultCommands } from "./commands/index.js";
import type { CommandContext, CommandEntry } from "./commands/types.js";
import { type Config, ConfigError, loadConfig } from "./config.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  loadConfig?: () => Config;
}

const consoleIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export function helpText(commands: readonly CommandEntry[] = defaultCommands): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  const rows = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    "Usage: hga <command> [args]",
    "",
    "Commands:",
    ...rows,
    "",
    "Run `hga <command> --help` for command usage.",
  ].join("\n");
}

export async function main(
  argv: string[],
  io: CliIo = consoleIo,
  commands: readonly CommandEntry[] = defaultCommands,
): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h" || name === "help") {
    (name === undefined ? io.err : io.out)(helpText(commands));
    return name === undefined ? 2 : 0;
  }
  const entry = commands.find((c) => c.name === name);
  if (entry === undefined) {
    io.err(`Unknown command: ${name}\n\n${helpText(commands)}`);
    return 2;
  }
  const command = await entry.load();
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(command.usage);
    return 0;
  }

  let config: Config | undefined;
  const ctx: CommandContext = {
    config: () => {
      config ??= (io.loadConfig ?? loadConfig)();
      return config;
    },
    out: io.out,
    err: io.err,
  };
  try {
    return await command.run(rest, ctx);
  } catch (err) {
    // ConfigError messages name the variable only, never a value.
    io.err(err instanceof ConfigError ? err.message : `hga ${name}: ${(err as Error).message}`);
    return 1;
  }
}
