import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../smoke-live.mjs", import.meta.url));
const FROM = "+12025550111";
const TO = "+12025550112";

function run(mode: string, env: Record<string, string> = {}, apply = false) {
  return spawnSync(process.execPath, [SCRIPT, mode, ...(apply ? ["--apply"] : [])], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      LINQ_FROM: FROM,
      LINQ_TEST_TO: TO,
      ...env,
    },
  });
}

describe("guarded live smoke CLI", () => {
  it("keeps provider request construction in TypeScript-checked source", () => {
    const source = readFileSync(SCRIPT, "utf8");

    expect(source).not.toContain("@linqapp/sdk");
    expect(source).not.toMatch(/\bsdk\.[A-Za-z]/);
  });

  it("prints a redacted one-text send plan without touching the provider", () => {
    const result = run("send");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"message_count": 1');
    expect(result.stdout).toContain('"provider_mutation": "one outbound text"');
    expect(result.stdout).toContain('"line_selection": "fixed"');
    expect(result.stdout).toContain("No provider operation was performed");
    expect(result.stdout).not.toContain(FROM);
    expect(result.stdout).not.toContain(TO);
  });

  it("rejects apply without the exact confirmation before requiring an API key", () => {
    const result = run("send", {}, true);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"ok":false');
    expect(result.stderr).not.toContain(FROM);
    expect(result.stderr).not.toContain(TO);
  });

  it("rejects a non-E.164 line without echoing it", () => {
    const unsafeLine = "not-a-phone";
    const result = run("send", { LINQ_FROM: unsafeLine });

    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain(unsafeLine);
  });

  it("plans an exact-line ephemeral webhook with cleanup and echo disabled", () => {
    const target = "https://tunnel.example.test/webhooks/linq";
    const result = run("live", {
      LINQ_WEBHOOK_TARGET_URL: target,
      LINQ_LIVE_STATE_FILE: "/tmp/ignored-linq-live.env",
      LINQ_LIVE_RUN_ID: "test-run-0001",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"exact_phone_filter": true');
    expect(result.stdout).toContain('"line_selection": "fixed"');
    expect(result.stdout).toContain('"cleanup": "delete subscription in finally"');
    expect(result.stdout).toContain('"echo": false');
    expect(result.stdout).toContain('"message.received"');
    expect(result.stdout).toContain('"message.sent"');
    expect(result.stdout).not.toContain(FROM);
    expect(result.stdout).not.toContain(TO);
    expect(result.stdout).not.toContain(target);
  });

  it("rejects a non-HTTPS webhook target during planning", () => {
    const target = "http://127.0.0.1:8787/webhooks/linq";
    const result = run("live", {
      LINQ_WEBHOOK_TARGET_URL: target,
      LINQ_LIVE_STATE_FILE: "/tmp/ignored-linq-live.env",
      LINQ_LIVE_RUN_ID: "test-run-0001",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain(target);
  });
});
