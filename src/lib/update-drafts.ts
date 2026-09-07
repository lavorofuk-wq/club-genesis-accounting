/** Update-only, tab-local recovery. This is never an accounting save. */
export const UPDATE_DRAFT_SCHEMA = 1;
const FORMAT = "gms-update-drafts";

export type UpdateDraftScope = { userId: string; environment: string };
export type UpdateDraftEntry = { key: string; value?: unknown };
export type UpdateDraft = UpdateDraftScope & {
  format: typeof FORMAT;
  schema: typeof UPDATE_DRAFT_SCHEMA;
  savedAt: string;
  view: string;
  entries: UpdateDraftEntry[];
};
export type UpdateDraftRecovery = Pick<UpdateDraft, "savedAt" | "view"> & { entryCount: number };
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function updateDraftStorageKey(scope: UpdateDraftScope) {
  if (!scope.userId || !scope.environment) throw new Error("入力退避先の利用者・環境を確認できません。画面は更新していません。");
  return `${FORMAT}:${encodeURIComponent(scope.environment)}:${encodeURIComponent(scope.userId)}`;
}

export function decodeUpdateDraft(raw: string, scope: UpdateDraftScope): UpdateDraft {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("退避入力が破損しているため復元できません。退避データと現在の入力は削除していません。"); }
  if (!record(value) || value.format !== FORMAT || value.schema !== UPDATE_DRAFT_SCHEMA)
    throw new Error("退避入力の形式がこのバージョンに対応していません。退避データと現在の入力は削除していません。");
  if (value.userId !== scope.userId || value.environment !== scope.environment)
    throw new Error("退避入力の利用者・環境が一致しません。データは復元・削除していません。");
  if (typeof value.savedAt !== "string" || !Number.isFinite(Date.parse(value.savedAt)) || typeof value.view !== "string" || !value.view || !Array.isArray(value.entries))
    throw new Error("退避入力の内容を確認できません。退避データと現在の入力は削除していません。");
  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.key !== "string" || !entry.key || keys.has(entry.key))
      throw new Error("退避入力の項目が不正です。退避データと現在の入力は削除していません。");
    keys.add(entry.key);
  }
  return value as UpdateDraft;
}

export function readUpdateDraft(storage: DraftStorage, scope: UpdateDraftScope): UpdateDraft | null {
  let raw: string | null;
  try { raw = storage.getItem(updateDraftStorageKey(scope)); }
  catch { throw new Error("この端末で入力退避領域を読み込めません。画面を更新せず、入力内容を控えてください。"); }
  return raw === null ? null : decodeUpdateDraft(raw, scope);
}

export function writeUpdateDraft(storage: DraftStorage, scope: UpdateDraftScope, view: string, entries: UpdateDraftEntry[], savedAt = new Date().toISOString()) {
  let raw: string;
  try {
    raw = JSON.stringify({ format: FORMAT, schema: UPDATE_DRAFT_SCHEMA, ...scope, view, savedAt, entries }, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value) || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint")
        throw new Error("入力に退避できない値があります。");
      return value;
    });
  } catch { throw new Error("入力内容を安全に退避できませんでした。画面を更新せず、入力内容を控えてください。"); }
  // Validate before replacing anything; setItem is atomic on quota errors.
  const snapshot = decodeUpdateDraft(raw, scope);
  try {
    const key = updateDraftStorageKey(scope);
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error("退避内容の書込確認に失敗しました。");
  }
  catch { throw new Error("入力を退避できませんでした（保存容量不足またはブラウザーの制限）。画面を更新せず、入力内容を控えてください。"); }
  return snapshot;
}

export function discardUpdateDraft(storage: DraftStorage, scope: UpdateDraftScope) {
  try { storage.removeItem(updateDraftStorageKey(scope)); }
  catch { throw new Error("退避入力を削除できませんでした。画面を更新せず、もう一度お試しください。"); }
}

/** Registration lives only as long as its form does, so abandoned forms never reappear. */
export function createUpdateDraftRegistry() {
  const active = new Map<string, { token: symbol; read: () => unknown }>();
  const busy = new Map<string, { token: symbol; read: () => boolean }>();
  let recovery = new Map<string, unknown>();
  const assertIdle = () => {
    if ([...busy.values()].some((entry) => entry.read())) throw new Error("JSON読込・ファイル出力などの処理中です。完了してから画面を更新・復元してください。");
  };
  return {
    assertIdle,
    prepare(entries: UpdateDraftEntry[]) { recovery = new Map(entries.map((entry) => [entry.key, entry.value])); },
    remaining() { return recovery.size; },
    clearRecovery() { recovery.clear(); },
    peek(key: string) { return { found: recovery.has(key), value: recovery.get(key) }; },
    register(key: string, read: () => unknown) {
      const token = Symbol(key);
      active.set(key, { token, read });
      // Consume at commit, not in a state initializer (which React may call twice).
      recovery.delete(key);
      return () => { if (active.get(key)?.token === token) active.delete(key); };
    },
    registerBusy(key: string, read: () => boolean) {
      const token = Symbol(key);
      busy.set(key, { token, read });
      return () => { if (busy.get(key)?.token === token) busy.delete(key); };
    },
    capture(): UpdateDraftEntry[] {
      assertIdle();
      return [...active].map(([key, entry]) => ({ key, value: entry.read() }));
    },
  };
}
