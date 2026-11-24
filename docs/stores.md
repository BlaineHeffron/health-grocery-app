# Store price sources (Charleston, SC)

What each store's source is, and why. A store gets an adapter only when an **official or
public, logged-out source** exists that its robots.txt and terms allow an automated client to
read. Everything else is `manual`: prices come from `hga prices add` / `hga prices import`
(receipts, shelf tags, weekly ads read by a person). See `docs/prices.md`.

Not used, for any store: logins or accounts, captcha or bot-check bypass, spoofed browser
fingerprints, private or app-internal endpoints, third-party scraping services.

**Checked 2026-11-24.** Two separate kinds of request were made:

- **robots.txt, by the app:** the app's own `PoliteFetcher` (generic User-Agent
  `health-grocery-app/0.1`, at least 3 s between requests to a host) made 25 requests, all for
  robots.txt. No product, search or API pages were requested.
- **Terms and API docs, by a research assistant:** these were read during development by an AI
  research assistant (Claude Code's WebSearch and WebFetch tools, not the app). It made 18 web
  searches and 20 one-off page fetches: the stores' terms pages listed below, Kroger and
  Walmart developer pages, the parent-company terms of Food Lion and Whole Foods, and two
  third-party copies of the Kroger and Walmart docs. Those fetches did **not** check robots.txt
  first, and they ran before the robots.txt check above. Two of them went to pages that the
  robots.txt findings below refuse: Aldi's terms page (its `*` group disallows `/`) and Trader
  Joe's terms page (its robots.txt answers 403; that fetch got a 403 and no text). They are not
  repeated and the app never makes such requests. Quotes are short excerpts. Where a quote came
  from somewhere other than the store's own page, the row says so.

| Store | Source checked | robots.txt finding (2026-11-24) | Built | Not built, and why |
|---|---|---|---|---|
| **Harris Teeter** | Official Kroger public API, `api.kroger.com` (Harris Teeter is a Kroger Co. chain); developer.kroger.com | `api.kroger.com/robots.txt` answers `404 Not Found`: no rules (RFC 9309), so `/v1/connect/oauth2/token`, `/v1/locations` and `/v1/products` are allowed. (`www.harristeeter.com/robots.txt` timed out twice; the site itself is not used.) | `kroger` adapter: client-credentials token (`product.compact`), locations near `HGA_PRICE_ZIP` kept to Harris Teeter, location-scoped product search. Needs `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` (see `docs/kroger-signup.md`); without them it reports "not configured". | No live call yet: there are no credentials, so it is built and tested against synthetic fixtures shaped like the documented responses. The exact `filter.chain` value for Harris Teeter is undocumented, so locations are fetched unfiltered and matched by chain/name. |
| **Publix** | publix.com, [website policies](https://www.publix.com/publix-website-policies) | `User-agent: *` … `Disallow: /search?*` (product search is disallowed) | manual | No API or feed. Terms §5(k): may not "access or use the Services by means of any automated program … or bot", except general-purpose search engines; §5(m): may not "scrape, copy, republish". |
| **Lowes Foods** | lowesfoods.com (terms page not found; only the Fresh Rewards terms, "only for personal and consumer use") | `robots.txt` answered 404 (no rules) on the second try; the first try failed and the host was refused | manual | No official API or feed found, and the site terms could not be found or verified, so no source "clearly qualifies". |
| **Food Lion** | foodlion.com, terms of use and the parent Ahold Delhaize USA legal terms (both answered 403) | `User-agent: *` / `Disallow: /product-search/` / `Disallow: /browse-aisles/` (product search is disallowed) | manual | No public API. The terms pages refuse automated clients, so permission cannot be verified; search snippets of the parent terms say any use "not expressly allowed in these Terms is prohibited". |
| **Walmart** | walmart.com terms of use; the [walmart.io affiliate API](https://walmart.io/apidocs/affiliates/quickstart) | `User-agent: *` / `Disallow: /search` (also `/api/`) | manual | Terms (quoted from a third-party copy, ConductAtlas, because walmart.com answered the fetch with a bot check, which was not bypassed): may not "Use any robot, spider, site search/retrieval application or other manual or automatic device to retrieve, index" content without written permission. The affiliate API needs a Walmart account login and affiliate approval ("at our sole discretion"), so it is not a logged-out source. |
| **Aldi** | aldi.us, [terms of use](https://www.aldi.us/en/terms-of-use) | `User-Agent: *` / `Disallow: /` (only named crawlers have groups of their own) | manual | Disallowed for every other agent, which alone decides it. The terms quote comes from the research assistant's one automated fetch of that page, which this robots.txt disallows (see above): §8 bars any "spider, web crawler or robot" used to "navigate, search, and/or extract information". No API. |
| **Costco** | costco.com, [terms and conditions of use](https://www.costco.com/f/-/terms-and-conditions-of-use) | `User-agent: *` … `Disallow: /CatalogSearch*` | manual | Terms §9: may not "Use any data mining, robots, agents or similar data gathering or extraction methods". No API. Membership pricing would also need a login. |
| **Trader Joe's** | traderjoes.com, terms of use (answered 403) | `robots.txt` answered `403 Forbidden`; the fetcher treats that as "refuse the whole host" | manual | robots.txt itself refuses automated clients, the terms could not be read, and there is no API or feed. |
| **Whole Foods Market** | wholefoodsmarket.com, [conditions of use](https://www.wholefoodsmarket.com/legal/terms-use) (incorporates Amazon's) | `User-agent: *` disallows `/locations/`, `/account/`, `/cart` and similar; search is not disallowed | manual | robots.txt alone would allow search pages, but the incorporated Amazon conditions (quoted from a search excerpt, because the Amazon page answered 503) exclude "any use of data mining, robots, or similar data gathering and extraction tools". No API. |

No chain on the list publishes an official weekly-ad feed or API; weekly ads are pages on their
own sites under the same terms, so they are read by a person and entered manually.

## Aggregator sources

Sources that cover many stores. Same rules as above: official or public, logged out, allowed
by the licence or terms and by robots.txt. **Checked 2026-11-24.**

**How the research was done this time.** Every request was made with `curl` and the app's own
generic User-Agent (`health-grocery-app/0.1 (personal grocery price comparison; honors
robots.txt)`), and robots.txt was fetched on each host before anything else on it, research
included. No WebFetch, no WebSearch, no logins. Requests by host (all on 2026-11-24):

| Host | Requests | What |
|---|---|---|
| `prices.openfoodfacts.org` | 20 | robots.txt ×2; API docs ×4 (`/api/openapi.json` ×2: timeout, 404; `/api/schema/`, `/api/docs/`: timeouts); API research ×3 (all failed, see below); `/data/locations.jsonl.gz` ×1 (1,272,508 bytes); `/data/prices.jsonl.gz` HEAD ×6 and GET ×2 (the first, 15,761,230 bytes, came mid-regeneration and was truncated, so it was discarded; the second, 23,293,936 bytes, `last-modified` 23:08:44 UTC, passed `gzip -t`); the app's one real run ×2 (robots.txt and the nearby query) |
| `world.openfoodfacts.org` | 2 | robots.txt; `/terms-of-use` (allowed: its `*` group disallows only `/api`, `/cgi`, `/facets`) |
| `wiki.openfoodfacts.org` | 1 | robots.txt only |
| `github.com`, `raw.githubusercontent.com`, `api.github.com` | 1, 16, 3 | robots.txt on each (raw and api answer 404: no rules); the Open Prices source code and docs (README, API.md, data guide, filters, serializers, models, pagination, views, settings, export script); one repository tree listing and one lookup of the `main` commit id |
| `flipp.com`, `www.flipp.com` | 1, 1 | robots.txt only (`www` answers 301 to `flipp.com`) |
| `corp.flipp.com`, `corporate.flipp.com` | 4, 1 | robots.txt; `/terms-of-use/`; `/sitemap_index.xml`; `/page-sitemap.xml` (`corporate.` did not resolve) |

### Open Prices (Open Food Facts), prices.openfoodfacts.org

- **Allowed: yes.**
  - robots.txt: `https://prices.openfoodfacts.org/robots.txt` answers `200` with an empty body
    (`content-length: 0`): no rules, so `/api/v1/prices` and `/data/` are allowed. (The
    separate `world.openfoodfacts.org` host disallows `/api` for `*`; the app never calls it.)
  - Licence: the Open Prices docs (`API.md`, `docs/guides/data.md` in the project's repository)
    say: "Make sure you comply with the OdBL licence, mentioning the source of your data, and
    ensuring to avoid combining non free data you can't release legally as open data." The Open
    Food Facts terms of use (`world.openfoodfacts.org/terms-of-use`): re-users "have to mention
    the licence and to attribute the authorship to Open Food Facts with a link to
    https://openfoodfacts.org"; "Derivative works must be shared under the same conditions."
  - Read access needs no account (README: "you can explore the data without an account"); only
    writes need a token.
  - Rate limits: none documented. The API settings define no throttling, the docs ask scripts to
    be tested on the pre-production server first, and the API refuses pages past 500 and points
    bulk users at the dumps. The app sends at most 1 + 5 requests per run (robots.txt, then up to
    five 100-row pages of one nearby query), 3 s apart, through the `PoliteFetcher`.
- **Charleston, SC coverage: none.** From the complete locations dump (8,010 locations, 406 in
  the US): **0 locations and 0 prices within 15 mi (24.1 km)** of downtown Charleston, the
  app's default radius. Within 60 km there are 2 locations with 1 price each, neither in range:
  Earth Fare, Summerville (35.7 km; not a listed store) and Publix, Summerville (40.9 km).
  South Carolina as a whole has 5 locations with 1 price each (also Publix Myrtle Beach, Food
  Lion Rock Hill, Walmart Lancaster). Their price dates, from the prices dump: Earth Fare
  Summerville 2024-10-30, Publix Myrtle Beach 2025-08-10, Publix Summerville 2025-08-21, Food
  Lion Rock Hill 2026-09-02, Walmart Lancaster 2026-11-19; all five are barcode (`PRODUCT`)
  prices. The live API agreed: the app's one real run (2026-11-24 23:13 UTC, 2 requests)
  answered `ok` and produced no offers.
- **Freshness.** From the complete prices dump (regenerated daily; the copy read was
  23,293,936 bytes, `last-modified` 2026-11-24 23:08:44 UTC, 349,620 rows), ages on
  2026-11-24 of the 48,289 US prices: median 285 days, quartiles 110 and 389 days; 3.2% are
  under 30 days old, 18.6% under 90, 68.9% under a year. Prices reach the database a median of
  3 days after their date. US prices added per month, Dec 2025 to Nov 2026 (Nov partial):
  2,576; 3,811; 2,869; 1,323; 1,844; 1,041; 2,144; 3,386; 4,062; 2,445; 7,501; 1,523. (The
  locations dump's US `price_count` sums to 48,216; the 73 more rows in the prices dump are
  prices counted after the locations dump was written.) With the default 30-day cutoff most
  prices would show as stale even where coverage exists.
- **Data shape.** Per item, crowd-sourced from receipts and shelf tags, at one OpenStreetMap
  location each. `GET /api/v1/prices` (paged: `items`, `page`, `pages`, `size`, `total`) takes
  `lat`, `lon`, `radius_km`, `currency`, `date__gte` and `order_by`, and nests the `product` and
  `location` objects. Two kinds of price: `CATEGORY` (raw produce such as `en:leeks`) with
  `price_per` `KILOGRAM`, `UNIT` or `LITER`, which gives the unit price directly; and `PRODUCT`
  (a barcode) with `price_per` null, whose size comes only from the product's
  `product_quantity` and `product_quantity_unit` (nested in the API; in the dump the price row
  has only `product_id`; sizes would need the products dump). Of the 48,289 US prices, 47,768
  are `PRODUCT` and 521 `CATEGORY` (273 per kg, 248 per unit). `price_is_discounted` and `price_without_discount` give
  promos. The dumps are daily gzipped JSONL files.
- **Integration effort: small, and built.** One adapter file plus a dated-offer path in the
  offer store. See "Open Prices adapter" below.
- **Verdict: adapter built, but it has no Charleston data today** (0 locations, 0 prices within
  15 mi). It is clearly allowed and small, so it is built and runs with the Kroger adapter; it
  will pick up Charleston prices if contributors add them. Its mapping is verified against
  synthetic fixtures shaped like the API serializer only: the research calls to the API all
  failed (504 or timeout) and the one real run returned no rows in range.

**Open Prices adapter** (`src/prices/adapters/open-prices.ts`, source id `open-prices`):

- One nearby query per run: `GET https://prices.openfoodfacts.org/api/v1/prices?lat=32.7765&lon=-79.9311&radius_km=<HGA_PRICE_RADIUS_MILES in km>&currency=USD&order_by=-date&size=100&page=N`,
  at most 5 pages, after robots.txt, 3 s apart, generic User-Agent, no account. Every search
  term is then answered from that one result in memory. The centre is downtown Charleston, the
  default ZIP 29401; with another `HGA_PRICE_ZIP` the source reports "not configured".
- The parameters are real filters, defined in the Open Prices source at commit `cac0dace7b3c`:
  `lat`, `lon`, `radius_km` (applied together through `Location.objects.nearby`),
  `currency` and `date` in `PriceFilter`
  ([open_prices/api/prices/filters.py](https://github.com/openfoodfacts/open-prices/blob/cac0dace7b3c1097a679ca45b1552a0f8545c0ab/open_prices/api/prices/filters.py));
  `order_by` is the API's `ORDERING_PARAM` with `date` among `ordering_fields`
  ([config/settings.py](https://github.com/openfoodfacts/open-prices/blob/cac0dace7b3c1097a679ca45b1552a0f8545c0ab/config/settings.py),
  [open_prices/api/prices/views.py](https://github.com/openfoodfacts/open-prices/blob/cac0dace7b3c1097a679ca45b1552a0f8545c0ab/open_prices/api/prices/views.py));
  the page envelope (`items`, `page`, `pages`, `size`, `total`) is in
  [open_prices/api/pagination.py](https://github.com/openfoodfacts/open-prices/blob/cac0dace7b3c1097a679ca45b1552a0f8545c0ab/open_prices/api/pagination.py).
  The adapter still checks every row's own location (US, inside the radius) and drops the
  rest, and treats a 200 without that envelope as an error.
- Term matching: a price matches a catalog search term when the term's words appear, in order,
  in its category tag (`en:collard-greens`) or product name, ignoring case and a plural "s".
  `garlic bulb` does not match `en:garlic`; strict on purpose.
- Store mapping: the location's `osm_brand`, else `osm_name`, is matched to a listed store
  (Harris Teeter, Publix, Lowes Foods, Food Lion, Walmart, Aldi, Costco, Trader Joe's, Whole
  Foods). Prices at any other location are dropped, as are prices outside the radius or the
  US and prices without a USD amount or a valid past date; the run line counts each group.
- Size: `CATEGORY` prices are 1 kg, 1 l or 1 each from `price_per`; `PRODUCT` prices use the
  product quantity, and without one the offer is kept with unit `?`, so it shows under "Not
  ranked" instead of being ranked with a guessed size.
- Age: each offer keeps the price's own `date` as `observedOn`, so its age and the
  `--max-age-days` cutoff use the contributor's date, not the fetch day. A refetch replaces
  every earlier Open Prices row for that search term, whatever its store or date; for each
  store, item and source only the latest date counts, as for every source.
- Attribution: offers carry `source: "open-prices"`, the product text ends with
  `(Open Prices #<price id>)`, the human output marks them `via open-prices` and prints
  "Open Prices data © Open Food Facts contributors, ODbL 1.0 (https://prices.openfoodfacts.org)"
  whenever one is shown, and `--json` lists the source and that notice under `sources`.
- Share-alike: the local database is a derivative database used privately. It is not
  committed or published; anyone who publishes it, or an export of its Open Prices rows, must
  do so under the ODbL with the attribution above.
- Errors: a 5xx or a hang ends the source for that run with an error line (no retry, no stored
  back-off); a 429 or 403 stores a back-off as for every adapter; manual prices still compare.

### Flipp (flipp.com weekly ads)

- **Allowed: no.**
  - robots.txt (`https://flipp.com/robots.txt`, 200): `User-agent: Baiduspider` / `Disallow: /`;
    `User-agent: *` disallows `/*-*/*-*/item/45*`, `/fr-us/`, `/fr-ca/browser/`,
    `/fr-ca/categories` and `/fr-ca/*-<province or state>/circulaires` paths. robots.txt
    alone would allow most English pages; the terms decide it.
  - Terms (`https://corp.flipp.com/terms-of-use/`, read 2026-11-24; `corp.flipp.com/robots.txt`
    disallows only `/pdf/`): the "Licensed Application" is defined as "this application,
    affiliated website, and the service performed or provided by this application"; §2.1 grants
    a licence "for personal and non-commercial use"; §2.2 says you may not "Incorporate, merge,
    combine or otherwise include the Application Content in any database, compilation or other
    storage means" and may not "Download, copy, capture, scrape or otherwise obtain the
    Application Content not otherwise expressly permitted through the Licensed Application".
    Storing ad prices in this app's database is exactly what §2.2 excludes.
  - No public API: the `corp.flipp.com` page sitemap lists retailer, brand and media platform
    pages, careers, legal and events, and no developer or API program. The only machine routes
    are the site's and apps' internal endpoints, which are excluded here.
- **Charleston, SC coverage: not measured.** There is no permitted automated route, so no
  Flipp page or data was requested (only the robots.txt, terms and sitemap requests above).
- **Freshness:** weekly ads, by their nature current for one ad week; not measured.
- **Data shape:** ad-only (circular items and sale prices), not a full shelf; unit price only
  where an ad states one.
- **Integration effort:** not applicable; it would need internal endpoints.
- **Verdict: not built.** The terms bar storing or scraping the content and there is no
  public API. Weekly-ad prices stay manual (`hga prices add` / `import`).

## Revisit when
- Kroger credentials exist: run one small live compare and record the request count.
- A store publishes an official API or feed, or its terms change to allow automated reads.
- Open Prices: run one live compare once its API answers again, and recheck Charleston
  coverage (`hga prices compare` reports the Open Prices offers and the dropped counts).
- Flipp: a public API or terms that allow automated use.
