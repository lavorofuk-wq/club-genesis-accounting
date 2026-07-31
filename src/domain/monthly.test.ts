import { describe, expect, it } from "vitest";
import { calculateCastRewards, closingTotals } from "./monthly";
import type { CastMember, FinalizedClosing } from "./types";

const member: CastMember = {
  id: "member-1",
  posCastId: "pos-1",
  personKey: "person-1",
  name: "あい",
  internalNo: 1,
  status: "active",
  guaranteedHourlyRate: 3_000
};
const closing: FinalizedClosing = {
  id: "closing-1",
  schema: "club-genesis-pos-closing",
  schemaVersion: 2,
  submissionId: "submission-1",
  checksum: "checksum",
  businessDate: "2026-07-31",
  status: "finalized",
  sales: { totalSales: 100_000, cashSales: 100_000, cardSales: 0 },
  customers: { groupCount: 1, totalCustomers: 2 },
  nominations: {},
  expenses: [{ amount: 5_000 }],
  auricLiquorAmount: 8_000,
  allowances: [{ amount: 1_000, personId: "member-1" }],
  payrollDeductions: [{
    type: "dailyPayment",
    amount: 4_000,
    personId: "member-1",
    personName: "あい",
    personType: "cast"
  }],
  transactions: [],
  castSales: [{ castId: "member-1", castName: "あい", honShimeiSales: 50_000 }],
  castWork: [{ castId: "member-1", castName: "あい", hours: 5 }],
  trialWork: [],
  staffWork: [],
  lifecycleEvents: []
};

describe("月次集計", () => {
  it("人物IDへ紐づいた日払いを報酬から控除する", () => {
    const row = calculateCastRewards([closing], [member])[0];
    expect(row.grossPayable).toBe(16_000);
    expect(row.deductions).toBe(4_000);
    expect(row.payable).toBe(12_000);
  });

  it("日次収支にオーリック酒代を含める", () => {
    expect(closingTotals(closing)).toMatchObject({
      expense: 13_000,
      allowance: 1_000,
      profit: 86_000
    });
  });
});
