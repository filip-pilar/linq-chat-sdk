import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const inventoryPath = fileURLToPath(new URL("../openapi-inventory.json", import.meta.url));
const eventTypesPath = fileURLToPath(
  new URL("../src/linq-event-types.generated.ts", import.meta.url),
);
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
const response = await fetch(inventory.source);

if (!response.ok) {
  throw new Error(`Failed to fetch canonical Linq OpenAPI: ${response.status}`);
}

const document = YAML.parse(await response.text());
const eventNames = document?.components?.schemas?.WebhookEventType?.enum;

if (!Array.isArray(eventNames)) {
  throw new Error("Canonical OpenAPI has no WebhookEventType enum");
}

const actual = [...eventNames].sort();
const expected = [...inventory.eventNames].sort();

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  const missing = expected.filter((name) => !actual.includes(name));
  const added = actual.filter((name) => !expected.includes(name));
  throw new Error(
    `Webhook event inventory drifted. Missing: ${missing.join(", ") || "none"}; added: ${added.join(", ") || "none"}`,
  );
}

const checkedInEventTypes = await readFile(eventTypesPath, "utf8");
const generatedEventTypes = renderEventTypes(eventNames);

if (checkedInEventTypes !== generatedEventTypes) {
  throw new Error(
    "Checked-in Linq event type inventory drifted; regenerate src/linq-event-types.generated.ts",
  );
}

console.log(`Linq OpenAPI webhook event contract matches (${eventNames.length} events).`);

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
