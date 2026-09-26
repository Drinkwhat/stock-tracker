# Stock Tracker

Email alerts when stocks on a watchlist approach their target price.

A signed-in user uploads a CSV watchlist through a small web page. Three times a day a
scheduled job fetches current prices and emails each user the stocks that are within
±5% (10:00) or ±3% (16:30, 18:30) of their long target price.

Runs entirely on AWS serverless services (Cognito, API Gateway, Lambda, DynamoDB,
EventBridge Scheduler, SES, S3 + CloudFront) and is deployed with the AWS CDK.

> Status: work in progress. Watchlist upload and review work end to end; scheduled
> price checks and email alerts are not implemented yet.

## Architecture

```
Browser ──► CloudFront ──► S3                 static site (frontend/)
               │
               └─ /watchlist* ──► API Gateway ──► Lambda ──► DynamoDB
                                   (Cognito JWT)     │
                                                     └──► Yahoo Finance search
```

- `frontend/`: static page, no build step. Signs in with the Cognito hosted UI
  (authorization code + PKCE) and keeps tokens in memory only.
- `backend/`: Lambda handlers.
  - `POST /watchlist/preview` parses the CSV and resolves tickers; it stores nothing.
  - `PUT /watchlist` validates the confirmed list and replaces the caller's watchlist.
  - `GET /watchlist` returns the caller's watchlist.
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
| `npx cdk diff` | Show infrastructure changes |
| `npx cdk deploy` | Deploy the stack |

Use `AWS_PROFILE=<profile>` to pick the credentials used by CDK. After a deploy the
site is available at the `SiteUrl` stack output.

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

## License

[MIT](LICENSE)
