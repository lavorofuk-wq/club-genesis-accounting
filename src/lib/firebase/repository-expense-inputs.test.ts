import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { AccountingExpenseInput, DailyClosing, MonthlyAdjustments } from "@/domain/gms";
const memory = vi.hoisted(() => ({ values: new Map<string, unknown>(), get: vi.fn(), transaction: vi.fn(), environment: "accounting-dev" }));
vi.mock("firebase/database", () => ({ get: memory.get, ref: (_db: unknown, path: string) => ({ path }), set: vi.fn(), update: vi.fn(), onValue: vi.fn(), serverTimestamp: vi.fn() }));
vi.mock("./client", () => ({ database: {}, rootRef: (path = "") => ({ path: [memory.environment, path].filter(Boolean).join("/") }) }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: memory.transaction }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: vi.fn().mockResolvedValue(undefined) }));
import { saveMonthlyAdjustments } from "./repository";
const user = { uid: "accountant" } as User;
const month = "2026-09";
const path = "accountingAdjustments/" + month;
const scoped = (path: string) => memory.environment + "/" + path;
const input = (extra: Partial<AccountingExpenseInput> = {}): AccountingExpenseInput => ({ id: "expense_1", category: "supplies", payee: "購入先", amount: 1500, ...extra });
const defaults = (extra: Partial<MonthlyAdjustments> = {}): MonthlyAdjustments => ({ month, revision: 0, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0, ...extra });
const saved = () => memory.values.get(scoped(path)) as MonthlyAdjustments & { expenseInputs?: Record<string, AccountingExpenseInput> };
const closing = { id: "day_1", businessDate: "2026-09-02", status: "approved", expenses: [{ id: "store_1", category: "liquor", payee: "酒屋", amount: 1000 }] } as DailyClosing;
describe.each(["accounting-dev", "accounting"])("追加経費の保存（%s）", (environment) => {
  beforeEach(() => {
    vi.clearAllMocks(); memory.values.clear(); memory.environment = environment;
    memory.values.set("users/accountant/role", "accounting");
    memory.values.set(scoped("history"), { day_1: structuredClone(closing) });
    memory.get.mockImplementation(async ({ path }: { path: string }) => ({ val: () => structuredClone(memory.values.get(path) ?? null) }));
    memory.transaction.mockImplementation(async ({ path }: { path: string }, callback: (v: unknown) => unknown) => {
      const result = callback(structuredClone(memory.values.get(path) ?? null));
      if (result !== undefined) memory.values.set(path, structuredClone(result));
      return { committed: result !== undefined, snapshot: { val: () => result } };
    });
  });
  it("日付あり・なしをID別に保存し、店舗原本と別環境を変更しない", async () => {
    const history = structuredClone(memory.values.get(scoped("history")));
    const other = (environment === "accounting" ? "accounting-dev" : "accounting") + "/" + path;
    memory.values.set(other, { revision: 99 });
    await saveMonthlyAdjustments(defaults({ expenseInputs: [input(), input({ id: "expense_2", category: "liquor", businessDate: "2026-09-02", amount: 2000 })] }), user);
    expect(saved()).toMatchObject({ revision: 1, updatedBy: user.uid, expenseInputs: {
      expense_1: input(), expense_2: input({ id: "expense_2", category: "liquor", businessDate: "2026-09-02", amount: 2000 }) } });
    expect(memory.values.get(scoped("history"))).toEqual(history);
    expect(memory.values.get(other)).toEqual({ revision: 99 });
    expect(memory.transaction.mock.calls.every(([ref]) => ref.path === scoped(path))).toBe(true);
  });
  it("経費の変更と全削除を保存する", async () => {
    await saveMonthlyAdjustments(defaults({ expenseInputs: [input()] }), user);
    await saveMonthlyAdjustments(defaults({ revision: 1, expenseInputs: [input({ amount: 4321 })] }), user);
    expect(saved().expenseInputs?.expense_1.amount).toBe(4321);
    await saveMonthlyAdjustments(defaults({ revision: 2, expenseInputs: [] }), user);
    expect(saved().expenseInputs).toBeUndefined();
    expect(saved().revision).toBe(3);
  });
  it("営業日指定は承認済みの当月日次だけを許可する", async () => {
    for (const status of ["submitted", "returned", "withdrawn"]) {
      memory.values.set(scoped("history"), { day_1: { ...closing, status } });
      await expect(saveMonthlyAdjustments(defaults({ expenseInputs: [input({ businessDate: "2026-09-02" })] }), user)).rejects.toThrow();
    }
    await expect(saveMonthlyAdjustments(defaults({ expenseInputs: [input({ businessDate: "2026-09-31" })] }), user)).rejects.toThrow();
    await expect(saveMonthlyAdjustments(defaults({ expenseInputs: [input({ businessDate: "2026-10-02" })] }), user)).rejects.toThrow();
    expect(memory.transaction).not.toHaveBeenCalled();
  });
  it.each([{ amount: -1 }, { amount: 0.5 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { payee: " " }, { category: "other" }, { id: "bad/path" }])("不正な入力を保存前に拒否する: %j", async (extra) => {
    await expect(saveMonthlyAdjustments(defaults({ expenseInputs: [input(extra as Partial<AccountingExpenseInput>)] }), user)).rejects.toThrow();
    expect(memory.transaction).not.toHaveBeenCalled();
  });
  it("重複IDを拒否する", async () => {
    await expect(saveMonthlyAdjustments(defaults({ expenseInputs: [input(), input()] }), user)).rejects.toThrow();
  });
  it("更新競合では最新経費を上書きしない", async () => {
    memory.values.set(scoped(path), { ...defaults(), revision: 2, expenseInputs: { expense_1: input({ amount: 900 }) } });
    await expect(saveMonthlyAdjustments(defaults({ revision: 1, expenseInputs: [input()] }), user)).rejects.toThrow("別の端末");
    expect(saved().expenseInputs?.expense_1.amount).toBe(900);
  });
  it.each(["closing", "closed"])("%s月は編集できない", async (status) => {
    memory.values.set(scoped("accountingMonthStates/" + month), { status });
    await expect(saveMonthlyAdjustments(defaults({ expenseInputs: [input()] }), user)).rejects.toThrow();
    expect(memory.transaction).not.toHaveBeenCalled();
  });
  it("店舗権限では追加できない", async () => {
    memory.values.set("users/accountant/role", "shop");
    await expect(saveMonthlyAdjustments(defaults({ expenseInputs: [input()] }), user)).rejects.toThrow();
    expect(memory.transaction).not.toHaveBeenCalled();
  });
});
