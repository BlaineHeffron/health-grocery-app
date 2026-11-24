import { ALLOW_ALL, parseRobots, type Robots, unavailable } from "./robots.js";

/** Generic product token and User-Agent: no personal details, no browser imitation. */
export const ROBOTS_TOKEN = "health-grocery-app";
export const USER_AGENT = `${ROBOTS_TOKEN}/0.1 (personal grocery price comparison; honors robots.txt)`;

/** Never faster than one request per host per 3 s; config may only make it slower. */
export const MIN_INTERVAL_MS = 3000;
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

export class RobotsDisallowedError extends Error {
  override name = "RobotsDisallowedError";
}

/** The host answered 429/403 (now or earlier): we stop asking it until the back-off ends. */
export class BackoffError extends Error {
  override name = "BackoffError";
  constructor(
    message: string,
    readonly until: number,
  ) {
    super(message);
  }
}

export interface FetchedResponse {
  status: number;
  headers: Headers;
  body: string;
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface FetcherOptions {
  fetchImpl?: FetchImpl;
  /** Per-host spacing; values below MIN_INTERVAL_MS are raised to it. */
  minIntervalMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PoliteRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

function retryAfterMs(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Shared HTTP client for every price adapter. Before any request it checks the host's
 * robots.txt (fetched once per host, then matched per path) and refuses disallowed paths;
 * it spaces requests per host, caches GET responses for `cacheTtlMs`, and on 429/403 backs
 * off the host (Retry-After, else 15 min doubling) instead of retrying.
 */
export class PoliteFetcher {
  readonly minIntervalMs: number;
  /** Network requests made, robots.txt included (for reporting live runs). */
  requestCount = 0;
  private readonly fetchImpl: FetchImpl;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly robots = new Map<string, Promise<Robots>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lastAt = new Map<string, number>();
  private readonly backoff = new Map<string, { until: number; ms: number }>();
  private readonly cache = new Map<string, { at: number; res: FetchedResponse }>();

  constructor(options: FetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.minIntervalMs = Math.max(MIN_INTERVAL_MS, options.minIntervalMs ?? MIN_INTERVAL_MS);
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request(url: string, req: PoliteRequest = {}): Promise<FetchedResponse> {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error(`refusing non-https URL for ${u.host}`);
    const method = req.method ?? "GET";
    const cacheKey = method === "GET" ? u.href : undefined;
    if (cacheKey !== undefined) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined && this.now() - hit.at < this.cacheTtlMs) return hit.res;
    }
    this.checkBackoff(u.host);
    const robots = await this.robotsFor(u);
    if (!robots.isAllowed(u.pathname + u.search)) {
      throw new RobotsDisallowedError(
        robots.unavailable === undefined
          ? `robots.txt of ${u.host} disallows ${u.pathname}`
          : `robots.txt of ${u.host} unavailable (${robots.unavailable}); refusing the host`,
      );
    }
    const res = await this.send(u, method, req);
    if (res.status === 429 || res.status === 403) {
      const prev = this.backoff.get(u.host);
      const ms = Math.min(
        MAX_BACKOFF_MS,
        retryAfterMs(res.headers.get("retry-after"), this.now()) ??
          (prev ? prev.ms * 2 : DEFAULT_BACKOFF_MS),
      );
      const until = this.now() + ms;
      this.backoff.set(u.host, { until, ms });
      throw new BackoffError(`${u.host} answered ${res.status}; backing off, not retrying`, until);
    }
    this.backoff.delete(u.host);
    if (cacheKey !== undefined && res.status >= 200 && res.status < 300) {
      this.cache.set(cacheKey, { at: this.now(), res });
    }
    return res;
  }

  private checkBackoff(host: string): void {
    const b = this.backoff.get(host);
    if (b !== undefined && this.now() < b.until) {
      throw new BackoffError(`${host} is in back-off; skipping request`, b.until);
    }
  }

  private robotsFor(u: URL): Promise<Robots> {
    let p = this.robots.get(u.host);
    if (p === undefined) {
      // RFC 9309 lets crawlers follow robots.txt redirects; other requests never follow them.
      p = this.send(new URL("/robots.txt", u.origin), "GET", {}, "follow").then(
        (res) => {
          if (res.status >= 200 && res.status < 300) return parseRobots(res.body, ROBOTS_TOKEN);
          // RFC 9309: 4xx means no rules. We stay conservative on 401/403/429 and on 5xx.
          if (res.status >= 400 && res.status < 500 && ![401, 403, 429].includes(res.status)) {
            return ALLOW_ALL;
          }
          return unavailable(`HTTP ${res.status}`);
        },
        (err: Error) => unavailable((err.cause as Error | undefined)?.message ?? err.message),
      );
      this.robots.set(u.host, p);
    }
    return p;
  }

  /** One network request, spaced at least minIntervalMs after the previous one to the host. */
  private send(
    u: URL,
    method: string,
    req: PoliteRequest,
    redirect: RequestRedirect = "error",
  ): Promise<FetchedResponse> {
    const prev = this.queues.get(u.host) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(async () => {
        const last = this.lastAt.get(u.host);
        if (last !== undefined) {
          const wait = last + this.minIntervalMs - this.now();
          if (wait > 0) await this.sleep(wait);
        }
        this.lastAt.set(u.host, this.now());
        this.requestCount++;
        const init: RequestInit = {
          method,
          headers: { "User-Agent": USER_AGENT, ...req.headers },
          redirect,
        };
        if (req.body !== undefined) init.body = req.body;
        const res = await this.fetchImpl(u.href, init);
        return { status: res.status, headers: res.headers, body: await res.text() };
      });
    this.queues.set(u.host, next);
    return next;
  }
}
