"use client";

import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import type { Role } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
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
  | "castSales"
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

type PageErrorBoundaryProps = {
  children: ReactNode;
  resetKey: string;
  onRetry: () => void;
};

class PageErrorBoundary extends Component<
  PageErrorBoundaryProps,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(previous: PageErrorBoundaryProps) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("GMS page render error", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <Card title="このページの表示中に問題が発生しました">
        <p>
          読み込んだデータの一部を表示できませんでした。別のページへ移動するか、最新データを読み直してください。
        </p>
        <button className="button secondary" onClick={this.props.onRetry}>
          最新データを読み直す
        </button>
      </Card>
    );
  }
}

const emptyData: AccountingWorkspaceData = {
  casts: [],
  staff: [],
  drivers: [],
  introducers: [],
  liquor: [],
  closings: [],
  adjustments: [],
  cashFloat: 200000,
  archivedCasts: [],
  archivedStaff: [],
  introducerEntryEvents: [],
  introducerDeletionCommits: [],
  introducerMonthEvents: [],
  monthStates: [],
  monthSnapshots: [],
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
  castSales: {
    group: "経理作業",
    label: "キャスト売上",
    title: "キャスト売上データ",
    description: "キャスト別・出勤日別の売上、酒代原価、バックを月次で確認します。",
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
  const [data, setData] = useState<AccountingWorkspaceData>(emptyData);
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pageRevision, setPageRevision] = useState(0);
  const [pageDirty, setPageDirty] = useState(false);
  const roleRef = useRef<Role | null>(null);
  const authEpochRef = useRef(0);
  const reloadRequestRef = useRef(0);
  const runLockRef = useRef(false);

  const reload = useCallback(async (
    knownRole?: Role,
    knownUser?: User,
    knownAuthEpoch?: number,
    resetPage = false,
  ) => {
    const requestId = ++reloadRequestRef.current;
    const authEpoch = knownAuthEpoch ?? authEpochRef.current;
    const currentUser = knownUser || auth.currentUser;
    const isCurrentRequest = () => (
      reloadRequestRef.current === requestId
      && authEpochRef.current === authEpoch
      && auth.currentUser?.uid === currentUser?.uid
    );
    setBusy(true);
    setNotice(null);
    try {
      if (!currentUser) throw new Error("ログイン状態を確認できません。再度ログインしてください。");

      let nextRole: Role;
      try {
        nextRole = knownRole || await userRole(currentUser);
      } catch (error) {
        if (!isCurrentRequest()) return false;
        roleRef.current = null;
        setRole(null);
        setData(emptyData);
        setView("home");
        setPageRevision((revision) => revision + 1);
        setNotice({
          kind: "error",
          text: `Firebase上の権限を確認できませんでした。権限の削除・不正値、または権限情報の読込失敗が考えられます。${message(error)}`,
        });
        return false;
      }

      const nextData = await loadWorkspaceData(nextRole);
      if (!isCurrentRequest()) return false;
      const roleChanged = roleRef.current !== nextRole;
      roleRef.current = nextRole;
      setRole(nextRole);
      if (roleChanged) setData(emptyData);
      setView((currentView) => viewInfo[currentView].roles.includes(nextRole) ? currentView : "home");
      setData(nextData);
      if (roleChanged || resetPage) setPageRevision((revision) => revision + 1);
      return true;
    } catch (error) {
      if (!isCurrentRequest()) return false;
      setNotice({
        kind: "error",
        text: `データを読み込めませんでした。${message(error)}`,
      });
      return false;
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let observerResponded = false;
    const applyAuthState = async (next: User | null) => {
      if (cancelled) return;
      observerResponded = true;
      window.clearTimeout(initializationWatchdog);
      const authEpoch = ++authEpochRef.current;
      setUser(next);
      setAuthReady(true);
      if (!next) {
        roleRef.current = null;
        setRole(null);
        setData(emptyData);
        setView("home");
        setNotice(null);
        return;
      }
      roleRef.current = null;
      setRole(null);
      setData(emptyData);
      setView("home");
      setNotice(null);
      await reload(undefined, next, authEpoch, true);
    };
    const initializationWatchdog = window.setTimeout(() => {
      if (cancelled || observerResponded) return;
      const next = auth.currentUser;
      ++authEpochRef.current;
      setUser(next);
      setAuthReady(true);
      roleRef.current = null;
      setRole(null);
      setData(emptyData);
      setView("home");
      setNotice({
        kind: "error",
        text: "Firebaseの認証確認に時間がかかっています。通信状態を確認してページを再読み込みしてください。認証応答が届いた場合は自動的に復帰します。",
      });
    }, 10_000);
    const unsubscribe = onAuthStateChanged(
      auth,
      (next) => { void applyAuthState(next); },
      (error) => {
        if (cancelled) return;
        observerResponded = true;
        window.clearTimeout(initializationWatchdog);
        ++authEpochRef.current;
        setUser(auth.currentUser);
        setAuthReady(true);
        roleRef.current = null;
        setRole(null);
        setData(emptyData);
        setView("home");
        setNotice({
          kind: "error",
          text: `Firebaseの認証状態を確認できませんでした。通信状態を確認してページを再読み込みしてください。${message(error)}`,
        });
      },
    );
    void setPersistence(auth, browserLocalPersistence).catch((error) => {
      console.warn("Firebase auth persistence setup failed", error);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(initializationWatchdog);
      unsubscribe();
    };
  }, [reload]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      )
      .catch((error) => console.warn("Legacy service worker cleanup failed", error));
    if ("caches" in window) {
      void caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch((error) => console.warn("Legacy cache cleanup failed", error));
    }
  }, []);

  useEffect(() => {
    if (!pageDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [pageDirty]);

  if (!authReady)
    return (
      <main className="login">
        <p>認証状態を確認しています…</p>
      </main>
    );
  if (!user) return <Login notice={notice?.kind === "error" ? notice.text : ""} />;
  if (!role)
    return (
      <main className="login">
        <Card title="権限を確認できません">
          {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
          <p>
            Firebaseにshop、accounting、opのいずれかの権限を設定してください。
          </p>
          <div className="actions">
            <button className="button secondary" disabled={busy} onClick={() => void reload()}>
              {busy ? "確認中…" : "権限を再確認"}
            </button>
            <button className="button secondary" disabled={busy} onClick={() => signOut(auth)}>
              ログアウト
            </button>
          </div>
        </Card>
      </main>
    );
  const permitted = viewInfo[view].roles.includes(role);
  const info = permitted ? viewInfo[view] : viewInfo.home;
  const navigateTo = (nextView: View) => {
    if (nextView === view) return;
    if (pageDirty && !window.confirm("未保存の入力があります。破棄して別のページへ移動しますか？")) return;
    setView(nextView);
  };
  const logout = () => {
    if (pageDirty && !window.confirm("未保存の入力があります。破棄してログアウトしますか？")) return;
    void signOut(auth);
  };
  const reloadWithGuard = () => {
    if (pageDirty && !window.confirm("未保存の入力があります。最新データを読み込みますか？")) return;
    void reload(undefined, undefined, undefined, true);
  };
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (runLockRef.current) {
      setNotice({ kind: "error", text: "別の処理を実行中です。完了してからもう一度操作してください。" });
      return false;
    }
    runLockRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (!await reload()) return false;
      setNotice({ kind: "success", text: success });
      return true;
    } catch (error) {
      setNotice({
        kind: "error",
        text: `処理できませんでした。${message(error)}`,
      });
      return false;
    } finally {
      runLockRef.current = false;
      setBusy(false);
    }
  };
  const commonSection = (
    ["casts", "introducers", "liquor", "staff", "drivers", "cash"] as View[]
  ).includes(view);
  const accountingSection = (
    [
      "approval",
      "castSales",
      "castRewards",
      "introducersPay",
      "staffPayroll",
      "driverPayroll",
      "expenses",
      "balance",
    ] as View[]
  ).includes(view);
  const integrityIssueCount = data.closings.filter(
    (row) => (row.integrityIssues?.length || 0) > 0,
  ).length;

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
            onClick={() => navigateTo("home")}
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
                    onClick={() => navigateTo(key)}
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
            Ver2.16.0 ·{" "}
            {role === "shop" ? "店舗" : role === "accounting" ? "経理" : "OP"}
          </small>
          <button className="button secondary" disabled={busy} onClick={logout}>
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
              onClick={reloadWithGuard}
            >
              {busy ? "読込中…" : "最新データを読込"}
            </button>
          </div>
        </header>
        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}
        {integrityIssueCount > 0 && (
          <div className="notice error">
            読込データが不完全な営業日が{integrityIssueCount}件あります。対象日の詳細と店舗送信データを確認してください。
          </div>
        )}
        <PageErrorBoundary
          resetKey={`${view}:${pageRevision}`}
          onRetry={reloadWithGuard}
        >
          {!permitted ? (
            <div className="notice error">
              このフォームへアクセスする権限がありません。
            </div>
          ) : (
            <>
              {view === "home" && (
                <Dashboard data={data} role={role} onNavigate={navigateTo} />
              )}
              {view === "store" && (
                <StoreWork key={`store:${pageRevision}`} data={data} user={user} busy={busy} run={run} onDirtyChange={setPageDirty} />
              )}
              {commonSection && (
                <CommonForms
                  key={`common:${pageRevision}`}
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
                  onDirtyChange={setPageDirty}
                />
              )}
              {accountingSection && (
                <AccountingForms
                  key={`accounting:${pageRevision}`}
                  section={
                    (view === "introducersPay" ? "introducers" : view) as
                      | "approval"
                      | "castSales"
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
                  onDirtyChange={setPageDirty}
                />
              )}
            </>
          )}
        </PageErrorBoundary>
      </main>
    </div>
  );
}

function Login({ notice = "" }: { notice?: string }) {
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
          <small>Ver2.16.0</small>
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
          {!error && notice && <div className="notice error">{notice}</div>}
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
  data: AccountingWorkspaceData;
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
