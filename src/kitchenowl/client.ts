/**
 * Minimal typed client for the KitchenOwl v0.8.1 HTTP API. Authenticates with a long-lived
 * token. Errors name the method, API path and status only: never the token or the base URL.
 */

export interface Household {
  id: number;
  name: string;
}

export interface ShoppingList {
  id: number;
  name: string;
}

export interface ListItem {
  /** KitchenOwl item id (per household); also the id used to remove it from a list. */
  id: number;
  name: string;
  description: string;
}

export class KitchenOwlError extends Error {
  override name = "KitchenOwlError";
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** KitchenOwl base URL (KITCHENOWL_URL), with or without a trailing slash or `/api`. */
  baseUrl: string;
  /** Long-lived API token (KITCHENOWL_TOKEN). */
  token: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  fetch?: Fetch;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export class KitchenOwlClient {
  readonly #api: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: Fetch;

  constructor(options: ClientOptions) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new KitchenOwlError("KITCHENOWL_URL is not a valid URL");
    }
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new KitchenOwlError("KITCHENOWL_URL must be http or https");
    }
    this.#api = `${base.origin}${base.pathname.replace(/\/+$/, "").replace(/\/api$/, "")}/api`;
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? fetch;
  }

  async #request(method: string, path: string, body?: unknown): Promise<unknown> {
    const what = `KitchenOwl ${method} /api${path}`;
    // A ref'd timer (unlike AbortSignal.timeout) keeps the process alive until it fires.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    const failed = (err: unknown, doing: string): KitchenOwlError => {
      if (abort.signal.aborted) {
        return new KitchenOwlError(`${what}: timed out after ${this.#timeoutMs} ms`);
      }
      const cause = ((err as Error).cause as { code?: string } | undefined)?.code;
      return new KitchenOwlError(`${what}: ${doing}${cause ? ` (${cause})` : ""}`);
    };
    try {
      let res: Response;
      try {
        res = await this.#fetch(`${this.#api}${path}`, {
          method,
          headers: {
            authorization: ["Bearer", this.#token].join(" "),
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: abort.signal,
          redirect: "error",
        });
      } catch (err) {
        throw failed(err, "request failed");
      }
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403
            ? " (check KITCHENOWL_TOKEN and that its user is a member of the household)"
            : "";
        throw new KitchenOwlError(`${what}: HTTP ${res.status}${hint}`, res.status);
      }
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        throw failed(err, "reading the response failed");
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new KitchenOwlError(`${what}: response is not JSON`, res.status);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async households(): Promise<Household[]> {
    return arrayOf(await this.#request("GET", "/household"), "households", toNamed);
  }

  async shoppingLists(householdId: number): Promise<ShoppingList[]> {
    const raw = await this.#request("GET", `/household/${id(householdId)}/shoppinglist`);
    return arrayOf(raw, "shopping lists", toNamed);
  }

  async listItems(listId: number): Promise<ListItem[]> {
    const raw = await this.#request("GET", `/shoppinglist/${id(listId)}/items`);
    return arrayOf(raw, "list items", (r) => ({
      ...toNamed(r),
      description: typeof r.description === "string" ? r.description : "",
    }));
  }

  /**
   * Adds an item by name with a description. If KitchenOwl already has that item on the list it
   * leaves it unchanged; callers skip existing names first. Returns the item id.
   */
  async addItem(listId: number, name: string, description: string): Promise<number> {
    const raw = await this.#request("POST", `/shoppinglist/${id(listId)}/add-item-by-name`, {
      name,
      description,
    });
    return toNamed(raw as Record<string, unknown>).id;
  }

  async removeItem(listId: number, itemId: number): Promise<void> {
    await this.#request("DELETE", `/shoppinglist/${id(listId)}/item`, { item_id: id(itemId) });
  }
}

function id(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new KitchenOwlError(`bad KitchenOwl id: ${n}`);
  return n;
}

function toNamed(r: Record<string, unknown>): { id: number; name: string } {
  if (
    r === null ||
    typeof r !== "object" ||
    typeof r.id !== "number" ||
    typeof r.name !== "string"
  ) {
    throw new KitchenOwlError("KitchenOwl response is missing id/name");
  }
  return { id: r.id, name: r.name };
}

function arrayOf<T>(raw: unknown, what: string, map: (r: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(raw)) throw new KitchenOwlError(`KitchenOwl ${what}: expected a list`);
  return raw.map((r) => map(r as Record<string, unknown>));
}
