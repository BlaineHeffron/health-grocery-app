# Kroger API sign-up (Harris Teeter prices)

The Harris Teeter adapter uses the official, free Kroger public API. It needs one app
registration that yields a client ID and a client secret. No customer account login is used by
the app: it only requests a client-credentials token for public product data.

1. Go to developer.kroger.com and create a developer account (free).
2. Create an application (any name, e.g. "health-grocery-app").
   - Scope: **`product.compact`** (read product information). Nothing else is needed: the
     locations lookup works with a client-credentials token, and the cart, identity and
     profile scopes are not used.
   - A redirect URI is only used by customer sign-in flows, which this app does not use. If the
     form requires one, enter a placeholder such as `http://localhost/unused`.
3. Copy the app's **Client ID** into `KROGER_CLIENT_ID` and its **Client Secret** into
   `KROGER_CLIENT_SECRET` in the untracked `.env` (both are listed, empty, in `.env.example`).

   Never commit `.env` or paste these values anywhere else. Optionally set `HGA_PRICE_ZIP`
   (default `29401`, downtown Charleston) and `HGA_PRICE_RADIUS_MILES` (default `15`).
4. Check: `hga prices stores` should show `harris-teeter  …  configured`. Then
   `hga prices compare --week 1` fetches that week's items once (cached for the day).

How the app uses them: it posts them (HTTP Basic) to
`https://api.kroger.com/v1/connect/oauth2/token` with
`grant_type=client_credentials&scope=product.compact`, keeps the access token in memory for its
lifetime (`expires_in`, about 30 minutes), and never writes it to disk or logs. Searches go through the polite
fetcher (robots.txt check, at most one request per 3 s per host, back-off on 429/403). A week's
compare is about 20 searches plus one token and one locations request; Kroger's limits are
reported as 10,000 product and 1,600 location calls per day (check the developer portal).
