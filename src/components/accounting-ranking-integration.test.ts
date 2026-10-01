import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CastRecord, MonthlyAdjustments } from "@/domain/gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting, type AccountingWorkspaceData } from "@/domain/month-accounting";
import { buildCastSalesRanking } from "@/domain/cast-sales-ranking";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effects: [] as Array<() => unknown>,
  drafts: new Map<string, unknown>(), production: false,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index], (value: T) => { hooks.values[index] = value; }];
    },
    useEffect: (effect: () => unknown) => { hooks.effects.push(effect); },
    useMemo: <T,>(factory: () => T) => factory(),
  };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T | (() => T)) => {
    if (!hooks.drafts.has(key)) hooks.drafts.set(key, typeof initial === "function" ? (initial as () => T)() : initial);
    return [hooks.drafts.get(key), (value: T | ((old: T) => T)) => hooks.drafts.set(key, typeof value === "function" ? (value as (old: T) => T)(hooks.drafts.get(key) as T) : value)];
  },
  useUpdateDraftBusy: () => undefined,
}));
vi.mock("@/lib/firebase/client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/firebase/client")>(),
  environmentRoot: () => hooks.production ? "accounting" : "accounting-dev",
}));
vi.mock("@/lib/firebase/repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/firebase/repository")>(),
  finalizeAccountingMonth: vi.fn(),
}));
import { finalizeAccountingMonth } from "@/lib/firebase/repository";
import { AccountingForms, CastSalesExport } from "./accounting-forms";
import { CastSalesRankingExport } from "./cast-sales-ranking-export";

type Element = ReactElement<Record<string, any>>;
type Section = Parameters<typeof AccountingForms>[0]["section"];
const month = "2026-09";
const base: MonthlyAdjustments = { month, revision: 1, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 };
const user = { uid: "test-accounting" } as never;
const run = vi.fn(async (action: () => Promise<unknown>) => { await action(); return true; });
function cast(id: string, name: string, overrides: Partial<CastRecord> = {}): CastRecord {
  return { id, name, legalName: "", status: "active", hiredAt: "2026-09-01", hourlyRates: { [month]: 3000 }, note: "", createdAt: "2026-09-01", updatedAt: "2026-09-01", ...overrides };
}
function fixture(): AccountingWorkspaceData {
  return { casts: [cast("zero", "出勤なし")], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [base], cashFloat: 200000,
    archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], monthStates: [], monthSnapshots: [] };
}
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode), ...elements(element.props.action as ReactNode)];
}
function renderOnce(data: AccountingWorkspaceData, section: Section = "castSales", busy = false) {
  hooks.cursor = 0; hooks.effects = [];
  const element = AccountingForms({ section, data, user, busy, run });
  const tree = (element.type as (props: typeof element.props) => ReactNode)(element.props);
  for (const effect of hooks.effects) effect();
  return tree;
}
function render(data: AccountingWorkspaceData, section: Section = "castSales", busy = false) {
  renderOnce(data, section, busy);
  return renderOnce(data, section, busy);
}
function ranking(tree: ReactNode) {
  return elements(tree).find((row) => row.type === CastSalesRankingExport);
}
function finalize(tree: ReactNode) {
  const button = elements(tree).find((row) => row.type === "button" && row.props.children === "月次確定");
  if (!button) throw new Error("月次確定ボタンが見つかりません。");
  return button;
}
function closeMonth(data: AccountingWorkspaceData, withRoster: boolean) {
  const snapshot = buildMonthlySnapshot(month, 1, "saved-fingerprint", base, calculateMonthlyAccounting(data, month, base), [], "test", "2026-09-30T00:00:00.000Z",
    withRoster ? { schemaVersion: 1, entries: [{ id: "zero", name: "確定時の名前" }] } : undefined);
  data.monthStates = [{ month, status: "closed", revision: 1, currentSnapshotRevision: 1, updatedAt: "2026-09-30", updatedBy: "test" }];
  data.monthSnapshots = [snapshot];
  return snapshot;
}
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.drafts.clear(); hooks.production = false;
  hooks.drafts.set("accounting.monthly.month", month);
  run.mockClear(); vi.mocked(finalizeAccountingMonth).mockReset().mockResolvedValue(1);
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
});
afterEach(() => vi.unstubAllGlobals());

describe("キャスト売上順位表の月次画面統合", () => {
  it("初回描画は環境を推測せず非表示、dev判定後だけ表示する", () => {
    const data = fixture();
    expect(ranking(renderOnce(data))).toBeUndefined();
    expect(ranking(renderOnce(data))).toBeDefined();
  });

  it("本番では順位表を表示せず、既存キャスト別売上出力を維持する", () => {
    hooks.production = true;
    const tree = render(fixture());
    expect(ranking(tree)).toBeUndefined();
    expect(elements(tree).filter((row) => row.type === CastSalesExport)).toHaveLength(1);
  });

  it.each(["castRewards", "introducers", "staffPayroll", "driverPayroll", "expenses", "balance"] as Section[])("%s画面へ順位表ボタンを増やさない", (section) => {
    expect(ranking(render(fixture(), section))).toBeUndefined();
  });

  it("承認済み出勤が0件でも名簿の在籍者を0円で出力可能にし、体入は名簿に補わない", () => {
    const data = fixture();
    data.casts.push(cast("trial", "体入", { status: "trial", trialDate: "2026-09-01" }));
    const tree = render(data);
    const output = ranking(tree)!;
    expect(output.props.disabledReason).toBe("");
    expect(output.props.roster).toEqual({ schemaVersion: 1, entries: [{ id: "zero", name: "出勤なし" }] });
    const built = buildCastSalesRanking(output.props.results, output.props.month, output.props.roster);
    expect(built.rosterMissing).toBe(false);
    expect(built.rows).toMatchObject([{ id: "zero", totalSales: 0, hours: 0, rank: 1 }]);
    const original = elements(tree).find((row) => row.type === CastSalesExport)!;
    expect(original.props.disabledReason).toBe("対象月の承認済みキャスト売上がありません。");
  });

  it("確定済み月は現在の名簿・名前・入店者を取り込まず保存名簿を出力する", () => {
    const data = fixture(); const snapshot = closeMonth(data, true);
    data.casts[0].name = "現在の名前";
    data.casts.push(cast("new", "後日登録された人"));
    const output = ranking(render(data))!;
    expect(output.props.roster).toBe(snapshot.castSalesRankingRoster);
    expect(output.props.results).toBe(snapshot);
    expect(output.props.sourceLabel).toBe("月次確定済み 第1版");
    const built = buildCastSalesRanking(output.props.results, month, output.props.roster);
    expect(built.rows.map((row) => row.name)).toEqual(["確定時の名前"]);
  });

  it("旧確定月の未保存名簿を現在のマスタから補わない", () => {
    const data = fixture(); const snapshot = closeMonth(data, false);
    const before = structuredClone(snapshot);
    const output = ranking(render(data))!;
    expect(output.props.roster).toBeUndefined();
    expect(output.props.results).toBe(snapshot);
    expect(buildCastSalesRanking(output.props.results, month, output.props.roster).rosterMissing).toBe(true);
    expect(snapshot).toEqual(before);
  });

  it("対象月を切り替えるとその月の名簿へ切り替える", () => {
    const data = fixture();
    data.casts.push(cast("october", "10月入店", { hiredAt: "2026-10-01" }));
    expect(ranking(render(data))!.props.roster.entries.map((entry: { id: string }) => entry.id)).toEqual(["zero"]);
    hooks.drafts.set("accounting.monthly.month", "2026-10");
    const output = ranking(render(data))!;
    expect(output.props.month).toBe("2026-10");
    expect(output.props.roster.entries.map((entry: { id: string }) => entry.id)).toEqual(["october", "zero"]);
  });

  it.each([false, true])("確定payloadの名簿保存はdevのみ（本番=%s）", async (production) => {
    hooks.production = production;
    const data = fixture(); const before = structuredClone(data);
    const tree = render(data);
    expect(finalize(tree).props.disabled).toBe(false);
    finalize(tree).props.onClick();
    await vi.waitFor(() => expect(finalizeAccountingMonth).toHaveBeenCalledOnce());
    const [savedMonth, payload, revision, savedUser] = vi.mocked(finalizeAccountingMonth).mock.calls[0];
    expect(savedMonth).toBe(month); expect(revision).toBe(0); expect(savedUser).toBe(user);
    if (production) expect(payload).not.toHaveProperty("castSalesRankingRoster");
    else expect(payload.castSalesRankingRoster).toEqual({ schemaVersion: 1, entries: [{ id: "zero", name: "出勤なし" }] });
    expect(payload.castRewards).toEqual([]);
    expect(payload.castSalesReports).toEqual([]);
    expect(data).toEqual(before);
  });

  it("devで名簿を検証できなければ順位表出力・確定の両方を止める", () => {
    const data = fixture(); delete data.casts[0].hiredAt;
    const tree = render(data);
    expect(ranking(tree)!.props.disabledReason).toContain("採用日を確認できない");
    expect(finalize(tree).props.disabled).toBe(true);
    finalize(tree).props.onClick();
    expect(finalizeAccountingMonth).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("名簿追加検証が本番の既存確定を阻害しない", async () => {
    hooks.production = true;
    const data = fixture(); delete data.casts[0].hiredAt;
    const tree = render(data);
    expect(finalize(tree).props.disabled).toBe(false);
    finalize(tree).props.onClick();
    await vi.waitFor(() => expect(finalizeAccountingMonth).toHaveBeenCalledOnce());
    expect(vi.mocked(finalizeAccountingMonth).mock.calls[0][1]).not.toHaveProperty("castSalesRankingRoster");
  });

  it("devの空名簿も確定payloadへ保存し未保存と区別する", async () => {
    const data = fixture(); data.casts = [];
    finalize(render(data)).props.onClick();
    await vi.waitFor(() => expect(finalizeAccountingMonth).toHaveBeenCalledOnce());
    expect(vi.mocked(finalizeAccountingMonth).mock.calls[0][1].castSalesRankingRoster).toEqual({ schemaVersion: 1, entries: [] });
  });

  it.each(["busy", "dirty", "stale", "closing"] as const)("%sでは順位表出力も停止する", (condition) => {
    const data = fixture(); render(data);
    if (condition === "dirty") hooks.drafts.set("accounting.monthly.adjustments", { ...base, cardFee: 10 });
    if (condition === "stale") { hooks.drafts.set("accounting.monthly.adjustments", { ...base, cardFee: 10 }); data.adjustments = [{ ...base, revision: 2 }]; }
    if (condition === "closing") data.monthStates = [{ month, status: "closing", revision: 1, currentSnapshotRevision: 0, updatedAt: "2026-09-30", updatedBy: "test" }];
    expect(ranking(render(data, "castSales", condition === "busy"))!.props.disabledReason).not.toBe("");
  });
});
