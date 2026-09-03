"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import type { Role, WorkspaceData } from "@/domain/gms";
import {
  auth,
  environmentRoot,
  isProductionEnvironment,
} from "@/lib/firebase/client";
import { loadWorkspaceData, userRole } from "@/lib/firebase/repository";
import { CommonForms } from "./common-forms";
import { StoreWork } from "./store-work";
import { AccountingForms } from "./accounting-forms";
import { Card, StatusPill, currentMonth, yen } from "./ui";

type View =
  | "home"
  | "store"
  | "approval"
  | "castRewards"
  | "introducersPay"
  | "staffPayroll"
  | "driverPayroll"
  | "expenses"
  | "balance"
  | "casts"
  | "introducers"
  | "liquor"
  | "staff"
  | "drivers"
  | "cash";
type Notice = { kind: "error" | "success"; text: string } | null;

const emptyData: WorkspaceData = {
  casts: [],
  staff: [],
  drivers: [],
  introducers: [],
  liquor: [],
  closings: [],
  adjustments: [],
  cashFloat: 200000,
};
const viewInfo: Record<
  View,
  {
    group: "店舗作業" | "経理作業" | "共通フォーム" | "";
    label: string;
    title: string;
    description: string;
    roles: Role[];
  }
> = {
  home: {
    group: "",
    label: "ホーム",
    title: "業務ダッシュボード",
    description: "店舗・経理・共通データの状況を確認します。",
    roles: ["shop", "accounting", "op"],
  },
  store: {
    group: "店舗作業",
    label: "営業日データ作成",
    title: "店舗作業",
    description: "POS JSONの取込から現金照合、経理送信までを行います。",
    roles: ["shop", "op"],
  },
  approval: {
    group: "経理作業",
    label: "受信・承認",
    title: "店舗データ確認",
    description: "店舗から送信された日次データを承認または差し戻します。",
    roles: ["accounting", "op"],
  },
  castRewards: {
    group: "経理作業",
    label: "キャスト報酬",
    title: "キャスト報酬データ",
    description: "月次報酬と差引支給額を確認します。",
    roles: ["accounting", "op"],
  },
  introducersPay: {
    group: "経理作業",
    label: "紹介者支払",
    title: "紹介者支払データ",
    description: "紹介者報酬と顧問料を確認します。",
    roles: ["accounting", "op"],
  },
  staffPayroll: {
    group: "経理作業",
    label: "スタッフ給与",
    title: "スタッフ給与データ",
    description: "勤務時間、手当、日払いを集計します。",
    roles: ["accounting", "op"],
  },
  driverPayroll: {
    group: "経理作業",
    label: "ドライバー給与",
    title: "送迎ドライバー給与",
    description: "日給と遠方手当を集計します。",
    roles: ["accounting", "op"],
  },
  expenses: {
    group: "経理作業",
    label: "経費",
    title: "経費データ",
    description: "日次経費、固定経費、酒代納品書分を管理します。",
    roles: ["accounting", "op"],
  },
  balance: {
    group: "経理作業",
    label: "収支",
    title: "収支データ",
    description: "売上とすべての支出から月次収支を算出します。",
    roles: ["accounting", "op"],
  },
  casts: {
    group: "共通フォーム",
    label: "キャスト",
    title: "キャストデータ",
    description: "在籍・体入・退店キャストを管理します。",
    roles: ["shop", "accounting", "op"],
  },
  introducers: {
    group: "共通フォーム",
    label: "紹介者",
    title: "紹介者データ",
    description: "紹介者報酬形態と顧問料設定を管理します。",
    roles: ["shop", "accounting", "op"],
  },
  liquor: {
    group: "共通フォーム",
    label: "酒代原価",
    title: "酒代原価データ",
    description: "ボトルの販売金額と酒代原価を管理します。",
    roles: ["shop", "accounting", "op"],
  },
  staff: {
    group: "共通フォーム",
    label: "スタッフ",
    title: "スタッフデータ",
    description: "在籍・体入・退店スタッフを管理します。",
    roles: ["shop", "accounting", "op"],
  },
  drivers: {
    group: "共通フォーム",
    label: "ドライバー",
    title: "送迎ドライバーデータ",
    description: "在籍・退店ドライバーを管理します。",
    roles: ["shop", "accounting", "op"],
  },
  cash: {
    group: "共通フォーム",
    label: "現金照合設定",
    title: "現金照合データ",
    description: "営業開始時のつり銭金額を設定します。",
    roles: ["shop", "accounting", "op"],
  },
};

export function AccountingApp() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [data, setData] = useState<WorkspaceData>(emptyData);
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const roleRef = useRef<Role | null>(null);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      setData(await loadWorkspaceData(roleRef.current || undefined));
    } catch (error) {
      setNotice({
        kind: "error",
        text: `データを読み込めませんでした。${message(error)}`,
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void setPersistence(auth, browserLocalPersistence);
    return onAuthStateChanged(auth, async (next) => {
      setUser(next);
      setAuthReady(true);
      if (!next) {
        roleRef.current = null;
        setRole(null);
        setData(emptyData);
        return;
      }
      try {
        const nextRole = await userRole(next);
        roleRef.current = nextRole;
        setRole(nextRole);
        setView("home");
        await reload();
      } catch (error) {
        setNotice({ kind: "error", text: message(error) });
      }
    });
  }, [reload]);

  if (!authReady)
    return (
      <main className="login">
        <p>認証状態を確認しています…</p>
      </main>
    );
  if (!user) return <Login />;
  if (!role)
    return (
      <main className="login">
        <Card title="権限を確認できません">
          <p>
            Firebaseにshop、accounting、opのいずれかの権限を設定してください。
          </p>
          <button className="button secondary" onClick={() => signOut(auth)}>
            ログアウト
          </button>
        </Card>
      </main>
    );
  const permitted = viewInfo[view].roles.includes(role);
  const info = permitted ? viewInfo[view] : viewInfo.home;
  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      await reload();
      setNotice({ kind: "success", text: success });
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        text: `処理できませんでした。${message(error)}`,
      });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const commonSection = (
    ["casts", "introducers", "liquor", "staff", "drivers", "cash"] as View[]
  ).includes(view);
  const accountingSection = (
    [
      "approval",
      "castRewards",
      "introducersPay",
      "staffPayroll",
      "driverPayroll",
      "expenses",
      "balance",
    ] as View[]
  ).includes(view);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span>CLUB GENESIS</span>
          <strong>GMS</strong>
          <small>GENESIS Management System</small>
        </div>
        <nav>
          <button
            className={view === "home" ? "active" : ""}
            onClick={() => setView("home")}
          >
            ホーム
          </button>
          {(["店舗作業", "経理作業", "共通フォーム"] as const).map((group) => {
            const rows = (Object.keys(viewInfo) as View[]).filter(
              (key) =>
                viewInfo[key].group === group &&
                viewInfo[key].roles.includes(role),
            );
            return rows.length ? (
              <div className="nav-group" key={group}>
                <p>{group}</p>
                {rows.map((key) => (
                  <button
                    key={key}
                    className={view === key ? "active" : ""}
                    onClick={() => setView(key)}
                  >
                    {viewInfo[key].label}
                  </button>
                ))}
              </div>
            ) : null;
          })}
        </nav>
        <div className="sidebar-foot">
          <StatusPill tone={isProductionEnvironment() ? "danger" : "good"}>
            {isProductionEnvironment() ? "本番環境" : "開発環境"}
          </StatusPill>
          <small>{user.email}</small>
          <small>
            Ver2.3.4 ·{" "}
            {role === "shop" ? "店舗" : role === "accounting" ? "経理" : "OP"}
          </small>
          <button className="button secondary" onClick={() => signOut(auth)}>
            ログアウト
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="page-header">
          <div>
            <p className="eyebrow">{info.group || "GMS"}</p>
            <h1>{info.title}</h1>
            <p>{info.description}</p>
          </div>
          <div className="header-actions">
            <span className="env-label">{environmentRoot()}</span>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void reload()}
            >
              {busy ? "読込中…" : "最新データを読込"}
            </button>
          </div>
        </header>
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
        {!permitted ? (
          <div className="notice error">
            このフォームへアクセスする権限がありません。
          </div>
        ) : (
          <>
            {view === "home" && (
              <Dashboard data={data} role={role} onNavigate={setView} />
            )}
            {view === "store" && (
              <StoreWork data={data} user={user} busy={busy} run={run} />
            )}
            {commonSection && (
              <CommonForms
                section={
                  view as
                    | "casts"
                    | "staff"
                    | "drivers"
                    | "introducers"
                    | "liquor"
                    | "cash"
                }
                data={data}
                user={user}
                busy={busy}
                run={run}
              />
            )}
            {accountingSection && (
              <AccountingForms
                section={
                  (view === "introducersPay" ? "introducers" : view) as
                    | "approval"
                    | "castRewards"
                    | "introducers"
                    | "staffPayroll"
                    | "driverPayroll"
                    | "expenses"
                    | "balance"
                }
                data={data}
                user={user}
                busy={busy}
                run={run}
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
      <form
        className="login-card"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await signInWithEmailAndPassword(auth, email.trim(), password);
          } catch {
            setError("メールアドレスまたはパスワードが正しくありません。");
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="login-brand">
          <span>CLUB GENESIS</span>
          <strong>GMS</strong>
          <p>GENESIS Management System</p>
          <small>Ver2.3.4</small>
        </div>
        <div className="stack">
          <label className="field">
            <span>メールアドレス</span>
            <input
              className="input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="field">
            <span>パスワード</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <div className="notice error">{error}</div>}
          <button className="button login-button" disabled={busy}>
            {busy ? "ログイン中…" : "ログイン"}
          </button>
        </div>
      </form>
    </main>
  );
}

function Dashboard({
  data,
  role,
  onNavigate,
}: {
  data: WorkspaceData;
  role: Role;
  onNavigate: (view: View) => void;
}) {
  const month = currentMonth();
  const approved = data.closings.filter(
    (row) => row.status === "approved" && row.businessDate.startsWith(month),
  );
  const pending = data.closings.filter(
    (row) => row.status === "submitted",
  ).length;
  return (
    <div className="grid">
      <section className="grid metrics">
        <Metric
          label="当月承認売上"
          value={yen.format(
            approved.reduce((sum, row) => sum + row.sales.totalSales, 0),
          )}
        />
        <Metric label="経理確認待ち" value={`${pending}件`} />
        <Metric
          label="在籍キャスト"
          value={`${data.casts.filter((row) => row.status === "active").length}名`}
        />
        <Metric label="つり銭設定" value={yen.format(data.cashFloat)} />
      </section>
      <section className="role-panels">
        {(role === "shop" || role === "op") && (
          <button onClick={() => onNavigate("store")}>
            <span>店舗作業</span>
            <strong>営業日データを作成</strong>
            <small>JSON取込・店舗入力・現金照合・経理送信</small>
          </button>
        )}
        {(role === "accounting" || role === "op") && (
          <button onClick={() => onNavigate("approval")}>
            <span>経理作業</span>
            <strong>
              {pending ? `${pending}件の確認待ち` : "受信データを確認"}
            </strong>
            <small>承認・差戻し・給与・経費・収支</small>
          </button>
        )}
        <button onClick={() => onNavigate("casts")}>
          <span>共通フォーム</span>
          <strong>マスタデータを管理</strong>
          <small>キャスト・紹介者・酒代・スタッフ・ドライバー</small>
        </button>
      </section>
      <Card title="最近の営業データ">
        <div className="recent-list">
          {data.closings.slice(0, 5).map((row) => (
            <div key={row.id}>
              <span>{row.businessDate}</span>
              <strong>{yen.format(row.sales.totalSales)}</strong>
              <StatusPill
                tone={
                  row.status === "approved"
                    ? "good"
                    : row.status === "returned"
                      ? "danger"
                      : "warn"
                }
              >
                {row.status === "approved"
                  ? "承認済み"
                  : row.status === "returned"
                    ? "差戻し"
                    : row.status === "submitted"
                      ? "確認待ち"
                      : "取下げ"}
              </StatusPill>
            </div>
          ))}
          {!data.closings.length && (
            <p className="muted">営業データはまだありません。</p>
          )}
        </div>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="card dashboard-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
