import { describe, expect, it } from "vitest";
import { calculateCash, normalizeDailyClosing, type DailyClosing } from "./gms";
import { assertCashLedgerChange, calculateCashFunding, calculateConfirmedCashFunding, cashFundingContext, cashFundingDraftContext, cashFundingIssues, cashDayIssues, cashChangeImpacts, cashLedgerIssues, recommendedPersonalRepayment, sameCashReconciliation, summarizeCashFunding, type CashFundingInputs } from "./cash-funding";

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
  it("各区分が安全な整数でも月間現金移動の合算が上限を超えれば停止する", () => {
    const amount = 4_000_000_000_000_000;
    const first = closing("2026-09-01", -amount, [], {}, amount);
    const second = closing("2026-09-02", -amount, [first], { companyReplenishment: amount, companyTransfer: amount }, amount);
    const third = closing("2026-09-03", -amount, [first, second], { companyTransfer: amount }, amount);
    expect(cashLedgerIssues([first, second, third])).toEqual([]);
    expect(() => summarizeCashFunding([first, second, third], "2026-09")).toThrow("現金移動合計");
  });

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

  it("後続営業日が利用した現金額の変更は再確認へ進め、削除は停止する", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-02", 10000, [first], { personalReplenishment: 20000 });
    expect(() => assertCashLedgerChange(first, null, [first, second])).toThrow(/実績を保護/);
    const changed = closing("2026-09-01", -10000);
    expect(() => assertCashLedgerChange(first, changed, [first, second])).not.toThrow();
    expect(() => assertCashLedgerChange(first, { ...first, updatedAt: "changed" }, [first, second])).not.toThrow();
    expect(() => assertCashLedgerChange(second, null, [first, second])).not.toThrow();
  });

  it("過去への新規挿入は後続再確認へ進め、古い前日前提の送信を停止する", () => {
    const first = closing("2026-09-01", -20000);
    const second = closing("2026-09-03", 10000, [first], { personalReplenishment: 20000 });
    const inserted = closing("2026-09-02", 10000, [first], { companyReplenishment: 20000 });
    expect(() => assertCashLedgerChange(null, inserted, [first, second])).not.toThrow();
    const changedFirst = closing("2026-09-01", -10000);
    expect(() => assertCashLedgerChange(null, second, [changedFirst])).toThrow(/繰越が前営業日/);
  });

  describe("作成時期を問わない現金管理と改訂", () => {
    const inputs: CashFundingInputs = { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 };
    function unrecorded(day: string, profit: number) {
      const row = closing(day, profit); delete row.cash.funding; row.status = "returned"; return row;
    }
    function reviewed(row: DailyClosing, previous: DailyClosing[], values = inputs, debt = 0, repayment = 0) {
      const draft = cashFundingDraftContext(previous, row.businessDate, row.cash.cashFloat, row.id);
      const funding = calculateConfirmedCashFunding({ ...draft, openingPersonalDebt: draft.openingPersonalDebt ?? debt }, values, repayment, row.cash.cashProfit, true);
      const expectedClosingCash = row.cash.cashFloat + row.cash.cashProfit + values.companyTransfer - repayment;
      return { ...row, cash: { ...row.cash, funding, expectedClosingCash, actualClosingCash: expectedClosingCash, difference: 0 } };
    }

    it("未記録の開始残高は現在0円との情報から過去0円を推測せずnullにする", () => {
      expect(cashFundingDraftContext([], "2026-09-01", 200000).openingPersonalDebt).toBeNull();
      const previous = unrecorded("2026-09-07", -33550);
      expect(cashFundingDraftContext([previous], "2026-09-08", 200000)).toMatchObject({
        openingPersonalDebt: null, openingShortfall: 33550, previousClosingCash: 166450,
      });
      expect(previous.cash.funding).toBeUndefined();
    });

    it("9月7日を確認保存しても後続9月8日の未入力が保存自体を妨げない", () => {
      const seventh = unrecorded("2026-09-07", -33550);
      const eighth = unrecorded("2026-09-08", 171750);
      const before = structuredClone([seventh, eighth]);
      const candidate = reviewed(seventh, []);
      expect(() => assertCashLedgerChange(seventh, candidate, [seventh, eighth])).not.toThrow();
      expect(candidate.cash.expectedClosingCash).toBe(166450);
      expect(cashChangeImpacts(seventh, candidate, [seventh, eighth])).toEqual([
        { id: eighth.id, businessDate: eighth.businessDate, status: eighth.status, issues: [expect.stringContaining("確認記録がありません")] },
      ]);
      expect([seventh, eighth]).toEqual(before);
    });

    it("補充元と返済を入力した次の日も保存でき、同じ月を一貫した台帳にする", () => {
      const seventh = reviewed(unrecorded("2026-09-07", -33550), []);
      const eighthBefore = unrecorded("2026-09-08", 171750);
      const eighth = reviewed(eighthBefore, [seventh], { ...inputs, companyReplenishment: 33550 });
      expect(() => assertCashLedgerChange(eighthBefore, eighth, [seventh, eighthBefore])).not.toThrow();
      expect(eighth.cash).toMatchObject({ expectedClosingCash: 371750, funding: { closingPersonalDebt: 0, companyReplenishment: 33550 } });
      expect(cashLedgerIssues([seventh, eighth], "2026-09")).toEqual([]);
    });

    it("当時確認した初期の未返済残高を0円へ置き換えない", () => {
      const day = reviewed(unrecorded("2026-09-01", 10000), [], inputs, 25000, 10000);
      expect(cashFundingIssues(day.cash)).toEqual([]);
      expect(day.cash.funding).toMatchObject({ schema: 2, openingPersonalDebt: 25000, personalRepayment: 10000, closingPersonalDebt: 15000 });
      expect(cashDayIssues(day, [])).toEqual([]);
    });

    it("推奨返済額と実返済を分け、過去の実返済を自動更新しない", () => {
      const before = reviewed(unrecorded("2026-09-01", 10000), [], inputs, 20000, 3000);
      expect(recommendedPersonalRepayment(before.cash.funding, inputs, before.cash.cashProfit)).toBe(10000);
      const corrected = structuredClone(before);
      corrected.cash.cashProfit = corrected.cash.cashSales = 20000;
      const after = reviewed(corrected, [], inputs, before.cash.funding.openingPersonalDebt, before.cash.funding.personalRepayment);
      expect(after.cash.funding.personalRepayment).toBe(3000);
      expect(after.cash.funding.closingPersonalDebt).toBe(17000);
      expect(cashFundingIssues(after.cash)).toEqual([]);
    });

    it("過去の残額修正は保存でき、後続の実補充・返済は変更せず差分を警告する", () => {
      const first = reviewed(unrecorded("2026-09-01", -20000), []);
      const second = reviewed(unrecorded("2026-09-02", 10000), [first], { ...inputs, personalReplenishment: 20000 }, 0, 10000);
      const original = structuredClone(second);
      const corrected = reviewed(unrecorded("2026-09-01", -10000), []);
      expect(() => assertCashLedgerChange(first, corrected, [first, second])).not.toThrow();
      expect(cashChangeImpacts(first, corrected, [first, second])[0].issues[0]).toContain("現金繰越");
      expect(second).toEqual(original);
      const draft = cashFundingDraftContext([corrected, second], second.businessDate, 200000, second.id);
      expect(draft.openingShortfall).toBe(10000);
      const unchangedActual = reviewed(second, [corrected], { ...inputs, personalReplenishment: 20000 }, 0, 10000);
      expect(cashFundingIssues(unchangedActual.cash)[0]).toContain("開店前のつり銭不足額");
    });

    it("先に確認した日より過去を補完した時も、異なる未返済残高は要再確認にする", () => {
      const earlierBefore = unrecorded("2026-09-05", 0);
      const seventh = reviewed(unrecorded("2026-09-07", 10000), [earlierBefore], inputs, 0, 0);
      const earlier = reviewed(earlierBefore, [], inputs, 20000, 0);
      expect(() => assertCashLedgerChange(earlierBefore, earlier, [earlierBefore, seventh])).not.toThrow();
      expect(cashDayIssues(seventh, [earlier, seventh])[0]).toContain("前営業日");
    });

    it("後続の確定済み空月へも繰越を変更しない", () => {
      const before = reviewed(unrecorded("2026-08-31", 10000), [], inputs, 0, 0);
      const after = reviewed(unrecorded("2026-08-31", 20000), [], inputs, 0, 0);
      expect(() => assertCashLedgerChange(before, after, [before], [{ month: "2026-09", status: "closed" }])).toThrow("確定解除");
      expect(() => assertCashLedgerChange(before, after, [before], [{ month: "2026-09", status: "closing" }])).toThrow("確定解除");
      expect(() => assertCashLedgerChange(before, after, [before], [{ month: "2026-09", status: "open" }])).not.toThrow();
      expect(() => assertCashLedgerChange(before, { ...before, updatedAt: "changed" }, [before], [{ month: "2026-09", status: "closed" }])).not.toThrow();
    });

    it("0円と未入力を同一扱いにせず、補完前の月次集計を止める", () => {
      const before = unrecorded("2026-09-01", 0);
      expect(cashLedgerIssues([before], "2026-09")[0]).toContain("確認記録がありません");
      expect(() => summarizeCashFunding([before], "2026-09")).toThrow("確認記録がありません");
      expect(() => summarizeCashFunding([before], "2026-10")).toThrow("未返済残高が未確認");
    });

    it("前月の未記録は当月開始残高を確認して補え、前月分を勝手に変更しない", () => {
      const previous = unrecorded("2026-08-31", 0);
      const day = reviewed(unrecorded("2026-09-01", 10000), [previous], inputs, 12000, 3000);
      expect(cashLedgerIssues([previous, day], "2026-09")).toEqual([]);
      day.status = "approved";
      expect(summarizeCashFunding([previous, day], "2026-09")).toMatchObject({ openingPersonalDebt: 12000, closingPersonalDebt: 9000 });
      expect(previous.cash.funding).toBeUndefined();
    });

    it.each([undefined, false])("確認%sは作成時期を問わず保存できない", (confirmation) => {
      const before = unrecorded("2026-09-07", 10000);
      const candidate = reviewed(before, []);
      candidate.cash.funding.confirmed = confirmation as boolean;
      expect(() => assertCashLedgerChange(before, candidate, [before])).toThrow();
    });

    it("新規も既存も記録欠落へ降格させない", () => {
      const before = reviewed(unrecorded("2026-09-07", 10000), []);
      const missing = structuredClone(before); delete (missing.cash as DailyClosing["cash"]).funding;
      expect(() => assertCashLedgerChange(null, missing, [])).toThrow("補充・返済の入力");
      expect(() => assertCashLedgerChange(before, missing, [before])).toThrow("補充・返済の入力");
    });

    it.each([-1, 0.5, 10001])("不正または返済可能額を超えた実返済%sを拒否する", (repayment) => {
      const context = { previousClosingId: "", previousBusinessDate: "", previousClosingCash: 200000, openingShortfall: 0, openingPersonalDebt: 20000 };
      if (repayment < 0 || !Number.isInteger(repayment)) expect(() => calculateConfirmedCashFunding(context, inputs, repayment, 10000, true)).toThrow();
      else {
        const row = reviewed(unrecorded("2026-09-01", 10000), [], inputs, 20000, repayment);
        expect(cashFundingIssues(row.cash).length).toBeGreaterThan(0);
      }
    });

    it("改訂理由の判定は未知項目も含む現金全体を比較する", () => {
      const cash = { ...closing("2026-09-01", 0).cash, detail: { values: [1, 2], note: "記録" } };
      const same = { ...structuredClone(cash), detail: { note: "記録", values: [1, 2] } };
      expect(sameCashReconciliation(cash, same)).toBe(true);
      same.detail.values[0] = 3;
      expect(sameCashReconciliation(cash, same)).toBe(false);
    });
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
