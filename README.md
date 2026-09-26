# Stock Tracker

Email alerts when stocks on a watchlist approach their target price.

A signed-in user uploads a CSV watchlist through a small web page. Three times a day a
scheduled job fetches current prices and emails each user the stocks that are within
±5% (10:00) or ±3% (16:30, 18:30) of their long target price.

Runs entirely on AWS serverless services (Cognito, API Gateway, Lambda, DynamoDB,
EventBridge Scheduler, SES, S3 + CloudFront) and is deployed with the AWS CDK.

> Status: work in progress. Currently deployed: Cognito user pool and hosted login.

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

Use `AWS_PROFILE=<profile>` to pick the credentials used by CDK.

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
