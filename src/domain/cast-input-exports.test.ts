import { describe, expect, it } from "vitest";
import { balanceDailyCounts, buildBalanceExportReport, type BalanceExportInput } from "./balance-export";
import type { DailyCast, DailyClosing, MonthlyAdjustments, PosCastWork, PosItem } from "./gms";
import { calculateCash } from "./gms";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
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
  const prior: DailyClosing[] = [];
  for (const row of [first, second]) {
    const cashInput = { sales: row.sales, cashFloat: 200000,
      expenses: 1234, regularDailyPayments: 1000, trialDailyPayments: 0, staffDailyPayments: 2000,
      driverDailyPayments: 1000, dispatchCastPayment: 6000, dispatchStaffPayment: 7000, dispatchFee: 800, actualClosingCash: 0 };
    const funding = calculateCashFunding(cashFundingContext(prior, row.businessDate, 200000),
      { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, calculateCash(cashInput).cashProfit, true);
    row.cash = calculateCash({ ...cashInput, funding });
    prior.push(row);
  }
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
  return { month: "2026-09", results, closings: [second, first], adjustments };
}

import { readFile, mkdir, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { buildCastReceiptSheets } from "./cast-receipt";
import { buildIntroducerExport } from "./introducer-export";
import { normalizeMonthlyAccountingSnapshot } from "./month-accounting";
import { validateExpenseExport } from "./expense-export";
import { createCastSalesWorkbook } from "../lib/xlsx/cast-sales";
import { createMonthlyBalanceWorkbook } from "../lib/xlsx/balance";
import { createMonthlyExpenseWorkbook } from "../lib/xlsx/expenses";
import { createIntroducerWorkbook } from "../lib/xlsx/introducers";
import { fillReceiptTemplate, receiptCellAddress } from "../lib/xlsx/receipt-template";
import type { CastRecord, IntroducerFeeType, WorkspaceData } from "./gms";

function featureInput(salesAmount = 90000, feeType: IntroducerFeeType = "gross10") {
  const source = fullInput();
  const member: CastRecord = { id: "regular", name: "regular", legalName: "", status: "active",
    hiredAt: "2026-09-01", hourlyRates: { "2026-09": 2000 }, note: "", createdAt: "2026-09-01", updatedAt: "2026-09-01" };
  for (const day of source.closings) {
    day.submittedAtMs = Date.parse(day.businessDate + "T19:00:00Z");
    day.casts[0].introducer = { id: "intro", name: "紹介者", feeType, attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 };
  }
  const data: WorkspaceData = { casts: [member], staff: [], drivers: [], introducers: [], liquor: [],
    closings: source.closings, adjustments: [], cashFloat: 200000 };
  const baseline = calculateMonthlyAccounting(data, source.month, source.adjustments);
  const adjustments: MonthlyAdjustments = { ...source.adjustments, castInputs: [
    { id: "sale", castId: member.id, castName: member.name, kind: "sales", label: "アフター売上", amount: salesAmount, businessDate: "2026-09-02" },
    { id: "allowance", castId: member.id, castName: member.name, kind: "allowance", label: "イベント1位手当", amount: 100001 },
    { id: "transport", castId: member.id, castName: member.name, kind: "transport", label: "追加送迎", amount: 1500 },
  ] };
  return { ...source, data, baseline, adjustments, results: calculateMonthlyAccounting(data, source.month, adjustments) };
}

describe("キャストデータ入力から全帳票への統合", () => {
  it.each([90000, 1210000])("追加売上 %i 円を報酬へ反映し店売上・現金原本を変えない", (sales) => {
    const input = featureInput(sales);
    const { results, baseline, closings } = input;
    const original = structuredClone(closings);
    expect(results.warnings).toEqual([]);
    expect(results.sales).toEqual(baseline.sales);
    const reward = results.castRewards[0];
    expect(reward.honShimeiSales).toBe(40000);
    expect(reward.jonaiExtensionSales).toBe(8000);
    expect(reward.additionalSales).toBe(sales);
    expect(reward.hourlyAndBack).toBe(33000);
    expect(reward.additionalAllowance).toBe(100001);
    expect(reward.transportFee).toBe(2500);
    expect(reward.grossPay).toBe(sales === 90000 ? 134001 : 855801);
    expect(reward.netPay).toBe(sales === 90000 ? 126168 : 847968);
    const report = buildBalanceExportReport(input);
    expect(report.additionalSales).toBe(sales);
    expect(report.castTransport).toBe(2500);
    expect(report.days.reduce((sum, day) => sum + day.castHourly + day.castSalesReward, 0)).toBe(reward.grossPay);
    validateExpenseExport(input);
    expect(buildCastReceiptSheets(results.castRewards, input.month)[0].statementCells.F15).toBe(101001);
    expect(buildIntroducerExport(results, input.month).sheets[0].total).toBe(Math.floor(reward.grossPay * .1));
    expect(closings).toEqual(original);
  });

  it.each(["sales10", "netSales10", "gross10", "higherSalesGross10", "higherNetSalesGross10"] as const)
    ("紹介者 %s の売上基準を増やさず総支給基準には追加手当を含む", (feeType) => {
      const input = featureInput(90000, feeType);
      const payment = input.results.introducerPayments[0];
      expect(payment.salesBase).toBe(40000);
      expect(payment.grossBase).toBe(134001);
      const workbook = createIntroducerWorkbook(input.results, input.month);
      expect(workbook.worksheets).toHaveLength(1);
      expect(buildIntroducerExport(input.results, input.month).sheets[0].total)
        .toBe(feeType === "sales10" || feeType === "netSales10" ? 4000 : 13400);
    });

  it("確定snapshotをFirebase形式で読み戻しても全帳票へ同じ金額を出力する", async () => {
    const input = featureInput(1210000);
    const snapshot = buildMonthlySnapshot(input.month, 1, "a".repeat(64), input.adjustments, input.results, input.closings, "op", "2026-10-01T00:00:00Z");
    const saved = normalizeMonthlyAccountingSnapshot(JSON.parse(JSON.stringify(snapshot)), input.month, 1);
    expect(saved).toBeDefined();
    expect(saved!.castRewards).toEqual(input.results.castRewards);
    const exported = { ...input, results: saved!, snapshot: saved! };
    validateExpenseExport(exported);
    const sheets = buildCastReceiptSheets(saved!.castRewards, input.month);
    const template = await readFile("public/templates/cast-receipt-v3.xlsx");
    const books = {
      "cast-sales": createCastSalesWorkbook(saved!, input.month, "追加項目確認"),
      balance: createMonthlyBalanceWorkbook(exported, "追加項目確認"),
      expenses: createMonthlyExpenseWorkbook(exported, "追加項目確認"),
      introducers: createIntroducerWorkbook(saved!, input.month),
    };
    const buffers = new Map<string, Uint8Array>();
    for (const [name, book] of Object.entries(books)) {
      const buffer = await book.xlsx.writeBuffer();
      const restored = new ExcelJS.Workbook();
      await restored.xlsx.load(buffer);
      expect(restored.worksheets.length).toBeGreaterThan(0);
      buffers.set(name, new Uint8Array(buffer));
    }
    const castSheet = books["cast-sales"].worksheets[0];
    expect(castSheet.getCell("T4").value).toBe(1234000);
    expect(castSheet.getCell("J49").value).toBe("アフター売上");
    expect(castSheet.getCell("S49").value).toBe(1210000);
    expect(books.balance.worksheets[0].getCell("D44").value).toEqual({ formula: "SUM(D42:D43,D45)", result: 1258000 });
    for (const document of ["receipt", "statement"] as const) {
      const bytes = await fillReceiptTemplate(template, sheets, document);
      const restored = new ExcelJS.Workbook();
      await restored.xlsx.load(bytes as unknown as ExcelJS.Buffer);
      const address = receiptCellAddress("salesReward", document, document === "receipt" ? "G7" : "F26");
      expect(restored.worksheets[0].getCell(address).value).toBe(847968);
      if (document === "statement") expect(restored.worksheets[0].getCell(receiptCellAddress("salesReward", "statement", "B15")).value).toBe("美容室・手当て等");
      buffers.set(document, bytes);
    }
    if (process.env.GMS_CAST_INPUT_QA_DIR) {
      await mkdir(process.env.GMS_CAST_INPUT_QA_DIR, { recursive: true });
      for (const [name, bytes] of buffers) await writeFile(process.env.GMS_CAST_INPUT_QA_DIR + "/" + name + ".xlsx", bytes);
    }
  });

  it("経理入力の日別・月別・報酬間の改変を出力時に拒否する", () => {
    const input = featureInput();
    input.results.castSalesReports[0].totals.additionalAllowance = 100000;
    expect(() => createCastSalesWorkbook(input.results, input.month, "")).toThrow();
    expect(() => buildBalanceExportReport(input)).toThrow();
  });
});
