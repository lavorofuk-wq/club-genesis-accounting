import { describe, expect, it } from "vitest";
import type { AccountingMonthState, AccountingWorkspaceData } from "./month-accounting";
import type { CastAccountingInput, CastRecord, DailyClosing, MonthlyAdjustments } from "./gms";
import { mergeWorkAllowanceRefresh, type WorkAllowanceRefresh } from "./work-allowance-refresh";
import { transportCastDays } from "./transport";

const month = "2026-10";
const closing = (id: string, businessDate: string) => ({ id, businessDate, status: "approved", casts: [] } as unknown as DailyClosing);
const state = (target: string, status: AccountingMonthState["status"] = "closed") => ({ month: target, status, revision: 1 } as AccountingMonthState);
const adjustment = (target: string, inputs: CastAccountingInput[] = []) => ({ month: target, castInputs: inputs,
  withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 } as MonthlyAdjustments);
const input = (amount: number) => ({ id: "transport_one", castId: "cast_1", castName: "花子", kind: "transport", label: "旧送迎", amount,
  businessDate: month + "-03" } as CastAccountingInput);
const transport = () => ({ revision: 0, casts: {}, drivers: {} });
const beauty = () => ({ revision: 0, casts: {} });
function current(): AccountingWorkspaceData {
  return { casts: [], archivedCasts: [], staff: [], archivedStaff: [], drivers: [], introducers: [], liquor: [],
    closings: [closing("prior", "2026-09-30"), closing("old", month + "-01"), closing("deleted", month + "-02"), closing("next", "2026-11-01")],
    adjustments: [adjustment("2026-09"), adjustment(month, [input(500)])], cashFloat: 200000,
    monthStates: [state("2026-09"), state(month)], monthSnapshots: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [],
    transportMonths: { "2026-09": transport(), [month]: { revision: 5, casts: {}, drivers: {} } },
    beautyMonths: { "2026-09": beauty(), [month]: { revision: 5, casts: {} } },
    transportLegacyInputs: { "2026-09": [], [month]: [input(500)] }, transportLegacyRemote: { "2026-09": { driver_1: 1000 }, [month]: { driver_1: 500 } } };
}
function fresh(): WorkAllowanceRefresh {
  return { month, casts: [], archivedCasts: [], drivers: [], closings: [closing("new", month + "-03")],
    transportSettings: { revision: 0, castRegistrations: {}, remoteAmounts: [] }, transportMonth: transport(), beautyMonth: beauty(), legacyInputs: [], legacyRemote: {} };
}

describe("送迎・美容室の当月更新結果の統合", () => {
  it("当月は削除も含めて置換し、他月の履歴・確定結果・無関係データを保持する", () => {
    const before = current(), next = fresh();
    const original = structuredClone(before), originalFresh = structuredClone(next);
    const merged = mergeWorkAllowanceRefresh(before, next);
    expect(merged.closings.map((row) => row.id)).toEqual(["next", "new", "prior"]);
    expect(merged.closings.find((row) => row.id === "prior")).toBe(before.closings[0]);
    for (const key of ["staff", "archivedStaff", "introducers", "liquor", "monthSnapshots", "introducerEntryEvents", "introducerMonthEvents", "introducerDeletionCommits"] as const) {
      expect(merged[key]).toBe(before[key]);
    }
    expect(merged.cashFloat).toBe(200000);
    expect(before).toEqual(original); expect(next).toEqual(originalFresh);
  });
  it("対象月の履歴が空になれば以前の行を残さない", () => {
    const merged = mergeWorkAllowanceRefresh(current(), { ...fresh(), closings: [] });
    expect(merged.closings.map((row) => row.id)).toEqual(["next", "prior"]);
  });
  it("同一IDが別月の旧表示に残っていても二重化せず新しい月の日次へ置き換える", () => {
    const merged = mergeWorkAllowanceRefresh(current(), { ...fresh(), closings: [closing("prior", month + "-03")] });
    expect(merged.closings.filter((row) => row.id === "prior")).toHaveLength(1);
    expect(merged.closings.find((row) => row.id === "prior")?.businessDate).toBe(month + "-03");
  });
  it("月次状態・経理入力の消失を反映し、別月の状態・金額は保持する", () => {
    const before = current(), merged = mergeWorkAllowanceRefresh(before, fresh());
    expect(merged.monthStates).toEqual([before.monthStates[0]]);
    expect(merged.adjustments).toEqual([before.adjustments[0]]);
    expect(merged.transportMonths?.[month]).toEqual(transport());
    expect(merged.beautyMonths?.[month]).toEqual(beauty());
    expect(merged.transportLegacyInputs?.[month]).toEqual([]);
    expect(merged.transportLegacyRemote?.[month]).toEqual({});
    expect(merged.transportMonths?.["2026-09"]).toBe(before.transportMonths?.["2026-09"]);
    expect(merged.beautyMonths?.["2026-09"]).toBe(before.beautyMonths?.["2026-09"]);
    expect(merged.transportLegacyInputs?.["2026-09"]).toBe(before.transportLegacyInputs?.["2026-09"]);
    expect(merged.transportLegacyRemote?.["2026-09"]).toBe(before.transportLegacyRemote?.["2026-09"]);
  });
  it("当月の確定状態・マスタと月次入力を最新へ置き換える", () => {
    const next = fresh();
    next.monthState = state(month, "closing"); next.adjustment = adjustment(month, [input(1000)]);
    next.casts = [{ id: "fresh_cast" } as CastRecord];
    next.archivedCasts = [{ id: "archived_cast" } as CastRecord];
    const merged = mergeWorkAllowanceRefresh(current(), next);
    expect(merged.monthStates.find((row) => row.month === month)).toBe(next.monthState);
    expect(merged.adjustments.find((row) => row.month === month)).toBe(next.adjustment);
    expect(merged.casts).toBe(next.casts); expect(merged.archivedCasts).toBe(next.archivedCasts); expect(merged.drivers).toBe(next.drivers);
  });
  it("OPの経理入力を更新し、古いadjustmentsが新しい旧送迎データを隠さない", () => {
    const next = fresh(); next.legacyInputs = [input(1500)]; next.adjustment = adjustment(month, [input(1500)]);
    const merged = mergeWorkAllowanceRefresh(current(), next);
    expect(transportCastDays(merged, month, "cast_1").find((row) => row.businessDate === month + "-03")?.amount).toBe(1500);
  });
  it("店舗用更新は当月の経理入力を残さず、店舗に許可された送迎子データを利用する", () => {
    const next = fresh(); next.legacyInputs = [input(1000)];
    const merged = mergeWorkAllowanceRefresh(current(), next);
    expect(merged.adjustments.some((row) => row.month === month)).toBe(false);
    expect(transportCastDays(merged, month, "cast_1").find((row) => row.businessDate === month + "-03")?.amount).toBe(1000);
  });
  it.each(["", "2026-0", "2026-00", "2026-13", "2026-10-01", "../history"])("不正な対象月%sを拒否する", (value) => {
    expect(() => mergeWorkAllowanceRefresh(current(), { ...fresh(), month: value })).toThrow("対象月");
  });
  it("他月の履歴・月次状態・経理入力の混在を拒否する", () => {
    for (const patch of [{ closings: [closing("wrong", "2026-11-01")] }, { monthState: state("2026-11") }, { adjustment: adjustment("2026-11") }]) {
      expect(() => mergeWorkAllowanceRefresh(current(), { ...fresh(), ...patch })).toThrow("対象月");
    }
  });
});
