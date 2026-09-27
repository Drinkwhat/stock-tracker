import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { evaluate, isEmpty, type AlertState, type RunKind, type TrackedItem } from "./bands.ts";
import { db, TABLE_NAME, type StoredItem } from "./db.ts";
import { fetchQuotes } from "./prices.ts";
import { renderEmail, type Email } from "./report-email.ts";

const ses = new SESv2Client({});
const cognito = new CognitoIdentityProviderClient({});
const SENDER_EMAIL = process.env.SENDER_EMAIL!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const TIME_ZONE = "Europe/Rome";

type StoredTrackedItem = StoredItem & TrackedItem;

export async function handler(event: { kind?: string }) {
  if (event.kind !== "morning" && event.kind !== "intraday") throw new Error(`Unknown run kind: ${event.kind}`);
  const kind: RunKind = event.kind;
  const now = new Date();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
  const runLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);

  const items = await scanAll();
  const quotes = await fetchQuotes([...new Set(items.map((i) => i.ticker))]);
  if (items.length > 0 && quotes.size === 0) throw new Error("No prices could be fetched");
  const prices = new Map([...quotes].map(([ticker, q]) => [ticker, q.price]));
  const exchanges = new Map([...quotes].map(([ticker, q]) => [ticker, q.exchange ?? ""]));

  const byUser = Map.groupBy(items, (item) => item.userId);
  let failures = 0;
  for (const [userId, userItems] of byUser) {
    try {
      const { report, updates } = evaluate(userItems, prices, kind, today);
      // Send before saving state so a failed email is retried on the next run.
      if (!isEmpty(report)) await send(await emailOf(userId), renderEmail(report, kind, exchanges, runLabel));
      for (const { item, state } of updates) await saveState(userId, item, state);
    } catch (err) {
      failures++;
      console.error("Alert run failed for user", { userId, error: String(err) });
    }
  }

  console.log("Alert run finished", { kind, users: byUser.size, tickers: prices.size, failures });
  if (failures > 0) throw new Error(`Alert run failed for ${failures} users`);
}

// Full table scan on every run; fine for a few users, add a GSI or per-user fan-out if it grows.
async function scanAll(): Promise<StoredTrackedItem[]> {
  const items: StoredTrackedItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey: lastKey }));
    items.push(...((page.Items ?? []) as StoredTrackedItem[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function emailOf(userId: string): Promise<string> {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error("Unexpected user id format");
  const res = await cognito.send(
    new ListUsersCommand({ UserPoolId: USER_POOL_ID, Filter: `sub = "${userId}"`, Limit: 1 }),
  );
  const email = res.Users?.[0]?.Attributes?.find((a) => a.Name === "email")?.Value;
  if (!email) throw new Error("No email for user");
  return email;
}

async function send(to: string, email: Email) {
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: SENDER_EMAIL,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: email.subject, Charset: "UTF-8" },
          Body: { Html: { Data: email.html, Charset: "UTF-8" }, Text: { Data: email.text, Charset: "UTF-8" } },
        },
      },
    }),
  );
}

async function saveState(userId: string, item: TrackedItem, state: AlertState) {
  const values: Record<string, unknown> = {
    ":b": state.band,
    ":ew": state.exitedWide,
    ":en": state.exitedNarrow,
    ":t": item.targetPrice,
  };
  let update = "SET band = :b, exitedWide = :ew, exitedNarrow = :en";
  if (state.firstFlaggedAt) {
    update += ", firstFlaggedAt = :f";
    values[":f"] = state.firstFlaggedAt;
  } else {
    update += " REMOVE firstFlaggedAt";
  }

  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { userId, ticker: item.ticker },
        UpdateExpression: update,
        // Skip items removed or re-targeted by an upload that happened during the run.
        ConditionExpression: "targetPrice = :t",
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
  }
}
