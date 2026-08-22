import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const OPENAPI_URL = "https://cdn.linqapp.com/openapi/linq-api-v3.yaml";
const eventTypesPath = fileURLToPath(
  new URL("../src/linq-event-types.generated.ts", import.meta.url),
);
const checkedInEventTypes = await readFile(eventTypesPath, "utf8");
const expected = readCheckedInEventNames(checkedInEventTypes);
const response = await fetch(OPENAPI_URL);

if (!response.ok) {
  throw new Error(`Failed to fetch canonical Linq OpenAPI: ${response.status}`);
}

const document = YAML.parse(await response.text());
const eventNames = document?.components?.schemas?.WebhookEventType?.enum;

if (!Array.isArray(eventNames)) {
  throw new Error("Canonical OpenAPI has no WebhookEventType enum");
}

const actual = [...eventNames].sort();
const sortedExpected = [...expected].sort();

if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
  const missing = sortedExpected.filter((name) => !actual.includes(name));
  const added = actual.filter((name) => !sortedExpected.includes(name));
  throw new Error(
    `Webhook event inventory drifted. Missing: ${missing.join(", ") || "none"}; added: ${added.join(", ") || "none"}`,
  );
}

const generatedEventTypes = renderEventTypes(eventNames);

if (checkedInEventTypes !== generatedEventTypes) {
  throw new Error(
    "Checked-in Linq event type inventory drifted; regenerate src/linq-event-types.generated.ts",
  );
}

console.log(`Linq OpenAPI webhook event contract matches (${eventNames.length} events).`);

function readCheckedInEventNames(source) {
  const match = /export const LINQ_KNOWN_EVENT_TYPES = \[([\s\S]*?)\] as const;/u.exec(source);

  if (!match) {
    throw new Error("Checked-in Linq event type source has no generated event tuple");
  }

  try {
    const names = JSON.parse(`[${match[1].replace(/,\s*$/u, "")}]`);
    if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
      throw new TypeError("event names must be strings");
    }
    return names;
  } catch (error) {
    throw new Error("Checked-in Linq event type tuple is not valid generated JSON", {
      cause: error,
    });
  }
}

function renderEventTypes(eventNames) {
  const entries = eventNames.map((eventName) => `  ${JSON.stringify(eventName)},`).join("\n");

  return `// Generated from the canonical Linq OpenAPI WebhookEventType enum.
// Run \`pnpm openapi:check\` to verify this checked-in inventory.
export const LINQ_KNOWN_EVENT_TYPES = [
${entries}
] as const;

export type LinqKnownEventType = (typeof LINQ_KNOWN_EVENT_TYPES)[number];
`;
}
