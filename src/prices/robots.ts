/** robots.txt (RFC 9309) parsing and matching. */

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface Robots {
  /** True when `path` (path + query) may be fetched by `agent`. */
  isAllowed(path: string): boolean;
  /** Why everything is refused, when robots.txt itself could not be read. */
  unavailable?: string;
}

export const ALLOW_ALL: Robots = { isAllowed: () => true };
/** robots.txt could not be read (5xx, 401/403/429, network error): refuse the whole host. */
export function unavailable(reason: string): Robots {
  return { isAllowed: () => false, unavailable: reason };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
}

/**
 * Parses robots.txt for the given product token (e.g. "health-grocery-app"): the group whose
 * user-agent names the token applies, otherwise the "*" group, otherwise everything is allowed.
 * The longest matching rule wins; Allow wins a tie.
 */
export function parseRobots(text: string, token: string): Robots {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const key = m[1].toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!lastWasAgent || current === undefined) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current !== undefined && (key === "allow" || key === "disallow") && value !== "") {
      current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const t = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && t.startsWith(a)));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  return {
    isAllowed(path: string) {
      if (path === "/robots.txt") return true;
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!matches(rule.pattern, path)) continue;
        if (
          best === undefined ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best?.allow ?? true;
    },
  };
}
