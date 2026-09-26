import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export type AuthedEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

export const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// The owner always comes from the verified token, never from the request.
export const userIdOf = (event: AuthedEvent) => event.requestContext.authorizer.jwt.claims.sub as string;

export function bodyText(event: AuthedEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}
