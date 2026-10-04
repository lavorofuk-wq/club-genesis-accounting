import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { describe, expect, it } from "vitest";
import { buildBalanceExportReport, type BalanceExportInput } from "./balance-export";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
import { buildCastReceiptSheets, buildCastStatementSheets } from "./cast-receipt";
import { calculateCash, type CastRecord, type DailyCast, type DailyClosing, type MonthlyAdjustments,
  type WorkspaceData } from "./gms";
import { buildIntroducerExport } from "./introducer-export";
import { buildMonthlySnapshot, calculateMonthlyAccounting, normalizeMonthlyAccountingSnapshot } from "./month-accounting";
import { createMonthlyBalanceWorkbook } from "../lib/xlsx/balance";
import { createCastSalesWorkbook } from "../lib/xlsx/cast-sales";
import { createMonthlyExpenseWorkbook } from "../lib/xlsx/expenses";
import { createIntroducerWorkbook } from "../lib/xlsx/introducers";
import { fillReceiptTemplate, receiptCellAddress } from "../lib/xlsx/receipt-template";

const month = "2026-09";

function fixture(salesReward = false) {
  const date = month + "-02";
  const member: CastRecord = { id: "cast-1", name: "源泉確認", legalName: "", status: "active",
    hiredAt: month + "-01", hourlyRates: { [month]: 50_000 }, introducerId: "intro-1",
    note: "", createdAt: date, updatedAt: date };
  const row: DailyCast = { masterId: member.id, posCastId: "pos-1", name: member.name, kind: "regular",
    startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 50_000,
    honShimeiSales: salesReward ? 1_210_010 : 200_000, jonaiExtensionSales: 0,
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
    bottles: [], liquorCost: 0, drinkSales: 0, beautyAllowance: 500,
    dailyPayment: 10_000, advancePayment: 2000, transportFee: 500,
    introducer: { id: "intro-1", name: "紹介者", feeType: "gross10", attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 } };
  const sales = { cashSales: 1_500_000, cardSales: 500_000, totalSales: 2_000_000 };
  const cashInput = { sales, cashFloat: 200_000, expenses: 1000, regularDailyPayments: 10_000,
    trialDailyPayments: 0, staffDailyPayments: 0, driverDailyPayments: 0,
    dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 1_689_000 };
  const funding = calculateCashFunding(cashFundingContext([], date, 200_000),
    { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, calculateCash(cashInput).cashProfit, true);
  const closing: DailyClosing = { id: "daily-1", businessDate: date, status: "approved",
    submissionId: "submission-1", checksum: "a".repeat(64), updatedAt: "2026-09-03T12:00:00Z",
    submittedAtMs: Date.parse("2026-09-03T11:00:00Z"), approvedAt: "2026-09-03T12:00:00Z", approvedBy: "accounting",
    casts: [row], staffWork: [], drivers: [], staffDailyPaymentTotal: 0, sales,
    customers: { groupCount: 1, totalCustomers: 1 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    expenses: [{ id: "expense-1", category: "supplies", payee: "商店", amount: 1000 }],
    dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: calculateCash({ ...cashInput, funding }),
    posSnapshot: { businessDate: date, nominations: { honShimeiCount: 0, jonaiCount: 0 },
      castWork: [{ castId: "pos-1", castName: member.name, castType: "regular", isTrial: false,
        startTime: "20:00", endTime: "00:00", breakMinutes: 0, hours: 4 }], transactions: [],
    } as unknown as DailyClosing["posSnapshot"] };
  const adjustments: MonthlyAdjustments = { month, withholdingByCast: { [member.id]: 1234 },
    staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
    fixedExpenses: [{ id: "fixed-1", account: "家賃", amount: 10_000 }], cardFee: 300, revision: 1,
    castInputs: [{ id: "allowance-1", castId: member.id, castName: member.name, kind: "allowance",
      label: "追加手当", amount: 10_001, businessDate: date }] };
  const data: WorkspaceData = { casts: [member], staff: [], drivers: [], liquor: [], cashFloat: 200_000,
    closings: [closing], adjustments: [adjustments], introducers: [{ id: "intro-1", name: "紹介者", feeType: "gross10",
      attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false, note: "", createdAt: date, updatedAt: date }] };
  const results = calculateMonthlyAccounting(data, month, adjustments);
  return { month, data, closings: data.closings, adjustments, results };
}

function withLegacyTax(input: ReturnType<typeof fixture>, amount = 1234): BalanceExportInput {
  const results = structuredClone(input.results);
  for (const row of results.castRewards) {
    row.netPay += row.withholding - amount;
    row.withholding = amount;
  }
  return { ...input, results };
}

function worksheetValues(sheet: ExcelJS.Worksheet) {
  const cells: Array<[string, ExcelJS.CellValue]> = [];
  sheet.eachRow((row) => row.eachCell((cell) => { if (!cell.isMerged || cell.master === cell) cells.push([cell.address, cell.value]); }));
  return cells;
}

async function roundTrip(book: ExcelJS.Workbook) {
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await book.xlsx.writeBuffer());
  return restored;
}

describe("在籍源泉自動計算の他計算・帳票への反映", () => {
  it("旧手入力の有無・値に左右されず、総支給・紹介料・損益・店舗現金原本を変えない", () => {
    const input = fixture();
    const before = structuredClone(input.data);
    const reward = input.results.castRewards[0];
    expect(input.results.warnings).toEqual([]);
    expect(reward).toMatchObject({ adoptedSystem: "hourlyAndBack", adoptedReward: 200_000,
      beautyAllowance: 500, additionalAllowance: 10_001, grossPay: 210_501,
      withholding: 6177, dailyPayment: 10_000, advancePayment: 2000, transportFee: 500, netPay: 191_824 });
    for (const manual of [undefined, 0, 1, 999_999]) {
      const settings: MonthlyAdjustments = { ...input.adjustments, withholdingByCast: manual === undefined ? {} : { "cast-1": manual } };
      expect(calculateMonthlyAccounting(input.data, month, settings)).toEqual(input.results);
    }
    const legacy = withLegacyTax(input);
    expect(legacy.results.castRewards[0].netPay - reward.netPay).toBe(6177 - 1234);
    expect(input.results.introducerPayments[0]).toMatchObject({ grossBase: 210_501, grossFee: 21_050, total: 21_050 });
    expect(input.results.introducerPayments).toEqual(legacy.results.introducerPayments);
    expect(input.results.balance).toEqual(legacy.results.balance);
    expect(input.results.expenses).toEqual(legacy.results.expenses);
    expect(input.results.sales).toEqual(legacy.results.sales);
    expect(input.results.castSalesReports).toEqual(legacy.results.castSalesReports);
    expect(input.data).toEqual(before);
  });

  it("源泉の増加と差引の減少が相殺され、M38・準備金・経費XLSXは変わらない", () => {
    const input = fixture();
    const legacy = withLegacyTax(input);
    const currentReport = buildBalanceExportReport(input);
    const oldReport = buildBalanceExportReport(legacy);
    expect(currentReport.castWithholding).toBe(6177);
    expect(oldReport.castWithholding).toBe(1234);
    expect(currentReport.castNet + currentReport.castWithholding).toBe(oldReport.castNet + oldReport.castWithholding);
    const current = createMonthlyBalanceWorkbook(input, "").worksheets[0];
    const old = createMonthlyBalanceWorkbook(legacy, "").worksheets[0];
    expect(current.getCell("M38").value).toEqual(old.getCell("M38").value);
    expect(current.getCell("U44").value).toEqual(old.getCell("U44").value);
    expect(current.getCell("U42").value).toBe(6177);
    expect(current.getCell("U41").value).toEqual({ formula: "M37", result: 191_824 });
    expect(worksheetValues(createMonthlyExpenseWorkbook(input, "").worksheets[0]))
      .toEqual(worksheetValues(createMonthlyExpenseWorkbook(legacy, "").worksheets[0]));
  });

  it.each([false, true])("採用方式が売上報酬=%sでも各XLSXの源泉・差引へ同じ自動計算額を転記する", async (salesReward) => {
    const input = fixture(salesReward);
    const reward = input.results.castRewards[0];
    const tax = salesReward ? 59_882 : 6177;
    const net = salesReward ? 664_125 : 191_824;
    expect(reward).toMatchObject({ withholding: tax, netPay: net });
    const casts = (await roundTrip(createCastSalesWorkbook(input.results, month, ""))).worksheets[0];
    expect(casts.getCell("I41").value).toBe(tax);
    expect(casts.getCell("U40").value).toBe(tax);
    expect(casts.getCell("U44").value).toBe(net);
    const balance = (await roundTrip(createMonthlyBalanceWorkbook(input, ""))).worksheets[0];
    expect(balance.getCell("U42").value).toBe(tax);
    expect(balance.getCell("U41").value).toEqual({ formula: "M37", result: net });
    const introduced = buildIntroducerExport(input.results, month).sheets[0].casts[0];
    expect(introduced).toMatchObject({ remuneration: { withholding: tax, netPay: net } });
    const introducer = (await roundTrip(createIntroducerWorkbook(input.results, month))).worksheets[0];
    expect(introducer.getCell("B10").value).toBe(tax);
    expect(introducer.getCell("B11").value).toBe(net);
    const template = await readFile("public/templates/cast-receipt-v3.xlsx");
    for (const document of ["receipt", "statement"] as const) {
      const rows = document === "receipt" ? buildCastReceiptSheets(input.results.castRewards, month)
        : buildCastStatementSheets(input.results.castRewards, input.results.castSalesReports, month);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(await fillReceiptTemplate(template, rows, document) as unknown as ExcelJS.Buffer);
      const taxAddress = document === "statement" ? "F19" : salesReward ? "G6" : "G7";
      const netAddress = document === "statement" ? "F26" : salesReward ? "G7" : "G8";
      expect(book.worksheets[0].getCell(receiptCellAddress(reward.adoptedSystem, document, taxAddress)).value).toBe(tax);
      expect(book.worksheets[0].getCell(receiptCellAddress(reward.adoptedSystem, document, netAddress)).value).toBe(net);
    }
  });

  it("旧確定snapshotの源泉・差引は読み戻しや帳票出力で自動再計算しない", () => {
    const input = fixture();
    const legacy = withLegacyTax(input);
    const snapshot = buildMonthlySnapshot(month, 1, "b".repeat(64), input.adjustments, legacy.results,
      input.closings, "accounting", "2026-10-01T00:00:00Z");
    snapshot.calculationVersion = "2.50.3";
    const saved = normalizeMonthlyAccountingSnapshot(JSON.parse(JSON.stringify(snapshot)), month, 1);
    expect(saved).toBeDefined();
    expect(saved!.castRewards[0]).toMatchObject({ withholding: 1234, netPay: 196_767 });
    const before = structuredClone(saved);
    const output = { ...input, results: saved!, snapshot: saved! };
    expect(createCastSalesWorkbook(saved!, month, "確定済み").worksheets[0].getCell("I41").value).toBe(1234);
    expect(createMonthlyBalanceWorkbook(output, "確定済み").worksheets[0].getCell("U42").value).toBe(1234);
    expect(createIntroducerWorkbook(saved!, month).worksheets[0].getCell("B10").value).toBe(1234);
    expect(buildCastReceiptSheets(saved!.castRewards, month)[0].statementCells).toMatchObject({ F19: 1234, F26: 196_767 });
    expect(saved).toEqual(before);
  });
});
