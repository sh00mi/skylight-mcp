/**
 * `skylight-mcp login`
 * Signs in through Skylight's own OAuth page and saves tokens for the server.
 */

/* eslint-disable no-console -- interactive CLI; output goes to the user's terminal, not MCP stdio */

import { createInterface } from "node:readline/promises";

import { API_VERSION } from "./api/auth.js";
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  exchangeAuthorizationCode,
  parseAuthorizationRedirect,
  saveTokens,
} from "./api/oauth.js";
import { getTokenFile } from "./config.js";

/**
 * List the account's frames so the user knows which SKYLIGHT_FRAME_ID to use
 */
async function listFrames(accessToken: string): Promise<Array<{ id: string; name: string }>> {
  const response = await fetch("https://app.ourskylight.com/api/frames", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Skylight-Api-Version": API_VERSION,
    },
  });
  if (!response.ok) {
    return [];
  }
  const body = (await response.json()) as { data: Array<{ id: string; attributes: { name?: string } }> };
  return body.data.map((frame) => ({ id: frame.id, name: frame.attributes.name ?? "unnamed" }));
}

export async function runLogin(): Promise<void> {
  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const authorizeUrl = buildAuthorizeUrl(challenge, state);

  // Skylight only redirects to its own /welcome page, which removes the code from the
  // address bar and browser history at once, so the redirect is read from DevTools.
  console.log(`Sign in to Skylight:

  1. Open a new browser tab and open developer tools (F12, or Cmd+Option+I on a Mac).
  2. In the Network tab, tick "Preserve log" and type "welcome" in the filter box.
  3. In that same tab, open this address and sign in:

     ${authorizeUrl}

  4. Click the "welcome?code=..." request in the Network tab and copy its Request URL
     (or right-click it > Copy > Copy URL).
`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let redirect: string;
  try {
    redirect = await rl.question("Paste the welcome URL (or just the code): ");
  } finally {
    rl.close();
  }

  const code = parseAuthorizationRedirect(redirect, state);
  const tokens = await exchangeAuthorizationCode(code, verifier);
  const tokenFile = getTokenFile();
  saveTokens(tokenFile, tokens);
  console.log(`\nSigned in. Tokens saved to ${tokenFile}`);

  const frames = await listFrames(tokens.accessToken);
  if (frames.length === 1) {
    console.log(`Frame: ${frames[0].id} (${frames[0].name}); the server will use it automatically.`);
  } else if (frames.length > 1) {
    console.log("This account has several frames. Set SKYLIGHT_FRAME_ID to one of:");
    for (const frame of frames) {
      console.log(`  ${frame.id}  ${frame.name}`);
    }
  }
}
