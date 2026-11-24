-- Rotation push state: the next rotation week, plus a log of every push and what it did.

CREATE TABLE rotation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_week INTEGER NOT NULL CHECK (next_week >= 1),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO rotation_state (id, next_week) VALUES (1, 1);

CREATE TABLE rotation_push (
  id INTEGER PRIMARY KEY,
  pushed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  week INTEGER NOT NULL,
  -- 1 when run with --week N (does not move next_week).
  override INTEGER NOT NULL CHECK (override IN (0, 1)),
  household_id INTEGER NOT NULL,
  list_id INTEGER NOT NULL,
  -- 'running' until the push finishes; a row left 'running' means the job was interrupted.
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  error TEXT
);

CREATE TABLE rotation_push_item (
  push_id INTEGER NOT NULL REFERENCES rotation_push (id),
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'skipped', 'failed')),
  -- KitchenOwl item id and the mark written, for items this job added.
  kitchenowl_item_id INTEGER,
  mark TEXT,
  -- Set when `rotation clear` removed the item from the list.
  cleared_at TEXT,
  PRIMARY KEY (push_id, name)
);
