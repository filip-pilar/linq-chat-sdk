// Live smoke test against the REAL Linq API, through the real adapter.
// Whatever lands on your phone is exactly what ships.
//
//   send   — bootstrap a chat (or reuse one) and send text + two images
//   cards  — send Chat SDK cards (incl. the image+buttons card that used to vanish)
//   serve  — receive real webhooks (text/reactions) and optionally echo-reply
//   verify — sign a delivery with a REAL Linq signing secret and run it through
//            the adapter. Sends no messages, so it needs no phone and no tunnel.
//   opendm — openDM() a handle with no existing chat, then post to it
//   live   — register a webhook at a public tunnel, send a message to trigger a
//            real delivery from Linq, and verify the signature Linq's server
//            produced. The only check that exercises the network path.
//
// Run from packages/adapter-linq so deps + ./dist resolve.
//
//   pnpm build   # make sure dist is current
//
//   LINQ_API_KEY=...  LINQ_FROM=+1...  LINQ_TEST_TO=+1<your phone> \
//   [LINQ_BASE_URL=https://sandbox...] node smoke-live.mjs send
//
//   LINQ_API_KEY=...  LINQ_SIGNING_SECRET=...  LINQ_ECHO=1 \
//   [PORT=8787] node smoke-live.mjs serve     # then tunnel + register webhook

import { createServer } from "node:http";
import { Buffer } from "node:buffer";

import { LinqAPIV3 } from "@linqapp/sdk";
import { Webhook } from "standardwebhooks";
import {
  Actions,
  Button,
  Card,
  CardLink,
  CardText,
  Divider,
  Field,
  Fields,
  Image,
  LinkButton,
} from "chat";
import { createLinqAdapter } from "./dist/index.js";

const API_KEY = need("LINQ_API_KEY");
const BASE_URL = process.env.LINQ_BASE_URL || undefined;
// Real 1x1 PNG so Linq's content validation passes on the pre-upload path.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const IMAGE_URL =
  process.env.LINQ_TEST_IMAGE_URL ||
  "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/120px-Cat03.jpg";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

function adapter(signingSecret = "unused-for-outbound") {
  return createLinqAdapter({ apiKey: API_KEY, baseURL: BASE_URL, signingSecret });
}

async function step(label, fn) {
  process.stdout.write(`  … ${label}`);
  try {
    const out = await fn();
    console.log(`\r  ✓ ${label}${out ? ` — ${out}` : ""}`);
    return true;
  } catch (err) {
    const status = err?.status ? ` [${err.status}]` : "";
    const body = err?.error ? ` ${JSON.stringify(err.error)}` : ` ${err?.message ?? err}`;
    console.log(`\r  ✗ ${label}${status}${body}`);
    return false;
  }
}

async function bootstrapChat(firstMessage) {
  let chatId = process.env.LINQ_TEST_CHAT_ID;

  if (!chatId) {
    const from = need("LINQ_FROM");
    const to = need("LINQ_TEST_TO");
    const sdk = new LinqAPIV3({ apiKey: API_KEY, baseURL: BASE_URL });
    console.log(`bootstrapping a chat ${from} → ${to} …`);
    const created = await sdk.chats.create({
      from,
      to: [to],
      message: { parts: [{ type: "text", value: firstMessage }] },
    });
    chatId = created.chat.id;
    console.log(`chat id: ${chatId}\n`);
  } else {
    console.log(`reusing chat ${chatId}\n`);
  }

  return chatId;
}

async function send() {
  const a = adapter();
  const chatId = await bootstrapChat("linq adapter smoke test 👋 (1/4)");
  const threadId = `linq:${chatId}`;
  console.log("sending through the adapter — watch your phone:");

  let ok = true;
  ok &= await step("2/4 outbound text", async () => {
    const r = await a.postMessage(threadId, "outbound text via the adapter ✅ (2/4)");
    return `msg ${r.id}`;
  });
  ok &= await step("3/4 image by public URL", async () => {
    const r = await a.postMessage(threadId, {
      markdown: "image by url (3/4)",
      attachments: [{ type: "image", url: IMAGE_URL, mimeType: "image/jpeg" }],
    });
    return `msg ${r.id}`;
  });
  ok &= await step("4/4 image by bytes (real /attachments pre-upload + PUT)", async () => {
    const r = await a.postMessage(threadId, {
      markdown: "image by bytes (4/4)",
      files: [{ filename: "smoke.png", mimeType: "image/png", data: PNG_1x1 }],
    });
    return `msg ${r.id}`;
  });

  console.log(
    ok
      ? "\nall sends accepted by Linq. confirm all 4 messages + both images arrived on the device."
      : "\nsomething was rejected — the error above is the real Linq response. that's the bug to fix before Wed.",
  );
  process.exit(ok ? 0 : 1);
}

// The card payloads below are exactly what chat-core hands the adapter after
// thread.post(<Card …/>) — JSX is flattened to these CardElement objects by
// toCardElement() before postMessage() runs.
async function cards() {
  const a = adapter();
  const chatId = await bootstrapChat("linq adapter card smoke test 🃏 (1/4)");
  const threadId = `linq:${chatId}`;
  console.log("sending cards through the adapter — watch your phone:");

  let ok = true;
  ok &= await step("2/4 full text card (title/fields/link/divider/buttons)", async () => {
    const r = await a.postMessage(
      threadId,
      Card({
        title: "Order #1234 (2/4)",
        subtitle: "Placed today",
        children: [
          CardText("Your order has been **received**! _No literal asterisks should show._"),
          Fields([Field({ label: "Name", value: "Eve" }), Field({ label: "Total", value: "$42" })]),
          CardLink({ url: "https://chat-sdk.dev/docs/cards", label: "View order" }),
          Divider(),
          Actions([
            Button({ id: "approve", label: "Approve", style: "primary" }),
            Button({ id: "reject", label: "Reject", style: "danger" }),
            LinkButton({ url: "https://linqapp.com", label: "Get help" }),
          ]),
        ],
      }),
    );
    return `msg ${r.id}`;
  });
  ok &= await step("3/4 card with an image element", async () => {
    const r = await a.postMessage(
      threadId,
      Card({
        title: "Card with image (3/4)",
        children: [
          CardText("This card should arrive as text + a real image attachment."),
          Image({ url: IMAGE_URL, alt: "cat" }),
        ],
      }),
    );
    return `msg ${r.id}`;
  });
  ok &= await step("4/4 regression: image + buttons only (used to vanish)", async () => {
    const r = await a.postMessage(
      threadId,
      Card({
        children: [
          Image({ url: IMAGE_URL, alt: "cat" }),
          Actions([Button({ id: "yes", label: "Yes" }), Button({ id: "no", label: "No" })]),
        ],
      }),
    );
    return `msg ${r.id}`;
  });

  console.log(
    ok
      ? "\nall card sends accepted by Linq. on the device, check: (2/4) one clean text bubble with no ** or dropped links, (3/4) text + image, (4/4) 'Options: Yes, No' + image."
      : "\na card send was rejected — the error above is the real Linq response.",
  );
  process.exit(ok ? 0 : 1);
}

async function serve() {
  const signingSecret = need("LINQ_SIGNING_SECRET");
  const a = adapter(signingSecret);
  const echo = process.env.LINQ_ECHO === "1";
  const port = Number(process.env.PORT || 8787);

  // Minimal stand-in for ChatInstance: log what the adapter dispatches, and
  // (optionally) reply so you get a real round-trip on the device.
  a.chat = {
    processMessage: async (_adapter, threadId, factory) => {
      const msg = await factory();
      console.log(
        `\n📩 inbound message  thread=${threadId}  from=${msg.author?.userName}  text=${JSON.stringify(msg.text)}  attachments=${msg.attachments?.length ?? 0}`,
      );
      if (echo && msg.text) {
        await a
          .postMessage(threadId, `echo: ${msg.text}`)
          .then((r) => console.log(`   ↪︎ replied msg ${r.id}`))
          .catch((e) => console.log(`   ↪︎ reply failed: ${e?.message ?? e}`));
      }
    },
    processReaction: (payload) => {
      console.log(
        `\n👍 inbound reaction  ${payload.added ? "added" : "removed"}  ${payload.emoji?.name}  on msg=${payload.messageId}`,
      );
    },
  };

  createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: "POST",
      headers,
      body: raw,
    });
    const response = await a.handleWebhook(request);
    if (response.status !== 200) {
      console.log(`⚠️  webhook rejected: ${response.status} ${await response.text()}`);
    }
    res.writeHead(response.status);
    res.end(await response.text().catch(() => ""));
  }).listen(port, () => {
    console.log(`webhook receiver on http://localhost:${port}`);
    console.log("now expose it and register the webhook:");
    console.log(`  1. tunnel:   cloudflared tunnel --url http://localhost:${port}`);
    console.log("                (or: ngrok http " + port + ")");
    console.log("  2. register the https tunnel URL as a Linq webhook subscription");
    console.log("     events: message.received, reaction.added, reaction.removed");
    console.log(
      "  3. text the sandbox number from your phone — watch this log" + (echo ? " (echo on)" : ""),
    );
  });
}

// Verifies the signing path against a secret Linq actually issued, rather than
// one a test invented. Creates a throwaway subscription, signs a synthetic
// delivery with its secret, runs it through the real adapter, and deletes the
// subscription. No messages are sent.
async function verify() {
  const sdk = new LinqAPIV3({ apiKey: API_KEY, baseURL: BASE_URL });
  const targetUrl =
    process.env.LINQ_PROBE_URL || `https://example.com/linq-adapter-verify-${Date.now()}`;

  console.log("creating a throwaway webhook subscription …");
  const sub = await sdk.webhookSubscriptions.create({
    subscribed_events: ["message.received"],
    target_url: targetUrl,
  });
  console.log(`subscription ${sub.id}\n`);

  let failures = 0;
  try {
    const secret = sub.signing_secret;
    const body = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    const keyBytes = Buffer.from(body, "base64").length;

    if (!(await step(`secret is whsec_ + base64 of ${keyBytes} bytes`, async () => {
      if (!secret.startsWith("whsec_")) throw new Error("no whsec_ prefix");
      if (keyBytes !== 32) throw new Error(`expected a 32-byte key, got ${keyBytes}`);
      return "matches Standard Webhooks";
    }))) failures += 1;

    const a = adapter(secret);
    let dispatched = null;
    a.chat = {
      processMessage: async (_adapter, threadId, factory) => {
        const msg = await factory();
        dispatched = { threadId, text: msg.text };
      },
      processReaction: () => {},
    };

    const payload = JSON.stringify(deliveryFixture());

    if (!(await step("a correctly signed delivery verifies and dispatches", async () => {
      dispatched = null;
      const res = await a.handleWebhook(signedDelivery(secret, payload));
      if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
      // Give the adapter's dispatch a turn to run.
      await new Promise((r) => setTimeout(r, 50));
      if (!dispatched) throw new Error("verified, but nothing reached the Chat SDK handler");
      return `thread=${dispatched.threadId} text=${JSON.stringify(dispatched.text)}`;
    }))) failures += 1;

    if (!(await step("a tampered body is rejected", async () => {
      const req = signedDelivery(secret, payload);
      const tampered = new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: payload.replace("hello from the smoke test", "tampered"),
      });
      const res = await a.handleWebhook(tampered);
      if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
      return "401";
    }))) failures += 1;

    if (!(await step("a delivery signed with a different secret is rejected", async () => {
      const other = "whsec_" + Buffer.from("0".repeat(32)).toString("base64");
      const res = await a.handleWebhook(signedDelivery(other, payload));
      if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
      return "401";
    }))) failures += 1;

    if (!(await step("the deprecated X-Webhook-* scheme no longer verifies", async () => {
      const req = new Request("https://example.com/webhooks/linq", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
          "x-webhook-signature": "sha256=deadbeef",
        },
        body: payload,
      });
      const res = await a.handleWebhook(req);
      if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
      return "401 as intended";
    }))) failures += 1;
  } finally {
    await sdk.webhookSubscriptions.delete(sub.id);
    console.log(`\ncleaned up subscription ${sub.id}`);
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nsigning path verified against a real Linq secret ✓");
}

function signedDelivery(secret, payload) {
  const messageId = "msg_smoke_1";
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(messageId, timestamp, payload);

  return new Request("https://example.com/webhooks/linq", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
      "webhook-signature": signature,
    },
    body: payload,
  });
}

function deliveryFixture() {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: "smoke-" + Date.now(),
    created_at: new Date().toISOString(),
    trace_id: "smoke-trace",
    partner_id: "smoke-partner",
    data: {
      id: "smoke-message-id",
      direction: "inbound",
      chat: { id: "00000000-0000-4000-8000-000000000000", is_group: false },
      sender_handle: { handle: "+12025550147", service: "iMessage" },
      service: "iMessage",
      parts: [{ type: "text", value: "hello from the smoke test" }],
      sent_at: new Date().toISOString(),
    },
  };
}

// Proves the proactive path: address a handle with no existing chat, then post.
async function opendm() {
  const to = need("LINQ_TEST_TO");
  const a = adapter();

  const threadId = await a.openDM(to);
  console.log(`openDM(${to}) → ${threadId}`);

  if (threadId !== `linq:pending:${to}`) {
    console.error(`unexpected pending thread ID: ${threadId}`);
    process.exit(1);
  }

  console.log("posting to the pending thread — watch your phone:");
  let realThreadId = null;
  const ok = await step("first post creates the chat", async () => {
    const sent = await a.postMessage(threadId, "linq openDM smoke test 👋 — this chat did not exist a second ago");
    realThreadId = sent.threadId;
    if (!/^linq:[0-9a-f-]{36}$/.test(sent.threadId)) {
      throw new Error(`expected a real chat thread ID, got ${sent.threadId}`);
    }
    return sent.threadId;
  });

  if (!ok) process.exit(1);

  await step("a second post reuses that chat rather than forking one", async () => {
    const again = await a.postMessage(threadId, "…and this one reused it");
    if (again.threadId !== realThreadId) {
      throw new Error(`forked a second chat: ${again.threadId} != ${realThreadId}`);
    }
    return again.threadId;
  });

  await step("operations needing a chat fail clearly on a pending thread", async () => {
    await a
      .openDM("+19999999999")
      .then((pending) => a.fetchMessages(pending))
      .then(
        () => {
          throw new Error("expected a throw");
        },
        (err) => {
          if (!/has no chat yet/.test(err.message)) throw err;
        },
      );
    return "throws with the remedy";
  });

  console.log(`\nopenDM verified — chat ${realThreadId}`);
}

// The strongest signing check available: verify a webhook Linq's own server
// produced and delivered over the network. `verify` signs its own payload with
// a real secret, which cannot catch a divergence between Linq's server-side
// signing and the standardwebhooks library. This can.
//
//   cloudflared tunnel --url http://localhost:8787
//   LINQ_API_KEY=... TUNNEL_URL=https://<id>.trycloudflare.com \
//     LINQ_TEST_TO=+1... node smoke-live.mjs live
async function live() {
  const tunnel = need("TUNNEL_URL");
  const to = need("LINQ_TEST_TO");
  const port = Number(process.env.PORT || 8787);
  const sdk = new LinqAPIV3({ apiKey: API_KEY, baseURL: BASE_URL });
  const targetUrl = `${tunnel}/webhooks/linq?version=2026-02-03`;

  console.log(`registering webhook → ${targetUrl}`);
  const sub = await sdk.webhookSubscriptions.create({
    subscribed_events: ["message.sent", "message.received"],
    target_url: targetUrl,
  });
  console.log(`subscription ${sub.id}\n`);

  const a = adapter(sub.signing_secret);
  a.chat = {
    processMessage: async (_adapter, threadId, factory) => {
      const msg = await factory();
      console.log(`   ↳ dispatched: thread=${threadId} text=${JSON.stringify(msg.text)}`);
    },
    processReaction: () => {},
  };

  const seen = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
    }

    const standard = ["webhook-id", "webhook-timestamp", "webhook-signature"].filter((h) =>
      headers.has(h),
    );
    const legacy = [...headers.keys()].filter((k) => k.startsWith("x-webhook-"));
    const eventType = JSON.parse(raw.toString()).event_type;

    const result = await a.handleWebhook(
      new Request(`http://localhost:${port}${req.url}`, { method: "POST", headers, body: raw }),
    );

    console.log(`📨 real delivery: ${eventType}`);
    console.log(`   standard-webhooks headers: [${standard.join(", ")}]`);
    console.log(`   legacy headers also sent:  [${legacy.join(", ")}]`);
    console.log(
      `   verification → HTTP ${result.status} ${result.status === 200 ? "✓" : "✗ REJECTED"}`,
    );
    seen.push(result.status);

    res.writeHead(result.status);
    res.end("ok");
  });

  await new Promise((r) => server.listen(port, r));
  await new Promise((r) => setTimeout(r, 4000));

  console.log(`sending a message to ${to} to trigger a delivery …`);
  const sent = await sdk.messages.create({
    to: [to],
    message: { parts: [{ type: "text", value: "linq adapter live webhook check" }] },
  });
  console.log(`sent ${sent.message.id} in chat ${sent.chat_id}\n`);
  console.log("waiting up to 60s for Linq to deliver …");

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && seen.length === 0) {
    await new Promise((r) => setTimeout(r, 1000));
  }

  await sdk.webhookSubscriptions.delete(sub.id);
  console.log(`\ncleaned up subscription ${sub.id}`);
  server.close();

  if (seen.length === 0) {
    console.error("\nno delivery arrived within 60s — inconclusive");
    process.exit(1);
  }
  const verified = seen.filter((s) => s === 200).length;
  console.log(`\n${verified}/${seen.length} real Linq deliveries verified`);
  if (verified !== seen.length) process.exit(1);
}

const mode = process.argv[2];
if (mode === "send") await send();
else if (mode === "cards") await cards();
else if (mode === "serve") await serve();
else if (mode === "verify") await verify();
else if (mode === "opendm") await opendm();
else if (mode === "live") await live();
else {
  console.error("usage: node smoke-live.mjs <send|cards|serve|verify|opendm|live>");
  process.exit(2);
}
