import { describe, expect, it } from "vitest";
import { calculateCash, type DailyClosing, type MonthlyAdjustments, type WorkspaceData } from "./gms";
import { calculateCashFunding, cashFundingContext, type CashFundingInputs } from "./cash-funding";
import { buildMonthlySnapshot, calculateMonthlyAccounting, canFinalizeMonthlyAccounting, monthlySourceFingerprint, normalizeMonthlyAccountingSnapshot } from "./month-accounting";

const month = "2026-09";
const adjustments: MonthlyAdjustments = { month, revision: 1, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 };
function day(businessDate: string, cashProfit = 0): DailyClosing {
  const sales = { cashSales: Math.max(0, cashProfit), cardSales: 0, totalSales: Math.max(0, cashProfit) };
  const expenses = Math.max(0, -cashProfit);
  return {
    id: businessDate, businessDate, status: "approved", submissionId: businessDate, checksum: "a".repeat(64), updatedAt: "2026-09-30T12:00:00.000Z",
    sales, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 }, casts: [], staffWork: [], drivers: [],
    expenses: expenses ? [{ id: businessDate, category: "supplies", payee: "商店", amount: expenses }] : [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: calculateCash({ sales, cashFloat: 200000, expenses, regularDailyPayments: 0, trialDailyPayments: 0, staffDailyPayments: 0, driverDailyPayments: 0,
      dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 200000 + cashProfit }),
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"],
  };
}
function fundedDay(businessDate: string, previous: DailyClosing[], cashProfit: number, inputs: CashFundingInputs): DailyClosing {
  const closing = day(businessDate, cashProfit);
  const context = cashFundingContext(previous, businessDate, 200000);
  const funding = calculateCashFunding(context, inputs, cashProfit, true);
  closing.cash = calculateCash({ sales: closing.sales, cashFloat: 200000, expenses: closing.cash.expenseAndPaymentTotal,
    regularDailyPayments: 0, trialDailyPayments: 0, staffDailyPayments: 0, driverDailyPayments: 0,
    dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 0, funding });
  return closing;
}
function fixture() {
  const previous = day("2026-08-31", -50000);
  const first = fundedDay("2026-09-01", [previous], 10000, { companyReplenishment: 20000, personalReplenishment: 30000, companyTransfer: 5000 });
  const second = fundedDay("2026-09-02", [previous, first], -10000, { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 });
  const next = fundedDay("2026-10-01", [previous, first, second], 5000, { companyReplenishment: 0, personalReplenishment: 10000, companyTransfer: 1000 });
  const source: WorkspaceData = { casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [next, second, previous, first], cashFloat: 200000, adjustments: [adjustments] };
  return { source, first, second, next };
}

describe("経理月次の現金補充・返済", () => {
  it("会社補充・借り・部分返済を利益から分離し、月をまたいだ未返済残高を保持する", () => {
    const { source } = fixture();
    const before = structuredClone(source);
    const result = calculateMonthlyAccounting(source, month, adjustments);
    expect(result.cashFunding).toEqual({ managedDays: 2, openingPersonalDebt: 0, companyReplenishment: 20000, personalReplenishment: 30000,
      companyTransfer: 5000, personalRepayment: 15000, closingPersonalDebt: 15000, netCashMovement: 40000 });
    const withoutFunding = structuredClone(source);
    withoutFunding.closings.forEach((row) => { delete row.cash.funding; });
    const legacy = calculateMonthlyAccounting(withoutFunding, month, adjustments);
    expect(result.sales).toEqual(legacy.sales);
    expect(result.expenses).toEqual(legacy.expenses);
    expect(result.balance).toEqual(legacy.balance);
    expect(result.balance.profit).toBe(0);
    const next = calculateMonthlyAccounting(source, "2026-10", { ...adjustments, month: "2026-10" });
    expect(next.cashFunding).toMatchObject({ openingPersonalDebt: 15000, personalReplenishment: 10000, personalRepayment: 6000, closingPersonalDebt: 19000 });
    expect(source).toEqual(before);
  });

  it.each(["submitted", "returned", "withdrawn"] as const)("%sの補充実績を承認済み集計へ混ぜず、集計未確定と理由を表示する", (status) => {
    const { source, second } = fixture();
    second.status = status;
    const result = calculateMonthlyAccounting(source, month, adjustments);
    expect(result.cashFunding).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("未承認・差戻し・取下げ");
    expect(result.sales.cash).toBe(10000);
    expect(result.expenses.dailyExpenseTotal).toBe(0);
    expect(canFinalizeMonthlyAccounting(source, month, adjustments, true).allowed).toBe(false);
  });

  it("繰越不一致を月次確定の阻害理由にし、通常の承認済み損益計算は継続する", () => {
    const { source, second } = fixture();
    second.cash.funding!.previousClosingId = "unknown";
    const result = calculateMonthlyAccounting(source, month, adjustments);
    expect(result.cashFunding).toBeUndefined();
    expect(result.warnings.join("\n")).toContain("現金繰越");
    expect(result.balance.profit).toBe(0);
    const check = canFinalizeMonthlyAccounting(source, month, adjustments, true);
    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.join("\n")).toContain("現金繰越");
  });

  it("現金管理のない旧日次・営業日0の月はゼロ集計にし、過去の現金実額は変更しない", () => {
    const source = fixture().source;
    source.closings.forEach((row) => { delete row.cash.funding; });
    const before = structuredClone(source);
    const result = calculateMonthlyAccounting(source, month, adjustments);
    expect(result.cashFunding).toEqual({ managedDays: 0, openingPersonalDebt: 0, companyReplenishment: 0, personalReplenishment: 0,
      companyTransfer: 0, personalRepayment: 0, closingPersonalDebt: 0, netCashMovement: 0 });
    expect(calculateMonthlyAccounting({ ...source, closings: [] }, month, adjustments).cashFunding).toEqual(result.cashFunding);
    expect(source).toEqual(before);
  });

  it("旧9月7日の現金不変再送確認を、新方式開始と誤認せず旧9月8日も保全する", () => {
    const seventh = day("2026-09-07", -33550);
    const eighth = day("2026-09-08", 171750);
    const source: WorkspaceData = { ...fixture().source, closings: [seventh, eighth] };
    const before = calculateMonthlyAccounting(source, month, adjustments);
    seventh.legacyCashConfirmed = true;
    const snapshot = structuredClone(source);
    const after = calculateMonthlyAccounting(source, month, adjustments);
    expect(after.cashFunding).toEqual(before.cashFunding);
    expect(after.cashFunding?.managedDays).toBe(0);
    expect(after.balance).toEqual(before.balance);
    expect(after.warnings.join("\n")).not.toContain("補充・返済の確認記録がありません");
    expect(source).toEqual(snapshot);
  });

  it("営業日0の月も前月からの借りを保持し、新たな現金移動0円のまま確定へ保存できる", () => {
    const { source } = fixture();
    const targetMonth = "2026-11";
    const input = { ...adjustments, month: targetMonth };
    const result = calculateMonthlyAccounting(source, targetMonth, input);
    expect(result.cashFunding).toEqual({ managedDays: 0, openingPersonalDebt: 19000, companyReplenishment: 0, personalReplenishment: 0,
      companyTransfer: 0, personalRepayment: 0, closingPersonalDebt: 19000, netCashMovement: 0 });
    const snapshot = buildMonthlySnapshot(targetMonth, 1, "a".repeat(64), input, result, source.closings, "accounting", "2026-11-30T12:00:00.000Z");
    snapshot.calculationVersion = "2.21.0";
    expect(normalizeMonthlyAccountingSnapshot(snapshot, targetMonth, 1)?.cashFunding).toEqual(result.cashFunding);
  });

  it("空月確定でも前月の借り・残額・繰越元の変更を検出し、表示済み残高で確定させない", async () => {
    const { source, next } = fixture();
    const targetMonth = "2026-11";
    const input = { ...adjustments, month: targetMonth };
    const original = await monthlySourceFingerprint(source, targetMonth, input);
    const beforeFunding = structuredClone(next.cash.funding!);
    const beforeCash = next.cash.expectedClosingCash;
    next.cash.funding!.closingPersonalDebt += 1;
    expect(await monthlySourceFingerprint(source, targetMonth, input)).not.toBe(original);
    next.cash.funding = beforeFunding;
    next.cash.expectedClosingCash += 1;
    expect(await monthlySourceFingerprint(source, targetMonth, input)).not.toBe(original);
    next.cash.expectedClosingCash = beforeCash;
    next.id = "changed-source-id";
    expect(await monthlySourceFingerprint(source, targetMonth, input)).not.toBe(original);
  });

  it("管理開始前のlegacy現金残額変更も検出し、未来月の現金変更は過去月へ影響させない", async () => {
    const { source, next } = fixture();
    const original = await monthlySourceFingerprint(source, month, adjustments);
    next.cash.funding!.closingPersonalDebt += 1;
    next.cash.expectedClosingCash += 1;
    expect(await monthlySourceFingerprint(source, month, adjustments)).toBe(original);
    const previous = source.closings.find((row) => row.businessDate === "2026-08-31")!;
    previous.cash.expectedClosingCash += 1;
    expect(await monthlySourceFingerprint(source, month, adjustments)).not.toBe(original);
  });

  it("新summaryを確定へ保存し、summaryがない旧schema3には後付けしない", () => {
    const { source } = fixture();
    const result = calculateMonthlyAccounting(source, month, adjustments);
    const snapshot = buildMonthlySnapshot(month, 1, "a".repeat(64), adjustments, result, source.closings, "accounting", "2026-09-30T12:00:00.000Z");
    expect(normalizeMonthlyAccountingSnapshot(snapshot, month, 1)?.cashFunding).toEqual(result.cashFunding);
    const legacy = structuredClone(snapshot);
    const missing = structuredClone(snapshot);
    missing.calculationVersion = "2.21.0";
    delete missing.cashFunding;
    expect(normalizeMonthlyAccountingSnapshot(missing, month, 1)).toBeUndefined();
    legacy.calculationVersion = "2.20.0";
    delete legacy.cashFunding;
    const normalized = normalizeMonthlyAccountingSnapshot(legacy, month, 1)!;
    expect(normalized).toBeDefined();
    expect(Object.hasOwn(normalized, "cashFunding")).toBe(false);
  });

  it.each([
    ["非整数", { personalReplenishment: 30000.1 }], ["負額", { companyReplenishment: -1 }],
    ["現金増減不一致", { netCashMovement: 40001 }], ["未返済不一致", { closingPersonalDebt: 15001 }],
    ["日数不一致", { managedDays: 3 }], ["非数値", { openingPersonalDebt: "0" }],
    ["管理日0なのに補充あり", { managedDays: 0 }],
  ])("確定summaryの%sを読み込まない", (_label, changes) => {
    const { source } = fixture();
    const result = calculateMonthlyAccounting(source, month, adjustments);
    const snapshot = buildMonthlySnapshot(month, 1, "a".repeat(64), adjustments, result, source.closings, "accounting", "2026-09-30T12:00:00.000Z");
    expect(normalizeMonthlyAccountingSnapshot({ ...snapshot, cashFunding: { ...snapshot.cashFunding, ...changes } }, month, 1)).toBeUndefined();
  });
});
