import { getAtlassianAuthorizationHeader } from "./atlassian.js";

export async function buildHttpHeaders(url: string): Promise<Record<string, string>> {
  const parsed = new URL(url);

  if (parsed.hostname === "mcp.atlassian.com") {
    return {
      Authorization: await getAtlassianAuthorizationHeader(url),
    };
  }

  return {};
}
