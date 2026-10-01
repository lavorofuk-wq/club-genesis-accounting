import { describe, expect, it } from "vitest";
import { DEFAULT_CONSUMPTION_TAX_RATE, consumptionTaxForSales, normalizeAccountingExpenseInputs, validateAccountingExpenseInputs, validateConsumptionTaxRate } from "./accounting-expenses";
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
  delete input.results.expenses.consumptionTaxRate;
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
  it("追加入力は指定日へ、未指定と税は収支表の月次経費行へ一度計上する", () => {
    const { input } = fixture();
    const report = buildBalanceExportReport(input);
    expect(report.days.map((day) => day.expenses)).toEqual([210, 110, 110]);
    expect(report.monthlyExpenses).toEqual({ expenses: 1879, introducerPayment: 0 });
    expect(report.days.reduce((sum, day) => sum + day.expenses, 0) + report.monthlyExpenses.expenses).toBe(input.results.balance.expenses);
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
    const legacyReport = buildBalanceExportReport(input);
    expect(legacyReport.days.map((day) => day.expenses)).toEqual([110, 110, 110]);
    expect(legacyReport.monthlyExpenses).toEqual({ expenses: 1380, introducerPayment: 0 });
    expect(input).toEqual(before);
    expect(input.results.expenses.consumptionTax).toBeUndefined();
    const recalculated = calculateMonthlyAccounting(data, month, adjustments);
    expect(recalculated.expenses.consumptionTax).toBe(299);
    expect(recalculated.expenses.total).toBe(input.results.expenses.total + 299);
    input.adjustments.expenseInputs = [expense({ businessDate: undefined })];
    expect(() => validateExpenseExport(input)).toThrow(/旧確定月/);
  });
});

describe("月別の預かり消費税率", () => {
  it("未設定だけ3%にし、0%・100%・0.29%・小数2桁を保持する", () => {
    expect(DEFAULT_CONSUMPTION_TAX_RATE).toBe(3);
    expect(validateConsumptionTaxRate(undefined)).toBe(3);
    for (const rate of [0, 100, 0.29, 3.25, 99.99]) expect(validateConsumptionTaxRate(rate)).toBe(rate);
    const { adjustments } = fixture();
    expect(normalizeMonthlyAdjustments({ ...adjustments, consumptionTaxRate: 0 }).consumptionTaxRate).toBe(0);
    expect(normalizeMonthlyAdjustments(adjustments)).not.toHaveProperty("consumptionTaxRate");
  });
  it.each([null, NaN, Infinity, -1, 100.01, "3", 1.001, 0.29000000000000004])("不正税率%sを丸めず拒否する", (rate) => {
    expect(() => validateConsumptionTaxRate(rate)).toThrow(/税率/);
    const { adjustments } = fixture();
    expect(() => normalizeMonthlyAdjustments({ ...adjustments, consumptionTaxRate: rate as number })).toThrow(/税率/);
  });
  it("小数税率と高額売上は整数bpsで1円未満を切捨て、小数売上の旧3%挙動は維持する", () => {
    expect(consumptionTaxForSales(10000, 0.29)).toBe(29);
    expect(consumptionTaxForSales(9999, 0.29)).toBe(28);
    expect(consumptionTaxForSales(9999, 0)).toBe(0);
    expect(consumptionTaxForSales(9999, 100)).toBe(9999);
    expect(consumptionTaxForSales(Number.MAX_SAFE_INTEGER, 99.99)).toBe(Number(BigInt(Number.MAX_SAFE_INTEGER) * BigInt(9999) / BigInt(10000)));
    expect(consumptionTaxForSales(9999.99, 0.29)).toBe(28);
    expect(consumptionTaxForSales(1e-7, 0.29)).toBe(0);
    for (const total of [0.01, 33.33333333333333, 666.6666666666667, 9999.9]) {
      expect(consumptionTaxForSales(total, 3)).toBe(Math.floor(total * 0.03));
    }
  });
  it.each([0, 0.29, 5, 100])("選択月の%s%だけを経費・収支・帳票へ一度反映する", (rate) => {
    const { data, adjustments, input } = fixture();
    const original = structuredClone(input.results);
    adjustments.consumptionTaxRate = rate;
    input.results = calculateMonthlyAccounting(data, month, adjustments);
    const tax = Math.floor(9999 * Math.round(rate * 100) / 10000);
    expect(input.results.expenses.consumptionTaxRate).toBe(rate);
    expect(input.results.expenses.consumptionTax).toBe(tax);
    expect(input.results.expenses.total).toBe(2010 + tax);
    expect(input.results.balance.profit).toBe(7989 - tax);
    expect(input.results.expenses.byCategory).toEqual(original.expenses.byCategory);
    expect(input.results.castRewards).toEqual(original.castRewards);
    expect(() => validateExpenseExport(input)).not.toThrow();
    const report = buildBalanceExportReport(input);
    expect(report.days.map((day) => day.expenses)).toEqual([210, 110, 110]);
    expect(report.monthlyExpenses).toEqual({ expenses: 1580 + tax, introducerPayment: 0 });
    const otherMonth = { ...adjustments, month: "2026-10", consumptionTaxRate: undefined, expenseInputs: [] };
    expect(calculateMonthlyAccounting(data, "2026-10", otherMonth).expenses.consumptionTaxRate).toBe(3);
  });
  it("不正編集中の税率は画面計算を落とさず警告し、確定を禁止する", () => {
    const { data, adjustments } = fixture();
    adjustments.consumptionTaxRate = NaN;
    const calculated = calculateMonthlyAccounting(data, month, adjustments);
    expect(calculated.warnings.join("\n")).toContain("税率");
    expect(calculated.expenses.consumptionTaxRate).toBeUndefined();
    expect(canFinalizeMonthlyAccounting(data, month, adjustments, true).allowed).toBe(false);
  });
  it("税額が同じでも保存税率と入力の不一致を検出し、source fingerprintも変わる", async () => {
    const { data, adjustments, input } = fixture();
    data.closings.forEach((row) => { row.sales = { cashSales: 1, cardSales: 0, totalSales: 1 }; });
    input.results = calculateMonthlyAccounting(data, month, adjustments);
    expect(consumptionTaxForSales(3, 3)).toBe(consumptionTaxForSales(3, 3.01));
    const before = await monthlySourceFingerprint(data, month, adjustments);
    adjustments.consumptionTaxRate = 3.01;
    expect(await monthlySourceFingerprint(data, month, adjustments)).not.toBe(before);
    expect(() => validateExpenseExport(input)).toThrow(/税率.*一致/);
  });
  it("未設定・明示3%・3.00入力後の正値は同じfingerprintで、0%や他項目の変更は区別する", async () => {
    const { data, adjustments, input } = fixture();
    const originalAdjustments = structuredClone(adjustments);
    const savedSnapshot = snapshot(input);
    const savedFingerprint = savedSnapshot.sourceFingerprint;
    const unset = await monthlySourceFingerprint(data, month, adjustments);
    expect(await monthlySourceFingerprint(data, month, { ...adjustments, consumptionTaxRate: 3 })).toBe(unset);
    // UIの未保存文字列は渡さず、入力3.00から確定した数値だけを計算元に含める。
    const committedUiValue = { ...adjustments, consumptionTaxRate: Number("3.00") };
    expect(await monthlySourceFingerprint(data, month, committedUiValue)).toBe(unset);
    expect(await monthlySourceFingerprint(data, month, { ...adjustments, consumptionTaxRate: 0 })).not.toBe(unset);
    expect(await monthlySourceFingerprint(data, month, { ...adjustments, cardFee: adjustments.cardFee + 1 })).not.toBe(unset);
    expect(adjustments).toEqual(originalAdjustments);
    expect(savedSnapshot.sourceFingerprint).toBe(savedFingerprint);
  });
  it("2.44の新確定は税率必須で、欠損・不正・保存税額と異なる税率を拒否する", () => {
    const { data, adjustments, input } = fixture();
    adjustments.consumptionTaxRate = 0.29;
    input.results = calculateMonthlyAccounting(data, month, adjustments);
    const stored = snapshot(input);
    expect(stored.calculationVersion).toBe("2.44.0");
    expect(normalizeMonthlyAccountingSnapshot(stored, month, 1)).toEqual(stored);
    for (const rate of [undefined, null, 0.291, 5]) {
      const corrupted = structuredClone(stored);
      corrupted.expenses.consumptionTaxRate = rate as number;
      expect(normalizeMonthlyAccountingSnapshot(corrupted, month, 1)).toBeUndefined();
    }
  });
  it("2.43確定は固定3%の税額を保持し、税率を補完・後付けしない", () => {
    const { data, adjustments, input } = fixture();
    delete input.results.expenses.consumptionTaxRate;
    input.snapshot = snapshot(input);
    input.snapshot.calculationVersion = "2.43.0";
    const before = structuredClone(input);
    expect(normalizeMonthlyAccountingSnapshot(input.snapshot, month, 1)).toEqual(input.snapshot);
    expect(() => validateExpenseExport(input)).not.toThrow();
    expect(input).toEqual(before);
    const corrupt = structuredClone(input.snapshot);
    corrupt.expenses.consumptionTaxRate = 3;
    expect(normalizeMonthlyAccountingSnapshot(corrupt, month, 1)).toBeUndefined();
    adjustments.consumptionTaxRate = 5;
    expect(() => validateExpenseExport(input)).toThrow(/税率.*一致/);
    expect(calculateMonthlyAccounting(data, month, adjustments).expenses.consumptionTax).toBe(499);
    expect(input.snapshot.expenses.consumptionTax).toBe(299);
  });
});
