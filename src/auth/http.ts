import { getOAuthAuthorizationHeader } from "./oauth.js";
import { atlassianOAuthProvider } from "./providers/atlassian.js";

export async function buildHttpHeaders(url: string): Promise<Record<string, string>> {
  const authorization = await getOAuthAuthorizationHeader(url, [atlassianOAuthProvider]);
  if (authorization) {
    return { Authorization: authorization };
  }

  return {};
}
