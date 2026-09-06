import { describe, expect, it } from "vitest";
import { balanceDailyCounts, buildBalanceExportReport, type BalanceExportInput } from "./balance-export";
import type { DailyCast, DailyClosing, MonthlyAdjustments, PosCastWork, PosItem } from "./gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting } from "./month-accounting";

function work(id: string, kind: PosCastWork["castType"]): PosCastWork {
  return { castId: id, castName: id, castType: kind, isTrial: kind === "trial",
    startTime: "20:00", endTime: "02:00", breakMinutes: 0, hours: 6 };
}

function item(id: string, category: string, quantity = 1): PosItem {
  return { itemId: id, label: id, category, quantity, price: 2000,
    isHonShimei: category === "honShimei", isBanaiShimei: category === "jonai",
    isSet: false, isExtension: false, isBanaiExtension: false, isDiscount: false,
    backTargetCastIds: [], backTargetCastNames: [], banaiExtCastIds: [] };
}

function closing(): DailyClosing {
  const casts = ["regular", "trial"].map((kind) => ({
    masterId: kind, posCastId: kind, name: kind, kind,
  } as DailyCast));
  return {
    businessDate: "2026-09-02", casts,
    customers: { groupCount: 3, totalCustomers: 5 },
    nominations: { honShimeiCount: 3, jonaiCount: 2 },
    posSnapshot: { businessDate: "2026-09-02", nominations: { honShimeiCount: 3, jonaiCount: 2 },
      castWork: [work("regular", "regular"), work("trial", "trial"), work("agency", "dispatch"), work("trial-as-dispatch", "trial")],
      transactions: [{ transactionId: "tx", items: [item("hon", "honShimei", 3), item("jonai", "jonai", 2),
        { ...item("companion-a", "dohan"), backTargetCastIds: ["regular"] },
        { ...item("companion-b", "dohan"), backTargetCastIds: ["agency"] }] }],
    },
  } as unknown as DailyClosing;
}

describe("収支帳票の店舗全体本数・人数", () => {
  it("在籍と体入をL、明示派遣と派遣指定体入をOへ分離し、派遣分を含む本数を数える", () => {
    expect(balanceDailyCounts(closing())).toEqual({ groups: 3, customers: 5, honShimeiCount: 3,
      jonaiCount: 2, dohanCount: 2, castCount: 2, dispatchCastCount: 2 });
  });
  it("同伴2人の課金2件を2本とし、複数数量も組数ではなく商品数量で数える", () => {
    const data = closing();
    data.posSnapshot.transactions[0].items[2].quantity = 2;
    expect(balanceDailyCounts(data).dohanCount).toBe(3);
  });
  it("勤務時間0を任意に欠勤へ変えず、保存済み出勤人数を保つ", () => {
    const data = closing();
    data.posSnapshot.castWork[0].hours = 0;
    expect(balanceDailyCounts(data).castCount).toBe(2);
  });
  it.each([
    ["POS欠落", (d: DailyClosing) => { d.posSnapshot = undefined as never; }, "保存POS"],
    ["営業日違い", (d: DailyClosing) => { d.posSnapshot.businessDate = "2026-09-03"; }, "保存POS"],
    ["regularの保存行欠落", (d: DailyClosing) => { d.casts.shift(); }, "派遣と推定せず"],
    ["保存行に対応する勤務欠落", (d: DailyClosing) => { d.posSnapshot.castWork.shift(); }, "POS勤務"],
    ["勤務ID重複", (d: DailyClosing) => { d.posSnapshot.castWork.push(d.posSnapshot.castWork[0]); }, "勤務ID"],
    ["キャストID重複", (d: DailyClosing) => { d.casts.push(d.casts[0]); }, "出勤が重複"],
    ["キャスト名前違い", (d: DailyClosing) => { d.casts[0].name = "別人"; }, "名前・区分"],
    ["店舗本数とPOS本数違い", (d: DailyClosing) => { d.nominations.honShimeiCount = 4; }, "一致しません"],
    ["商品本数とPOS集計違い", (d: DailyClosing) => { d.posSnapshot.nominations.jonaiCount = 4; }, "一致しません"],
    ["同伴本数の小数", (d: DailyClosing) => { d.posSnapshot.transactions[0].items[2].quantity = .5; }, "整数"],
    ["商品重複", (d: DailyClosing) => { d.posSnapshot.transactions[0].items.push(d.posSnapshot.transactions[0].items[0]); }, "商品区分"],
    ["会計重複", (d: DailyClosing) => { d.posSnapshot.transactions.push(d.posSnapshot.transactions[0]); }, "会計明細"],
    ["客数欠落", (d: DailyClosing) => { d.customers.totalCustomers = undefined as never; }, "客数"],
  ] as const)("%sをゼロ件と誤表示せず停止する", (_name, mutate, error) => {
    const data = closing();
    mutate(data);
    expect(() => balanceDailyCounts(data)).toThrow(error);
  });
});

function fullInput(): BalanceExportInput {
  const casts: DailyCast[] = [{
    masterId: "regular", posCastId: "regular", name: "regular", kind: "regular",
    startTime: "20:00", endTime: "02:00", hours: 6, hourlyRate: 2000,
    honShimeiSales: 20000, jonaiExtensionSales: 4000, honShimeiCount: 1, banaiShimeiCount: 1,
    dohanCount: 1, dohanBack: 3000, bottles: [], liquorCost: 0, drinkSales: 0,
    beautyAllowance: 500, dailyPayment: 1000, advancePayment: 1500, transportFee: 500,
  }];
  const first: DailyClosing = {
    ...closing(), id: "day-1", status: "approved", submissionId: "submission-1", checksum: "a".repeat(64),
    updatedAt: "2026-09-03T12:00:00.000Z", submittedAt: "2026-09-03T10:00:00.000Z",
    casts, sales: { cashSales: 100001, cardSales: 50003, totalSales: 150004 },
    staffWork: [{ staffId: "staff", name: "スタッフ", kind: "regular", startTime: "20:00", endTime: "02:00",
      hours: 6, hourlyRate: 1500, dailyPayment: 2000 }],
    drivers: [{ driverId: "driver", name: "ドライバー", dailyRate: 4000, dailyPayment: 1000 }],
    staffDailyPaymentTotal: 2000,
    expenses: [{ id: "exp", category: "supplies", payee: "商店", amount: 1234 }],
    dispatchCastPayment: 6000, dispatchStaffPayment: 7000, dispatchFee: 800, liquorDeliveryAmount: 2000,
    cash: { cashSales: 100001, cardSales: 50003, totalSales: 150004, cashFloat: 200000,
      expenseAndPaymentTotal: 0, expectedClosingCash: 0, cashProfit: 0, actualClosingCash: 0, difference: 0 },
  };
  // trial は派遣指定であり、保存キャストとしては存在しない。
  const second = structuredClone(first);
  second.id = "day-2";
  second.businessDate = "2026-09-04";
  second.posSnapshot.businessDate = second.businessDate;
  second.updatedAt = "2026-09-05T12:00:00.000Z";
  const adjustments: MonthlyAdjustments = {
    month: "2026-09", withholdingByCast: { regular: 333 }, staffSalesAllowance: { staff: 1200 },
    staffBottleAllowance: { staff: 300 }, driverRemoteAllowance: { driver: 500 },
    fixedExpenses: [{ id: "fixed", account: "家賃", amount: 60000 }], cardFee: 400,
    liquorDeliveryAmount: 3500, revision: 1,
  };
  const results = calculateMonthlyAccounting({ casts: [], staff: [], drivers: [], introducers: [], liquor: [],
    closings: [second, first], adjustments: [adjustments], cashFloat: 200000 }, "2026-09", adjustments);
  results.introducerPayments = [{ id: "intro_regular", introducerId: "intro", castId: "regular", introducer: "紹介者",
    cast: "regular", feeType: "sales10", honShimeiLiquorCost: 0, salesBase: 40000, salesFee: 4000,
    grossBase: 0, grossFee: 0, adopted: "売上10%", attendanceAdvisory: 100, entryAdvisory: 200,
    advisory: 300, total: 4300 }];
  results.balance.introducer = 4300;
  results.balance.totalCosts += 4300;
  results.balance.profit -= 4300;
  return { month: "2026-09", results, closings: [second, first], adjustments, monthlyChargeDate: "2026-09-04" };
}

describe("収支帳票の月次突合", () => {
  it("明示計上日に月額費用を置き、派遣支払をP/Rへ分離してGMS収支に一致する", () => {
    const data = fullInput();
    const before = structuredClone(data);
    const report = buildBalanceExportReport(data);
    expect(report.days.map((day) => day.businessDate)).toEqual(["2026-09-02", "2026-09-04"]);
    expect(report.days.map((day) => day.introducerPayment)).toEqual([0, 4300]);
    expect(report.days.map((day) => day.expenses)).toEqual([2034, 65934]);
    expect(report.days.map((day) => day.employeeGross)).toEqual([20000, 22000]);
    expect(report.days.map((day) => day.dispatchCastPayment)).toEqual([6000, 6000]);
    expect(report.days.map((day) => day.dispatchCastCount)).toEqual([3, 3]);
    expect(report.days[0].cashSales).toBe(100001);
    expect(report.days[0].cardSales).toBe(50003);
    expect(report.days[0].totalSales).toBe(150004);
    expect(report.castDailyAndAdvance).toBe(5000);
    expect(report.employeeDaily).toBe(6000);
    expect(report.castTransport).toBe(1000);
    expect(report.castWithholding).toBe(333);
    expect(data).toEqual(before);
  });
  it("現金残高の展開式はキャスト控除・従業員日払い・派遣・手数料を各1回だけ引く", () => {
    const data = fullInput();
    const report = buildBalanceExportReport(data);
    const result = data.results;
    const employeeNet = result.staffPayroll.reduce((sum, row) => sum + row.net, 0)
      + result.driverPayroll.reduce((sum, row) => sum + row.net, 0);
    const expanded = result.sales.cash - report.castNet - report.castWithholding - result.balance.introducer
      - employeeNet - report.castDailyAndAdvance - report.employeeDaily - result.expenses.total;
    expect(expanded).toBe(result.sales.cash - result.balance.totalCosts + report.castTransport);
  });
  it("未回答の月額計上日を勝手に既定化しない", () => {
    const data = fullInput();
    delete data.monthlyChargeDate;
    expect(() => buildBalanceExportReport(data)).toThrow("計上日が未指定");
  });
  it("承認前・別月の日次を含めず、月次確定時の日次の保存世代を突合する", () => {
    const data = fullInput();
    const report = buildBalanceExportReport(data);
    data.snapshot = buildMonthlySnapshot(data.month, 1, "b".repeat(64), data.adjustments,
      structuredClone(data.results), data.closings, "user", "2026-09-30T12:00:00.000Z");
    data.closings.push({ ...data.closings[0], id: "pending", status: "submitted" });
    data.closings.push({ ...data.closings[0], id: "returned", status: "returned" });
    data.closings.push({ ...data.closings[0], id: "draft", status: "withdrawn" });
    expect(buildBalanceExportReport(data)).toEqual(report);
    data.closings[0].updatedAt = "2026-09-05T13:00:00.000Z";
    expect(() => buildBalanceExportReport(data)).toThrow("保存世代");
  });
  it("確定済みの日別売上を別配分へ変更した結果を出力しない", () => {
    const data = fullInput();
    data.snapshot = buildMonthlySnapshot(data.month, 1, "b".repeat(64), data.adjustments,
      structuredClone(data.results), data.closings, "user", "2026-09-30T12:00:00.000Z");
    data.results.castSalesReports[0].days[0].hours += .25;
    expect(() => buildBalanceExportReport(data)).toThrow("月次確定時と一致");
  });
  it("保存済みのキャスト日払いが月次と違えば現金残高を出力しない", () => {
    const data = fullInput();
    data.closings[0].casts[0].dailyPayment += 1;
    expect(() => buildBalanceExportReport(data)).toThrow("キャスト日払い・立替");
  });
});
