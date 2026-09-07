"use client";

import { useEffect, useState } from "react";
import { APP_VERSION } from "@/lib/app-release";
import { clientReleaseMonitor, type ClientReleaseState } from "@/lib/client-release";
import { useUpdateDrafts } from "./update-drafts";

export function useClientReleaseState() {
  const [state, setState] = useState<ClientReleaseState>({ status: "checking" });
  useEffect(() => {
    const monitor = clientReleaseMonitor();
    if (!monitor) return;
    setState(monitor.getSnapshot());
    const unsubscribe = monitor.subscribe(setState);
    const check = () => { if (document.visibilityState !== "hidden") void monitor.check(); };
    void monitor.check();
    const timer = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return state;
}

type Props = { state: ClientReleaseState; busy: boolean; dirty?: boolean; onReload: () => void };

export function ClientUpdateNotice({ state, busy, dirty = false, onReload }: Props) {
  const drafts = useUpdateDrafts();
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const blocked = state.status !== "current";
  if (!blocked && !drafts.recovery && !drafts.recoveryError && !error) return null;

  const safely = (action: () => void) => {
    if (busy) { setError("処理が完了してから操作してください。入力は保持されています。"); return; }
    try { setError(""); action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "入力を保護できないため、画面は更新していません。"); }
  };
  const refresh = () => safely(() => {
    // 保存失敗時は絶対にreloadへ進めない。フォームのrevisionもそのまま退避する。
    drafts.assertIdle();
    if (drafts.recovery) {
      if (dirty) throw new Error("現在の入力と前回の退避入力が両方あります。先に退避入力を確認・復元してください。画面は更新していません。");
      // 再読込直後にさらに新版が公開された場合も、既存退避を捨てずに更新する。
    } else drafts.saveForReload();
    onReload();
  });
  const retry = async () => {
    setChecking(true);
    try { await clientReleaseMonitor()?.check(); }
    finally { setChecking(false); }
  };

  return <section className="client-update-notice" aria-label="バージョンと入力の保護" aria-live="polite">
    {state.status === "checking" && <p>最新版を確認しています…</p>}
    {state.status === "outdated" && <>
      <strong>最新版へ更新してください</strong>
      <p>現在 Ver{APP_VERSION} → 公開版 Ver{state.release?.version}。保存・送信・承認・差戻しなどの新しい操作は停止しています。</p>
      <p>入力をこのタブに退避して更新し、更新後に内容を確認して復元できます。処理中は更新しません。</p>
      <div className="actions"><button type="button" className="button" disabled={busy || checking || Boolean(drafts.recovery && dirty)} onClick={refresh}>{drafts.recovery ? "退避入力を残して最新版に更新" : "入力を退避して最新版に更新"}</button></div>
    </>}
    {(state.status === "unavailable" || state.status === "unsupported") && <>
      <strong>最新版の確認が必要です</strong><p>{state.message}</p>
      {state.updateUrl && <p><a href={state.updateUrl} target="_blank" rel="noopener noreferrer">最新環境を別のタブで開く</a></p>}
    </>}
    {blocked && <button type="button" className="button secondary mini" disabled={busy || checking} onClick={() => void retry()}>{checking ? "確認中…" : "最新版を再確認"}</button>}
    {drafts.recovery && <div className="top-gap">
      <strong>更新前に退避した入力があります</strong>
      <p>{new Date(drafts.recovery.savedAt).toLocaleString("ja-JP")}の入力です。復元しても自動保存・送信はしません。最新データとの競合や参照先は保存時に再確認します。</p>
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={() => safely(() => {
          if (dirty && !window.confirm("現在の未保存入力を置き換えて、更新前の退避入力を復元しますか？")) return;
          drafts.restore();
        })}>退避入力を復元する</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => safely(() => {
          if (window.confirm("退避した未保存入力を破棄しますか？この操作は取り消せません。")) drafts.discard();
        })}>退避入力を破棄</button>
      </div>
    </div>}
    {!drafts.recovery && drafts.recoveryError && <button type="button" className="button secondary" disabled={busy} onClick={() => safely(() => {
      if (window.confirm("読み込めない退避入力を破棄しますか？この操作は取り消せません。現在の画面の入力は残ります。")) drafts.discard();
    })}>読み込めない退避入力を破棄</button>}
    {(error || drafts.recoveryError) && <p role="alert" className="text-danger">{error || drafts.recoveryError}</p>}
  </section>;
}

export function LoginUpdateNotice({ state, busy }: Pick<Props, "state" | "busy">) {
  if (state.status === "current" || state.status === "checking") return null;
  return <section className="client-update-notice" aria-live="polite">
    <strong>{state.status === "outdated" ? "最新版へ更新してください" : "最新版を確認できません"}</strong>
    <p>{state.message || "新しいバージョンが公開されています。ログイン前に画面を更新してください。"}</p>
    {state.updateUrl ? <a href={state.updateUrl}>最新環境を開く</a> : <button type="button" className="button" disabled={busy} onClick={() => window.location.reload()}>最新版に更新</button>}
  </section>;
}
