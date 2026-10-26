#!/usr/bin/env node

import { runLogin } from "./login.js";
import { createServer } from "./server.js";

async function main() {
  if (process.argv[2] === "login") {
    await runLogin();
    return;
  }

  const server = await createServer();
  await server.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
