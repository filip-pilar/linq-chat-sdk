// Guarded live smoke tooling for the real Linq API.
//
// Every mode is plan-only unless --apply is present. Mutating modes also require
// an exact confirmation phrase. Output contains fingerprints, never raw handles,
// credentials, provider IDs, message content, or target URLs.
//
// Run from packages/adapter-linq after `pnpm build`:
//   node smoke-live.mjs send
//   node smoke-live.mjs send --apply
//   node smoke-live.mjs serve
//   node smoke-live.mjs serve --apply
//   node smoke-live.mjs live
//   node smoke-live.mjs live --apply

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { LinqAPIV3 } from "@linqapp/sdk";
import { createLinqAdapter } from "./dist/index.js";

const CURRENT_WEBHOOK_VERSION = "2026-02-03";
const SEND_CONFIRMATION = "SEND_ONE_REAL_TEXT";
const RECEIVE_CONFIRMATION = "ACCEPT_REAL_WEBHOOKS";
const LIVE_EVENTS = ["message.received", "message.sent"];
const DEFAULT_TEXT = "Linq adapter live smoke test.";
const DEFAULT_PORT = 8787;
const LIVE_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

const mode = process.argv[2];
const apply = process.argv.slice(3).includes("--apply");

function optional(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function need(...names) {
  const value = optional(...names);
  if (!value) throw new Error(`missing required environment setting: ${names.join(" or ")}`);
  return value;
}

function exactPhone(name, value) {
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error(`${name} must be one exact E.164 handle`);
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requireConfirmation(expected) {
  if (process.env.LINQ_LIVE_CONFIRM !== expected) {
    throw new Error(`--apply requires LINQ_LIVE_CONFIRM=${expected}`);
  }
}

function apiConfig() {
  return {
    apiKey: need("LINQ_API_KEY", "LINQ_API_TOKEN"),
    baseURL: optional("LINQ_BASE_URL", "LINQ_API_BASE_URL"),
  };
}

function lineAndRecipient() {
  return {
    from: exactPhone("LINQ_FROM", need("LINQ_FROM", "LINQ_DEVELOPMENT_LINE")),
    to: exactPhone("LINQ_TEST_TO", need("LINQ_TEST_TO")),
  };
}

function webhookTarget() {
  const target = new URL(need("LINQ_WEBHOOK_TARGET_URL"));
  const runID = need("LINQ_LIVE_RUN_ID");
  if (target.protocol !== "https:") {
    throw new Error("LINQ_WEBHOOK_TARGET_URL must use HTTPS");
  }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(runID)) {
    throw new Error("LINQ_LIVE_RUN_ID must contain 8-64 safe identifier characters");
  }
  target.searchParams.set("version", CURRENT_WEBHOOK_VERSION);
  target.searchParams.set("smoke_run", runID);
  return target;
}

function port() {
  const value = Number(optional("PORT") ?? DEFAULT_PORT);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535");
  }
  return value;
}

function printPlan(plan) {
  console.log(JSON.stringify({ apply: false, ...plan }, null, 2));
  console.log(
    "No provider operation was performed. Re-run with --apply and the displayed confirmation.",
  );
}

function safeFailure(error) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    status: typeof error?.status === "number" ? error.status : undefined,
    code:
      typeof error?.code === "number" || typeof error?.code === "string" ? error.code : undefined,
  };
}

async function send() {
  const { from, to } = lineAndRecipient();
  const text = optional("LINQ_TEST_TEXT") ?? DEFAULT_TEXT;
  const plan = {
    mode: "send",
    provider_mutation: "one outbound text",
    message_count: 1,
    line_fp: fingerprint(from),
    recipient_fp: fingerprint(to),
    text_fp: fingerprint(text),
    confirmation: SEND_CONFIRMATION,
  };
  if (!apply) return printPlan(plan);

  requireConfirmation(SEND_CONFIRMATION);
  const sdk = new LinqAPIV3(apiConfig());
  const result = await sdk.messages.create({
    from,
    to: [to],
    message: { parts: [{ type: "text", value: text }] },
  });
  console.log(
    JSON.stringify({
      ok: true,
      mode: "send",
      message_count: 1,
      message_fp: fingerprint(result.message.id),
      chat_fp: fingerprint(result.chat_id),
    }),
  );
}

function attachChat(adapter) {
  adapter.chat = {
    processMessage: async (_adapter, threadId, factory) => {
      const message = await factory();
      console.log(
        JSON.stringify({
          delivery: "message",
          thread_fp: fingerprint(threadId),
          message_fp: fingerprint(message.id),
          attachments: message.attachments?.length ?? 0,
        }),
      );
    },
    processReaction: (reaction) => {
      console.log(
        JSON.stringify({
          delivery: "reaction",
          message_fp: fingerprint(reaction.messageId),
          added: reaction.added,
        }),
      );
    },
  };
}

function requestHandler(getAdapter, receiverPort, delivery) {
  return async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200);
      response.end("ok");
      return;
    }

    const adapter = getAdapter();
    if (!adapter) {
      response.writeHead(503);
      response.end("receiver not ready");
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }

    let eventType = "unknown";
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (typeof parsed?.event_type === "string") eventType = parsed.event_type;
    } catch {
      // The adapter owns the typed malformed-body response.
    }

    const result = await adapter.handleWebhook(
      new Request(`http://127.0.0.1:${receiverPort}${request.url}`, {
        method: "POST",
        headers,
        body: raw,
      }),
    );
    const responseText = await result.text();
    console.log(JSON.stringify({ delivery: eventType, status: result.status }));
    if (result.status === 200) delivery?.(eventType);
    response.writeHead(result.status, { "content-type": "text/plain" });
    response.end(responseText);
  };
}

function waitForSignal() {
  return new Promise((resolveSignal) => {
    const stop = (signal) => resolveSignal(signal);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function listen(server, receiverPort) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(receiverPort, "127.0.0.1", resolveListen);
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function serve() {
  const receiverPort = port();
  const plan = {
    mode: "serve",
    provider_mutation: "none",
    receiver_port: receiverPort,
    echo: false,
    confirmation: RECEIVE_CONFIRMATION,
  };
  if (!apply) return printPlan(plan);

  requireConfirmation(RECEIVE_CONFIRMATION);
  const signingSecret = need("LINQ_SIGNING_SECRET", "LINQ_WEBHOOK_SIGNING_SECRET");
  const adapter = createLinqAdapter({ ...apiConfig(), signingSecret });
  attachChat(adapter);
  const server = createServer(requestHandler(() => adapter, receiverPort));

  try {
    await listen(server, receiverPort);
    console.log(
      JSON.stringify({ ready: true, mode: "serve", receiver_port: receiverPort, echo: false }),
    );
    await waitForSignal();
  } finally {
    await close(server);
    console.log(JSON.stringify({ cleaned_up: true, resource: "local receiver" }));
  }
}

async function updateLiveState(path, values) {
  const absolutePath = resolve(path);
  const existing = await readFile(absolutePath, "utf8");
  const replacements = new Map(Object.entries(values));
  const found = new Set();
  const lines = existing.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !replacements.has(match[1])) return line;
    found.add(match[1]);
    return `${match[1]}=${replacements.get(match[1])}`;
  });
  for (const [name, value] of replacements) {
    if (!found.has(name)) lines.push(`${name}=${value}`);
  }

  const temporary = `${absolutePath}.${process.pid}.tmp`;
  await writeFile(temporary, lines.join("\n"), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, absolutePath);
  await chmod(absolutePath, 0o600);
}

async function requirePrivateIgnoredStateFile(path) {
  const absolutePath = resolve(path);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("LINQ_LIVE_STATE_FILE must be a regular mode-0600 private file");
  }
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", absolutePath]);
  } catch {
    throw new Error("LINQ_LIVE_STATE_FILE must be ignored by this Git repository");
  }
}

async function live() {
  const { from, to } = lineAndRecipient();
  const receiverPort = port();
  const target = webhookTarget();
  const text = optional("LINQ_TEST_TEXT") ?? DEFAULT_TEXT;
  const stateFile = need("LINQ_LIVE_STATE_FILE");
  const plan = {
    mode: "live",
    provider_mutation: "ephemeral filtered subscription plus one outbound text",
    message_count: 1,
    line_fp: fingerprint(from),
    recipient_fp: fingerprint(to),
    target_fp: fingerprint(target.toString()),
    exact_phone_filter: true,
    events: LIVE_EVENTS,
    webhook_version: CURRENT_WEBHOOK_VERSION,
    echo: false,
    cleanup: "delete subscription in finally",
    confirmation: SEND_CONFIRMATION,
  };
  if (!apply) return printPlan(plan);

  requireConfirmation(SEND_CONFIRMATION);
  await requirePrivateIgnoredStateFile(stateFile);
  const sdk = new LinqAPIV3(apiConfig());
  let adapter;
  let subscription;
  let subscriptionDeleted = false;
  let stateCleared = false;
  let resolveDelivery;
  const deliveryPromise = new Promise((resolveSeen) => {
    resolveDelivery = resolveSeen;
  });
  const server = createServer(
    requestHandler(
      () => adapter,
      receiverPort,
      (eventType) => {
        if (eventType === "message.sent") resolveDelivery(eventType);
      },
    ),
  );

  try {
    await listen(server, receiverPort);
    subscription = await sdk.webhookSubscriptions.create({
      target_url: target.toString(),
      subscribed_events: LIVE_EVENTS,
      phone_numbers: [from],
    });
    await updateLiveState(stateFile, {
      LINQ_WEBHOOK_SUBSCRIPTION_ID: subscription.id,
      LINQ_WEBHOOK_SIGNING_SECRET: subscription.signing_secret,
      LINQ_WEBHOOK_TARGET_URL: target.toString(),
    });
    adapter = createLinqAdapter({ ...apiConfig(), signingSecret: subscription.signing_secret });
    attachChat(adapter);

    await sdk.messages.create({
      from,
      to: [to],
      message: { parts: [{ type: "text", value: text }] },
    });
    console.log(JSON.stringify({ sent: true, message_count: 1, waiting_for: "message.sent" }));

    const outcome = await Promise.race([
      deliveryPromise,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), LIVE_TIMEOUT_MS)),
      waitForSignal(),
    ]);
    if (outcome !== "message.sent") {
      throw new Error("no verified message.sent delivery arrived before stop/timeout");
    }
    console.log(JSON.stringify({ verified_provider_delivery: true, event: outcome }));
  } finally {
    if (subscription) {
      try {
        await sdk.webhookSubscriptions.delete(subscription.id);
        subscriptionDeleted = true;
        await updateLiveState(stateFile, {
          LINQ_WEBHOOK_SUBSCRIPTION_ID: "",
          LINQ_WEBHOOK_SIGNING_SECRET: "",
          LINQ_WEBHOOK_TARGET_URL: "",
        });
        stateCleared = true;
      } catch (error) {
        console.error(JSON.stringify({ cleanup_failed: true, ...safeFailure(error) }));
      }
    }
    await close(server);
    console.log(
      JSON.stringify({
        subscription_deleted: subscriptionDeleted,
        private_state_cleared: stateCleared,
        subscription_created: Boolean(subscription),
        local_receiver_closed: true,
      }),
    );
  }

  if (subscription && !subscriptionDeleted) {
    throw new Error("subscription cleanup failed; private state file retains recovery identifiers");
  }
  if (subscription && !stateCleared) {
    throw new Error("subscription was deleted but the private state file could not be cleared");
  }
}

try {
  if (mode === "send") await send();
  else if (mode === "serve") await serve();
  else if (mode === "live") await live();
  else throw new Error("usage: node smoke-live.mjs <send|serve|live> [--apply]");
} catch (error) {
  console.error(JSON.stringify({ ok: false, ...safeFailure(error) }));
  if (error instanceof Error && error.message.startsWith("usage:")) console.error(error.message);
  process.exitCode = 2;
}
