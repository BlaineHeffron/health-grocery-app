import type { Household, ListItem, ShoppingList } from "../src/kitchenowl/client.js";
import { matchKey } from "../src/rotation/plan.js";
import type { ListClient } from "../src/rotation/push.js";

/** In-memory stand-in for one KitchenOwl household with one list. Synthetic data only. */
export class FakeKitchenOwl implements ListClient {
  items: ListItem[] = [];
  writes = 0;
  reads = 0;
  nextId = 100;
  /** When set, the Nth addItem call (1-based) throws. */
  failOnAdd: number | undefined;
  private adds = 0;

  constructor(
    readonly household: Household = { id: 7, name: "Synthetic Household" },
    readonly list: ShoppingList = { id: 3, name: "Synthetic List" },
  ) {}

  async households() {
    this.reads++;
    return [this.household];
  }

  async shoppingLists(householdId: number) {
    this.reads++;
    return householdId === this.household.id ? [this.list] : [];
  }

  async listItems(listId: number) {
    this.reads++;
    return listId === this.list.id ? this.items.map((i) => ({ ...i })) : [];
  }

  /** Mirrors KitchenOwl: an item already on the list (case-insensitive) is left unchanged. */
  async addItem(_listId: number, name: string, description: string) {
    this.adds++;
    if (this.failOnAdd === this.adds) throw new Error("KitchenOwl POST: timed out after 1 ms");
    this.writes++;
    const existing = this.items.find((i) => matchKey(i.name) === matchKey(name));
    if (existing) return existing.id;
    const item = { id: this.nextId++, name, description };
    this.items.push(item);
    return item.id;
  }

  async removeItem(_listId: number, itemId: number) {
    this.writes++;
    this.items = this.items.filter((i) => i.id !== itemId);
  }

  /** Test setup helper: puts an item on the list directly (not a job write). */
  seed(name: string, description = ""): ListItem {
    const item = { id: this.nextId++, name, description };
    this.items.push(item);
    return item;
  }
}
