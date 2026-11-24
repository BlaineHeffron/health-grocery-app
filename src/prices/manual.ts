import type { DatabaseSync } from "node:sqlite";
import { storeById } from "./adapters/registry.js";
import { type Catalog, resolveItem } from "./catalog.js";
import { insertOffer, isDay, type StoredOffer } from "./store.js";
import { canonicalUnit } from "./units.js";

/** Fields of one manual or receipt price, as typed on the CLI or read from CSV. */
export interface ManualInput {
  store: string;
  item: string;
  price: string;
  size: string;
  unit: string;
  date?: string | undefined;
  promo?: string | undefined;
  product?: string | undefined;
}

export const CSV_COLUMNS = ["store", "item", "price", "size", "unit", "date", "promo", "product"];
const REQUIRED = ["store", "item", "price", "size", "unit"];

/** Validates a manual price into a stored offer (source "manual"). Throws on bad input. */
export function manualOffer(
  catalog: Catalog,
  input: ManualInput,
  today: string,
  now: Date,
): StoredOffer {
  storeById(input.store);
  const item = resolveItem(catalog, input.item);
  const price = Number(input.price);
  if (input.price.trim() === "" || !Number.isFinite(price) || price < 0) {
    throw new Error(`bad price "${input.price}"`);
  }
  const size = Number(input.size);
  if (input.size.trim() === "" || !Number.isFinite(size) || size <= 0) {
    throw new Error(`bad size "${input.size}"`);
  }
  // Unknown units are stored as given: the comparison shows them as unconvertible.
  const unit = canonicalUnit(input.unit) ?? input.unit.trim();
  if (unit === "") throw new Error("missing unit");
  const date = input.date?.trim() || today;
  if (!isDay(date)) throw new Error(`bad date "${input.date}" (use YYYY-MM-DD)`);
  const promoText = (input.promo ?? "").trim().toLowerCase();
  if (!["", "0", "1", "yes", "no", "true", "false", "y", "n"].includes(promoText)) {
    throw new Error(`bad promo "${input.promo}" (yes or no)`);
  }
  return {
    store: input.store,
    item: item.name,
    term: item.name,
    product: input.product?.trim() || item.name,
    price,
    size,
    unit,
    promo: ["1", "yes", "true", "y"].includes(promoText),
    source: "manual",
    observedOn: date,
    fetchedAt: now.toISOString(),
  };
}

/** RFC 4180-style CSV: commas, double-quoted fields with "" escapes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) throw new Error("CSV: unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/**
 * Imports a CSV of manual prices (format in docs/prices.md). All rows are validated first;
 * nothing is written unless every row is valid. Returns the number of rows imported.
 */
export function importCsv(
  db: DatabaseSync,
  catalog: Catalog,
  text: string,
  today: string,
  now: Date,
): number {
  const [header, ...rows] = parseCsv(text);
  if (header === undefined) throw new Error("CSV is empty");
  const cols = header.map((h) => h.trim().toLowerCase());
  const unknown = cols.filter((c) => !CSV_COLUMNS.includes(c));
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `CSV header: unknown [${unknown.join(", ")}], missing [${missing.join(", ")}]; columns: ${CSV_COLUMNS.join(",")}`,
    );
  }
  const errors: string[] = [];
  const offers: StoredOffer[] = [];
  rows.forEach((fields, i) => {
    const get = (c: string) => {
      const at = cols.indexOf(c);
      return at === -1 ? undefined : (fields[at] ?? "").trim();
    };
    try {
      offers.push(
        manualOffer(
          catalog,
          {
            store: get("store") ?? "",
            item: get("item") ?? "",
            price: get("price") ?? "",
            size: get("size") ?? "",
            unit: get("unit") ?? "",
            date: get("date"),
            promo: get("promo"),
            product: get("product"),
          },
          today,
          now,
        ),
      );
    } catch (err) {
      errors.push(`row ${i + 2}: ${(err as Error).message}`);
    }
  });
  if (errors.length > 0) throw new Error(`CSV not imported:\n  ${errors.join("\n  ")}`);
  db.exec("BEGIN");
  try {
    for (const o of offers) insertOffer(db, o);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return offers.length;
}
