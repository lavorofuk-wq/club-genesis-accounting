import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { CastRecord, DailyCast, DailyClosing } from "@/domain/gms";
import type { BeautyMonth } from "@/domain/beauty-allowance";

const memory = vi.hoisted(() => ({ values: new Map<string, unknown>(), get: vi.fn(), update: vi.fn(), release: vi.fn() }));
vi.mock("firebase/database", () => ({ get: memory.get, ref: (_db: unknown, path: string) => ({ path }),
  query: (reference: unknown) => reference, orderByChild: vi.fn(), equalTo: vi.fn(),
  set: vi.fn(), update: memory.update, onValue: vi.fn(), serverTimestamp: vi.fn() }));
vi.mock("./client", () => ({ database: {}, rootRef: (path = "") => ({ path }) }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: vi.fn() }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: memory.release }));
import { saveBeautyAllowanceDay, loadWorkspaceData } from "./repository";

const month = "2026-09", date = "2026-09-02", monthPath = "beautyMonths/" + month, user = { uid: "shop_user" } as User;
const cast = (extra: Partial<CastRecord> = {}): CastRecord => ({ id: "cast_1", name: "テスト",
  status: "active", hiredAt: "2026-08-01", hourlyRates: { [month]: 3000 }, ...extra } as CastRecord);
const dailyCast = (extra: Partial<DailyCast> = {}): DailyCast => ({ posCastId: "pos_1", masterId: "cast_1",
  name: "テスト", kind: "regular", startTime: "20:00", endTime: "21:00", hours: 1, hourlyRate: 3000,
  honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
  honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, bottles: [], liquorCost: 0,
  beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0, ...extra });
const closing = (extra: Partial<DailyClosing> = {}): DailyClosing => ({
  id: "daily_20260902", businessDate: date, status: "submitted",
  submissionId: "submission_1", checksum: "a".repeat(64), updatedAt: "2026-09-03T01:00:00Z",
  sales: { totalSales: 10000, cashSales: 10000, cardSales: 0 }, customers: { groupCount: 1, totalCustomers: 1 },
  nominations: { honShimeiCount: 0, jonaiCount: 0 }, casts: [dailyCast()], staffWork: [], drivers: [], expenses: [],
  staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
  cash: { cashSales: 10000, cardSales: 0, totalSales: 10000, cashFloat: 200000, expenseAndPaymentTotal: 0,
    expectedClosingCash: 210000, actualClosingCash: 210000, cashProfit: 10000, difference: 0 }, ...extra,
} as DailyClosing);
const seed = (rows: DailyClosing[] = [closing()], masters: CastRecord[] = [cast()]) => {
  memory.values.set("history", Object.fromEntries(rows.map((row) => [row.id, row])));
  memory.values.set("casts", Object.fromEntries(masters.map((row) => [row.id, row])));
};
const records = () => memory.values.get(monthPath) as BeautyMonth;
const save = (eligible: boolean, revision = 0) => saveBeautyAllowanceDay(month, "cast_1", date, eligible, revision, user);

beforeEach(() => {
  vi.clearAllMocks(); memory.values.clear(); memory.release.mockResolvedValue(undefined);
  memory.values.set("users/shop_user/role", "shop"); seed();
  memory.get.mockImplementation(async ({ path }: { path: string }) => ({ val: () => structuredClone(memory.values.get(path) ?? null) }));
  memory.update.mockImplementation(async (_reference: unknown, patch: Record<string, unknown>) => {
    const current = structuredClone(memory.values.get(monthPath) || {}) as Record<string, unknown>;
    if (patch[monthPath + "/revision"] !== Number(current.revision || 0) + 1) throw new Error("PERMISSION_DENIED");
    for (const [key, value] of Object.entries(patch)) {
      const segments = key.slice(monthPath.length + 1).split("/"); let parent = current;
      for (const segment of segments.slice(0, -1)) { parent[segment] ??= {}; parent = parent[segment] as Record<string, unknown>; }
      parent[segments.at(-1)!] = structuredClone(value);
    }
    memory.values.set(monthPath, current);
  });
});

describe("美容室手当の保存境界", () => {
  it.each(["submitted", "approved"] as const)("%sの本人の在籍出勤日に可・否を保存する", async (status) => {
    seed([closing({ status })]);
    await save(true);
    expect(records()).toMatchObject({ revision: 1, updatedBy: user.uid,
      casts: { cast_1: { [date]: { eligible: true, attendanceClosingId: "daily_20260902", attendanceIndex: 0, attendancePosCastId: "pos_1" } } } });
    await save(false, 1);
    expect(records().casts.cast_1[date].eligible).toBe(false);
  });
  it("旧日次500円を否へ訂正しても日次原本と体入現金経費を変更しない", async () => {
    seed([closing({ casts: [dailyCast({ beautyAllowance: 500 }), dailyCast({ masterId: "trial_1", kind: "trial" })],
      expenses: [{ id: "beauty_trial", category: "beautyTrial", payee: "体入", amount: 800, castId: "trial_1" }] as unknown as DailyClosing["expenses"] })]);
    const before = structuredClone(memory.values.get("history"));
    await save(false);
    expect(records().casts.cast_1[date].eligible).toBe(false);
    expect(memory.values.get("history")).toEqual(before);
    expect(memory.update.mock.calls[0][1]).not.toHaveProperty("history");
  });
  it("未登録の在籍出勤日にも否を保存できる", async () => {
    await save(false);
    expect(records().casts.cast_1[date].eligible).toBe(false);
  });
  it.each(["returned", "withdrawn"] as const)("%sの新規指定は可・否とも拒否する", async (status) => {
    seed([closing({ status })]);
    await expect(save(true)).rejects.toThrow("出勤");
    await expect(save(false)).rejects.toThrow("出勤");
    expect(memory.update).not.toHaveBeenCalled();
  });
  it("出勤取消後は保存済み・旧日次の手当を否へ訂正できる", async () => {
    await save(true); seed([]);
    await expect(save(true, 1)).rejects.toThrow("出勤");
    await save(false, 1);
    expect(records().casts.cast_1[date]).toMatchObject({ eligible: false, attendanceClosingId: "daily_20260902" });
    memory.values.delete(monthPath);
    seed([closing({ status: "returned", casts: [dailyCast({ beautyAllowance: 500 })] })]);
    await save(false);
    expect(records().casts.cast_1[date].eligible).toBe(false);
  });
  it.each(["sameId", "conversion"] as const)("同月在籍化でも体入日には可・否とも登録しない（%s）", async (mode) => {
    seed([closing({ casts: [dailyCast({ kind: "trial", masterId: mode === "sameId" ? "cast_1" : "trial_1" })] })],
      [cast({ hiredAt: "2026-09-03", convertedFromTrialId: "trial_1" }), cast({ id: "trial_1", status: "trial", convertedToCastId: "cast_1" })]);
    await expect(save(true)).rejects.toThrow("体入日");
    await expect(save(false)).rejects.toThrow("体入日");
    expect(memory.update).not.toHaveBeenCalled();
  });
  it.each(["accounting", "unknown"])("%s権限で変更できない", async (role) => {
    memory.values.set("users/shop_user/role", role);
    await expect(save(true)).rejects.toThrow();
    expect(memory.update).not.toHaveBeenCalled();
  });
  it("OP権限で記録できる", async () => {
    memory.values.set("users/shop_user/role", "op"); await save(true);
    expect(records().revision).toBe(1);
  });
  it.each(["closed", "closing"])("%s月は旧記録も変更できない", async (status) => {
    seed([closing({ casts: [dailyCast({ beautyAllowance: 500 })] })]);
    memory.values.set("accountingMonthStates/" + month, { status });
    await expect(save(false)).rejects.toThrow("確定");
    expect(memory.update).not.toHaveBeenCalled();
  });
  it("退店者は新規可を拒否し、保存済み可の参照修復と否への訂正を許可する", async () => {
    seed([closing()], [cast({ status: "departed" })]);
    await expect(save(true)).rejects.toThrow("在籍");
    seed(); await save(true);
    seed([closing({ casts: [dailyCast({ masterId: "other" }), dailyCast()] })], [cast({ status: "departed" })]);
    await save(true, 1);
    expect(records().casts.cast_1[date]).toMatchObject({ eligible: true, attendanceIndex: 1 });
    await save(false, 2);
    await expect(save(true, 3)).rejects.toThrow("在籍");
  });
  it("削除済みキャストの可を拒否し、保存済み記録の否への訂正は許可する", async () => {
    await save(true); seed([closing()], [cast({ deletedAt: "2026-09-03T00:00:00Z" })]);
    await expect(save(true, 1)).rejects.toThrow("在籍");
    await save(false, 1);
    expect(records().casts.cast_1[date].eligible).toBe(false);
  });
  it("不正な月・日付・ID・版番号・可否型を保存しない", async () => {
    for (const args of [
      ["2026-13", "cast_1", date, true, 0], [month, "cast_1", "2026-09-31", true, 0],
      [month, "cast_1", "2026-10-02", true, 0], [month, "cast/1", date, true, 0],
      [month, "cast_1", date, true, -1], [month, "cast_1", date, 500, 0],
    ]) await expect(saveBeautyAllowanceDay(args[0] as string, args[1] as string, args[2] as string, args[3] as boolean, args[4] as number, user)).rejects.toThrow();
    expect(memory.update).not.toHaveBeenCalled();
  });
  it("古い版による上書きを拒否する", async () => {
    await save(true);
    await expect(save(false)).rejects.toThrow("別の端末");
    expect(records().casts.cast_1[date].eligible).toBe(true);
  });
  it("読込後の競合もCASで拒否し競合先の記録を保持する", async () => {
    const apply = memory.update.getMockImplementation()!;
    memory.update.mockImplementationOnce(async (reference, patch) => {
      memory.values.set(monthPath, { revision: 1, casts: { cast_1: { [date]: { eligible: false, attendanceClosingId: "daily_20260902", attendanceIndex: 0, attendancePosCastId: "pos_1" } } } });
      return apply(reference, patch);
    });
    await expect(save(true)).rejects.toThrow("保存結果");
    expect(records().casts.cast_1[date].eligible).toBe(false);
  });
  it.each(["shop", "accounting", "op"] as const)("%sのワークスペースにfalseを含む新記録を読み込む", async (role) => {
    memory.values.set("beautyMonths", { [month]: { revision: 2, casts: { cast_1: { [date]: {
      eligible: false, attendanceClosingId: "daily_20260902", attendanceIndex: 0, attendancePosCastId: "pos_1" } } } } });
    const data = await loadWorkspaceData(role);
    expect(data.beautyMonths?.[month].casts.cast_1[date].eligible).toBe(false);
  });
  it("本人出勤の重複時は新規可否を拒否し保存済み記録の取消だけ許可する", async () => {
    seed([closing({ casts: [dailyCast(), dailyCast({ posCastId: "pos_2" })] })]);
    await expect(save(true)).rejects.toThrow("重複");
    await expect(save(false)).rejects.toThrow("重複");
    seed(); await save(true);
    seed([closing({ casts: [dailyCast(), dailyCast({ posCastId: "pos_2" })] })]);
    await expect(save(true, 1)).rejects.toThrow("重複");
    await save(false, 1);
    expect(records().casts.cast_1[date]).toMatchObject({ eligible: false, attendanceIndex: 0, attendancePosCastId: "pos_1" });
  });
  it("出勤取消後の旧元行も一意でなければ推測してfalseを作らない", async () => {
    seed([closing({ status: "returned", casts: [dailyCast({ beautyAllowance: 500 }), dailyCast({ posCastId: "pos_2", beautyAllowance: 500 })] })]);
    await expect(save(false)).rejects.toThrow("一意");
  });
  it("再照合後に否へ訂正しても元行のPOS・出勤アンカーを保持する", async () => {
    await save(true);
    seed([closing({ casts: [dailyCast({ masterId: "other", beautyAllowance: 500 }), dailyCast({ posCastId: "pos_new" })] })]);
    await save(false, 1);
    expect(records().casts.cast_1[date]).toMatchObject({ eligible: false, attendanceClosingId: "daily_20260902", attendanceIndex: 0, attendancePosCastId: "pos_1" });
  });

  it.each([false, true])("元POSを他キャストへ再照合した場合は照合先の可否確認前にアンカーを付け替えない（並替え=%s）", async (reordered) => {
    seed([closing({ casts: [dailyCast({ beautyAllowance: 500 })] })]); await save(false);
    const mapped = dailyCast({ masterId: "cast_b", beautyAllowance: 500 });
    const own = dailyCast({ posCastId: "pos_new" });
    seed([closing({ casts: reordered ? [own, mapped] : [mapped, own] })], [cast(), cast({ id: "cast_b" })]);
    await expect(save(true, 1)).rejects.toThrow("照合先キャスト");
    expect(records().casts.cast_1[date]).toMatchObject({ eligible: false, attendancePosCastId: "pos_1" });
    await saveBeautyAllowanceDay(month, "cast_b", date, false, 1, user);
    await save(true, 2);
    expect(records().casts.cast_1[date]).toMatchObject({ eligible: true, attendancePosCastId: "pos_new" });
    expect(records().casts.cast_b[date].eligible).toBe(false);
  });
  it("同じ本人のPOS再取込による識別子変更は通常通り修復できる", async () => {
    await save(true);
    seed([closing({ casts: [dailyCast({ posCastId: "pos_new" })] })]);
    await save(true, 1);
    expect(records().casts.cast_1[date].attendancePosCastId).toBe("pos_new");
  });

  it("保存の権限検証で拒否されたら出勤と月次の再確認を案内し、記録を変えない", async () => {
    memory.update.mockRejectedValueOnce(new Error("PERMISSION_DENIED"));
    await expect(save(true)).rejects.toThrow("出勤・キャスト照合と月次確定状態");
    expect(records()).toBeUndefined();
  });
  it("照合先の同日記録が別POSを参照する相互入替は元手当の抑制を失うため拒否する", async () => {
    const castB = cast({ id: "cast_b" });
    const rowB = dailyCast({ masterId: "cast_b", posCastId: "pos_b", beautyAllowance: 500 });
    seed([closing({ casts: [dailyCast({ beautyAllowance: 500 }), rowB] })], [cast(), castB]);
    await save(false);
    await saveBeautyAllowanceDay(month, "cast_b", date, false, 1, user);
    const before = structuredClone(records());
    seed([closing({ casts: [dailyCast({ masterId: "cast_b", beautyAllowance: 500 }), dailyCast({ posCastId: "pos_b", beautyAllowance: 500 })] })], [cast(), castB]);
    await expect(save(true, 2)).rejects.toThrow("日次のキャスト照合");
    await expect(saveBeautyAllowanceDay(month, "cast_b", date, true, 2, user)).rejects.toThrow("日次のキャスト照合");
    expect(records()).toEqual(before);
  });

});
