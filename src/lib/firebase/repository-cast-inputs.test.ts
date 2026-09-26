import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { CastAccountingInput, CastRecord, DailyCast, DailyClosing, MonthlyAdjustments } from "@/domain/gms";

const memory = vi.hoisted(() => ({ values: new Map<string, unknown>(), get: vi.fn(), transaction: vi.fn(),
  environment: "accounting-dev", release: vi.fn() }));
vi.mock("firebase/database", () => ({ get: memory.get, ref: (_db: unknown, path: string) => ({ path }),
  set: vi.fn(), update: vi.fn(), onValue: vi.fn(), serverTimestamp: vi.fn() }));
vi.mock("./client", () => ({ database: {}, rootRef: (path = "") => ({ path }), environmentRoot: () => memory.environment }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: memory.transaction }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: memory.release }));
import { saveCastAccountingInputs, saveMonthlyAdjustments } from "./repository";

const month = "2026-09";
const user = { uid: "accountant" } as User;
const input = (extra: Partial<CastAccountingInput> = {}): CastAccountingInput => ({
  id: "input_1", castId: "cast_1", castName: "テスト", kind: "sales", label: "追加売上",
  amount: 1230, businessDate: "2026-09-02", ...extra,
});
const cast = (extra: Partial<CastRecord> = {}): CastRecord => ({ id: "cast_1", name: "テスト",
  status: "active", hiredAt: "2026-08-01", hourlyRates: { [month]: 3000 }, ...extra } as CastRecord);
const dailyCast = (extra: Partial<DailyCast> = {}): DailyCast => ({ posCastId: "pos_1", masterId: "cast_1",
  name: "テスト", kind: "regular", startTime: "20:00", endTime: "21:00", hours: 1, hourlyRate: 3000,
  honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
  honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, bottles: [], liquorCost: 0,
  beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0, ...extra });
const closing = (date = "2026-09-02", extra: Partial<DailyClosing> = {}): DailyClosing => ({
  id: "daily_" + date.replaceAll("-", ""), businessDate: date, status: "approved",
  submissionId: "submission_1", checksum: "a".repeat(64), updatedAt: "2026-09-03T01:00:00Z",
  sales: { totalSales: 10000, cashSales: 10000, cardSales: 0 }, customers: { groupCount: 1, totalCustomers: 1 },
  nominations: { honShimeiCount: 0, jonaiCount: 0 }, casts: [dailyCast()], staffWork: [], drivers: [], expenses: [],
  staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
  cash: { cashSales: 10000, cardSales: 0, totalSales: 10000, cashFloat: 200000, expenseAndPaymentTotal: 0,
    expectedClosingCash: 210000, actualClosingCash: 210000, cashProfit: 10000, difference: 0 }, ...extra,
} as DailyClosing);
const defaults = (): MonthlyAdjustments => ({ month, withholdingByCast: {}, staffSalesAllowance: {},
  staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0, revision: 0 });
const path = "accountingAdjustments/" + month;
const saved = () => structuredClone(memory.values.get(path)) as MonthlyAdjustments & { castInputs: Record<string, CastAccountingInput> };
const seed = (rows: DailyClosing[] = [closing()], masters: CastRecord[] = [cast()]) => {
  memory.values.set("history", Object.fromEntries(rows.map((row) => [row.id, row])));
  memory.values.set("casts", Object.fromEntries(masters.map((row) => [row.id, row])));
};
beforeEach(() => {
  vi.clearAllMocks(); memory.values.clear(); memory.environment = "accounting-dev";
  memory.release.mockResolvedValue(undefined); memory.values.set("users/accountant/role", "accounting"); seed();
  memory.get.mockImplementation(async ({ path }: { path: string }) => ({ val: () => structuredClone(memory.values.get(path) ?? null) }));
  memory.transaction.mockImplementation(async ({ path }: { path: string }, callback: (v: unknown) => unknown) => {
    const result = callback(structuredClone(memory.values.get(path) ?? null));
    if (result !== undefined) memory.values.set(path, structuredClone(result));
    return { committed: result !== undefined, snapshot: { val: () => result } };
  });
});

describe("キャストデータ入力の保存境界", () => {
  it.each(["accounting", "op"])("%sは未確定月へIDキー付きで保存し、店舗原本を変更しない", async (role) => {
    memory.values.set("users/accountant/role", role);
    const before = structuredClone(memory.values.get("history"));
    await saveCastAccountingInputs(month, [input()], 0, user);
    expect(saved()).toMatchObject({ revision: 1, updatedBy: user.uid, cardFee: 0,
      castInputs: { input_1: { ...input(), attendanceClosingId: "daily_20260902", attendanceIndex: 0 } } });
    expect(memory.values.get("history")).toEqual(before);
    expect(memory.transaction).toHaveBeenCalledTimes(1);
    expect(memory.transaction.mock.calls[0][0].path).toBe(path);
  });
  it("店舗ユーザーを拒否する", async () => {
    memory.values.set("users/accountant/role", "shop");
    await expect(saveCastAccountingInputs(month, [input()], 0, user)).rejects.toThrow();
    expect(memory.transaction).not.toHaveBeenCalled();
  });
  it("本番を拒否する", async () => {
    memory.environment = "accounting";
    await expect(saveCastAccountingInputs(month, [input()], 0, user)).rejects.toThrow("開発環境");
    expect(memory.transaction).not.toHaveBeenCalled();
  });
  it.each(["closed", "closing"])("%s月を拒否する", async (status) => {
    memory.values.set("accountingMonthStates/" + month, { status });
    await expect(saveCastAccountingInputs(month, [input()], 0, user)).rejects.toThrow("確定");
    expect(memory.transaction).not.toHaveBeenCalled();
  });
  it("未指定の手当・送迎は最終本人出勤を根拠にするが日付を固定保存しない", async () => {
    seed([closing(), closing("2026-09-07"), closing("2026-09-09", { status: "returned" })]);
    await saveCastAccountingInputs(month, [input({ kind: "allowance", amount: 101, businessDate: undefined }),
      input({ id: "input_2", kind: "transport", amount: 1500, businessDate: undefined })], 0, user);
    expect(Object.values(saved().castInputs).every((row) => row.businessDate === undefined
      && row.attendanceClosingId === "daily_20260907")).toBe(true);
  });
  it("0時間の記録も既存の出勤判定どおり扱う", async () => {
    seed([closing("2026-09-02", { casts: [dailyCast({ hours: 0, endTime: "20:00" })] })]);
    await expect(saveCastAccountingInputs(month, [input()], 0, user)).resolves.toBeUndefined();
  });
  it("同月体入から在籍化した本人の出勤を使う", async () => {
    seed([closing("2026-09-02", { casts: [dailyCast({ masterId: "trial_1", kind: "trial" })] })],
      [cast({ hiredAt: "2026-09-06", convertedFromTrialId: "trial_1" })]);
    await expect(saveCastAccountingInputs(month, [input()], 0, user)).resolves.toBeUndefined();
  });
  it.each([
    { id: "bad/path" }, { castId: "bad.id" }, { label: " " }, { label: "a".repeat(101) },
    { amount: -10 }, { amount: 1.1 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { amount: 1234 },
    { kind: "transport" as const, amount: 501 }, { businessDate: undefined },
    { businessDate: "2026-10-02" }, { businessDate: "2026-09-31" }, { businessDate: "2026-09-03" },
    { castId: "other_1" }, { castName: "別名" },
  ])("不正・未承認出勤入力を拒否する %j", async (extra) => {
    await expect(saveCastAccountingInputs(month, [input(extra)], 0, user)).rejects.toThrow();
    expect(memory.values.has(path)).toBe(false);
  });
  it("重複IDを拒否する", async () => {
    await expect(saveCastAccountingInputs(month, [input(), input()], 0, user)).rejects.toThrow("重複");
  });
  it.each(["trial", "departed"] as const)("%sの新規入力を拒否する", async (status) => {
    seed([closing()], [cast({ status })]);
    await expect(saveCastAccountingInputs(month, [input()], 0, user)).rejects.toThrow("在籍");
  });
  it("本人出勤のない月には日付未指定手当も入れない", async () => {
    seed([]);
    await expect(saveCastAccountingInputs(month, [input({ kind: "allowance", businessDate: undefined })], 0, user)).rejects.toThrow("出勤");
  });
  it("更新した行の旧出勤根拠は信用せず再設定する", async () => {
    await saveCastAccountingInputs(month, [input()], 0, user);
    seed([closing(), closing("2026-09-08")]);
    await saveCastAccountingInputs(month, [input({ businessDate: "2026-09-08", attendanceClosingId: "wrong", attendanceIndex: 8 })], 1, user);
    expect(saved().castInputs.input_1.attendanceClosingId).toBe("daily_20260908");
    expect(saved().castInputs.input_1.attendanceIndex).toBe(0);
  });
  it("既存退店行・後発差戻しは未変更なら保持し、変更不可・削除可", async () => {
    await saveCastAccountingInputs(month, [input()], 0, user);
    const before = saved().castInputs.input_1;
    seed([closing("2026-09-02", { status: "returned" })], [cast({ status: "departed" })]);
    await saveCastAccountingInputs(month, [before], 1, user);
    expect(saved().castInputs.input_1).toEqual(before);
    await expect(saveCastAccountingInputs(month, [{ ...before, amount: 5000 }], 2, user)).rejects.toThrow("在籍");
    await saveCastAccountingInputs(month, [], 2, user);
    expect(saved().castInputs).toBeUndefined();
  });
  it("共通revisionの競合で他画面の源泉・経費を上書きしない", async () => {
    memory.values.set(path, { ...defaults(), revision: 5, cardFee: 321, withholdingByCast: { cast_1: 456 } });
    await expect(saveCastAccountingInputs(month, [input()], 4, user)).rejects.toThrow("別の端末");
    await saveCastAccountingInputs(month, [input()], 5, user);
    expect(saved()).toMatchObject({ revision: 6, cardFee: 321, withholdingByCast: { cast_1: 456 } });
  });
  it("通常の月次保存は追加入力を変更・削除できず、未変更なら保持する", async () => {
    await saveCastAccountingInputs(month, [input()], 0, user);
    await expect(saveMonthlyAdjustments({ ...defaults(), revision: 1 }, user)).rejects.toThrow("専用画面");
    const row = saved().castInputs.input_1;
    await expect(saveMonthlyAdjustments({ ...defaults(), revision: 1, castInputs: [{ ...row, amount: 9990 }] }, user)).rejects.toThrow("専用画面");
    await saveMonthlyAdjustments({ ...defaults(), revision: 1, castInputs: [row], cardFee: 987 }, user);
    expect(saved()).toMatchObject({ revision: 2, cardFee: 987, castInputs: { input_1: row } });
  });
  it("通常月次保存から新しい追加入力を作れない", async () => {
    await expect(saveMonthlyAdjustments({ ...defaults(), castInputs: [input()] }, user)).rejects.toThrow("専用画面");
  });
  it("トランザクション不成立を成功扱いしない", async () => {
    memory.transaction.mockResolvedValueOnce({ committed: false });
    await expect(saveCastAccountingInputs(month, [input()], 0, user)).rejects.toThrow("保存できません");
  });
});
