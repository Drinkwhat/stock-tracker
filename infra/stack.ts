import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import * as path from "node:path";

const LOCAL_DEV_ORIGIN = "http://localhost:5173";
const LOCAL_DEV_URL = `${LOCAL_DEV_ORIGIN}/`;

export class StockTrackerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Users are invited by an admin: open sign-up would let anyone trigger outbound email.
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const domain = userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: `stock-tracker-${this.account}` },
    });

    const client = userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [LOCAL_DEV_URL],
        logoutUrls: [LOCAL_DEV_URL],
      },
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    });

    const table = new dynamodb.TableV2(this, "Watchlist", {
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ticker", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const fn = (id: string, file: string, timeout: Duration) =>
      new NodejsFunction(this, id, {
        entry: path.join(import.meta.dirname, "../backend", file),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout,
        environment: { TABLE_NAME: table.tableName },
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

    const watchlistFn = fn("WatchlistFn", "watchlist.ts", Duration.seconds(10));
    table.grantReadData(watchlistFn);

    // Ticker searches run inside the request, bounded by the 30 s API Gateway timeout.
    const previewFn = fn("PreviewFn", "preview.ts", Duration.seconds(28));

    const saveFn = fn("SaveFn", "save.ts", Duration.seconds(28));
    table.grantReadWriteData(saveFn);

    const api = new apigw.HttpApi(this, "Api", {
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: [LOCAL_DEV_ORIGIN],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.PUT],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    const stage = api.addStage("DefaultStage", {
      autoDeploy: true,
      throttle: { rateLimit: 5, burstLimit: 10 },
    });

    const authorizer = new HttpUserPoolAuthorizer("CognitoAuthorizer", userPool, {
      userPoolClients: [client],
    });

    api.addRoutes({
      path: "/watchlist",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("WatchlistIntegration", watchlistFn),
      authorizer,
    });
    api.addRoutes({
      path: "/watchlist",
      methods: [apigw.HttpMethod.PUT],
      integration: new HttpLambdaIntegration("SaveIntegration", saveFn),
      authorizer,
    });
    api.addRoutes({
      path: "/watchlist/preview",
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration("PreviewIntegration", previewFn),
      authorizer,
    });

    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: domain.baseUrl() });
    new CfnOutput(this, "ApiUrl", { value: stage.url });
  }
}
