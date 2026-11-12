import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import type { WorkAllowanceRefresh } from "@/domain/work-allowance-refresh";

// React の要素とイベントを検証し、Firebase 認証・DB・ブラウザーへの副作用は実行しない。
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, production: true, releaseStatus: "current" }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index], (value: T | ((previous: T) => T)) => {
        hooks.values[index] = typeof value === "function" ? (value as (previous: T) => T)(hooks.values[index] as T) : value;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: vi.fn(),
    useCallback: <T,>(callback: T) => callback,
  };
});
vi.mock("firebase/auth", () => ({
  browserLocalPersistence: {}, onAuthStateChanged: vi.fn(), setPersistence: vi.fn(),
  signInWithEmailAndPassword: vi.fn(), signOut: vi.fn(),
}));
vi.mock("@/lib/firebase/client", () => ({
  auth: { currentUser: { uid: "accounting-user" } },
  isProductionEnvironment: () => hooks.production,
  environmentRoot: () => hooks.production ? "accounting" : "accounting-dev",
}));
vi.mock("@/lib/firebase/repository", () => ({ loadWorkspaceData: vi.fn(), userRole: vi.fn() }));
vi.mock("@/lib/firebase/work-allowance-refresh", () => ({ loadWorkAllowanceMonth: vi.fn() }));
vi.mock("./common-forms", () => ({ CommonForms: () => null }));
vi.mock("./store-work", () => ({ StoreWork: () => null }));
vi.mock("./beauty-allowance-work", () => ({ BeautyAllowanceWork: () => null }));
vi.mock("./accounting-forms", () => ({ AccountingForms: () => null }));
vi.mock("./client-update", () => ({
  ClientUpdateNotice: () => null, LoginUpdateNotice: () => null,
  useClientReleaseState: () => ({ status: hooks.releaseStatus }),
}));
vi.mock("./update-drafts", () => ({ UpdateDraftProvider: () => null }));
import { AccountingApp } from "./accounting-app";
import { AccountingForms } from "./accounting-forms";
import { BeautyAllowanceWork } from "./beauty-allowance-work";
import { UpdateDraftProvider } from "./update-drafts";
import { auth } from "@/lib/firebase/client";
import { loadWorkspaceData, userRole } from "@/lib/firebase/repository";
import { loadWorkAllowanceMonth } from "@/lib/firebase/work-allowance-refresh";

type Element = ReactElement<Record<string, any>>; // テストで JSX のイベントを呼び出す。
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function find(node: ReactNode, predicate: (element: Element) => boolean) {
  const result = elements(node).find(predicate);
  if (!result) throw new Error("対象の要素がありません。");
  return result;
}
const button = (node: ReactNode, label: string) => find(node, (item) => item.type === "button" && item.props.children === label);
const provider = (node: ReactNode) => find(node, (item) => item.type === UpdateDraftProvider);
const accounting = (node: ReactNode) => find(node, (item) => item.type === AccountingForms);
function seed(role: Role, view = "home", dirty = false, busy = false) {
  const data = { closings: [] } as unknown as AccountingWorkspaceData;
  hooks.values = [{ uid: "accounting-user", email: "accounting@example.test" }, role, true, data, view, busy, null, 0, dirty];
}
function render() { hooks.cursor = 0; return AccountingApp(); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.production = true; hooks.releaseStatus = "current";
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe.each([true, false])("キャストデータ入力の権限・環境分離（本番=%s）", (production) => {
  beforeEach(() => { hooks.production = production; });
  it.each(["accounting", "op"] as const)("%s はナビから入力画面を開ける", (role) => {
    seed(role);
    const tree = render();
    const nav = find(tree, (item) => item.type === "nav");
    const labels = elements(nav).filter((item) => item.type === "button").map((item) => item.props.children);
    expect(labels.indexOf("キャストデータ入力")).toBe(labels.indexOf("受信・承認") + 1);
    button(tree, "キャストデータ入力").props.onClick();
    expect(accounting(render()).props.section).toBe("castInputs");
  });
  it.each(["accounting", "op"] as const)("%s は同じ環境に退避した入力画面を復元できる", (role) => {
    seed(role);
    const scope = provider(render());
    expect(scope.props.userId).toBe("accounting-user");
    expect(scope.props.environment).toBe(production ? "accounting" : "accounting-dev");
    expect(() => scope.props.onRestoreView("castInputs")).not.toThrow();
    expect(accounting(render()).props.section).toBe("castInputs");
    expect(provider(render()).props.view).toBe("castInputs");
  });
  it("店舗権限ではナビ・直接表示・退避画面の復元を許可しない", () => {
    seed("shop");
    expect(elements(render()).some((item) => item.type === "button" && item.props.children === "キャストデータ入力")).toBe(false);
    expect(() => provider(render()).props.onRestoreView("castInputs")).toThrow("権限");
    seed("shop", "castInputs");
    const tree = render();
    expect(elements(tree).some((item) => item.type === AccountingForms)).toBe(false);
    expect(elements(tree).some((item) => item.props.children === "このフォームへアクセスする権限がありません。")).toBe(true);
  });
  it("存在しない画面の復元を許可しない", () => {
    seed("op");
    expect(() => provider(render()).props.onRestoreView("unknown-view")).toThrow("権限");
    expect(() => provider(render()).props.onRestoreView("__proto__")).toThrow("権限");
  });
  it("未保存入力があるときの画面変更は取消できる", () => {
    seed("accounting", "castRewards", true);
    vi.mocked(window.confirm).mockReturnValue(false);
    button(render(), "キャストデータ入力").props.onClick();
    expect(accounting(render()).props.section).toBe("castRewards");
    vi.mocked(window.confirm).mockReturnValue(true);
    button(render(), "キャストデータ入力").props.onClick();
    expect(accounting(render()).props.section).toBe("castInputs");
  });
  it.each(["current", "update-available", "error"])("公開状態%sによる保存停止を維持する", (status) => {
    seed("op", "castInputs");
    hooks.releaseStatus = status;
    expect(accounting(render()).props.busy).toBe(status !== "current");
    seed("op", "castInputs", false, true);
    expect(accounting(render()).props.busy).toBe(true);
  });
});

describe("美容室手当の店舗作業導線", () => {
  it.each(["shop", "op"] as const)("%sは送迎の次にある美容室手当を開ける", (role) => {
    seed(role);
    const tree = render();
    const nav = find(tree, (item) => item.type === "nav");
    const labels = elements(nav).filter((item) => item.type === "button").map((item) => item.props.children);
    expect(labels.indexOf("美容室手当")).toBe(labels.indexOf("送迎") + 1);
    button(tree, "美容室手当").props.onClick();
    expect(elements(render()).some((item) => item.type === BeautyAllowanceWork)).toBe(true);
  });
  it("経理権限では新画面の直接表示と退避復元を止める", () => {
    seed("accounting");
    expect(elements(render()).some((item) => item.type === "button" && item.props.children === "美容室手当")).toBe(false);
    expect(() => provider(render()).props.onRestoreView("beautyAllowance")).toThrow("権限");
    seed("accounting", "beautyAllowance");
    expect(elements(render()).some((item) => item.type === BeautyAllowanceWork)).toBe(false);
  });
  it("更新待ちの美容室画面に保存停止を伝える", () => {
    seed("shop", "beautyAllowance"); hooks.releaseStatus = "update-available";
    expect(find(render(), (item) => item.type === BeautyAllowanceWork).props.busy).toBe(true);
  });
});

describe("送迎・美容室保存後の部分再読込の安全境界", () => {
  const month = "2026-10";
  const fullData = (extra: Partial<AccountingWorkspaceData> = {}): AccountingWorkspaceData => ({
    casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200000,
    archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [],
    monthStates: [], monthSnapshots: [], ...extra,
  });
  const partialData = (targetMonth = month): WorkAllowanceRefresh => ({
    month: targetMonth, casts: [], archivedCasts: [], drivers: [], closings: [],
    transportSettings: { revision: 1, castRegistrations: {}, remoteAmounts: [] },
    transportMonth: { revision: 1, casts: {}, drivers: {} }, beautyMonth: { revision: 1, casts: {} },
    legacyInputs: [], legacyRemote: {},
  });
  const allowance = (node: ReactNode) => find(node, (item) => item.type === BeautyAllowanceWork);
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const authUser = auth as unknown as { currentUser: { uid: string } | null };
  const workState = () => hooks.values[14] as { current: { month?: string; required: boolean } };
  function seedWork(role: Role = "op") {
    seed(role, "beautyAllowance");
    hooks.values[3] = fullData();
    // 既存harnessはeffectを実行しないため、認証済み状態の各refも明示する。
    hooks.values.push({ current: role }, { current: 1 }, { current: 0 }, { current: false }, { current: false },
      { current: { required: false } });
  }
  const save = (action = vi.fn(async () => undefined)) => allowance(render()).props.run(action, "保存しました", month) as Promise<boolean>;

  beforeEach(() => {
    authUser.currentUser = { uid: "accounting-user" };
    vi.mocked(userRole).mockReset().mockResolvedValue("op");
    vi.mocked(loadWorkspaceData).mockReset().mockResolvedValue(fullData());
    vi.mocked(loadWorkAllowanceMonth).mockReset().mockImplementation(async (targetMonth) => partialData(targetMonth));
    seedWork();
  });
  afterEach(() => { authUser.currentUser = { uid: "accounting-user" }; });

  it("書込成功後は対象月だけを読み直し、成功前には反映しない", async () => {
    const written = deferred<void>();
    const pending = save(vi.fn(() => written.promise));
    expect(loadWorkAllowanceMonth).not.toHaveBeenCalled();
    expect(allowance(render()).props.busy).toBe(true);
    written.resolve(undefined);
    expect(await pending).toBe(true);
    expect(loadWorkAllowanceMonth).toHaveBeenCalledWith(month, "op");
    expect(loadWorkspaceData).not.toHaveBeenCalled();
    expect((hooks.values[3] as AccountingWorkspaceData).beautyMonths?.[month].revision).toBe(1);
    expect(workState().current).toEqual({ month, required: false });
  });

  it("部分更新後の確定状態と旧snapshotを他画面へ渡さず、全体読込の完了を待つ", async () => {
    const partial = partialData();
    partial.monthState = { month, status: "closed", revision: 2 } as NonNullable<WorkAllowanceRefresh["monthState"]>;
    vi.mocked(loadWorkAllowanceMonth).mockResolvedValueOnce(partial);
    await save();
    const next = deferred<AccountingWorkspaceData>();
    vi.mocked(loadWorkspaceData).mockReturnValueOnce(next.promise);
    const navigation = button(render(), "キャスト報酬").props.onClick() as Promise<void>;
    await settle();
    expect(provider(render()).props.view).toBe("beautyAllowance");
    expect((hooks.values[3] as AccountingWorkspaceData).monthSnapshots).toEqual([]);
    const complete = fullData();
    next.resolve(complete);
    await navigation;
    expect(provider(render()).props.view).toBe("castRewards");
    expect(hooks.values[3]).toBe(complete);
    expect(workState().current).toEqual({ month: undefined, required: false });
  });

  it("別月へ切り替えたらその月を取得し、対象月データの完了まで保存を止める", async () => {
    await save();
    const next = deferred<WorkAllowanceRefresh>();
    vi.mocked(loadWorkAllowanceMonth).mockReturnValueOnce(next.promise);
    allowance(render()).props.onScopeChange("2026-11");
    await settle();
    expect(loadWorkAllowanceMonth).toHaveBeenLastCalledWith("2026-11", "op");
    expect(allowance(render()).props.busy).toBe(true);
    const action = vi.fn(async () => undefined);
    expect(await save(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
    next.resolve(partialData("2026-11"));
    await settle();
    expect(workState().current).toEqual({ month: "2026-11", required: false });
    expect(allowance(render()).props.busy).toBe(false);
  });

  it("別月の読込失敗では保存を停止し、古い月の記録で更新しない", async () => {
    await save();
    vi.mocked(loadWorkAllowanceMonth).mockRejectedValueOnce(new Error("通信エラー"));
    allowance(render()).props.onScopeChange("2026-11");
    await settle();
    expect(workState().current.required).toBe(true);
    expect(allowance(render()).props.busy).toBe(true);
    const action = vi.fn(async () => undefined);
    expect(await save(action)).toBe(false);
    expect(action).not.toHaveBeenCalled();
  });

  it("月読込が競合した場合は最新の要求だけを採用し、古い要求の失敗で保存を止めない", async () => {
    await save();
    const november = deferred<WorkAllowanceRefresh>();
    const december = deferred<WorkAllowanceRefresh>();
    vi.mocked(loadWorkAllowanceMonth).mockImplementation((targetMonth) => targetMonth === "2026-11" ? november.promise : december.promise);
    const onScopeChange = allowance(render()).props.onScopeChange;
    onScopeChange("2026-11");
    await settle();
    onScopeChange("2026-12");
    await settle();
    december.resolve(partialData("2026-12"));
    await settle();
    expect(workState().current).toEqual({ month: "2026-12", required: false });
    november.reject(new Error("古い要求の失敗"));
    await settle();
    expect(workState().current).toEqual({ month: "2026-12", required: false });
    expect(allowance(render()).props.busy).toBe(false);
  });

  it("書込後の読込失敗は保存済みと伝え、再保存を拒否して全体読込で復帰する", async () => {
    vi.mocked(loadWorkAllowanceMonth).mockRejectedValueOnce(new Error("読取失敗"));
    const action = vi.fn(async () => undefined);
    expect(await save(action)).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
    expect(hooks.values[6]).toMatchObject({ kind: "error", text: expect.stringContaining("保存は完了しました") });
    expect(workState().current.required).toBe(true);
    expect(await save(action)).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
    button(render(), "最新データを読込").props.onClick();
    await settle();
    expect(loadWorkspaceData).toHaveBeenCalledTimes(1);
    expect(workState().current.required).toBe(false);
    expect(allowance(render()).props.busy).toBe(false);
  });

  it("権限が経理へ変わっていたら部分読込せず全体読込・画面権限を更新する", async () => {
    seedWork("shop");
    vi.mocked(userRole).mockResolvedValueOnce("accounting");
    expect(await save()).toBe(true);
    expect(loadWorkAllowanceMonth).not.toHaveBeenCalled();
    expect(loadWorkspaceData).toHaveBeenCalledWith("accounting");
    expect(provider(render()).props.view).toBe("home");
    expect(hooks.values[1]).toBe("accounting");
    expect(elements(render()).some((item) => item.type === BeautyAllowanceWork)).toBe(false);
  });

  it("書込待機中に認証ユーザーが交代したら旧操作の再読込や成功通知を反映しない", async () => {
    const written = deferred<void>();
    const pending = save(vi.fn(() => written.promise));
    authUser.currentUser = { uid: "next-user" };
    (hooks.values[10] as { current: number }).current++;
    const nextData = fullData({ cashFloat: 300000 });
    hooks.values[0] = { uid: "next-user" };
    hooks.values[3] = nextData;
    hooks.values[6] = { kind: "success", text: "新しいログイン" };
    written.resolve(undefined);
    expect(await pending).toBe(false);
    expect(loadWorkAllowanceMonth).not.toHaveBeenCalled();
    expect(loadWorkspaceData).not.toHaveBeenCalled();
    expect(hooks.values[3]).toBe(nextData);
    expect(hooks.values[6]).toEqual({ kind: "success", text: "新しいログイン" });
  });

  it("部分読込待機中のユーザー交代でも旧データを破棄する", async () => {
    const next = deferred<WorkAllowanceRefresh>();
    vi.mocked(loadWorkAllowanceMonth).mockReturnValueOnce(next.promise);
    const pending = save();
    await settle();
    authUser.currentUser = { uid: "next-user" };
    (hooks.values[10] as { current: number }).current++;
    const nextData = fullData({ cashFloat: 300000 });
    hooks.values[0] = { uid: "next-user" }; hooks.values[3] = nextData;
    next.resolve(partialData());
    expect(await pending).toBe(false);
    expect(hooks.values[3]).toBe(nextData);
    expect(workState().current.required).toBe(false);
  });

  it("保存処理中は画面移動・退避入力の復元・二重保存を拒否する", async () => {
    const written = deferred<void>();
    const pending = save(vi.fn(() => written.promise));
    await button(render(), "キャスト報酬").props.onClick();
    expect(provider(render()).props.view).toBe("beautyAllowance");
    expect(() => provider(render()).props.onRestoreView("castRewards")).toThrow("最新データ");
    const other = vi.fn(async () => undefined);
    expect(await save(other)).toBe(false);
    expect(other).not.toHaveBeenCalled();
    written.resolve(undefined);
    expect(await pending).toBe(true);
  });

  it("部分更新後の退避画面復元は全体読込が済むまで拒否する", async () => {
    await save();
    expect(() => provider(render()).props.onRestoreView("castRewards")).toThrow("最新データ");
    expect(provider(render()).props.view).toBe("beautyAllowance");
  });
});
