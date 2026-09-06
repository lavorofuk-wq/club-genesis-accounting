import { describe, expect, it } from "vitest";
import type { CastReward, DailyClosing, MonthlyAdjustments, WorkspaceData } from "./gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting } from "./month-accounting";
import { validateExpenseExport, type ExpenseExportInput } from "./expense-export";

function fixture(): ExpenseExportInput {
  const month = "2026-09";
  const adjustments: MonthlyAdjustments = {
    month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
    fixedExpenses: [{ id: "rent", account: "家賃", amount: 60_000 }], cardFee: 1_300, revision: 2,
  };
  const closing: DailyClosing = {
    id: "day-1", businessDate: `${month}-02`, status: "approved", submissionId: "submission-1",
    checksum: "a".repeat(64), updatedAt: "2026-09-03T12:00:00Z",
    sales: { cashSales: 100_000, cardSales: 50_000, totalSales: 150_000 },
    customers: { groupCount: 1, totalCustomers: 2 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [], staffWork: [], drivers: [], staffDailyPaymentTotal: 0,
    expenses: [
      { id: "expense-1", category: "beautyTrial", payee: "体入A", amount: 500 },
      { id: "expense-2", category: "introduction", payee: "紹介者A", amount: 10_000 },
      { id: "expense-3", category: "advertising", payee: "広告会社", amount: 20_000 },
      { id: "expense-4", category: "supplies", payee: "購入先", amount: 1_250 },
      { id: "expense-5", category: "entertainment", payee: "購入先", amount: 2_000 },
      { id: "expense-6", category: "liquor", payee: "酒屋", amount: 12_000 },
      { id: "expense-7", category: "transportOther", payee: "タクシー", amount: 780 },
    ],
    dispatchCastPayment: 12_000, dispatchStaffPayment: 9_000, dispatchFee: 3_000, liquorDeliveryAmount: 30_000,
    cash: { cashSales: 100_000, cardSales: 50_000, totalSales: 150_000, cashFloat: 200_000,
      expenseAndPaymentTotal: 70_530, expectedClosingCash: 229_470, cashProfit: 29_470,
      actualClosingCash: 229_470, difference: 0 },
    posSnapshot: {} as DailyClosing["posSnapshot"],
  };
  const data: WorkspaceData = { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [closing], adjustments: [adjustments], cashFloat: 200_000 };
  const results = calculateMonthlyAccounting(data, month, adjustments);
  return { month, results, closings: [closing], adjustments };
}

function addPayroll(input: ExpenseExportInput) {
  const cast: CastReward = {
    id: "cast-1", name: "花子", days: 1, advisoryDays: 1, hours: 4, trialOnly: false,
    hourlyPay: 12_000, honShimeiSales: 0, jonaiExtensionSales: 0, liquorCost: 0, honShimeiLiquorCost: 0,
    honShimeiBack: 0, banaiShimeiBack: 0, dohanBack: 0, bottleBack: 337, drinkBack: 0,
    hourlyAndBack: 12_337, rewardRate: 0, salesRewardBase: 0, salesReward: 0,
    adoptedSystem: "hourlyAndBack", adoptedReward: 12_337, beautyAllowance: 500, grossPay: 12_837,
    dailyPayment: 15_000, advancePayment: 0, transportFee: 500, withholding: 321, netPay: -2_984,
  };
  input.results.castRewards = [cast];
  input.results.staffPayroll = [{ id: "staff-1", name: "スタッフ", hours: 4, hourly: 6_000, sales: 1_000, bottle: 500, gross: 7_500, daily: 1_000, net: 6_500 }];
  input.results.driverPayroll = [{ id: "driver-1", name: "ドライバー", days: 1, basic: 5_000, remote: 1_000, gross: 6_000, dailyPayment: 1_000, net: 5_000 }];
  input.results.introducerPayments = [{ id: "intro-1", introducer: "紹介者", cast: "花子", feeType: "gross10", honShimeiLiquorCost: 0,
    salesBase: 0, salesFee: 0, grossBase: 12_837, grossFee: 1_283, adopted: "総支給額10%", attendanceAdvisory: 100,
    entryAdvisory: 3_000, advisory: 3_100, total: 4_383 }];
  input.results.balance.cast = cast.grossPay;
  input.results.balance.staff = 7_500;
  input.results.balance.driver = 6_000;
  input.results.balance.introducer = 4_383;
  input.results.balance.totalCosts = 12_837 + 7_500 + 6_000 + 4_383 + input.results.expenses.total;
  input.results.balance.profit = input.results.sales.total - input.results.balance.totalCosts;
}

function finalize(input: ExpenseExportInput) {
  input.snapshot = buildMonthlySnapshot(input.month, 1, "b".repeat(64), input.adjustments, structuredClone(input.results), input.closings, "accounting-user", "2026-09-30T12:00:00Z");
}

describe("経費XLSXの出力元検査", () => {
  it("承認済みだけを検査し、未承認・差戻し・店舗編集中・別月を除外できる", () => {
    const input = fixture();
    ["submitted", "returned", "withdrawn"].forEach((status) => input.closings.push({
      ...input.closings[0], id: status, status: status as DailyClosing["status"], expenses: undefined as unknown as DailyClosing["expenses"],
    }));
    input.closings.push({ ...input.closings[0], id: "other-month", businessDate: "2026-08-31", expenses: [] });
    expect(() => validateExpenseExport(input)).not.toThrow();
  });

  it("承認済み日次がない月でも固定費だけの出力を認める", () => {
    const input = fixture();
    input.closings = [];
    input.results = calculateMonthlyAccounting({ casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200_000 }, input.month, input.adjustments);
    expect(() => validateExpenseExport(input)).not.toThrow();
  });

  it("酒代納品書分の月締め調整は日次合計を置き換え、0円への調整も認める", () => {
    const input = fixture();
    input.adjustments.liquorDeliveryAmount = 0;
    input.results.expenses.liquorDelivery = 0;
    input.results.expenses.total -= 30_000;
    input.results.balance.expenses -= 30_000;
    input.results.balance.totalCosts -= 30_000;
    input.results.balance.profit += 30_000;
    expect(() => validateExpenseExport(input)).not.toThrow();
  });

  it("旧確定済みの1円単位バック・総支給額・負の差引支給を再計算しない", () => {
    const input = fixture();
    addPayroll(input);
    finalize(input);
    input.snapshot!.schemaVersion = 1;
    input.snapshot!.calculationVersion = "2.12.0";
    const before = structuredClone(input);
    expect(() => validateExpenseExport(input)).not.toThrow();
    expect(input).toEqual(before);
  });

  it.each([
    ["存在しない営業日", (input: ExpenseExportInput) => { input.closings[0].businessDate = "2026-09-31"; }, "営業日"],
    ["日付形式不正", (input: ExpenseExportInput) => { input.closings[0].businessDate = "2026-09-2"; }, "営業日"],
    ["営業日重複", (input: ExpenseExportInput) => { input.closings.push({ ...input.closings[0], id: "day-2" }); }, "重複"],
    ["日次ID重複", (input: ExpenseExportInput) => { input.closings.push({ ...input.closings[0], businessDate: "2026-09-03" }); }, "重複"],
    ["経費ID重複", (input: ExpenseExportInput) => { input.closings[0].expenses.push(input.closings[0].expenses[0]); }, "重複"],
    ["不正金額", (input: ExpenseExportInput) => { input.closings[0].expenses[0].amount = NaN; }, "金額"],
    ["負額", (input: ExpenseExportInput) => { input.closings[0].dispatchFee = -1; }, "金額"],
    ["経費欠損", (input: ExpenseExportInput) => { input.closings[0].expenses = undefined as unknown as DailyClosing["expenses"]; }, "経費明細"],
    ["支払先欠損", (input: ExpenseExportInput) => { input.closings[0].expenses[0].payee = " "; }, "支払先"],
    ["未対応科目", (input: ExpenseExportInput) => { input.closings[0].expenses[0].category = "unknown" as never; }, "勘定科目"],
    ["日次の不整合", (input: ExpenseExportInput) => { input.closings[0].integrityIssues = ["不正な金額"]; }, "不整合"],
    ["月次警告", (input: ExpenseExportInput) => { input.results.warnings = ["未解決"]; }, "警告"],
  ])("%sを含む帳票を出力しない", (_label, mutate, error) => {
    const input = fixture();
    mutate(input);
    expect(() => validateExpenseExport(input)).toThrow(error);
  });

  it.each([
    ["科目別月計", (input: ExpenseExportInput) => { input.results.expenses.byCategory.introduction += 1; }],
    ["派遣手数料", (input: ExpenseExportInput) => { input.results.expenses.dispatchFee += 1; }],
    ["酒代月調整", (input: ExpenseExportInput) => { input.adjustments.liquorDeliveryAmount = 29_000; }],
    ["固定経費", (input: ExpenseExportInput) => { input.adjustments.fixedExpenses[0].amount += 1; }],
    ["カード手数料", (input: ExpenseExportInput) => { input.adjustments.cardFee += 1; }],
    ["日次売上", (input: ExpenseExportInput) => { input.closings[0].sales.totalSales += 1; }],
    ["総支出", (input: ExpenseExportInput) => { input.results.balance.totalCosts += 1; }],
    ["キャスト報酬", (input: ExpenseExportInput) => { input.results.castRewards[0].grossPay += 1; }],
    ["キャスト採用方式", (input: ExpenseExportInput) => { input.results.castRewards[0].adoptedSystem = "salesReward"; }],
    ["紹介者報酬", (input: ExpenseExportInput) => { input.results.introducerPayments[0].total += 1; }],
    ["スタッフ給与", (input: ExpenseExportInput) => { input.results.staffPayroll[0].gross += 1; }],
    ["ドライバー給与", (input: ExpenseExportInput) => { input.results.driverPayroll[0].gross += 1; }],
  ])("%sの内訳と月計の不一致を検出する", (_label, mutate) => {
    const input = fixture();
    addPayroll(input);
    mutate(input);
    expect(() => validateExpenseExport(input)).toThrow("一致しません");
  });

  it.each([
    ["日次欠落", (input: ExpenseExportInput) => { input.snapshot!.approvedClosings.push({ id: "missing", checksum: "c", updatedAt: "d" }); }],
    ["日次チェックサム変更", (input: ExpenseExportInput) => { input.closings[0].checksum = "c".repeat(64); }],
    ["日次保存日時変更", (input: ExpenseExportInput) => { input.closings[0].updatedAt = "2026-09-04T12:00:00Z"; }],
    ["経理保存世代変更", (input: ExpenseExportInput) => { input.adjustments.revision = 3; }],
    ["確定結果変更", (input: ExpenseExportInput) => { input.snapshot!.expenses.fixed += 1; }],
  ])("月次確定後の%sを検出する", (_label, mutate) => {
    const input = fixture();
    finalize(input);
    mutate(input);
    expect(() => validateExpenseExport(input)).toThrow(/確定|保存世代/);
  });
});
