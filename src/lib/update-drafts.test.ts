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

describe("廃止したフォームの退避互換ガード", () => {
  it("日次編集専用の退避だけを復元対象から外し、通常の経理入力を保持する", () => {
    const registry = createUpdateDraftRegistry();
    registry.prepare([
      { key: "accounting.castDaily.editing", value: { draft: { entries: [{ honShimeiSales: 999999 }] } } },
      { key: "accounting.monthly.adjustments", value: { withholdingByCast: { one: 1234 } } },
      { key: "common.casts.editing", value: { name: "通常のマスタ入力" } },
    ]);
    expect(registry.peek("accounting.castDaily.editing")).toEqual({ found: false, value: undefined });
    expect(registry.peek("accounting.monthly.adjustments").found).toBe(true);
    expect(registry.peek("common.casts.editing").found).toBe(true);
    registry.register("accounting.monthly.adjustments", () => ({}));
    registry.register("common.casts.editing", () => ({}));
    expect(registry.remaining()).toBe(0);
    expect(registry.incompatible()).toBe(false);
  });

  it.each([
    { castReturnHandoffId: "handoff-1" },
    { castInputRevision: { schema: 1 } },
    { casts: [{ accountingCorrection: { sourceClosingId: "daily_1" } }] },
  ])("廃止metadataを持つ再編集元と同じ営業日の入力だけを自動復元しない（%j）", (metadata) => {
    const registry = createUpdateDraftRegistry();
    const entries = [
      { key: "store.editing", value: { id: "daily_1", ...metadata } },
      { key: "store.workflowDirty", value: true },
      { key: "store.workflow.daily_1.castRows", value: [{ honShimeiSales: 999999 }] },
      { key: "store.workflow.daily_1.expenses", value: [{ amount: 1234 }] },
      { key: "store.workflow.daily_10.castRows", value: [{ honShimeiSales: 5000 }] },
      { key: "common.cash.amount", value: 200000 },
    ];
    const original = structuredClone(entries);
    registry.prepare(entries);
    for (const entry of entries.slice(0, 4)) {
      expect(registry.peek(entry.key)).toEqual({ found: false, value: undefined });
      registry.register(entry.key, () => null);
    }
    expect(registry.peek("store.workflow.daily_10.castRows").found).toBe(true);
    expect(registry.peek("common.cash.amount").found).toBe(true);
    registry.register("store.workflow.daily_10.castRows", () => []);
    registry.register("common.cash.amount", () => 200000);
    expect(registry.remaining()).toBe(4);
    expect(registry.incompatible()).toBe(true);
    expect(entries).toEqual(original);
  });

  it("引継ぎ専用keyしか残っていなくても元の経費・現金退避を削除せず保留する", () => {
    const storage = memoryStorage();
    const entries = [
      { key: "store.workflow.daily_1.handoff.history-1.castRows", value: [{ honShimeiSales: 999999 }] },
      { key: "store.workflow.daily_1.handoff.history-1.expenses", value: [{ amount: 1234 }] },
      { key: "store.workflow.daily_1.handoff.history-1.personalRepayment", value: 10000 },
    ];
    writeUpdateDraft(storage, scope, "store", entries, savedAt);
    const raw = storage.getItem(updateDraftStorageKey(scope));
    const registry = createUpdateDraftRegistry();
    registry.prepare(readUpdateDraft(storage, scope)!.entries);
    expect(registry.incompatible()).toBe(true);
    expect(registry.remaining()).toBe(3);
    expect(registry.peek(entries[0].key).found).toBe(false);
    expect(storage.getItem(updateDraftStorageKey(scope))).toBe(raw);
    registry.clearRecovery();
    expect(registry.incompatible()).toBe(false);
  });

  it("行の廃止metadataから対応workflowを保留し、同じIDの再編集元も復元しない", () => {
    const registry = createUpdateDraftRegistry();
    registry.prepare([
      { key: "store.editing", value: { id: "daily_1" } },
      { key: "store.workflow.daily_1.castRows", value: [{ accountingCorrection: { sourceClosingId: "daily_1" } }] },
      { key: "store.workflow.daily_1.pos", value: { businessDate: "2026-09-01" } },
    ]);
    expect(registry.peek("store.editing").found).toBe(false);
    expect(registry.peek("store.workflow.daily_1.pos").found).toBe(false);
    expect(registry.remaining()).toBe(3);
  });

  it("metadataのない通常手入力や自由記述から経理修正と推測して破棄しない", () => {
    const registry = createUpdateDraftRegistry();
    const entries = [
      { key: "store.editing", value: { id: "daily_1", castInputRevision: null, castReturnHandoffId: "" } },
      { key: "store.workflowDirty", value: true },
      { key: "store.workflow.daily_1.castRows", value: [{ honShimeiSales: 999999 }] },
      { key: "store.workflow.daily_1.expenses", value: [{ payee: "accountingCorrection", amount: 5000 }] },
      { key: "store.workflow.daily_1.cashRevisionReason", value: "castInputRevision" },
      { key: "common.casts.editing", value: { note: "accounting.castDaily.editing" } },
    ];
    registry.prepare(entries);
    for (const entry of entries) expect(registry.peek(entry.key)).toEqual({ found: true, value: entry.value });
    expect(registry.incompatible()).toBe(false);
  });
});
