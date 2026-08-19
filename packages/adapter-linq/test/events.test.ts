import { describe, expect, it, vi } from "vitest";

import { LinqEventRegistry } from "../src/events.js";

describe("Linq event registry", () => {
  it("filters single and multiple event registrations", () => {
    const registry = new LinqEventRegistry();
    const delivered = vi.fn();
    const lifecycle = vi.fn();

    registry.subscribe(["message.delivered"], delivered);
    registry.subscribe(["message.read", "message.failed"], lifecycle);

    expect(registry.handlersFor("message.delivered")).toEqual([delivered]);
    expect(registry.handlersFor("message.read")).toEqual([lifecycle]);
    expect(registry.handlersFor("message.failed")).toEqual([lifecycle]);
    expect(registry.handlersFor("chat.created")).toEqual([]);
  });

  it("registers all-event handlers for known and future names", () => {
    const registry = new LinqEventRegistry();
    const all = vi.fn();
    const known = vi.fn();

    registry.subscribe(null, all);
    registry.subscribe(["message.received"], known);

    expect(registry.handlersFor("message.received")).toEqual([all, known]);
    expect(registry.handlersFor("future.provider_event")).toEqual([all]);
  });

  it("deduplicates repeated types within one registration", () => {
    const registry = new LinqEventRegistry();
    const handler = vi.fn();

    registry.subscribe(["message.read", "message.read"], handler);

    expect(registry.handlersFor("message.read")).toEqual([handler]);
  });

  it("unsubscribes idempotently without affecting sibling registrations", () => {
    const registry = new LinqEventRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = registry.subscribe(["message.read", "message.failed"], first);

    registry.subscribe(["message.read"], second);
    unsubscribe();
    unsubscribe();

    expect(registry.handlersFor("message.read")).toEqual([second]);
    expect(registry.handlersFor("message.failed")).toEqual([]);
  });

  it("keeps registries isolated by adapter instance", () => {
    const first = new LinqEventRegistry();
    const second = new LinqEventRegistry();
    const handler = vi.fn();

    first.subscribe(null, handler);

    expect(first.handlersFor("message.sent")).toEqual([handler]);
    expect(second.handlersFor("message.sent")).toEqual([]);
  });

  it("rejects an empty event selection", () => {
    expect(() => new LinqEventRegistry().subscribe([], vi.fn())).toThrow(
      "onLinqEvent requires at least one event type",
    );
  });
});
