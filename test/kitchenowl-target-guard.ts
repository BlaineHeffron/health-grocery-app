/** Ports of the real KitchenOwl. Integration tests never touch them. */
export const REAL_KITCHENOWL_PORTS = ["8449", "8450"];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Throws unless `url` is a plain-http loopback URL with an explicit port that is not one of the
 * real KitchenOwl ports. Integration tests call this before making any request.
 */
export function assertDisposableTarget(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("refusing: integration target is not a valid URL");
  }
  if (u.protocol !== "http:") throw new Error("refusing: integration target must be plain http");
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(
      "refusing: integration target host must be loopback (127.0.0.1, localhost, ::1)",
    );
  }
  if (u.port === "") throw new Error("refusing: integration target needs an explicit port");
  if (REAL_KITCHENOWL_PORTS.includes(u.port)) {
    throw new Error(`refusing: port ${u.port} is the real KitchenOwl`);
  }
  return u;
}
