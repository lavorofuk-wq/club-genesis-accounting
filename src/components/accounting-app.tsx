"use client";

import { useCallback, useEffect, useState } from "react";
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
  archiveIntroducer,
  archiveLiquorCost,
  archivePartTimeWorker,
  finalizeClosing,
  finalizedOnly,
  loadWorkspaceData,
  saveFixedExpense,
  saveIntroducer,
  saveLiquorCost,
  savePartTimeWorker,
  submitStoreClosing,
  userRole,
  type WorkspaceData
} from "@/lib/firebase/repository";
import type { FixedExpense, Introducer, LiquorCost, PartTimeWorker, StoreClosingInput } from "@/domain/types";
import {
  createCastMonthlyWorkbook,
  createCastStatementsWorkbook,
  createExpenseWorkbook,
  createFinalizedWorkbook,
  downloadWorkbook
} from "@/lib/xlsx/workbooks";
import { closingTotals } from "@/domain/monthly";
import { StoreClosingWorkflow } from "./store-closing-workflow";
import {
  AccountingSummaryView,
  CastsView,
  FixedExpenseView,
  SalesWorkView,
  SharedMastersView
} from "./system-views";

type View = "home" | "today" | "accounting" | "closings" | "casts" | "salesWork" | "masters" | "fixed" | "exports";
type Notice = { kind: "error" | "success"; text: string } | null;
type Role = "shop" | "accounting";

const viewInfo: Record<View, { label: string; eyebrow: string; title: string; description: string; roles: Role[] }> = {
  home: { label: "概要", eyebrow: "基幹システム", title: "業務ダッシュボード", description: "店舗と経理で共有する最新情報を確認します。", roles: ["shop", "accounting"] },
  today: { label: "今日の締め", eyebrow: "店舗業務", title: "今日の締め作業", description: "9段階の確認を終えて経理へ送信します。", roles: ["shop"] },
  accounting: { label: "総収支", eyebrow: "経理業務", title: "売上データ・総収支", description: "経理確定済みの売上と支出を月単位で確認します。", roles: ["accounting"] },
  closings: { label: "受信・確定", eyebrow: "経理業務", title: "店舗締め受信データ", description: "店舗から届いた締めデータを確認して経理確定します。", roles: ["accounting"] },
  casts: { label: "キャスト情報", eyebrow: "共有機能", title: "キャスト情報", description: "在籍・体入・退店キャストを共通の人物台帳で管理します。", roles: ["shop", "accounting"] },
  salesWork: { label: "売上・勤務", eyebrow: "共有機能", title: "売上・報酬・勤務時間", description: "キャスト売上、報酬、勤務時間を月単位で確認します。", roles: ["shop", "accounting"] },
  masters: { label: "共有設定", eyebrow: "共有機能", title: "共有マスター設定", description: "紹介者、アルバイト、酒代原価を店舗と経理で共有します。", roles: ["shop", "accounting"] },
  fixed: { label: "固定費", eyebrow: "経理業務", title: "固定費設定", description: "月別の固定費とオーリック酒代月合計を管理します。", roles: ["accounting"] },
  exports: { label: "XLSX出力", eyebrow: "経理業務", title: "帳票出力", description: "既存の4種類のXLSX帳票を出力します。", roles: ["accounting"] }
};
const emptyData: WorkspaceData = {
  closings: [], casts: [], staff: [], introducers: [], liquorCosts: [], fixedExpenses: []
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
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [month, setMonth] = useState(currentMonth());

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadWorkspaceData());
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
        setData(emptyData);
        return;
      }
      try {
        const nextRole = await userRole(nextUser);
        setRole(nextRole);
        if (nextRole !== "shop" && nextRole !== "accounting") {
          setNotice({ kind: "error", text: "店舗または経理の権限が設定されたアカウントでログインしてください。" });
          return;
        }
        setView("home");
        await reload();
      } catch (error) {
        setNotice({ kind: "error", text: `権限を確認できませんでした。${messageOf(error)}` });
      }
    });
  }, [reload]);

  if (!authReady) return <div className="login"><p>認証状態を確認しています…</p></div>;
  if (!user) return <Login />;

  const validRole = role === "shop" || role === "accounting" ? role : null;
  const info = viewInfo[view];
  const nav = validRole ? (Object.keys(viewInfo) as View[]).filter((key) => viewInfo[key].roles.includes(validRole)) : [];
  const finalized = finalizedOnly(data.closings);

  const runSave = async (action: () => Promise<void>, success: string) => {
    setLoading(true);
    setNotice(null);
    try {
      await action();
      await reload();
      setNotice({ kind: "success", text: success });
      return true;
    } catch (error) {
      setNotice({ kind: "error", text: `処理できませんでした。${messageOf(error)}` });
      return false;
    } finally {
      setLoading(false);
    }
  };

  return <div className="shell">
    <aside className="sidebar">
      <div>
        <div className="brand-mark">CLUB GENESIS</div>
        <div className="brand-title">GENESIS 基幹</div>
        <div className="version">Ver2.2.0 · {role === "shop" ? "店舗" : role === "accounting" ? "経理" : "権限未設定"}</div>
      </div>
      <nav className="nav">{nav.map((key) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{viewInfo[key].label}</button>)}</nav>
      <div className="sidebar-bottom">
        <span className="env">{isProductionEnvironment() ? "本番" : "開発"} · {collectionNames().closings}</span>
        <span className="version">{user.email}</span>
        <button className="button secondary" onClick={() => signOut(auth)}>ログアウト</button>
      </div>
    </aside>
    <main className="main">
      <header className="page-header"><div><p className="eyebrow">{info.eyebrow}</p><h1>{info.title}</h1><p className="muted">{info.description}</p></div>
        <button className="button secondary" disabled={loading || !validRole} onClick={reload}>{loading ? "読込中…" : "再読込"}</button>
      </header>
      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
      {!validRole ? <section className="card"><p>この画面を利用する権限がありません。</p></section> : <>
        {view === "home" && <Home data={data} role={validRole} onStart={() => setView("today")} />}
        {view === "today" && validRole === "shop" && <StoreClosingWorkflow data={data} loading={loading} onSubmit={async (input: StoreClosingInput) => {
          setLoading(true); setNotice(null);
          try {
            await submitStoreClosing(input, user);
            await reload();
            setNotice({ kind: "success", text: `${input.preview.closing.businessDate} の締めデータを経理へ送信しました。` });
            setView("home");
          } catch (error) {
            setNotice({ kind: "error", text: `経理へ送信できませんでした。${messageOf(error)}` });
            throw error;
          } finally {
            setLoading(false);
          }
        }} />}
        {view === "accounting" && validRole === "accounting" && <AccountingSummaryView data={data} />}
        {view === "closings" && validRole === "accounting" && <ClosingsView rows={data.closings} onFinalize={(id) => {
          if (!window.confirm("この店舗締めデータを経理確定しますか？")) return;
          void runSave(() => finalizeClosing(id, user), "経理確定しました。総収支とXLSXへ反映されます。");
        }} />}
        {view === "casts" && <CastsView rows={data.casts} />}
        {view === "salesWork" && <SalesWorkView data={data} />}
        {view === "masters" && <SharedMastersView data={data} busy={loading}
          onSaveIntroducer={(value: Omit<Introducer, "id"> & { id?: string }) =>
            runSave(() => saveIntroducer(value, user), value.id ? "紹介者を更新しました。" : "紹介者を登録しました。")}
          onSaveStaff={(value: Pick<PartTimeWorker, "name" | "payType" | "payAmount"> & {
            id?: string;
            jobType?: PartTimeWorker["jobType"];
          }) =>
            runSave(() => savePartTimeWorker(value, user), value.id ? "アルバイトを更新しました。" : "アルバイトを登録しました。")}
          onSaveLiquor={(value: Omit<LiquorCost, "id"> & { id?: string }) =>
            runSave(() => saveLiquorCost(value, user), value.id ? "酒代原価を更新しました。" : "酒代原価を登録しました。")}
          onDeleteIntroducer={(id) => runSave(() => archiveIntroducer(id, user), "紹介者を削除しました。")}
          onDeleteStaff={(id) => runSave(() => archivePartTimeWorker(id, user), "アルバイトを削除しました。")}
          onDeleteLiquor={(id) => runSave(() => archiveLiquorCost(id, user), "酒代原価を削除しました。")} />}
        {view === "fixed" && validRole === "accounting" && <FixedExpenseView data={data} busy={loading}
          onSave={(value: FixedExpense) => runSave(() => saveFixedExpense(value, user), "固定費を保存しました。")} />}
        {view === "exports" && validRole === "accounting" && <ExportsView month={month} setMonth={setMonth} onExport={async (kind) => {
          try {
            const stamp = month.replace("-", "");
            if (kind === "finalized") await downloadWorkbook(createFinalizedWorkbook(finalized, month), `gms_income_statement_${stamp}.xlsx`);
            else if (kind === "expense") await downloadWorkbook(createExpenseWorkbook(finalized, data.fixedExpenses, month), `genesis_expenses_${stamp}.xlsx`);
            else if (kind === "statement") await downloadWorkbook(createCastStatementsWorkbook(finalized, data.casts, month), `cast_rewards_${stamp}.xlsx`);
            else await downloadWorkbook(createCastMonthlyWorkbook(finalized, data.casts, month), `cast_reward_monthly_${stamp}.xlsx`);
            setNotice({ kind: "success", text: "XLSXを出力しました。" });
          } catch (error) {
            setNotice({ kind: "error", text: `XLSXを出力できませんでした。${messageOf(error)}` });
          }
        }} />}
      </>}
    </main>
  </div>;
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return <main className="login"><form className="card login-card stack" onSubmit={async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await signInWithEmailAndPassword(auth, email.trim(), password); }
    catch { setError("ログインできませんでした。メールアドレスとパスワードを確認してください。"); }
    finally { setBusy(false); }
  }}>
    <div><p className="eyebrow">CLUB GENESIS　Ver2.2.0</p><h1>基幹システム</h1><p className="muted">店舗または経理アカウントでログインしてください。</p></div>
    <div className="field"><label>メールアドレス</label><input className="input" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></div>
    <div className="field"><label>パスワード</label><input className="input" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></div>
    {error && <div className="notice error">{error}</div>}
    <button className="button" disabled={busy}>{busy ? "ログイン中…" : "ログイン"}</button>
  </form></main>;
}

function Home({ data, role, onStart }: { data: WorkspaceData; role: Role; onStart: () => void }) {
  const rows = data.closings.filter((row) => row.businessDate.startsWith(currentMonth()) && row.status !== "superseded");
  const sales = rows.reduce((sum, row) => sum + closingTotals(row as Parameters<typeof closingTotals>[0]).sales, 0);
  const pending = data.closings.filter((row) => row.status === "submitted").length;
  return <div className="grid">
    {role === "shop" && <section className="card today-callout"><div><p className="eyebrow">本日の店舗業務</p><h2>締め作業は9項目を順番に確認します</h2><p className="muted">JSON、キャスト紐づけ、勤務、経費、日払いまで一度に経理へ送信します。</p></div><button className="button" onClick={onStart}>今日の締め作業を開始</button></section>}
    <section className="grid metrics">
      <Metric label="当月送信売上" value={yen.format(sales)} />
      <Metric label={role === "accounting" ? "経理確認待ち" : "経理へ送信済み"} value={`${pending}件`} />
      <Metric label="在籍キャスト" value={`${data.casts.filter((row) => !row.deleted && row.status === "active").length}名`} />
      <Metric label="体入キャスト" value={`${data.casts.filter((row) => !row.deleted && row.status === "trial").length}名`} />
    </section>
    <section className="card"><div className="section-head"><h2>基盤の接続状態</h2><span className="pill good">完全分離</span></div>
      <div className="grid three architecture-list"><div><b>POS</b><p>Firebaseには接続せず、店舗締めJSONだけを読み込みます。</p></div>
        <div><b>店舗・経理</b><p>同じ経理専用Firebaseで人物、勤務、売上、設定を共有します。</p></div>
        <div><b>確定データ</b><p>店舗送信後に経理が確定し、総収支と4帳票へ反映します。</p></div></div>
    </section>
  </div>;
}

function ClosingsView({ rows, onFinalize }: { rows: WorkspaceData["closings"]; onFinalize: (id: string) => void }) {
  return <section className="card"><div className="section-head"><h2>店舗からの受信データ</h2><span className="pill">{rows.length}件</span></div>
    <div className="table-wrap"><table><thead><tr><th>営業日</th><th>状態</th><th>売上</th><th>店舗経費</th><th>オーリック</th><th>キャスト勤務</th><th>操作</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}><td>{row.businessDate}</td><td><span className={`pill ${row.status === "finalized" ? "good" : "warn"}`}>{closingStatus(String(row.status))}</span></td>
        <td>{yen.format(row.sales.totalSales)}</td><td>{yen.format(row.expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0))}</td>
        <td>{yen.format(Number(row.auricLiquorAmount || 0))}</td><td>{row.castWork.length + row.trialWork.length}名</td>
        <td>{row.status === "submitted" ? <button className="button" onClick={() => onFinalize(row.id)}>経理確定</button> : "—"}</td></tr>)}
        {!rows.length && <tr><td colSpan={7}>受信データはありません。</td></tr>}</tbody></table></div>
  </section>;
}

function ExportsView({ month, setMonth, onExport }: {
  month: string; setMonth: (value: string) => void;
  onExport: (kind: "expense" | "statement" | "monthly" | "finalized") => void;
}) {
  const rows = [
    ["expense", "経費表XLSX", "日別変動費と月別固定費"],
    ["statement", "明細書XLSX", "キャストごとの報酬明細"],
    ["monthly", "月次報酬表XLSX", "キャストの日別・月次報酬"],
    ["finalized", "確定データXLSX", "売上・決済・経費・収支"]
  ] as const;
  return <div className="grid"><section className="card"><div className="field short-field"><label>対象月</label><input className="input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></div></section>
    <section className="grid two">{rows.map(([kind, label, description]) => <div className="card stack" key={kind}><h2>{label}</h2><p className="muted">{description}</p>
      <button className="button" disabled={!month} onClick={() => onExport(kind)}>XLSX出力</button></div>)}</section></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="card"><div className="metric-label">{label}</div><div className="metric-value">{value}</div></div>;
}
function closingStatus(status: string) {
  return { submitted: "経理確認待ち", finalized: "経理確定", superseded: "訂正前データ", rejected: "差し戻し" }[status] || status;
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
