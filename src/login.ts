/**
 * `skylight-mcp login`
 * Signs in through Skylight's own OAuth page and saves tokens for the server.
 */

/* eslint-disable no-console -- interactive CLI; output goes to the user's terminal, not MCP stdio */

import { spawn } from "node:child_process";
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
 * Best-effort attempt to open a URL in the default browser
 */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // The URL is printed anyway
    });
    child.unref();
  } catch {
    // The URL is printed anyway
  }
}

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

  console.log("Sign in to Skylight in your browser:\n");
  console.log(`  ${authorizeUrl}\n`);
  console.log("After signing in, the browser lands on an ourskylight.com/welcome address.");
  console.log("Copy that full address from the address bar and paste it below.\n");
  openBrowser(authorizeUrl);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let redirect: string;
  try {
    redirect = await rl.question("Address: ");
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
