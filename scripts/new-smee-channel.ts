// Provision a fresh smee.io channel for local webhook delivery.
//
// Run with `pnpm smee:new`. The printed URL is the public endpoint smee.io
// hands you; point both your GitHub App's webhook URL and the local
// WEBHOOK_PROXY_URL at it. When WEBHOOK_PROXY_URL is set, `pnpm start` connects
// the smee client automatically (Probot's built-in webhook proxy) and forwards
// every delivery to the local server.
import { SmeeClient } from "smee-client";

const channel = await SmeeClient.createChannel();

console.log(`
Created a new smee.io channel:

  ${channel}

Next steps:
  1. Add it to .env:

       WEBHOOK_PROXY_URL=${channel}

  2. Set the GitHub App's webhook URL (Settings → Advanced, or the
     manifest registration flow) to the same URL.

  3. Run \`pnpm start\` — Probot connects the smee client and forwards
     deliveries to http://localhost:3000/api/github/webhooks.
`);
