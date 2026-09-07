import { describe, expect, it } from "vitest";
import { createUpdateDraftRegistry, decodeUpdateDraft, discardUpdateDraft, readUpdateDraft, updateDraftStorageKey, writeUpdateDraft, type DraftStorage } from "./update-drafts";

const scope = { userId: "user-1", environment: "accounting-dev" };
const savedAt = "2026-09-07T12:00:00.000Z";
function memoryStorage() {
  const rows = new Map<string, string>();
  return { rows, getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
}

describe("update-only tab-local recovery storage", () => {
  it("round-trips names, numbers, source revisions, false, null and undefined", () => {
    const storage = memoryStorage();
    const entries = [
      { key: "common.casts.editing", value: { name: "未保存の花子", updatedAt: "original-revision", hourlyRates: { "2026-09": 3200 } } },
      { key: "number", value: 0 }, { key: "false", value: false }, { key: "null", value: null }, { key: "undefined", value: undefined },
    ];
    writeUpdateDraft(storage, scope, "common-casts", entries, savedAt);
    expect(readUpdateDraft(storage, scope)).toEqual({ format: "gms-update-drafts", schema: 1, ...scope, view: "common-casts", savedAt, entries: entries.map((entry) => entry.value === undefined ? { key: entry.key } : entry) });
  });

  it("separates users and production/development; scope strings cannot collide", () => {
    const storage = memoryStorage();
    writeUpdateDraft(storage, scope, "common-casts", [], savedAt);
    expect(readUpdateDraft(storage, { ...scope, userId: "other-user" })).toBeNull();
    expect(readUpdateDraft(storage, { ...scope, environment: "accounting" })).toBeNull();
    expect(updateDraftStorageKey({ userId: "c", environment: "a:b" })).not.toEqual(updateDraftStorageKey({ userId: "b:c", environment: "a" }));
  });

  it("preserves corrupt storage and rejects it without returning partial inputs", () => {
    const storage = memoryStorage();
    storage.setItem(updateDraftStorageKey(scope), "{broken");
    expect(() => readUpdateDraft(storage, scope)).toThrow("破損");
    expect(storage.getItem(updateDraftStorageKey(scope))).toBe("{broken");
  });

  it("rejects unknown schemas and preserves their bytes", () => {
    const storage = memoryStorage();
    const draft = writeUpdateDraft(storage, scope, "common-casts", [], savedAt);
    const raw = JSON.stringify({ ...draft, schema: 999 });
    storage.setItem(updateDraftStorageKey(scope), raw);
    expect(() => readUpdateDraft(storage, scope)).toThrow("対応していません");
    expect(storage.getItem(updateDraftStorageKey(scope))).toBe(raw);
  });

  it("rejects another user's payload even if copied under the active scope's key", () => {
    const storage = memoryStorage();
    const draft = writeUpdateDraft(storage, scope, "common-casts", [], savedAt);
    expect(() => decodeUpdateDraft(JSON.stringify({ ...draft, userId: "other-user" }), scope)).toThrow("一致しません");
  });

  it.each([
    { view: "" }, { savedAt: "broken" }, { entries: null },
    { entries: [{ key: "same", value: 1 }, { key: "same", value: 2 }] },
    { entries: [{ key: 1 }] },
  ])("rejects invalid metadata/duplicate keys (%j)", (change) => {
    const storage = memoryStorage();
    const draft = writeUpdateDraft(storage, scope, "common-casts", [], savedAt);
    expect(() => decodeUpdateDraft(JSON.stringify({ ...draft, ...change }), scope)).toThrow();
  });

  it("quota failures preserve the preceding backup and report that reload must stop", () => {
    const storage = memoryStorage();
    writeUpdateDraft(storage, scope, "common-casts", [{ key: "before", value: 1 }], savedAt);
    const raw = storage.getItem(updateDraftStorageKey(scope));
    const full: DraftStorage = { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(() => writeUpdateDraft(full, scope, "common-casts", [{ key: "after", value: 2 }], savedAt)).toThrow("画面を更新せず");
    expect(storage.getItem(updateDraftStorageKey(scope))).toBe(raw);
  });

  it("rejects silent writes and readback failures before permitting reload", () => {
    const ignored: DraftStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    expect(() => writeUpdateDraft(ignored, scope, "common-casts", [{ key: "input", value: "keep in memory" }], savedAt)).toThrow("画面を更新せず");
    const unreadable: DraftStorage = { ...ignored, getItem: () => { throw new Error("SecurityError"); } };
    expect(() => writeUpdateDraft(unreadable, scope, "common-casts", [], savedAt)).toThrow("画面を更新せず");
  });

  it.each([NaN, Infinity, () => undefined, Symbol("x"), BigInt(1)])("rejects lossy/non-JSON values (%s)", (value) => {
    const storage = memoryStorage();
    expect(() => writeUpdateDraft(storage, scope, "common-casts", [{ key: "input", value }], savedAt)).toThrow("安全に退避");
    expect(storage.rows.size).toBe(0);
  });

  it("rejects circular values without changing existing storage", () => {
    const storage = memoryStorage();
    const circular: { value?: unknown } = {};
    circular.value = circular;
    expect(() => writeUpdateDraft(storage, scope, "common-casts", [{ key: "input", value: circular }], savedAt)).toThrow("安全に退避");
    expect(storage.rows.size).toBe(0);
  });

  it("only discards the requested user's environment", () => {
    const storage = memoryStorage();
    const otherScope = { ...scope, environment: "accounting" };
    writeUpdateDraft(storage, scope, "common-casts", [], savedAt);
    writeUpdateDraft(storage, otherScope, "common-casts", [], savedAt);
    discardUpdateDraft(storage, scope);
    expect(readUpdateDraft(storage, scope)).toBeNull();
    expect(readUpdateDraft(storage, otherScope)).not.toBeNull();
  });

  it("reports blocked storage access without silently losing recovery", () => {
    const storage: DraftStorage = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => undefined, removeItem: () => { throw new Error("SecurityError"); } };
    expect(() => readUpdateDraft(storage, scope)).toThrow("画面を更新せず");
    expect(() => discardUpdateDraft(storage, scope)).toThrow("削除できません");
  });
});

describe("recovery registry", () => {
  it("reads latest state and drops unmounted/abandoned forms", () => {
    const registry = createUpdateDraftRegistry();
    let value = "before";
    const unmount = registry.register("editing", () => value);
    value = "latest";
    expect(registry.capture()).toEqual([{ key: "editing", value: "latest" }]);
    unmount();
    expect(registry.capture()).toEqual([]);
  });

  it("does not consume restoration during repeated React initializers", () => {
    const registry = createUpdateDraftRegistry();
    registry.prepare([{ key: "editing", value: { revision: 7 } }, { key: "empty" }]);
    expect(registry.peek("editing")).toEqual({ found: true, value: { revision: 7 } });
    expect(registry.peek("editing")).toEqual({ found: true, value: { revision: 7 } });
    expect(registry.peek("empty")).toEqual({ found: true, value: undefined });
    expect(registry.remaining()).toBe(2);
  });

  it("consumes restoration at mount so opening the same form later does not revive it", () => {
    const registry = createUpdateDraftRegistry();
    registry.prepare([{ key: "editing", value: "old input" }]);
    const unmount = registry.register("editing", () => "restored input");
    expect(registry.remaining()).toBe(0);
    unmount();
    expect(registry.peek("editing").found).toBe(false);
    expect(registry.capture()).toEqual([]);
  });

  it("unknown recovery keys remain detectable until explicit discard", () => {
    const registry = createUpdateDraftRegistry();
    registry.prepare([{ key: "known", value: 1 }, { key: "old-schema-form", value: 2 }]);
    registry.register("known", () => 1);
    expect(registry.remaining()).toBe(1);
    registry.clearRecovery();
    expect(registry.remaining()).toBe(0);
  });

  it("an old effect cleanup cannot unregister a new form instance", () => {
    const registry = createUpdateDraftRegistry();
    const staleCleanup = registry.register("editing", () => "old");
    registry.register("editing", () => "new");
    staleCleanup();
    expect(registry.capture()).toEqual([{ key: "editing", value: "new" }]);
  });

  it("blocks snapshots while local file work is running and never serializes busy flags", () => {
    const registry = createUpdateDraftRegistry();
    let busy = true;
    const unmount = registry.registerBusy("json-file", () => busy);
    registry.register("input", () => "kept");
    expect(() => registry.assertIdle()).toThrow("処理中");
    expect(() => registry.capture()).toThrow("処理中");
    busy = false;
    expect(registry.capture()).toEqual([{ key: "input", value: "kept" }]);
    busy = true;
    unmount();
    expect(registry.capture()).toEqual([{ key: "input", value: "kept" }]);
  });
});
