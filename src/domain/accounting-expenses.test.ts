import { describe, expect, it } from "vitest";
import { consumptionTaxForSales, normalizeAccountingExpenseInputs, validateAccountingExpenseInputs } from "./accounting-expenses";
import { normalizeMonthlyAdjustments, type AccountingExpenseInput, type DailyClosing, type MonthlyAdjustments, type WorkspaceData } from "./gms";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
import { buildMonthlySnapshot, calculateMonthlyAccounting, canFinalizeMonthlyAccounting, monthlySourceFingerprint, normalizeMonthlyAccountingSnapshot } from "./month-accounting";
import { validateExpenseExport, type ExpenseExportInput } from "./expense-export";
import { buildBalanceExportReport } from "./balance-export";

const month = "2026-09";
const expense = (overrides: Partial<AccountingExpenseInput> = {}): AccountingExpenseInput => ({
  id: "input-1", category: "supplies", payee: "備品追加", amount: 100, businessDate: "2026-09-02", ...overrides,
});
function fixture(withInputs = true) {
  const adjustments: MonthlyAdjustments = { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
    fixedExpenses: [{ id: "fixed", account: "家賃", amount: 700 }], cardFee: 80, revision: 1,
    ...(withInputs ? { expenseInputs: [expense(), expense({ id: "input-2", category: "transportOther", payee: "月額追加", amount: 200, businessDate: undefined })] } : {}),
  };
  const closings: DailyClosing[] = [];
  for (const date of ["02", "04", "30"]) {
    const businessDate = `${month}-${date}`;
    const closing: DailyClosing = {
      id: `day-${date}`, businessDate, status: "approved", submissionId: `submission-${date}`, checksum: "a".repeat(64), updatedAt: "2026-09-30T12:00:00.000Z",
      sales: { cashSales: 3333, cardSales: 0, totalSales: 3333 }, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
      casts: [], staffWork: [], drivers: [], staffDailyPaymentTotal: 0,
      expenses: [{ id: "store-expense", category: "supplies", payee: "店舗備品", amount: 110 }],
      dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 200,
      cash: { cashSales: 3333, cardSales: 0, totalSales: 3333, cashFloat: 200000,
        expenseAndPaymentTotal: 110, expectedClosingCash: 203223, cashProfit: 3223, actualClosingCash: 203223, difference: 0 },
      posSnapshot: { businessDate, nominations: { honShimeiCount: 0, jonaiCount: 0 }, castWork: [], transactions: [] } as unknown as DailyClosing["posSnapshot"],
    };
    closing.cash.funding = calculateCashFunding(cashFundingContext(closings, businessDate, 200000),
      { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, closing.cash.cashProfit, true);
    closings.push(closing);
  }
  const data: WorkspaceData = { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings, adjustments: [adjustments], cashFloat: 200000 };
  const results = calculateMonthlyAccounting(data, month, adjustments);
  const input: ExpenseExportInput = { month, adjustments, results, closings };
  return { data, adjustments, input };
}
function snapshot(input: ExpenseExportInput) {
  return buildMonthlySnapshot(month, 1, "b".repeat(64), input.adjustments, structuredClone(input.results), input.closings, "accounting", "2026-09-30T12:00:00.000Z");
}
function legacy(input: ExpenseExportInput) {
  const delta = (input.results.expenses.consumptionTax ?? 0) + (input.results.expenses.accountingExpenseTotal ?? 0);
  delete input.results.expenses.accountingExpenseInputs;
  delete input.results.expenses.accountingExpenseTotal;
  delete input.results.expenses.consumptionTax;
  input.results.expenses.total -= delta;
  input.results.balance.expenses -= delta;
  input.results.balance.totalCosts -= delta;
  input.results.balance.profit += delta;
  input.snapshot = snapshot(input);
  input.snapshot.calculationVersion = "2.42.0";
}

describe("経費追加入力の検証", () => {
  it("配列・IDキーオブジェクトを金額と日付を保持して復元する", () => {
    expect(normalizeAccountingExpenseInputs({ "input-1": expense() })).toEqual([expense()]);
    expect(normalizeAccountingExpenseInputs([null, expense()])).toEqual([expense()]);
    expect(normalizeAccountingExpenseInputs({})).toEqual([]);
    const { adjustments } = fixture();
    expect(normalizeMonthlyAdjustments({ ...adjustments, expenseInputs: { "input-1": expense() } as never }).expenseInputs).toEqual([expense()]);
  });
  it.each([
    ["小数", { amount: 1.5 }], ["負数", { amount: -1 }], ["文字列", { amount: "100" }], ["無限値", { amount: Infinity }],
    ["桁あふれ", { amount: Number.MAX_SAFE_INTEGER + 1 }], ["空支払先", { payee: " " }], ["不明科目", { category: "other" }],
    ["継承プロパティ科目", { category: "constructor" }], ["不正日付", { businessDate: "2026-09-31" }], ["空ID", { id: "" }],
  ])("%sを黙って補正しない", (_label, overrides) => {
    expect(() => normalizeAccountingExpenseInputs([{ ...expense(), ...(overrides as object) }])).toThrow();
  });
  it("ID重複・保存キー不一致・合計あふれを拒否する", () => {
    expect(() => normalizeAccountingExpenseInputs([expense(), expense()])).toThrow(/重複/);
    expect(() => normalizeAccountingExpenseInputs({ wrong: expense() })).toThrow(/保存キー/);
    expect(() => normalizeAccountingExpenseInputs([expense({ amount: Number.MAX_SAFE_INTEGER }), expense({ id: "input-2", amount: 1 })])).toThrow(/合計金額/);
  });
  it("指定日は対象月の実在する承認日だけを認め、未指定は営業日なしでも認める", () => {
    const { input } = fixture();
    expect(validateAccountingExpenseInputs([expense()], month, input.closings)).toEqual([expense()]);
    expect(() => validateAccountingExpenseInputs([expense({ businessDate: "2026-10-02" })], month)).toThrow(/対象月/);
    expect(() => validateAccountingExpenseInputs([expense({ businessDate: "2026-09-03" })], month, input.closings)).toThrow(/承認済み/);
    expect(() => validateAccountingExpenseInputs([expense()], month, [{ ...input.closings[0], status: "submitted" }])).toThrow(/承認済み/);
    expect(validateAccountingExpenseInputs([expense({ businessDate: undefined })], month, [])).toHaveLength(1);
  });
});

describe("月次3%と追加経費の計算・帳票突合", () => {
  it("承認済み合計売上に月額で一度3%を掛け、店舗経費・給与・既存経費を変えない", () => {
    const { input } = fixture();
    expect(input.results.sales.total).toBe(9999);
    expect(input.results.expenses).toMatchObject({ byCategory: { supplies: 330 }, dailyExpenseTotal: 330,
      accountingExpenseTotal: 300, consumptionTax: 299, liquorDelivery: 600, fixed: 700, cardFee: 80, total: 2309 });
    expect(input.results.balance).toMatchObject({ cast: 0, staff: 0, introducer: 0, driver: 0, totalCosts: 2309, profit: 7690 });
    expect(input.results.warnings).toEqual([]);
    expect(() => validateExpenseExport(input)).not.toThrow();
    expect(consumptionTaxForSales(100)).toBe(3);
    expect(consumptionTaxForSales(9999)).toBe(299);
    expect(consumptionTaxForSales(0)).toBe(0);
  });
  it("追加入力は指定日へ、未指定と税は収支表の最終承認日へ一度配分する", () => {
    const { input } = fixture();
    const report = buildBalanceExportReport(input);
    expect(report.days.map((day) => day.expenses)).toEqual([210, 110, 1989]);
    expect(report.days.reduce((sum, day) => sum + day.expenses, 0)).toBe(input.results.balance.expenses);
  });
  it("入力不正・指定日の差戻し・経費合計の上限超過を警告して確定を拒否する", () => {
    for (const kind of ["fraction", "returned", "overflow"]) {
      const { data, adjustments } = fixture();
      if (kind === "fraction") adjustments.expenseInputs![0].amount = 1.5;
      if (kind === "returned") data.closings[0].status = "returned";
      if (kind === "overflow") adjustments.expenseInputs = [expense({ amount: Number.MAX_SAFE_INTEGER })];
      const result = calculateMonthlyAccounting(data, month, adjustments);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(canFinalizeMonthlyAccounting(data, month, adjustments, false).allowed).toBe(false);
    }
  });
  it("同額でも支払先・日付の変更を計算済み明細と突合し、税の改ざんも検知する", () => {
    const { input } = fixture();
    input.adjustments.expenseInputs![0].payee = "変更後";
    expect(() => validateExpenseExport(input)).toThrow(/保存明細/);
    const second = fixture().input;
    second.results.expenses.consumptionTax! += 1;
    expect(() => validateExpenseExport(second)).toThrow(/預かり消費税/);
  });
  it("新しい入力がsource fingerprintに含まれる", async () => {
    const { data, adjustments } = fixture();
    const before = await monthlySourceFingerprint(data, month, adjustments);
    adjustments.expenseInputs![0].businessDate = "2026-09-04";
    expect(await monthlySourceFingerprint(data, month, adjustments)).not.toBe(before);
  });
});

describe("経費確定の保存と旧確定互換", () => {
  it("旧計算版に新しい税・経費明細を付けたsnapshotを拒否する", () => {
    const { input } = fixture();
    input.snapshot = snapshot(input);
    input.snapshot.calculationVersion = "2.42.0";
    expect(normalizeMonthlyAccountingSnapshot(input.snapshot, month, 1)).toBeUndefined();
    expect(() => validateExpenseExport(input)).toThrow(/旧計算版/);
  });
  it("新明細を復元し、対象月・合計・ID・3%の不整合や金額欠損を拒否する", () => {
    const { input } = fixture();
    const stored = snapshot(input);
    expect(normalizeMonthlyAccountingSnapshot(stored, month, 1)).toEqual(stored);
    const firebase = structuredClone(stored);
    firebase.expenses.accountingExpenseInputs = Object.fromEntries(firebase.expenses.accountingExpenseInputs!.map((row, index) => [index, row])) as never;
    expect(normalizeMonthlyAccountingSnapshot(firebase, month, 1)).toEqual(stored);
    const mutations = [
      (row: typeof stored) => { delete row.expenses.consumptionTax; },
      (row: typeof stored) => { delete row.expenses.accountingExpenseTotal; },
      (row: typeof stored) => { delete row.expenses.accountingExpenseInputs; },
      (row: typeof stored) => { row.expenses.consumptionTax! += 1; },
      (row: typeof stored) => { row.expenses.accountingExpenseInputs![0].amount += 1; },
      (row: typeof stored) => { row.expenses.accountingExpenseInputs![0].businessDate = "2026-10-02"; },
      (row: typeof stored) => { row.expenses.accountingExpenseInputs!.push(row.expenses.accountingExpenseInputs![0]); },
    ];
    for (const mutate of mutations) {
      const corrupted = structuredClone(stored);
      mutate(corrupted);
      expect(normalizeMonthlyAccountingSnapshot(corrupted, month, 1)).toBeUndefined();
    }
  });
  it("Firebaseで空明細が消えても0円を復元する", () => {
    const stored = snapshot(fixture(false).input);
    delete stored.expenses.accountingExpenseInputs;
    expect(normalizeMonthlyAccountingSnapshot(stored, month, 1)?.expenses.accountingExpenseInputs).toEqual([]);
  });
  it("旧確定は税や明細を後付けせず保持し、再計算後だけ3%を適用する", () => {
    const { data, adjustments, input } = fixture(false);
    legacy(input);
    const before = structuredClone(input);
    expect(normalizeMonthlyAccountingSnapshot(input.snapshot, month, 1)).toEqual(input.snapshot);
    expect(() => validateExpenseExport(input)).not.toThrow();
    expect(buildBalanceExportReport(input).days.map((day) => day.expenses)).toEqual([110, 110, 1490]);
    expect(input).toEqual(before);
    expect(input.results.expenses.consumptionTax).toBeUndefined();
    const recalculated = calculateMonthlyAccounting(data, month, adjustments);
    expect(recalculated.expenses.consumptionTax).toBe(299);
    expect(recalculated.expenses.total).toBe(input.results.expenses.total + 299);
    input.adjustments.expenseInputs = [expense({ businessDate: undefined })];
    expect(() => validateExpenseExport(input)).toThrow(/旧確定月/);
  });
});
