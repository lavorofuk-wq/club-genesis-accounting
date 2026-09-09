import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CashReconciliation } from "@/domain/gms";
import type { CashFundingSummary } from "@/domain/cash-funding";
import { CashFundingDetail, MonthlyCashFunding } from "./accounting-forms";

function cash(): CashReconciliation {
  return { cashSales: 10000, cardSales: 0, totalSales: 10000, cashFloat: 200000, expenseAndPaymentTotal: 0,
    expectedClosingCash: 200000, cashProfit: 10000, actualClosingCash: 200000, difference: 0,
    funding: { schema: 1, previousClosingId: "previous", previousBusinessDate: "2026-09-01", previousClosingCash: 150000,
      openingShortfall: 50000, openingPersonalDebt: 20000, companyReplenishment: 20000, personalReplenishment: 30000,
      companyTransfer: 5000, personalRepayment: 15000, closingPersonalDebt: 35000, confirmed: true } };
}
const summary: CashFundingSummary = { managedDays: 2, openingPersonalDebt: 20000, companyReplenishment: 20000, personalReplenishment: 30000,
  companyTransfer: 5000, personalRepayment: 15000, closingPersonalDebt: 35000, netCashMovement: 40000 };

describe("経理の補充・返済表示", () => {
  it("日次の会社補充・個人借り・会社送金・返済・未返済を区分して表示する", () => {
    const value = cash();
    const before = structuredClone(value);
    const markup = renderToStaticMarkup(createElement(CashFundingDetail, { cash: value }));
    for (const text of ["損益とは別管理", "返済不要", "個人による補充（借り）", "会社からの送金（返済原資）", "個人への返済", "翌営業日へ繰り越す個人未返済残高", "35,000", "2026-09-01"]) expect(markup).toContain(text);
    expect(markup).not.toContain("notice error");
    expect(value).toEqual(before);
  });

  it("一致未確認の保存データは確認を促し、表示だけで確認済みに変更しない", () => {
    const value = cash();
    value.funding!.confirmed = false;
    const markup = renderToStaticMarkup(createElement(CashFundingDetail, { cash: value }));
    expect(markup).toContain("一致していることを確認してください");
    expect(value.funding!.confirmed).toBe(false);
  });

  it("旧日次に補充項目を後付けせず、現金実額・差額を保持する", () => {
    const value = cash();
    delete value.funding;
    value.actualClosingCash = 190123;
    value.difference = -9877;
    const before = structuredClone(value);
    expect(renderToStaticMarkup(createElement(CashFundingDetail, { cash: value }))).toBe("");
    expect(value).toEqual(before);
  });

  it("破損した繰越フィールドをReactへ渡さず、エラー内容を表示する", () => {
    const value = cash();
    value.funding!.previousBusinessDate = { unexpected: true } as never;
    const markup = renderToStaticMarkup(createElement(CashFundingDetail, { cash: value }));
    expect(markup).toContain("現金繰越元の営業日・日次IDが不正");
    expect(markup).not.toContain("<table");
  });

  it("月次では承認済みの現金移動と翌月未返済を損益から独立表示する", () => {
    const markup = renderToStaticMarkup(createElement(MonthlyCashFunding, { summary }));
    for (const text of ["売上・経費・利益には含めません", "2日", "翌月繰越", "35,000", "40,000"]) expect(markup).toContain(text);
  });

  it("集計できない月をゼロとして表示せず、未承認・警告の確認を促す", () => {
    const markup = renderToStaticMarkup(createElement(MonthlyCashFunding, {}));
    expect(markup).toContain("未確定または未記録");
    expect(markup).toContain("未承認日次・警告");
    expect(markup).not.toContain("<table");
  });
});
