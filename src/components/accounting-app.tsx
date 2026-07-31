"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User
} from "firebase/auth";
import { auth, collectionNames, isProductionEnvironment } from "@/lib/firebase/client";
import {
  finalizeClosing,
  finalizedOnly,
  importClosing,
  loadWorkspaceData,
  userRole,
  type WorkspaceData
} from "@/lib/firebase/repository";
import { parsePosClosing, previewRoster } from "@/domain/pos-import";
import type { ImportPreview } from "@/domain/types";
import {
  createCastMonthlyWorkbook,
  createCastStatementsWorkbook,
  createExpenseWorkbook,
  createFinalizedWorkbook,
  downloadWorkbook
} from "@/lib/xlsx/workbooks";
import { closingTotals } from "@/domain/monthly";

type View = "home" | "import" | "closings" | "casts" | "exports";
type Notice = { kind: "error" | "success"; text: string } | null;

const viewInfo: Record<View, { label: string; eyebrow: string; title: string; description: string }> = {
  home: { label: "概要", eyebrow: "経理業務", title: "経理ダッシュボード", description: "確定前後のデータと月次処理を確認します。" },
  import: { label: "POS JSON取込", eyebrow: "POS連携", title: "POS JSON取込", description: "ファイルと在籍差分を確認してから経理データへ保存します。" },
  closings: { label: "確定データ", eyebrow: "営業日管理", title: "受信・確定データ", description: "取り込んだ営業日データを確認し、経理確定します。" },
  casts: { label: "キャスト", eyebrow: "人物台帳", title: "キャスト台帳", description: "GMSで管理している人物と在籍状態を表示します。" },
  exports: { label: "XLSX出力", eyebrow: "月次帳票", title: "帳票出力", description: "対象月を選び、必要な帳票を出力します。" }
};

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const currentMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};

export function AccountingApp() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [role, setRole] = useState("");
  const [view, setView] = useState<View>("home");
  const [data, setData] = useState<WorkspaceData>({ closings: [], casts: [], fixedExpenses: [] });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [month, setMonth] = useState(currentMonth());

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadWorkspaceData());
      setNotice(null);
    } catch (error) {
      setNotice({ kind: "error", text: `データを読み込めませんでした。${messageOf(error)}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPersistence(auth, browserLocalPersistence).catch(() => undefined);
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setRole("");
        return;
      }
      try {
        const nextRole = await userRole(nextUser);
        setRole(nextRole);
        if (nextRole !== "accounting") {
          setNotice({ kind: "error", text: "経理権限のあるアカウントでログインしてください。" });
          return;
        }
        await reload();
      } catch (error) {
        setNotice({ kind: "error", text: `権限を確認できませんでした。${messageOf(error)}` });
      }
    });
  }, [reload]);

  if (!authReady) return <div className="login"><p>認証状態を確認しています…</p></div>;
  if (!user) return <Login />;

  const info = viewInfo[view];
  const finalized = finalizedOnly(data.closings);
  const received = data.closings.filter((closing) => closing.status !== "finalized" && closing.status !== "superseded");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand-mark">CLUB GENESIS</div>
          <div className="brand-title">GENESIS 経理</div>
          <div className="version">Ver2.0.3</div>
        </div>
        <nav className="nav">
          {(Object.keys(viewInfo) as View[]).map((key) => (
            <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>
              {viewInfo[key].label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="env">{isProductionEnvironment() ? "本番環境" : "開発環境"} · {collectionNames().closings}</span>
          <span className="version">{user.email}</span>
          <button className="button secondary" onClick={() => signOut(auth)}>ログアウト</button>
        </div>
      </aside>
      <main className="main">
        <header className="page-header">
          <div>
            <p className="eyebrow">{info.eyebrow}</p>
            <h1>{info.title}</h1>
            <p className="muted">{info.description}</p>
          </div>
          <button className="button secondary" disabled={loading || role !== "accounting"} onClick={reload}>
            {loading ? "読込中…" : "再読込"}
          </button>
        </header>
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
        {role !== "accounting" ? (
          <div className="card"><p>この画面を利用する権限がありません。</p></div>
        ) : (
          <>
            {view === "home" && <Home data={data} />}
            {view === "import" && (
              <ImportView
                preview={preview}
                onFile={async (file) => {
                  try {
                    const parsed = parsePosClosing(JSON.parse((await file.text()).replace(/^\uFEFF/, "")));
                    setPreview(previewRoster(parsed, data.casts));
                    setNotice(null);
                  } catch (error) {
                    setPreview(null);
                    setNotice({ kind: "error", text: messageOf(error) });
                  }
                }}
                onAcknowledge={() => setPreview((current) => current ? {
                  ...current,
                  differences: current.differences.map((item) =>
                    item.kind === "missing-local" ? { ...item, blocking: false, message: `${item.message}（GMS状態を維持）` } : item),
                  blockingCount: current.differences.filter((item) => item.blocking && item.kind !== "missing-local").length
                } : null)}
                onImport={async () => {
                  if (!preview) return;
                  setLoading(true);
                  try {
                    await importClosing(preview, user);
                    await reload();
                    setPreview(null);
                    setNotice({ kind: "success", text: `${preview.closing.businessDate} のJSONを安全に取り込みました。` });
                  } catch (error) {
                    setNotice({ kind: "error", text: `取込を完了できませんでした。${messageOf(error)}` });
                  } finally {
                    setLoading(false);
                  }
                }}
                loading={loading}
              />
            )}
            {view === "closings" && (
              <ClosingsView
                rows={data.closings}
                onFinalize={async (id) => {
                  if (!window.confirm("この受信データを経理確定しますか？")) return;
                  setLoading(true);
                  try {
                    await finalizeClosing(id, user);
                    await reload();
                    setNotice({ kind: "success", text: "経理確定しました。" });
                  } catch (error) {
                    setNotice({ kind: "error", text: `経理確定できませんでした。${messageOf(error)}` });
                  } finally {
                    setLoading(false);
                  }
                }}
              />
            )}
            {view === "casts" && <CastsView rows={data.casts} />}
            {view === "exports" && (
              <ExportsView
                month={month}
                setMonth={setMonth}
                onExport={async (kind) => {
                  try {
                    const stamp = month.replace("-", "");
                    if (kind === "finalized") {
                      await downloadWorkbook(createFinalizedWorkbook(finalized, month), `gms_income_statement_${stamp}.xlsx`);
                    } else if (kind === "expense") {
                      await downloadWorkbook(createExpenseWorkbook(finalized, data.fixedExpenses, month), `genesis_expenses_${stamp}.xlsx`);
                    } else if (kind === "statement") {
                      await downloadWorkbook(createCastStatementsWorkbook(finalized, data.casts, month), `cast_rewards_${stamp}.xlsx`);
                    } else {
                      await downloadWorkbook(createCastMonthlyWorkbook(finalized, data.casts, month), `cast_reward_monthly_${stamp}.xlsx`);
                    }
                    setNotice({ kind: "success", text: "XLSXを出力しました。" });
                  } catch (error) {
                    setNotice({ kind: "error", text: `XLSXを出力できませんでした。${messageOf(error)}` });
                  }
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <form className="card login-card stack" onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await signInWithEmailAndPassword(auth, email.trim(), password);
        } catch {
          setError("ログインできませんでした。メールアドレスとパスワードを確認してください。");
        } finally {
          setBusy(false);
        }
      }}>
        <div>
          <p className="eyebrow">CLUB GENESIS　Ver2.0.3</p>
          <h1>経理システム</h1>
          <p className="muted">経理担当者のアカウントでログインしてください。</p>
        </div>
        <div className="field"><label>メールアドレス</label><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label>パスワード</label><input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error && <div className="notice error">{error}</div>}
        <button className="button" disabled={busy}>{busy ? "ログイン中…" : "ログイン"}</button>
      </form>
    </main>
  );
}

function Home({ data }: { data: WorkspaceData }) {
  const finalized = finalizedOnly(data.closings);
  const monthRows = finalized.filter((row) => row.businessDate.startsWith(currentMonth()));
  const sales = monthRows.reduce((sum, row) => sum + closingTotals(row).sales, 0);
  const expense = monthRows.reduce((sum, row) => sum + closingTotals(row).expense, 0);
  return (
    <div className="grid">
      <section className="grid metrics">
        <Metric label="受信・未確定" value={`${data.closings.filter((row) => row.status !== "finalized" && row.status !== "superseded").length}件`} />
        <Metric label="確定済み" value={`${finalized.length}件`} />
        <Metric label="当月売上" value={yen.format(sales)} />
        <Metric label="当月経費" value={yen.format(expense)} />
      </section>
      <section className="card">
        <div className="section-head"><h2>データ連携の状態</h2></div>
        <div className="grid two">
          <div><p className="eyebrow">POS</p><p>POS Firebaseには接続しません。POSが出力したJSONファイルだけを入口にします。</p></div>
          <div><p className="eyebrow">GMS</p><p>経理専用Firebaseでキャスト人物台帳、取込履歴、確定データを管理します。</p></div>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="card"><div className="metric-label">{label}</div><div className="metric-value">{value}</div></div>;
}

function ImportView({ preview, onFile, onAcknowledge, onImport, loading }: {
  preview: ImportPreview | null;
  onFile: (file: File) => void;
  onAcknowledge: () => void;
  onImport: () => void;
  loading: boolean;
}) {
  return (
    <div className="grid">
      <section className="card stack">
        <div className="section-head"><h2>1. JSONファイルを選択</h2></div>
        <input className="input" type="file" accept=".json,application/json" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.currentTarget.value = "";
        }} />
        <p className="muted">schemaVersion 1/2を検証します。Ver2ではsubmissionId、生成日時、在籍スナップショット、ライフサイクルイベントを必須確認します。</p>
      </section>
      {preview && (
        <section className="card stack">
          <div className="section-head">
            <div><h2>2. 取込前レビュー</h2><p className="muted">{preview.closing.businessDate} · {preview.closing.submissionId}</p></div>
            <span className={`pill ${preview.blockingCount ? "warn" : "good"}`}>
              {preview.blockingCount ? `要確認 ${preview.blockingCount}件` : "取込可能"}
            </span>
          </div>
          <div className="grid metrics">
            <Metric label="売上" value={yen.format(preview.closing.sales.totalSales)} />
            <Metric label="会計" value={`${preview.closing.transactions.length}件`} />
            <Metric label="在籍スナップショット" value={`${preview.closing.rosterSnapshot?.casts.length || 0}名`} />
            <Metric label="新規人物" value={`${preview.newCount}名`} />
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>判定</th><th>POS ID</th><th>POS名</th><th>GMS名</th><th>処理</th></tr></thead>
              <tbody>
                {preview.differences.map((item, index) => (
                  <tr key={`${item.kind}-${item.sourceCastId}-${index}`}>
                    <td><span className={`pill ${item.blocking ? "warn" : "good"}`}>{differenceLabel(item.kind)}</span></td>
                    <td>{item.sourceCastId}</td><td>{item.sourceName || "—"}</td><td>{item.memberName || "—"}</td><td>{item.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            {preview.differences.some((item) => item.kind === "missing-local" && item.blocking) && (
              <button className="button secondary" onClick={onAcknowledge}>不在者のGMS状態を維持して続行</button>
            )}
            <button className="button" disabled={loading || preview.blockingCount > 0} onClick={onImport}>
              {loading ? "取込中…" : "検証済みJSONを取り込む"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function ClosingsView({ rows, onFinalize }: { rows: WorkspaceData["closings"]; onFinalize: (id: string) => void }) {
  return (
    <section className="card">
      <div className="section-head"><h2>営業日データ</h2><span className="pill">{rows.length}件</span></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>営業日</th><th>状態</th><th>売上</th><th>現金</th><th>カード</th><th>会計数</th><th>操作</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.businessDate}</td>
                <td><span className={`pill ${row.status === "finalized" ? "good" : "warn"}`}>{row.status === "finalized" ? "経理確定" : row.status}</span></td>
                <td>{yen.format(row.sales.totalSales)}</td><td>{yen.format(row.sales.cashSales)}</td><td>{yen.format(row.sales.cardSales)}</td>
                <td>{row.transactions.length}</td>
                <td>{row.status !== "finalized" && row.status !== "superseded" ? <button className="button" onClick={() => onFinalize(row.id)}>経理確定</button> : "—"}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7}>データがありません。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CastsView({ rows }: { rows: WorkspaceData["casts"] }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => a.internalNo - b.internalNo || a.name.localeCompare(b.name, "ja")), [rows]);
  return (
    <section className="card">
      <div className="section-head"><h2>人物台帳</h2><span className="pill">{rows.filter((row) => !row.deleted).length}名</span></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>No.</th><th>名前</th><th>状態</th><th>POS ID</th><th>人物キー</th><th>報酬方式</th></tr></thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id}>
                <td>{row.internalNo || "—"}</td><td>{row.name}</td>
                <td><span className={`pill ${row.status === "active" ? "good" : "warn"}`}>{row.deleted ? "削除済み" : row.status}</span></td>
                <td>{row.posCastId}</td><td>{row.personKey || row.id}</td><td>{row.rewardSystem || "未設定"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ExportsView({ month, setMonth, onExport }: {
  month: string;
  setMonth: (value: string) => void;
  onExport: (kind: "expense" | "statement" | "monthly" | "finalized") => void;
}) {
  const exports = [
    ["expense", "経費表XLSX", "日別変動費と月別固定費を出力"],
    ["statement", "明細書XLSX", "キャストごとの報酬明細書を出力"],
    ["monthly", "月次報酬表XLSX", "キャストごとの日別月次報酬表を出力"],
    ["finalized", "確定データXLSX", "売上・決済・経費・収支の月次表を出力"]
  ] as const;
  return (
    <div className="grid">
      <section className="card">
        <div className="field"><label>対象月</label><input className="input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></div>
      </section>
      <section className="grid two">
        {exports.map(([kind, label, description]) => (
          <div className="card stack" key={kind}>
            <h2>{label}</h2><p className="muted">{description}</p>
            <button className="button" disabled={!month} onClick={() => onExport(kind)}>XLSX出力</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function differenceLabel(kind: ImportPreview["differences"][number]["kind"]) {
  return { linked: "一致", new: "新規", renamed: "名称差分", "missing-local": "POSに不在", conflict: "競合" }[kind];
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
