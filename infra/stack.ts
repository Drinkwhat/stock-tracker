import { CfnOutput, Duration, RemovalPolicy, Stack, TimeZone, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpUserPoolAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { LambdaInvoke } from "aws-cdk-lib/aws-scheduler-targets";
import * as ses from "aws-cdk-lib/aws-ses";
import type { Construct } from "constructs";
import * as path from "node:path";
import type { RunKind } from "../backend/bands.ts";

const LOCAL_DEV_ORIGIN = "http://localhost:5173";
const FRONTEND_DIR = path.join(import.meta.dirname, "../frontend");

export class StockTrackerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- Website hosting ---

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- Authentication ---

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

    // --- Data and API ---

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

    const searchFn = fn("SearchFn", "search.ts", Duration.seconds(10));

    const saveFn = fn("SaveFn", "save.ts", Duration.seconds(28));
    table.grantReadWriteData(saveFn);

    // Production traffic reaches the API through CloudFront on the site's own origin,
    // so CORS is only needed for local development.
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

    // --- CDN with security headers ---

    const headers = new cloudfront.ResponseHeadersPolicy(this, "SecurityHeaders", {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'none'",
            "script-src 'self'",
            "style-src 'self'",
            `connect-src 'self' ${domain.baseUrl()}`,
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join("; "),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
    });

    const distribution = new cloudfront.Distribution(this, "Site", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
      },
      additionalBehaviors: {
        "/watchlist*": {
          origin: new HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    const siteOrigin = `https://${distribution.distributionDomainName}`;

    // --- Wiring that needs the site URL ---

    const client = userPool.addClient("WebClient", {
      generateSecret: false,
      authFlows: {},
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${siteOrigin}/`, `${LOCAL_DEV_ORIGIN}/`],
        logoutUrls: [`${siteOrigin}/`, `${LOCAL_DEV_ORIGIN}/`],
      },
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
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

    api.addRoutes({
      path: "/watchlist/search",
      methods: [apigw.HttpMethod.GET],
      integration: new HttpLambdaIntegration("SearchIntegration", searchFn),
      authorizer,
    });

    // --- Scheduled alerts ---

    const senderEmail: unknown = this.node.tryGetContext("senderEmail");
    if (typeof senderEmail !== "string" || !senderEmail.includes("@")) {
      throw new Error("Pass the alert sender address with: cdk deploy -c senderEmail=you@example.com");
    }
    const senderIdentity = new ses.EmailIdentity(this, "SenderIdentity", {
      identity: ses.Identity.email(senderEmail),
    });

    const alertsFn = fn("AlertsFn", "alerts.ts", Duration.seconds(60));
    alertsFn.addEnvironment("SENDER_EMAIL", senderEmail);
    alertsFn.addEnvironment("USER_POOL_ID", userPool.userPoolId);
    // A retry would email users who were already notified in the failed run.
    alertsFn.configureAsyncInvoke({ retryAttempts: 0 });
    table.grantReadWriteData(alertsFn);
    userPool.grant(alertsFn, "cognito-idp:ListUsers");
    senderIdentity.grantSendEmail(alertsFn);

    const schedule = (id: string, cron: scheduler.CronOptionsWithTimezone, kind: RunKind) =>
      new scheduler.Schedule(this, id, {
        schedule: scheduler.ScheduleExpression.cron({ ...cron, weekDay: "MON-FRI", timeZone: TimeZone.EUROPE_ROME }),
        target: new LambdaInvoke(alertsFn, {
          input: scheduler.ScheduleTargetInput.fromObject({ kind }),
          retryAttempts: 0,
        }),
      });
    schedule("MorningAlerts", { hour: "10", minute: "0" }, "morning");
    schedule("IntradayAlerts", { hour: "16,18", minute: "30" }, "intraday");

    new s3deploy.BucketDeployment(this, "DeploySite", {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(FRONTEND_DIR, { exclude: ["config.json"] }),
        s3deploy.Source.jsonData("config.json", {
          apiUrl: `${siteOrigin}/`,
          cognitoDomain: domain.baseUrl(),
          clientId: client.userPoolClientId,
        }),
      ],
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "SiteUrl", { value: `${siteOrigin}/` });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: domain.baseUrl() });
    new CfnOutput(this, "ApiUrl", { value: stage.url });
  }
}
