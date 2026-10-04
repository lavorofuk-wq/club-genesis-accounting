import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

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
