"use client";

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { createUpdateDraftRegistry, discardUpdateDraft, readUpdateDraft, updateDraftStorageKey, writeUpdateDraft, type UpdateDraftRecovery, type UpdateDraftScope } from "@/lib/update-drafts";

type DraftActions = {
  assertIdle: () => void;
  saveForReload: () => void;
  recovery: UpdateDraftRecovery | null;
  recoveryError: string;
  restore: () => void;
  discard: () => void;
};
type Props = UpdateDraftScope & { view: string; onRestoreView: (view: string) => void; children: ReactNode };
const RegistryContext = createContext<ReturnType<typeof createUpdateDraftRegistry> | null>(null);
const ActionsContext = createContext<DraftActions | null>(null);

function browserStorage() {
  try { return window.sessionStorage; }
  catch { throw new Error("この端末で入力を退避できません。画面を更新せず、入力内容を控えてください。"); }
}

export function UpdateDraftProvider(props: Props) {
  // User/environment changes cannot leave another account's form values mounted.
  return <ScopedUpdateDraftProvider key={updateDraftStorageKey(props)} {...props} />;
}

function ScopedUpdateDraftProvider({ userId, environment, view, onRestoreView, children }: Props) {
  const scope = useMemo(() => ({ userId, environment }), [userId, environment]);
  const registry = useMemo(createUpdateDraftRegistry, []);
  const [recovery, setRecovery] = useState<UpdateDraftRecovery | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    try {
      const draft = readUpdateDraft(browserStorage(), scope);
      setRecovery(draft ? { savedAt: draft.savedAt, view: draft.view, entryCount: draft.entries.length } : null);
      setRecoveryError("");
    } catch (error) { setRecoveryError(error instanceof Error ? error.message : "退避入力を読み込めません。"); }
  }, [scope]);
  useEffect(() => {
    if (!generation) return;
    // Child registration effects have committed by this point. Retain the only
    // backup if a changed/unknown form did not consume every restored key.
    if (registry.remaining()) {
      setRecoveryError("このバージョンで復元できない入力項目があります。退避データは削除していません。現在の入力を確認し、必要な内容を控えてください。");
      return;
    }
    try {
      discardUpdateDraft(browserStorage(), scope);
      setRecovery(null);
      setRecoveryError("");
    } catch (error) { setRecoveryError(error instanceof Error ? error.message : "退避入力の復元完了を記録できません。"); }
  }, [generation, registry, scope]);
  const saveForReload = useCallback(() => {
    const storage = browserStorage();
    if (readUpdateDraft(storage, scope)) throw new Error("前回の退避入力が残っています。先に復元するか、内容を確認して破棄してください。画面は更新していません。");
    const draft = writeUpdateDraft(storage, scope, view, registry.capture());
    // If navigation itself fails, the user can still restore/discard this backup.
    setRecovery({ savedAt: draft.savedAt, view: draft.view, entryCount: draft.entries.length });
    setRecoveryError("");
  }, [registry, scope, view]);
  const restore = useCallback(() => {
    registry.assertIdle();
    const storage = browserStorage();
    const draft = readUpdateDraft(storage, scope);
    if (!draft) throw new Error("復元する退避入力が見つかりません。現在の入力は変更していません。");
    // The backup survives until all child forms have mounted successfully.
    onRestoreView(draft.view);
    registry.prepare(draft.entries);
    setRecoveryError("");
    setGeneration((value) => value + 1);
  }, [onRestoreView, registry, scope]);
  const discard = useCallback(() => {
    registry.assertIdle();
    discardUpdateDraft(browserStorage(), scope);
    registry.clearRecovery();
    setRecovery(null);
    setRecoveryError("");
  }, [registry, scope]);
  const actions = useMemo(() => ({ assertIdle: registry.assertIdle, saveForReload, recovery, recoveryError, restore, discard }), [registry, saveForReload, recovery, recoveryError, restore, discard]);
  return <ActionsContext.Provider value={actions}><RegistryContext.Provider value={registry}><Fragment key={generation}>{children}</Fragment></RegistryContext.Provider></ActionsContext.Provider>;
}

export function useUpdateDrafts(): DraftActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("入力保護機能が初期化されていません。");
  return actions;
}

/** Opt in only business form fields; never use this for credentials or busy flags. */
export function useRecoverableState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const registry = useContext(RegistryContext);
  const [value, setValue] = useState<T>(() => {
    const recovered = registry?.peek(key);
    return recovered?.found ? recovered.value as T : typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const current = useRef(value);
  current.current = value;
  useEffect(() => registry?.register(key, () => current.current), [key, registry]);
  return [value, setValue];
}

/** Busy flags are watched in memory only; they are never restored as true. */
export function useUpdateDraftBusy(key: string, busy: boolean) {
  const registry = useContext(RegistryContext);
  const current = useRef(busy);
  current.current = busy;
  useEffect(() => registry?.registerBusy(key, () => current.current), [key, registry]);
}
