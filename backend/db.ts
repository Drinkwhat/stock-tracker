import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  type BatchWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
export const TABLE_NAME = process.env.TABLE_NAME!;

export type StoredItem = Record<string, unknown> & { userId: string; ticker: string };

type WriteRequest = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];

export async function queryUserItems(userId: string): Promise<StoredItem[]> {
  const items: StoredItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": userId },
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((page.Items ?? []) as StoredItem[]));
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;

export async function batchWrite(requests: WriteRequest[]): Promise<void> {
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    let pending = requests.slice(i, i + BATCH_SIZE);
    for (let attempt = 1; pending.length > 0; attempt++) {
      if (attempt > MAX_ATTEMPTS) throw new Error(`${pending.length} writes still unprocessed`);
      const res = await db.send(new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending } }));
      pending = res.UnprocessedItems?.[TABLE_NAME] ?? [];
      if (pending.length > 0) await new Promise((ok) => setTimeout(ok, 100 * 2 ** attempt));
    }
  }
}
