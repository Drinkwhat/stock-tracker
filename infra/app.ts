import { App } from "aws-cdk-lib";
import { StockTrackerStack } from "./stack.ts";

const app = new App();

new StockTrackerStack(app, "StockTracker", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
