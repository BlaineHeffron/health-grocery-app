# Store price sources (Charleston, SC)

What each store's source is, and why. A store gets an adapter only when an **official or
public, logged-out source** exists that its robots.txt and terms allow an automated client to
read. Everything else is `manual`: prices come from `hga prices add` / `hga prices import`
(receipts, shelf tags, weekly ads read by a person). See `docs/prices.md`.

Not used, for any store: logins or accounts, captcha or bot-check bypass, spoofed browser
fingerprints, private or app-internal endpoints, third-party scraping services.

**Checked 2026-11-24.** robots.txt was fetched with the app's own `PoliteFetcher` (generic
User-Agent `health-grocery-app/0.1`, at least 3 s between requests to a host); 25 requests in
total, all of them for robots.txt (no product or search pages were requested). Terms were read
from the public terms pages, or from search excerpts where a page refused automated clients;
quotes are short excerpts.

| Store | Source checked | robots.txt finding (2026-11-24) | Built | Not built, and why |
|---|---|---|---|---|
| **Harris Teeter** | Official Kroger public API, `api.kroger.com` (Harris Teeter is a Kroger Co. chain); developer.kroger.com | `api.kroger.com/robots.txt` answers `404 Not Found`: no rules (RFC 9309), so `/v1/connect/oauth2/token`, `/v1/locations` and `/v1/products` are allowed. (`www.harristeeter.com/robots.txt` timed out twice; the site itself is not used.) | `kroger` adapter: client-credentials token (`product.compact`), locations near `HGA_PRICE_ZIP` kept to Harris Teeter, location-scoped product search. Needs `KROGER_CLIENT_ID` / `KROGER_CLIENT_SECRET` (see `docs/kroger-signup.md`); without them it reports "not configured". | No live call yet: there are no credentials, so it is built and tested against synthetic fixtures shaped like the documented responses. The exact `filter.chain` value for Harris Teeter is undocumented, so locations are fetched unfiltered and matched by chain/name. |
| **Publix** | publix.com, [website policies](https://www.publix.com/publix-website-policies) | `User-agent: *` … `Disallow: /search?*` (product search is disallowed) | manual | No API or feed. Terms §5(k): may not "access or use the Services by means of any automated program … or bot", except general-purpose search engines; §5(m): may not "scrape, copy, republish". |
| **Lowes Foods** | lowesfoods.com (terms page not found; only the Fresh Rewards terms, "only for personal and consumer use") | `robots.txt` answered 404 (no rules) on the second try; the first try failed and the host was refused | manual | No official API or feed found, and the site terms could not be found or verified, so no source "clearly qualifies". |
| **Food Lion** | foodlion.com, terms of use and the parent Ahold Delhaize USA legal terms (both answered 403) | `User-agent: *` / `Disallow: /product-search/` / `Disallow: /browse-aisles/` (product search is disallowed) | manual | No public API. The terms pages refuse automated clients, so permission cannot be verified; search snippets of the parent terms say any use "not expressly allowed in these Terms is prohibited". |
| **Walmart** | walmart.com terms of use; the [walmart.io affiliate API](https://walmart.io/apidocs/affiliates/quickstart) | `User-agent: *` / `Disallow: /search` (also `/api/`) | manual | Terms: may not "Use any robot, spider, site search/retrieval application or other manual or automatic device to retrieve, index" content without written permission. The affiliate API needs a Walmart account login and affiliate approval ("at our sole discretion"), so it is not a logged-out source. |
| **Aldi** | aldi.us, [terms of use](https://www.aldi.us/en/terms-of-use) | `User-Agent: *` / `Disallow: /` (only named crawlers have groups of their own) | manual | Disallowed for every other agent; terms §8 also bar any "spider, web crawler or robot" used to "navigate, search, and/or extract information". No API. |
| **Costco** | costco.com, [terms and conditions of use](https://www.costco.com/f/-/terms-and-conditions-of-use) | `User-agent: *` … `Disallow: /CatalogSearch*` | manual | Terms §9: may not "Use any data mining, robots, agents or similar data gathering or extraction methods". No API. Membership pricing would also need a login. |
| **Trader Joe's** | traderjoes.com, terms of use (answered 403) | `robots.txt` answered `403 Forbidden`; the fetcher treats that as "refuse the whole host" | manual | robots.txt itself refuses automated clients, the terms could not be read, and there is no API or feed. |
| **Whole Foods Market** | wholefoodsmarket.com, [conditions of use](https://www.wholefoodsmarket.com/legal/terms-use) (incorporates Amazon's) | `User-agent: *` disallows `/locations/`, `/account/`, `/cart` and similar; search is not disallowed | manual | robots.txt alone would allow search pages, but the incorporated Amazon conditions exclude "any use of data mining, robots, or similar data gathering and extraction tools". No API. |

No chain on the list publishes an official weekly-ad feed or API; weekly ads are pages on their
own sites under the same terms, so they are read by a person and entered manually.

## Revisit when
- Kroger credentials exist: run one small live compare and record the request count.
- A store publishes an official API or feed, or its terms change to allow automated reads.
