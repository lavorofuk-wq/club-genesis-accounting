import { describe, expect, it } from "vitest";
import { calculateCash, normalizeDailyClosing, type DailyClosing } from "./gms";
import { assertCashLedgerChange, calculateCashFunding, cashFundingContext, cashFundingIssues, cashLedgerIssues, summarizeCashFunding, type CashFundingInputs } from "./cash-funding";

function closing(day: string, cashProfit: number, previous: DailyClosing[] = [], inputs: Partial<CashFundingInputs> = {}, cashFloat = 200000): DailyClosing {
  const funding = calculateCashFunding(cashFundingContext(previous, day, cashFloat), {
    companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0, ...inputs,
  }, cashProfit, true);
  const cash = calculateCash({
    funding, cashFloat, sales: { cashSales: Math.max(0, cashProfit), cardSales: 12345, totalSales: Math.max(0, cashProfit) + 12345 },
    expenses: Math.max(0, -cashProfit), regularDailyPayments: 0, trialDailyPayments: 0, staffDailyPayments: 0,
    driverDailyPayments: 0, dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 0,
  });
  return { id: `daily_${day.replaceAll("-", "")}`, businessDate: day, status: "approved", cash } as DailyClosing;
}

describe("会社補充・個人立替・返済の現金管理", () => {
  it("初回の未返済残高は0、確認済みの計算残額を保存する", () => {
    const day = closing("2026-09-01", 30000);
    expect(day.cash).toMatchObject({ cashProfit: 30000, expectedClosingCash: 230000, actualClosingCash: 230000, difference: 0 });
    expect(day.cash.funding).toMatchObject({ openingPersonalDebt: 0, openingShortfall: 0, previousClosingId: "", personalRepayment: 0, closingPersonalDebt: 0, confirmed: true });
    expect(cashFundingIssues(day.cash)).toEqual([]);
  });

  it("個人立替2万円を利益1万円で一部返済し、会社送金で残額を完済する", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-02", 10000, [first], { personalReplenishment: 20000 });
    const third = closing("2026-09-03", 0, [first, second], { companyTransfer: 10000 });
    expect(first.cash.expectedClosingCash).toBe(180000);
    expect(second.cash.funding).toMatchObject({ openingShortfall: 20000, personalReplenishment: 20000, personalRepayment: 10000, closingPersonalDebt: 10000 });
    expect(second.cash).toMatchObject({ cashProfit: 10000, expectedClosingCash: 200000 });
    expect(third.cash.funding).toMatchObject({ openingPersonalDebt: 10000, companyTransfer: 10000, personalRepayment: 10000, closingPersonalDebt: 0 });
    expect(third.cash).toMatchObject({ cashProfit: 0, expectedClosingCash: 200000 });
    expect(cashLedgerIssues([third, first, second])).toEqual([]);
  });

  it("会社からのつり銭補充は借りにならず利益も現金余剰も減らさない", () => {
    const first = closing("2026-09-01", -20000);
    const day = closing("2026-09-02", 30000, [first], { companyReplenishment: 20000 });
    expect(day.cash.funding).toMatchObject({ companyReplenishment: 20000, personalReplenishment: 0, personalRepayment: 0, closingPersonalDebt: 0 });
    expect(day.cash).toMatchObject({ expectedClosingCash: 230000, cashProfit: 30000 });
    expect(day.cash.cardSales).toBe(12345);
    expect(cashFundingIssues(day.cash)).toEqual([]);
  });

  it("会社補充と個人立替の併用は入力された内訳どおりに記録する", () => {
    const first = closing("2026-09-01", -30000);
    const day = closing("2026-09-02", 15000, [first], { companyReplenishment: 10000, personalReplenishment: 20000 });
    expect(day.cash.funding).toMatchObject({ personalRepayment: 15000, closingPersonalDebt: 5000 });
    expect(day.cash.expectedClosingCash).toBe(200000);
    expect(cashFundingIssues(day.cash)).toEqual([]);
  });

  it("会社送金と現金余剰を合わせて返済し、残りは手元現金として保管する", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-02", 0, [first], { personalReplenishment: 20000 });
    const day = closing("2026-09-03", 10000, [first, second], { companyTransfer: 15000 });
    expect(day.cash.funding).toMatchObject({ openingPersonalDebt: 20000, personalRepayment: 20000, closingPersonalDebt: 0 });
    expect(day.cash).toMatchObject({ cashProfit: 10000, expectedClosingCash: 205000 });
    expect(cashFundingIssues(day.cash)).toEqual([]);
  });

  it("返済によって設定つり銭を下回らない", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-02", -10000, [first], { personalReplenishment: 20000, companyTransfer: 5000 });
    expect(second.cash.funding).toMatchObject({ personalRepayment: 0, closingPersonalDebt: 20000 });
    expect(second.cash.expectedClosingCash).toBe(195000);
  });

  it("月が変わっても未返済を繰り越し、会社補充で過去の個人債務を消さない", () => {
    const first = closing("2026-09-29", -20000);
    const second = closing("2026-09-30", -10000, [first], { personalReplenishment: 20000 });
    const third = closing("2026-10-01", 5000, [first, second], { companyReplenishment: 10000 });
    expect(third.cash.funding).toMatchObject({ openingPersonalDebt: 20000, companyReplenishment: 10000, personalRepayment: 5000, closingPersonalDebt: 15000 });
    expect(summarizeCashFunding([first, second, third], "2026-10")).toEqual({ managedDays: 1, openingPersonalDebt: 20000, companyReplenishment: 10000, personalReplenishment: 0, companyTransfer: 0, personalRepayment: 5000, closingPersonalDebt: 15000, netCashMovement: 5000 });
  });

  it("開店補充は設定つり銭に含め、日次残額へ二重加算しない", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-02", 0, [first], { personalReplenishment: 20000 });
    expect(second.cash.expectedClosingCash).toBe(200000);
    expect(summarizeCashFunding([first, second], "2026-09").netCashMovement).toBe(20000);
  });

  it("出勤のない月にも既存の未返済残高を繰り越して0円へ戻さない", () => {
    const first = closing("2026-09-29", -20000);
    const second = closing("2026-09-30", 0, [first], { personalReplenishment: 20000 });
    expect(summarizeCashFunding([first, second], "2026-10")).toMatchObject({ managedDays: 0, openingPersonalDebt: 20000, closingPersonalDebt: 20000, netCashMovement: 0 });
  });

  it.each(["returned", "withdrawn", "submitted"] as const)("前日が%sでも記録済みの現金と債務を繰越し、月次集計は承認を待つ", (status) => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-02", 10000, [first], { personalReplenishment: 20000 });
    second.status = status;
    const third = closing("2026-09-03", 0, [first, second]);
    expect(third.cash.funding?.openingPersonalDebt).toBe(10000);
    expect(cashLedgerIssues([first, second, third])).toEqual([]);
    expect(() => summarizeCashFunding([first, second, third], "2026-09")).toThrow(/未承認/);
  });

  it("過去の現金マイナスから個人立替を推定せず、実在高・差額を改変しない", () => {
    const legacy = closing("2026-09-01", -20000);
    delete legacy.cash.funding;
    legacy.cash.actualClosingCash = 179999;
    legacy.cash.difference = -1;
    const before = structuredClone(legacy);
    expect(cashFundingContext([legacy], "2026-09-02", 200000)).toMatchObject({ previousClosingCash: 180000, openingShortfall: 20000, openingPersonalDebt: 0 });
    expect(cashFundingIssues(legacy.cash)).toEqual([]);
    expect(legacy).toEqual(before);
    expect(normalizeDailyClosing(legacy).cash).toEqual(before.cash);
  });

  it("新方式の照合記録を正規化で落とさず、不正な確認値は警告する", () => {
    const day = closing("2026-09-01", 0);
    expect(normalizeDailyClosing(day).cash.funding).toEqual(day.cash.funding);
    day.cash.funding!.confirmed = false;
    expect(normalizeDailyClosing(day).integrityIssues?.some((s) => s.includes("一致していることを確認"))).toBe(true);
  });

  it.each([
    ["確認なし", (day: DailyClosing) => { day.cash.funding!.confirmed = false; }],
    ["開店補充不足", (day: DailyClosing) => { day.cash.funding!.personalReplenishment -= 1; }],
    ["借り残高改変", (day: DailyClosing) => { day.cash.funding!.closingPersonalDebt += 1; }],
    ["返済改変", (day: DailyClosing) => { day.cash.funding!.personalRepayment += 1; }],
    ["1円未満", (day: DailyClosing) => { day.cash.funding!.companyTransfer += 0.5; }],
    ["不正な前日ID", (day: DailyClosing) => { day.cash.funding!.previousClosingId = "../test"; }],
    ["利益から返済控除", (day: DailyClosing) => { day.cash.cashProfit -= 10000; }],
    ["実在高改変", (day: DailyClosing) => { day.cash.actualClosingCash += 1; }],
  ])("%sを拒否する", (_label, corrupt) => {
    const first = closing("2026-09-01", -20000);
    const day = closing("2026-09-02", 10000, [first], { personalReplenishment: 20000 });
    corrupt(day);
    expect(cashFundingIssues(day.cash).length).toBeGreaterThan(0);
  });

  it("補充元未指定は個人立替と推定せず、送信可能な状態にしない", () => {
    const first = closing("2026-09-01", -20000);
    const day = closing("2026-09-02", 10000, [first]);
    expect(cashFundingIssues(day.cash)[0]).toContain("会社補充と個人立替の合計");
  });

  it("後続営業日が利用した現金額の変更・削除を停止する", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-02", 10000, [first], { personalReplenishment: 20000 });
    expect(() => assertCashLedgerChange(first, null, [first, second])).toThrow(/実績を保護/);
    const changed = closing("2026-09-01", -10000);
    expect(() => assertCashLedgerChange(first, changed, [first, second])).toThrow(/実績を保護/);
    expect(() => assertCashLedgerChange(first, { ...first, updatedAt: "changed" }, [first, second])).not.toThrow();
    expect(() => assertCashLedgerChange(second, null, [first, second])).not.toThrow();
  });

  it("過去への新規挿入と前日改変後の古い画面からの送信を停止する", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-03", 10000, [first], { personalReplenishment: 20000 });
    const inserted = closing("2026-09-02", 10000, [first], { companyReplenishment: 20000 });
    expect(() => assertCashLedgerChange(null, inserted, [first, second])).toThrow(/過去日次の追加/);
    const changedFirst = closing("2026-09-01", -10000);
    expect(() => assertCashLedgerChange(null, second, [changedFirst])).toThrow(/繰越が前営業日/);
  });

  it("承認済み月の資金移動を集計し、未来月の不具合は過去月へ波及させない", () => {
    const first = closing("2026-09-30", 10000);
    const future = closing("2026-10-01", 0, [first]);
    future.cash.funding!.openingPersonalDebt = 100;
    expect(cashLedgerIssues([first, future], "2026-09")).toEqual([]);
    expect(summarizeCashFunding([first, future], "2026-09").managedDays).toBe(1);
    expect(cashLedgerIssues([first, future], "2026-10").length).toBeGreaterThan(0);
  });
});
