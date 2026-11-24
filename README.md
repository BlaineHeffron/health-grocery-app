# health-grocery-app

An all-in-one meal, macro and grocery app for Blaine, built on top of his self-hosted KitchenOwl (running on Dueno and reached only over a private tailnet; its URL comes from `KITCHENOWL_URL` in the untracked `.env`). It works alongside KitchenOwl instead of replacing it.

## Scope
1. **Macro tracking integrated with meal logging.** Log meals, which can come from KitchenOwl recipes, and get protein, carbs, fat, fiber and calories per meal, per day and per week.
2. **Nutrient-variety rotation.** A 4-week plan that cycles vegetable and food families (see `data/rotation.yaml`). A weekly job pushes the next rotation week's items to the KitchenOwl shopping list through its API.
3. **Local grocery price comparison** around Charleston, SC for the suggested items.

See `PLAN.md` for the architecture, phases and open questions.

## Privacy rules (binding)
- No personal health data, labs or anything from Blaine's private health folder (its path is deliberately kept out of this repo) goes in this repo or to any outside service.
- The rotation content is generic food-family data, with no personal data.
- Secrets (the KitchenOwl API token, any price API keys) live in an untracked `.env` and are never committed or printed.
- It runs on Dueno and is reachable only over the tailnet, never exposed publicly.
