import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { CastAccountingInput, CastRecord, DailyCast, DailyClosing, MonthlyAdjustments } from "@/domain/gms";

const memory = vi.hoisted(() => ({ values: new Map<string, unknown>(), get: vi.fn(), transaction: vi.fn(), update: vi.fn(),
  environment: "accounting-dev", release: vi.fn() }));
vi.mock("firebase/database", () => ({ get: memory.get, ref: (_db: unknown, path: string) => ({ path }),
  query: (reference: unknown) => reference, orderByChild: vi.fn(), equalTo: vi.fn(),
  set: vi.fn(), update: memory.update, onValue: vi.fn(), serverTimestamp: vi.fn() }));
vi.mock("./client", () => ({ database: {}, rootRef: (path = "") => ({ path: [memory.environment, path].filter(Boolean).join("/") }) }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: memory.transaction }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: memory.release }));
import { saveTransportSettings, saveCastTransportDay, saveDriverTransportDay, loadWorkspaceData } from "./repository";

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
const scoped = (path: string) => memory.environment + "/" + path;
const saved = () => structuredClone(memory.values.get(scoped(path))) as MonthlyAdjustments & { castInputs: Record<string, CastAccountingInput> };
const seed = (rows: DailyClosing[] = [closing()], masters: CastRecord[] = [cast()]) => {
  memory.values.set(scoped("history"), Object.fromEntries(rows.map((row) => [row.id, row])));
  memory.values.set(scoped("casts"), Object.fromEntries(masters.map((row) => [row.id, row])));
};
describe.each(["accounting-dev", "accounting"])("送迎保存境界（%s）", (environment) => {
  beforeEach(() => {
    vi.clearAllMocks(); memory.values.clear(); memory.environment = environment;
    memory.release.mockResolvedValue(undefined); memory.values.set("users/accountant/role", "shop"); seed();
    memory.values.set(scoped("drivers"), { driver_1: { name: "ドライバー" } });
    memory.values.set(scoped("config/transportSettings"), { revision: 1, castRegistrations: { cast_1: { amounts: [500, 1000] } }, remoteAmounts: [500, 1000, 2000] });
    memory.get.mockImplementation(async ({ path }: { path: string }) => ({ val: () => structuredClone(memory.values.get(path) ?? null) }));
    memory.update.mockImplementation(async ({ path }: { path: string }, patch: Record<string, unknown>) => {
      const grouped: Record<string, Record<string, unknown>> = {};
      for (const [key, value] of Object.entries(patch)) {
        const parts = key.split("/"), base = path + "/" + parts.slice(0, 2).join("/");
        grouped[base] ??= {}; grouped[base][parts.slice(2).join("/")] = value;
      }
      const updates = Object.entries(grouped).map(([base, fields]) => {
        const current = structuredClone(memory.values.get(base) || {}) as Record<string, unknown>;
        if (fields.revision !== Number(current.revision || 0) + 1) throw new Error("PERMISSION_DENIED");
        for (const [key, value] of Object.entries(fields)) {
          const segments = key.split("/"); let parent = current;
          for (const segment of segments.slice(0, -1)) { parent[segment] ??= {}; parent = parent[segment] as Record<string, unknown>; }
          parent[segments.at(-1)!] = structuredClone(value);
        }
        return [base, current] as const;
      });
      for (const [base, value] of updates) memory.values.set(base, value);
    });
    memory.transaction.mockImplementation(async ({ path }: { path: string }, callback: (v: unknown) => unknown) => {
      const result = callback(structuredClone(memory.values.get(path) ?? null));
      if (result !== undefined) memory.values.set(path, structuredClone(result));
      return { committed: result !== undefined, snapshot: { val: () => result } };
    });
  });
  const records = () => memory.values.get(scoped("transportMonths/" + month)) as { revision: number; casts: Record<string, Record<string, { amount: number; legacyInputIds: string[] }>>; drivers: Record<string, Record<string, { entries: Record<string, number> }>> };
  it("送信済み出勤日に記録し、旧日次・旧追加の原本を変更しない", async () => {
    seed([closing("2026-09-02", { status: "submitted", casts: [dailyCast({ transportFee: 500 })] })]);
    memory.values.set(scoped(path + "/castInputs"), { input_1: input({ kind: "transport", amount: 500 }) });
    const before = structuredClone(memory.values.get(scoped("history")));
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 1000, 0, user);
    expect(records()).toMatchObject({ revision: 1, casts: { cast_1: { "2026-09-02": { amount: 1000, legacyInputIds: ["input_1"] } } } });
    expect(memory.values.get(scoped("history"))).toEqual(before);
    expect(memory.values.get(scoped(path + "/castInputs"))).toEqual({ input_1: input({ kind: "transport", amount: 500 }) });
  });
  it("登録済み候補以外と不正な日付を拒否する", async () => {
    for (const amount of [501, 1500, -1, 3000]) await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", amount, 0, user)).rejects.toThrow();
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-31", 500, 0, user)).rejects.toThrow();
    expect(records()).toBeUndefined();
  });
  it("経理権限は送迎を編集できない", async () => {
    memory.values.set("users/accountant/role", "accounting");
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user)).rejects.toThrow("権限");
    expect(memory.transaction).not.toHaveBeenCalled();
  });
  it.each(["closed", "closing"])("%s月は記録を変更できない", async (status) => {
    memory.values.set(scoped("accountingMonthStates/" + month), { status });
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user)).rejects.toThrow("確定");
  });
  it("旧送迎だけの未登録キャストは4候補で編集でき、削除は0円の履歴として保存する", async () => {
    memory.values.set(scoped("config/transportSettings"), null);
    seed([closing("2026-09-02", { casts: [dailyCast({ transportFee: 3000 })] })]);
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 1500, 0, user);
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 0, 1, user);
    expect(records().casts.cast_1["2026-09-02"].amount).toBe(0);
  });
  it("出勤を差し戻された記録は増額不可だが削除できる", async () => {
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user);
    seed([closing("2026-09-02", { status: "returned" })]);
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", 1000, 1, user)).rejects.toThrow("出勤");
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 0, 1, user);
    expect(records().casts.cast_1["2026-09-02"].amount).toBe(0);
  });
  it("未登録者の新規利用と未出勤日を拒否する", async () => {
    memory.values.set(scoped("config/transportSettings"), null);
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user)).rejects.toThrow("送迎登録");
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-03", 500, 0, user)).rejects.toThrow("出勤");
  });
  it("古い版での変更は他端末の記録を失わせない", async () => {
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user);
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", 1000, 0, user)).rejects.toThrow("別の端末");
    expect(records().casts.cast_1["2026-09-02"].amount).toBe(500);
  });
  it("同日の遠方手当を複数保持し、編集・全削除も履歴を保持する", async () => {
    seed([closing("2026-09-02", { status: "submitted", drivers: [{ driverId: "driver_1", name: "ドライバー", dailyRate: 5000, dailyPayment: 0 }] })]);
    await saveDriverTransportDay(month, "driver_1", "2026-09-02", { first: 500, second: 2000 }, 0, user);
    expect(records().drivers.driver_1["2026-09-02"].entries).toEqual({ first: 500, second: 2000 });
    await saveDriverTransportDay(month, "driver_1", "2026-09-02", { first: 1000 }, 1, user);
    seed([]);
    await saveDriverTransportDay(month, "driver_1", "2026-09-02", {}, 2, user);
    expect(records().drivers.driver_1["2026-09-02"].entries).toEqual({});
  });
  it("表示月に旧/新送迎があれば登録削除を拒否し、候補変更は記録を変更しない", async () => {
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user);
    await expect(saveTransportSettings({ revision: 2, castRegistrations: {}, remoteAmounts: [] }, month, user)).rejects.toThrow("当月に送迎記録があるため削除できません");
    await saveTransportSettings({ revision: 2, castRegistrations: { cast_1: { amounts: [2000] } }, remoteAmounts: [1000] }, month, user);
    expect(records().casts.cast_1["2026-09-02"].amount).toBe(500);
    await saveTransportSettings({ revision: 3, castRegistrations: {}, remoteAmounts: [] }, "2026-10", user);
    expect(records().casts.cast_1["2026-09-02"].amount).toBe(500);
  });
  it("店舗読み込みは経理入力全体を取得せず送迎子パスだけ参照する", async () => {
    await loadWorkspaceData("shop");
    const paths = memory.get.mock.calls.map(([reference]) => reference.path);
    expect(paths).not.toContain(scoped("accountingAdjustments"));
    expect(paths).toContain(scoped(path + "/castInputs"));
    expect(paths).toContain(scoped(path + "/driverRemoteAllowance"));
  });
  it("記録保存が登録削除と競合した場合は設定CASにより月記録も原子的に拒否する", async () => {
    const apply = memory.update.getMockImplementation()!;
    memory.update.mockImplementationOnce(async (reference, patch) => {
      memory.values.set(scoped("config/transportSettings"), { revision: 2, castRegistrations: {}, remoteAmounts: [500] });
      return apply(reference, patch);
    });
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user)).rejects.toThrow();
    expect(records()).toBeUndefined();
  });
  it("日別保存後の古い設定版による登録削除を拒否する", async () => {
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user);
    await expect(saveTransportSettings({ revision: 1, castRegistrations: {}, remoteAmounts: [] }, month, user)).rejects.toThrow("別の端末");
    expect(records().casts.cast_1["2026-09-02"].amount).toBe(500);
  });
  it("候補削減後も旧金額を保ち同額保存で出勤根拠を再設定できる", async () => {
    await saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 0, user);
    memory.values.set(scoped("config/transportSettings"), { revision: 3, castRegistrations: { cast_1: { amounts: [2000] } }, remoteAmounts: [] });
    await expect(saveCastTransportDay(month, "cast_1", "2026-09-02", 500, 1, user)).resolves.toBeUndefined();
  });

});
