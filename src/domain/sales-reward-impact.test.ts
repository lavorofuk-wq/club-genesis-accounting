import { describe, expect, it } from "vitest";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
import {
  calculateCash,
  floorTen,
  legacyBottleSourceKey,
  type CastRecord,
  type DailyCast,
  type DailyClosing,
  type IntroducerFeeType,
  type MonthlyAdjustments,
  type WorkspaceData,
} from "./gms";
import { calculateIntroducerPayments, calculateMonthlyAccounting } from "./month-accounting";

const month = "2026-09";

function fixture(feeType: IntroducerFeeType = "gross10") {
  const member: CastRecord = {
    id: "cast-1", name: "計算確認", legalName: "", status: "active", hiredAt: `${month}-01`,
    hourlyRates: { [month]: 3000 }, introducerId: "referrer-1", note: "", createdAt: "", updatedAt: "",
  };
  const row: DailyCast = {
    masterId: member.id, posCastId: "pos-cast-1", name: member.name, kind: "regular",
    startTime: "20:00", endTime: "00:15", hours: 4.25, hourlyRate: 3000,
    honShimeiCount: 1, banaiShimeiCount: 1, dohanCount: 1, dohanBack: 3000,
    honShimeiSales: 600_000, jonaiExtensionSales: 610_010, liquorCost: 40_001,
    bottles: [{ itemId: "bottle-1", name: "確認用シャンパン", kind: "champagneWine", quantity: 1,
      salesAmount: 44_001, costAmount: 40_001, specialCost: false }],
    drinkSales: 3330,
    drinkAllocations: [{ itemId: "drink-1", name: "確認用ドリンク", quantity: 1, salesAmount: 3330, backAmount: 333 }],
    beautyAllowance: 0, dailyPayment: 10_000, advancePayment: 2000, transportFee: 500,
    introducer: { id: "referrer-1", name: "紹介者", feeType, attendanceAdvisoryEnabled: false,
      entryAdvisoryEnabled: false, attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 },
  };
  const sales = { cashSales: 500_003, cardSales: 710_007, totalSales: 1_210_010 };
  const cash = calculateCash({ sales, cashFloat: 200_000, expenses: 2000, regularDailyPayments: 10_000,
    trialDailyPayments: 0, staffDailyPayments: 2000, driverDailyPayments: 1000,
    dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 685_003 });
  const businessDate = `${month}-02`;
  cash.funding = calculateCashFunding(cashFundingContext([], businessDate, 200_000),
    { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, cash.cashProfit, true);
  const closing: DailyClosing = {
    id: "closing-1", businessDate, status: "approved", submissionId: "submission-1", checksum: "a".repeat(64),
    casts: [row], sales, customers: { groupCount: 1, totalCustomers: 1 }, nominations: { honShimeiCount: 1, jonaiCount: 1 },
    staffWork: [{ staffId: "staff-1", name: "スタッフ", kind: "regular", startTime: "20:00", endTime: "00:15",
      hours: 4.25, hourlyRate: 1400, dailyPayment: 2000 }],
    drivers: [{ driverId: "driver-1", name: "ドライバー", dailyRate: 10_000, dailyPayment: 1000 }],
    expenses: [{ id: "expense-1", category: "supplies", payee: "支払先", amount: 2000 }],
    staffDailyPaymentTotal: 2000, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0,
    liquorDeliveryAmount: 0, cash, posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"],
    approvedAt: "2026-09-03T03:00:00.000Z", approvedBy: "accounting", updatedAt: "2026-09-03T03:00:00.000Z",
  };
  const settings: MonthlyAdjustments = {
    month, withholdingByCast: { [member.id]: 1234 }, staffSalesAllowance: { "staff-1": 301 },
    staffBottleAllowance: { "staff-1": 202 }, driverRemoteAllowance: { "driver-1": 1500 }, fixedExpenses: [], cardFee: 0,
    legacyBottleClassifications: { [legacyBottleSourceKey(closing, row, 0)]: "honShimei" },
    castInputs: [{ id: "allowance-1", castId: member.id, castName: member.name,
      kind: "allowance", label: "追加手当", amount: 5, businessDate }],
  };
  const data: WorkspaceData = {
    casts: [member], staff: [], drivers: [], liquor: [], closings: [closing], adjustments: [settings], cashFloat: 200_000,
    introducers: [{ id: "referrer-1", name: "紹介者", feeType, attendanceAdvisoryEnabled: false,
      entryAdvisoryEnabled: false, note: "", createdAt: "", updatedAt: "" }],
  };
  return { data, settings };
}

describe("売上報酬1円単位の他計算への影響", () => {
  it.each([
    ["gross10", 71_401],
    ["higherSalesGross10", 71_401],
    ["higherNetSalesGross10", 71_401],
    ["sales10", 60_000],
    ["netSales10", 55_999],
  ] as const)("%sは既存の算定基準を維持し、総支給型だけ1円境界を反映する", (feeType, fee) => {
    const { data, settings } = fixture(feeType);
    const before = structuredClone({ data, settings });
    const result = calculateMonthlyAccounting(data, month, settings);
    const reward = result.castRewards[0];
    expect(reward).toMatchObject({
      honShimeiSales: 600_000, jonaiExtensionSales: 610_010, rewardRate: .6,
      salesRewardBase: 1_190_009.5, salesReward: 714_005, adoptedReward: 714_005,
      additionalAllowance: 5, grossPay: 714_010, dailyPayment: 10_000, advancePayment: 2000,
      transportFee: 500, withholding: 57_585, netPay: 643_925,
    });
    const payment = result.introducerPayments[0];
    expect(payment).toMatchObject({ grossBase: 714_010, grossFee: 71_401, total: fee });
    const oldPay = floorTen(floorTen(reward.salesRewardBase) * reward.rewardRate);
    expect(oldPay).toBe(714_000);
    const oldWithholding = 57_584;
    const oldReward = { ...reward, salesReward: oldPay, adoptedReward: oldPay,
      grossPay: oldPay + 5, withholding: oldWithholding, netPay: oldPay + 5 - 12_500 - oldWithholding };
    const oldPayment = calculateIntroducerPayments([oldReward], data, month)[0];
    expect(payment.salesBase).toBe(oldPayment.salesBase);
    expect(payment.salesFee).toBe(oldPayment.salesFee);
    expect(payment.grossFee - oldPayment.grossFee).toBe(1);
    expect(payment.total - oldPayment.total).toBe(feeType === "sales10" || feeType === "netSales10" ? 0 : 1);
    expect(result.balance.cast).toBe(714_010);
    expect(result.balance.introducer).toBe(fee);
    expect(result.balance.profit).toBe(1_210_010 - 714_010 - fee - 6453 - 11_500 - result.expenses.total);
    expect({ data, settings }).toEqual(before);
  });

  it("時給・各種バック、スタッフ・ドライバー給与、店舗売上・記録済み現金を変更しない", () => {
    const { data, settings } = fixture();
    const before = structuredClone({ data, settings });
    const result = calculateMonthlyAccounting(data, month, settings);
    expect(result.castRewards[0]).toMatchObject({ hourlyPay: 12_750, honShimeiBack: 1000, banaiShimeiBack: 500,
      dohanBack: 3000, bottleBack: 1000, drinkBack: 330, hourlyAndBack: 18_580 });
    expect(result.staffPayroll[0]).toMatchObject({ hours: 4.25, hourly: 5950, sales: 301, bottle: 202,
      gross: 6453, daily: 2000, net: 4453 });
    expect(result.driverPayroll[0]).toMatchObject({ days: 1, basic: 10_000, remote: 1500,
      gross: 11_500, dailyPayment: 1000, net: 10_500 });
    expect(result.sales).toEqual({ cash: 500_003, card: 710_007, total: 1_210_010 });
    expect(data.closings[0].cash).toMatchObject({ expenseAndPaymentTotal: 15_000,
      cashProfit: 485_003, expectedClosingCash: 685_003, actualClosingCash: 685_003, difference: 0 });
    expect({ data, settings }).toEqual(before);
  });
});
