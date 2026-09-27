# Stock Tracker

Email alerts when stocks on a watchlist approach their target price.

A signed-in user builds a watchlist on a small web page (from a CSV file, by hand, or
straight from TradingView). Three times a day a scheduled job fetches current prices and
emails each user the stocks that are within ±5% (10:00) or ±3% (16:30, 18:30) of their
long target price.

Runs entirely on AWS serverless services (Cognito, API Gateway, Lambda, DynamoDB,
EventBridge Scheduler, SES, S3 + CloudFront) and is deployed with the AWS CDK.

## Alerts

Prices are checked Monday to Friday (Europe/Rome time):

| Time | Email contains |
| --- | --- |
| 10:00 | Stocks within ±5% of the target, stocks that left the ±5% band, and stocks that left the ±3% band while staying within ±5% since the previous morning |
| 16:30, 18:30 | Stocks within ±3% of the target |

- The distance is symmetric: `|price − target| / target`.
- Each reported stock shows the date it was first reported. The date is kept while the
  stock stays within ±5% and cleared when it leaves.
- No email is sent when there is nothing to report.
- Each ticker in the email links to its TradingView page.
- Targets are in EUR. Prices come from Yahoo Finance in the listing currency and are
  converted to EUR at the current Yahoo FX rate before comparing; a stock whose FX rate
  cannot be fetched is reported as unpriced.

## Web app

- **Onboarding:** an empty watchlist offers a CSV import (reviewed before saving) or
  manual entry. Once stocks exist, the list is edited in place.
- **Editing:** name, ticker and target are edited inline; removals can be undone until
  saved. A sticky bar counts unsaved changes and holds Save / Discard, and leaving the
  page with unsaved changes asks for confirmation.
- **Ticker lookup:** typing a new stock's name searches Yahoo; when several listings
  match, a dropdown lists them with a TradingView chart link to check the right one.
- **Search:** filters the list by name or ticker (`/` focuses it, `Esc` clears it);
  saving always keeps the rows hidden by the filter.
- **TradingView links:** US tickers carry no exchange suffix, so saving looks up and
  stores Yahoo's exchange code (NYQ, NMS, …); without it TradingView may open a
  namesake abroad (HAL → India's NSE). Stocks saved before this have no link until the
  list is saved again.
- **Bookmarklet:** "➕ Stock Tracker", dragged to the bookmarks bar, reads the stock on
  the current TradingView page and opens the site with it pre-filled. On charts it reads
  the tab title and the legend's exchange, because the chart URL does not follow symbol
  changes.
- Works on phones: each stock becomes a compact block below 640 px.

## Architecture

```
Browser ──► CloudFront ──► S3                          static site (frontend/)
               │
               └─ /watchlist* ──► API Gateway ──► API Lambdas ──► DynamoDB
                                  (Cognito JWT)        │
                                                       └──► Yahoo Finance (ticker search)

EventBridge Scheduler ──► Alerts Lambda ──► DynamoDB (watchlists, alert state)
                                 ├────────► Yahoo Finance (prices)
                                 └────────► SES ──► email to each user
```

- `frontend/`: static page, no build step. Signs in with the Cognito hosted UI
  (authorization code + PKCE) and keeps tokens in memory only.
- `backend/`: Lambda handlers.
  - `POST /watchlist/preview` parses the CSV and resolves tickers; it stores nothing.
  - `PUT /watchlist` validates the confirmed list and replaces the caller's watchlist,
    looking up the Yahoo exchange of new US tickers for their TradingView links.
  - `GET /watchlist` returns the caller's watchlist.
  - `GET /watchlist/search?q=` looks up tickers by name when a stock is added by hand;
    `?tv=NYSE:HAL` resolves a TradingView symbol for the "➕ Stock Tracker" bookmarklet, which
    opens the site with `?add=<symbol>` from any TradingView chart or symbol page.
  - `alerts.ts` runs on a schedule, fetches prices, updates alert state and emails
    each user.
- `infra/`: the CDK stack.

The API is served from the site's own origin through CloudFront, so production needs
no CORS and the Content Security Policy only allows connections to the site itself
and the Cognito domain.

## CSV format

Semicolon-separated, UTF-8. Required columns (header names are case-insensitive):

| Column | Meaning |
| --- | --- |
| `nazione` | Country, used to pick the right exchange for the ticker lookup |
| `Nome` | Company name |
| `prezzo Target Long` | Long target price; Italian decimals (`16,3`) are accepted |
| `note` | Any text here excludes the row |
| `ticker` | Optional; overrides the automatic lookup |

Rows without a long target price or with a note are skipped. Supported countries:
stati uniti, francia, svizzera, italia, germania, regno unito, spagna, olanda,
belgio, portogallo. Rows from other countries need a ticker entered manually.

## Requirements

- Node.js 22+
- AWS CLI v2 with credentials for the target account
- An AWS account bootstrapped for CDK (`npx cdk bootstrap`)

## Setup

```sh
npm install
```

## Commands

| Command | Description |
| --- | --- |
| `npm test` | Run unit tests |
| `npm run typecheck` | Type-check the project |
| `npx cdk diff -c senderEmail=<address>` | Show infrastructure changes |
| `npx cdk deploy -c senderEmail=<address>` | Deploy the stack |

Use `AWS_PROFILE=<profile>` to pick the credentials used by CDK. After a deploy the
site is available at the `SiteUrl` stack output.

### Email sending

`senderEmail` is the address alerts are sent from. The first deploy registers it with
Amazon SES, which emails a verification link to that address.

New SES accounts start in the sandbox, where every recipient must be verified too.
Either verify each user's address
(`aws sesv2 create-email-identity --email-identity user@example.com`) or request
production access in the SES console.

A sender on a domain you control, with DKIM configured, is the most reliable option.
Mail sent through SES from a free webmail address may be filtered as spam.

### Local frontend development

Create `frontend/config.json` from the stack outputs (the file is git-ignored):

```json
{
  "apiUrl": "<ApiUrl output>",
  "cognitoDomain": "<HostedUiDomain output>",
  "clientId": "<UserPoolClientId output>"
}
```

Then serve the folder on port 5173, which is allowed by Cognito and CORS:

```sh
python3 -m http.server 5173 -d frontend
```

## Users

Self sign-up is disabled. Create users from the CLI:

```sh
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId output> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true
```

The user receives a temporary password by email and sets a new one on first login.
While SES is in the sandbox, also verify their address (see Email sending); the
verification link expires after 24 hours.

Remove a user with `aws cognito-idp admin-delete-user --user-pool-id <UserPoolId output>
--username <username or sub>` and `aws sesv2 delete-email-identity --email-identity
<address>`. Their watchlist rows in DynamoDB are not deleted automatically.

## License

[MIT](LICENSE)
