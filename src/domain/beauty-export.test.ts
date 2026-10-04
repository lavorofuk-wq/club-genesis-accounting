import { describe, expect, it } from "vitest";
import type { CastRecord, DailyCast, DailyClosing, MonthlyAdjustments, WorkspaceData } from "./gms";
import { calculateMonthlyAccounting } from "./month-accounting";
import { allocateBalancePayroll } from "./balance-allocation";
import { beautyClosingsForExport } from "./beauty-export";

const month = "2026-09";
const adjustments: MonthlyAdjustments = { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 };
function fixture(): WorkspaceData {
  const cast: DailyCast = { masterId: "cast-1", posCastId: "pos-1", name: "花子", kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000,
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0 };
  const daily: DailyClosing = { id: "day-2", businessDate: month + "-02", status: "approved", submissionId: "submitted", checksum: "a".repeat(64), updatedAt: month + "-03T00:00:00Z",
    sales: { cashSales: 0, cardSales: 0, totalSales: 0 }, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [cast], staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000, cashProfit: 0, actualClosingCash: 200000, difference: 0 },
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"] };
  return { casts: [{ id: "cast-1", name: "花子", legalName: "", note: "", createdAt: "", updatedAt: "", status: "active", hiredAt: month + "-01", hourlyRates: { [month]: 3000 } } as CastRecord],
    staff: [], drivers: [], introducers: [], liquor: [], closings: [daily], adjustments: [adjustments], cashFloat: 200000,
    beautyMonths: { [month]: { revision: 1, casts: { "cast-1": { [daily.businessDate]: { eligible: true, attendanceClosingId: daily.id, attendanceIndex: 0, attendancePosCastId: "pos-1" } } } } } };
}

describe("美容室手当の帳票・日別収支への接続", () => {
  it("新登録500円を売上・報酬・日別給与で一致させ、日次原本と現金を変えない", () => {
    const data = fixture(), before = structuredClone(data);
    const results = calculateMonthlyAccounting(data, month, adjustments);
    expect(results.castRewards[0].beautyAllowance).toBe(500);
    expect(results.castSalesReports[0].totals.beautyAllowance).toBe(500);
    const allocation = allocateBalancePayroll({ results, closings: beautyClosingsForExport(data, month), month });
    expect(allocation.byDate[0].castHourly).toBe(12500);
    expect(allocation.byDate[0].castHourly).toBe(results.castRewards[0].grossPay);
    expect(data).toEqual(before);
  });
  it("旧500円を否へ変えた結果を日別収支にも適用し、旧額を二重計上しない", () => {
    const data = fixture(); data.closings[0].casts[0].beautyAllowance = 500;
    data.beautyMonths![month].casts["cast-1"][month + "-02"].eligible = false;
    const results = calculateMonthlyAccounting(data, month, adjustments);
    expect(results.castRewards[0].beautyAllowance).toBe(0);
    const output = allocateBalancePayroll({ results, closings: beautyClosingsForExport(data, month), month });
    expect(output.byDate[0].castHourly).toBe(12000);
    expect(data.closings[0].casts[0].beautyAllowance).toBe(500);
  });
  it.each(["2.12.0", "2.49.1", ""])("旧確定%sの出力は新記録を無視して原本を保持する", (calculationVersion) => {
    const data = fixture(); data.closings[0].casts[0].beautyAllowance = 500;
    data.beautyMonths![month].casts["cast-1"][month + "-02"].eligible = false;
    const results = calculateMonthlyAccounting({ ...data, beautyMonths: undefined }, month, adjustments);
    const closings = beautyClosingsForExport(data, month, { calculationVersion });
    expect(closings).toBe(data.closings);
    expect(allocateBalancePayroll({ results, closings, month }).byDate[0].castHourly).toBe(12500);
  });
  it.each(["2.50.0", "2.100.0", "3.0.0"])("新計算%sの確定帳票にも登録結果を渡す", (calculationVersion) => {
    const data = fixture(), results = calculateMonthlyAccounting(data, month, adjustments);
    expect(allocateBalancePayroll({ results, closings: beautyClosingsForExport(data, month, { calculationVersion }), month }).byDate[0].castHourly).toBe(12500);
  });
});
