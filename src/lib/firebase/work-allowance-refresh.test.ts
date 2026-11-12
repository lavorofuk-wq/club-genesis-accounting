import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CastAccountingInput, DailyClosing, Role } from "@/domain/gms";
import { mergeWorkAllowanceRefresh } from "@/domain/work-allowance-refresh";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { transportCastDays } from "@/domain/transport";

type Constraint = { type: "order" | "start" | "end" | "equal"; value: string };
type Reference = { path: string; constraints?: Constraint[] };
const memory = vi.hoisted(() => ({ values: new Map<string, unknown>(), get: vi.fn(), rootRef: vi.fn(), update: vi.fn(), set: vi.fn() }));
vi.mock("firebase/database", () => ({ get: memory.get, update: memory.update, set: memory.set,
  query: (reference: Reference, ...constraints: Constraint[]) => ({ ...reference, constraints }),
  orderByChild: (value: string): Constraint => ({ type: "order", value }),
  startAt: (value: string): Constraint => ({ type: "start", value }),
  endAt: (value: string): Constraint => ({ type: "end", value }),
  equalTo: (value: string): Constraint => ({ type: "equal", value }),
}));
vi.mock("./client", () => ({ rootRef: memory.rootRef }));
import { loadWorkAllowanceMonth } from "./work-allowance-refresh";

const month = "2026-10";
const input = (id = "transport_input", kind: CastAccountingInput["kind"] = "transport") => ({ id, castId: "cast_1", castName: "花子",
  kind, label: "旧送迎", amount: 1000, ...(kind === "sales" ? { businessDate: month + "-01" } : {}) } as CastAccountingInput);
const closing = (businessDate: string, status: DailyClosing["status"] = "approved") => ({ businessDate, status, submissionId: "submitted", checksum: "a".repeat(64),
  sales: { totalSales: 0, cashSales: 0, cardSales: 0 },
  cash: { totalSales: 0, cashSales: 0, cardSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0,
    expectedClosingCash: 200000, actualClosingCash: 200000, cashProfit: 0, difference: 0 },
  casts: [{ masterId: "cast_1", posCastId: "pos_1", name: "花子", kind: "regular", hours: 1, hourlyRate: 3000, startTime: "20:00", endTime: "21:00",
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0,
    liquorCost: 0, beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0, bottles: [], drinkAllocations: [] }],
  staffWork: [], drivers: [], expenses: [],
});

beforeEach(() => {
  vi.clearAllMocks(); memory.values.clear();
  memory.rootRef.mockImplementation((path: string) => ({ path }));
  memory.values.set("casts", { cast_1: { id: "wrong_stored_id", name: "花子", status: "active", hourlyRates: { [month]: 3000 } },
    deleted: { name: "削除済み", deletedAt: "2026-10-01T00:00:00Z", status: "departed" },
    cancelled: { name: "入店取消", deletedAt: "2026-10-01T00:00:00Z", entryCancelledAt: "2026-10-01T00:00:00Z", status: "departed" } });
  memory.values.set("drivers", { driver_1: { id: "wrong_driver", name: "運転手", status: "active" } });
  memory.values.set("history", { before: closing("2026-09-30"), first: closing(month + "-01"), last: closing(month + "-31"), after: closing("2026-11-01") });
  memory.values.set(`accountingMonthStates/${month}`, { month: "wrong_month", status: "open", revision: 2 });
  memory.values.set(`accountingAdjustments/${month}`, { month: "wrong_month", castInputs: { transport_input: input(), sale_input: input("sale_input", "sales") },
    withholdingByCast: { cast_1: 12345 }, driverRemoteAllowance: { driver_1: 2000 }, revision: 3 });
  memory.values.set(`accountingAdjustments/${month}/castInputs`, { transport_input: input(), sale_input: input("sale_input", "sales") });
  memory.values.set(`accountingAdjustments/${month}/driverRemoteAllowance`, { driver_1: 2000 });
  memory.get.mockImplementation(async ({ path, constraints }: Reference) => {
    let value = structuredClone(memory.values.get(path) ?? null);
    if (constraints) {
      const order = constraints.find((row) => row.type === "order")?.value;
      const start = constraints.find((row) => row.type === "start")?.value;
      const end = constraints.find((row) => row.type === "end")?.value;
      const equal = constraints.find((row) => row.type === "equal")?.value;
      value = Object.fromEntries(Object.entries((value || {}) as Record<string, Record<string, unknown>>).filter(([, row]) => {
        const field = String(row[order!]);
        return (start === undefined || field >= start) && (end === undefined || field <= end) && (equal === undefined || field === equal);
      }));
    }
    return { val: () => value, exists: () => value !== null };
  });
});
const references = () => memory.get.mock.calls.map(([reference]) => reference as Reference);
const paths = () => references().map((reference) => reference.path);

describe("送迎・美容室の保存後の月限定再読込", () => {
  it("店舗は経理入力全体や源泉情報を取得せず、送迎子パスだけ取得する", async () => {
    const result = await loadWorkAllowanceMonth(month, "shop");
    expect(paths()).toContain(`accountingAdjustments/${month}/castInputs`);
    expect(paths()).toContain(`accountingAdjustments/${month}/driverRemoteAllowance`);
    expect(paths()).not.toContain(`accountingAdjustments/${month}`);
    expect(result.adjustment).toBeUndefined();
    expect(result.legacyInputs).toEqual([input()]);
    expect(result.legacyRemote).toEqual({ driver_1: 2000 });
    expect(references().find((row) => row.path.endsWith("/castInputs"))?.constraints).toEqual([
      { type: "order", value: "kind" }, { type: "equal", value: "transport" },
    ]);
    expect(memory.get).toHaveBeenCalledTimes(9);
  });
  it("OPは当月の経理入力を一度取得し、保存前の入力を優先させない", async () => {
    const result = await loadWorkAllowanceMonth(month, "op");
    expect(paths()).toContain(`accountingAdjustments/${month}`);
    expect(paths()).not.toContain(`accountingAdjustments/${month}/castInputs`);
    expect(paths()).not.toContain(`accountingAdjustments/${month}/driverRemoteAllowance`);
    expect(result.adjustment?.month).toBe(month);
    expect(result.adjustment?.withholdingByCast).toEqual({ cast_1: 12345 });
    expect(result.adjustment?.castInputs).toEqual([input(), input("sale_input", "sales")]);
    expect(result.legacyRemote).toEqual({ driver_1: 2000 });
    expect(memory.get).toHaveBeenCalledTimes(8);
  });
  it.each(["shop", "op"] as const)("%sでは履歴を月範囲だけ読み、全月記録・他マスタ・確定帳票を取得しない", async (role) => {
    const result = await loadWorkAllowanceMonth(month, role);
    expect(result.closings.map((row) => row.id)).toEqual(["first", "last"]);
    expect(result.monthState).toMatchObject({ month, status: "open", revision: 2 });
    expect(references().find((row) => row.path === "history")?.constraints).toEqual([
      { type: "order", value: "businessDate" }, { type: "start", value: month + "-01" }, { type: "end", value: month + "-31" },
    ]);
    for (const path of ["transportMonths", "beautyMonths", "accountingMonthStates", "accountingAdjustments", "accountingMonthSnapshots", "staff", "liquorCosts", "introducers"]) {
      expect(paths()).not.toContain(path);
    }
    expect(memory.update).not.toHaveBeenCalled(); expect(memory.set).not.toHaveBeenCalled();
  });
  it("店舗は入店取消分だけ、OPは全削除キャストを保存済み表示用に保持する", async () => {
    const shop = await loadWorkAllowanceMonth(month, "shop"), op = await loadWorkAllowanceMonth(month, "op");
    expect(shop.casts.map((row) => row.id)).toEqual(["cast_1"]);
    expect(shop.archivedCasts.map((row) => row.id)).toEqual(["cancelled"]);
    expect(op.archivedCasts.map((row) => row.id)).toEqual(["deleted", "cancelled"]);
    expect(shop.drivers[0].id).toBe("driver_1");
  });
  it.each(["shop", "op"] as const)("%sで月データがなくなったら未登録・未確定として返す", async (role) => {
    memory.values.clear();
    const result = await loadWorkAllowanceMonth(month, role);
    expect(result.closings).toEqual([]); expect(result.casts).toEqual([]); expect(result.drivers).toEqual([]);
    expect(result.monthState).toBeUndefined(); expect(result.adjustment).toBeUndefined();
    expect(result.transportMonth).toEqual({ revision: 0, casts: {}, drivers: {} });
    expect(result.beautyMonth).toEqual({ revision: 0, casts: {} });
    expect(result.legacyInputs).toEqual([]); expect(result.legacyRemote).toEqual({});
  });
  it("月限定読込でも日付未指定の旧送迎を対象月の最終承認出勤日に付ける", async () => {
    const result = await loadWorkAllowanceMonth(month, "shop");
    const empty = { casts: [], archivedCasts: [], drivers: [], closings: [], adjustments: [], monthStates: [],
      staff: [], archivedStaff: [], introducers: [], liquor: [], cashFloat: 0,
      monthSnapshots: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [] } as AccountingWorkspaceData;
    const merged = mergeWorkAllowanceRefresh(empty, result);
    expect(transportCastDays(merged, month, "cast_1").map((row) => [row.businessDate, row.amount])).toEqual([
      [month + "-01", 0], [month + "-31", 1000],
    ]);
  });
  it.each(["2026-01", "2026-12", "2024-02"])("月境界%sでも同じ月をすべてのパスへ使用する", async (target) => {
    memory.values.clear(); await loadWorkAllowanceMonth(target, "shop");
    for (const path of paths().filter((path) => /^(transportMonths|beautyMonths|accountingMonthStates|accountingAdjustments)\//.test(path))) {
      expect(path.split("/")[1]).toBe(target);
    }
    expect(references().find((row) => row.path === "history")?.constraints?.slice(1)).toEqual([
      { type: "start", value: target + "-01" }, { type: "end", value: target + "-31" },
    ]);
  });
  it.each(["", "2026-00", "2026-13", "2026-1", "2026-10-01", "../history"])("不正な月%sは読取前に拒否する", async (target) => {
    await expect(loadWorkAllowanceMonth(target, "shop")).rejects.toThrow("対象月");
    expect(memory.rootRef).not.toHaveBeenCalled(); expect(memory.get).not.toHaveBeenCalled();
  });
  it.each(["accounting", "unknown"])("権限%sでは読取を開始しない", async (role) => {
    await expect(loadWorkAllowanceMonth(month, role as Role)).rejects.toThrow("権限");
    expect(memory.rootRef).not.toHaveBeenCalled(); expect(memory.get).not.toHaveBeenCalled();
  });
  it("部分読取の失敗を空データで成功にせず呼出元へ返す", async () => {
    const implementation = memory.get.getMockImplementation()!, failure = new Error("PERMISSION_DENIED");
    memory.get.mockImplementation((reference: Reference) => reference.path === `beautyMonths/${month}` ? Promise.reject(failure) : implementation(reference));
    await expect(loadWorkAllowanceMonth(month, "shop")).rejects.toBe(failure);
    expect(memory.update).not.toHaveBeenCalled(); expect(memory.set).not.toHaveBeenCalled();
  });
  it("不正な保存済み手当を黙って捨てず更新停止する", async () => {
    memory.values.set(`beautyMonths/${month}`, { revision: -1 });
    await expect(loadWorkAllowanceMonth(month, "shop")).rejects.toThrow("保存世代");
  });
});
