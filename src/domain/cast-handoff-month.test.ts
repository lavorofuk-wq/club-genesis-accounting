import { describe, expect, it } from "vitest";
import { createCastCorrectionDraft, sealCastCorrectionDraft } from "./cast-corrections";
import { createCastReturnHandoff, materializeCastReturnHandoff, validateCastReturnSubmission } from "./cast-return-handoff";
import { buildBalanceExportReport } from "./balance-export";
import { calculateCash, type CastDailyCorrectionDocument, type DailyCast, type DailyClosing, type MonthlyAdjustments, type PosClosingV3, type PosItem } from "./gms";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
import { buildMonthlySnapshot, calculateMonthlyAccounting, canFinalizeMonthlyAccounting, castAccountingClosings, normalizeMonthlyAccountingSnapshot,
  type AccountingWorkspaceData, type MonthlyAccountingResults } from "./month-accounting";

const month = "2026-09";
const adjustments: MonthlyAdjustments = { month, withholdingByCast: { a: 100, b: 200 }, staffSalesAllowance: { staff: 600 },
  staffBottleAllowance: { staff: 100 }, driverRemoteAllowance: { driver: 500 }, fixedExpenses: [{ id: "rent", account: "家賃", amount: 10000 }], cardFee: 300, revision: 1 };
function cast(id: string): DailyCast {
  return { masterId: id, posCastId: `pos-${id}`, name: id, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4,
    hourlyRate: 3000, honShimeiCount: 1, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 100000,
    jonaiExtensionSales: 10000, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0, beautyAllowance: 0,
    dailyPayment: 1000, advancePayment: 500, transportFee: 500, introducer: { id: "intro", name: "紹介者",
      feeType: "netSales10", attendanceAdvisoryEnabled: true, attendanceAdvisoryFee: 300,
      entryAdvisoryEnabled: false, entryAdvisoryFee: 0 } };
}
function item(id: string, values: Partial<PosItem>): PosItem {
  return { itemId: id, label: id, category: "honShimei", quantity: 1, price: 2000, isHonShimei: true, isBanaiShimei: false,
    isSet: false, isExtension: false, isBanaiExtension: false, isDiscount: false, backTargetCastIds: [], backTargetCastNames: [], banaiExtCastIds: [], ...values };
}
function workspace(): AccountingWorkspaceData {
  const closings: DailyClosing[] = [];
  for (const businessDate of ["2026-09-01", "2026-09-02"]) {
    const id = `daily_${businessDate.replaceAll("-", "")}`;
    const rows = [cast("a"), cast("b")];
    const sales = { cashSales: 1000000, cardSales: 500000, totalSales: 1500000 };
    const customers = { groupCount: 3, totalCustomers: 5 }, nominations = { honShimeiCount: 3, jonaiCount: 0 };
    const submittedAt = `${businessDate}T18:00:00.000Z`;
    const cashInput = { sales, cashFloat: 200000, expenses: 1000, regularDailyPayments: 2000, trialDailyPayments: 0,
      staffDailyPayments: 1000, driverDailyPayments: 500, dispatchCastPayment: 5000, dispatchStaffPayment: 2000, dispatchFee: 500, actualClosingCash: 0 };
    const funding = calculateCashFunding(cashFundingContext(closings, businessDate, 200000), { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, calculateCash(cashInput).cashProfit, true);
    const pos: PosClosingV3 = { schema: "club-genesis-pos-closing", schemaVersion: 3, status: "closed", businessDate,
      sales, customers, nominations, transactions: [{ transactionId: `tx-${id}`, startTime: Date.parse(`${businessDate}T20:00:00+09:00`),
        items: [...rows.map((row) => item(`hon-${row.posCastId}`, { castId: row.posCastId })), item("agency-hon", { castId: "agency" }),
          item("agency-dohan", { category: "dohan", isHonShimei: false, backTargetCastIds: ["agency"] })] } as PosClosingV3["transactions"][number]],
      castWork: [...rows.map((row) => ({ castId: row.posCastId, castName: row.name, castType: row.kind, isTrial: false,
        startTime: row.startTime, endTime: row.endTime, breakMinutes: 0, hours: row.hours })), { castId: "agency", castName: "派遣",
        castType: "dispatch", isTrial: false, startTime: "20:00", endTime: "00:00", breakMinutes: 0, hours: 4 }],
      castSales: rows.map((row) => ({ castId: row.posCastId, castName: row.name, honShimeiSales: row.honShimeiSales, jonaiExtensionSales: row.jonaiExtensionSales,
        drinkSales: 0, totalAttributedSales: row.honShimeiSales + row.jonaiExtensionSales })), enteredCasts: [], exitedCasts: [], trialCasts: [],
      rosterSnapshot: { complete: true, capturedAt: submittedAt, casts: [] }, lifecycleEvents: [], submissionId: id,
      generatedAt: submittedAt, checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64) };
    closings.push({ id, businessDate, status: "approved", checksum: pos.checksum, submissionId: id, submittedAt,
      submittedAtMs: Date.parse(submittedAt), updatedAt: submittedAt, sales, customers, nominations, casts: rows, posSnapshot: pos,
      staffWork: [{ staffId: "staff", name: "スタッフ", kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 1400, dailyPayment: 1000 }],
      drivers: [{ driverId: "driver", name: "ドライバー", dailyRate: 5000, dailyPayment: 500 }], expenses: [{ id: "exp", category: "supplies", payee: "商店", amount: 1000 }],
      staffDailyPaymentTotal: 1000, dispatchCastPayment: 5000, dispatchStaffPayment: 2000, dispatchFee: 500, liquorDeliveryAmount: 600,
      cash: calculateCash({ ...cashInput, funding }) });
  }
  return { closings, casts: ["a", "b"].map((id) => ({ id, name: id, legalName: "", status: "active", hiredAt: "2026-08-01",
    hourlyRates: { [month]: 3000 }, introducerId: "intro", attendanceAdvisoryFee: 300, entryAdvisoryFee: 0, note: "", createdAt: "", updatedAt: "" })),
    staff: [{ id: "staff", name: "スタッフ", status: "active", hiredAt: "2026-08-01", hourlyRate: 1400, hourlyRates: { [month]: 1400 }, note: "", createdAt: "", updatedAt: "" }],
    drivers: [], introducers: [{ id: "intro", name: "紹介者", feeType: "netSales10", attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: false, note: "", createdAt: "", updatedAt: "" }],
    liquor: [], adjustments: [adjustments], cashFloat: 200000, archivedCasts: [], archivedStaff: [], monthStates: [], monthSnapshots: [],
    introducerEntryEvents: [], introducerMonthEvents: [], introducerDeletionCommits: [] };
}
function correct(data: AccountingWorkspaceData, mutate?: (draft: ReturnType<typeof createCastCorrectionDraft>) => void) {
  const source = data.closings[0], draft = createCastCorrectionDraft(source);
  draft.entries[0].endTime = "01:15"; draft.entries[0].honShimeiSales = 1400000; draft.entries[0].jonaiExtensionSales = 100000;
  draft.entries[0].honShimeiCount = 3; draft.entries[0].banaiShimeiCount = 2; draft.entries[0].beautyAllowance = 500;
  draft.entries[0].dohan = [{ arrivalTime: "20:30", extended: true, quantity: 2 }];
  draft.products = [
    { id: "bottle", name: "シャンパン", kind: "champagneWine", unitPrice: 35000, unitCost: 12500, quantity: 1, classification: "honShimei", targets: draft.entries.map((entry) => entry.id), externalTargetCount: 0 },
    { id: "jonai", name: "キープ", kind: "keepBottle", unitPrice: 45000, unitCost: 5000, quantity: 1, classification: "jonaiExtension", targets: [draft.entries[0].id], externalTargetCount: 0 },
    { id: "free", name: "対象外", kind: "champagneWine", unitPrice: 50000, unitCost: 10000, quantity: 1, classification: "excluded", targets: [draft.entries[0].id], externalTargetCount: 0 },
    { id: "drink", name: "ドリンク", kind: "castDrink", unitPrice: 3000, unitCost: 0, quantity: 4, classification: "excluded", targets: draft.entries.map((entry) => entry.id), externalTargetCount: 0 },
  ];
  mutate?.(draft);
  const current = sealCastCorrectionDraft(draft, data), revision = (data.castCorrections?.[0]?.revision || 0) + 1;
  const correction: CastDailyCorrectionDocument = { sourceClosingId: source.id, active: true, revision, current,
    history: { [String(revision)]: { revision, active: true, draft: current, createdAt: "2026-09-10T00:00:00Z", createdBy: "op", reason: "訂正" } } };
  data.castCorrections = [correction]; return correction;
}
function accept(data: AccountingWorkspaceData, timestamp = "2026-09-15T00:00:00.000Z") {
  const next = structuredClone(data), source = next.closings[0], correction = next.castCorrections![0];
  const handoff = createCastReturnHandoff(source, correction, next, { id: `handoff-${correction.revision}`, createdAt: timestamp, returnedAt: timestamp, createdBy: "op", reason: "店舗再確認" });
  const returned = { ...source, status: "returned" as const, castReturnHandoffId: handoff.id, updatedAt: timestamp, returnedAt: timestamp };
  const edited = materializeCastReturnHandoff(returned, handoff);
  validateCastReturnSubmission(edited, returned, handoff);
  delete edited.castReturnHandoffId; delete edited.returnedAt;
  next.closings[0] = { ...edited, status: "approved", submittedAt: timestamp, submittedAtMs: Date.parse(timestamp), updatedAt: timestamp };
  next.castCorrections = [{ ...correction, active: false, current: null }];
  return next;
}
const calculate = (data: AccountingWorkspaceData) => calculateMonthlyAccounting(data, month, adjustments);
const report = (data: AccountingWorkspaceData, results: MonthlyAccountingResults) => buildBalanceExportReport({ month, results,
  adjustments, closings: data.closings, staff: data.staff, castClosings: castAccountingClosings(results, data.closings, month) });
const financial = (result: MonthlyAccountingResults) => ({ castRewards: result.castRewards, introducerPayments: result.introducerPayments,
  staffPayroll: result.staffPayroll, driverPayroll: result.driverPayroll, sales: result.sales, expenses: result.expenses, balance: result.balance, cashFunding: result.cashFunding });

describe("経理修正の差戻し受入・月次確定・帳票の一貫性", () => {
  it("時給方式と売上方式・本指名原価引き紹介料・出勤顧問料・収支が受入前後で一致する", () => {
    const before = workspace(); correct(before); const expected = calculate(before), after = accept(before), actual = calculate(after);
    expect(expected.warnings).toEqual([]); expect(actual.warnings).toEqual([]);
    expect(financial(actual)).toEqual(financial(expected));
    expect(actual.castRewards.find((row) => row.id === "a")).toMatchObject({ adoptedSystem: "salesReward", honShimeiLiquorCost: 6250,
      liquorCost: 11250, bottleBack: 8810, drinkBack: 600, beautyAllowance: 500 });
    expect(actual.castRewards.find((row) => row.id === "b")).toMatchObject({ adoptedSystem: "hourlyAndBack", bottleBack: 2810, drinkBack: 600 });
    expect(actual.introducerPayments.find((row) => row.castId === "a")).toMatchObject({ salesBase: 1493750, salesFee: 149375, attendanceAdvisory: 600, total: 149975 });
    expect(after.closings[0].cash).toEqual(before.closings[0].cash); expect(after.closings[0].posSnapshot).toEqual(before.closings[0].posSnapshot);
    expect(after.closings[0].casts.map(({ dailyPayment, advancePayment, transportFee }) => ({ dailyPayment, advancePayment, transportFee })))
      .toEqual(before.closings[0].casts.map(({ dailyPayment, advancePayment, transportFee }) => ({ dailyPayment, advancePayment, transportFee })));
    expect(report(after, actual)).toEqual(report(before, expected));
    expect(report(after, actual).days[0]).toMatchObject({ honShimeiCount: 5, jonaiCount: 2, dohanCount: 3, castCount: 2, dispatchCastCount: 1 });
  });
  it("再承認後の月次確定snapshotを正規化しても報酬・控除・日別帳票が変わらない", () => {
    const before = workspace(); correct(before); const after = accept(before), calculated = calculate(after);
    expect(canFinalizeMonthlyAccounting(after, month, adjustments, true).allowed).toBe(true);
    const snapshot = buildMonthlySnapshot(month, 1, "c".repeat(64), adjustments, calculated, after.closings, "op", "2026-09-30T18:00:00Z");
    const restored = normalizeMonthlyAccountingSnapshot(JSON.parse(JSON.stringify(snapshot)), month, 1);
    expect(restored).toBeDefined(); expect(financial(restored!)).toEqual(financial(calculated));
    expect(buildBalanceExportReport({ month, results: restored!, snapshot: restored!, adjustments, closings: after.closings,
      staff: after.staff, castClosings: castAccountingClosings(restored!, after.closings, month) })).toEqual(report(after, calculated));
  });
  it("二回目の個別訂正と受入で共有バック・店舗本数・紹介者報酬を二重加算しない", () => {
    const before = workspace(); correct(before); const first = accept(before), originalCounts = structuredClone(first.closings[0].castInputRevision!.originalCasts);
    correct(first, (draft) => { draft.products[0].unitPrice = 40000; draft.entries[0].honShimeiCount = 4; });
    const wanted = calculate(first), second = accept(first, "2026-09-17T00:00:00.000Z"), actual = calculate(second);
    expect(financial(actual)).toEqual(financial(wanted)); expect(report(second, actual)).toEqual(report(first, wanted));
    expect(actual.castRewards.find((row) => row.id === "b")?.bottleBack).toBe(3430);
    expect(report(second, actual).days[0]).toMatchObject({ honShimeiCount: 6, dispatchCastCount: 1 });
    expect(second.closings[0].castInputRevision!.originalCasts).toEqual(originalCounts);
  });
  it("経理訂正だけでは紹介者の保存順序を変えず、店舗再送後のみ最新日次条件を月全体に適用する", () => {
    const before = workspace(); before.closings[1].casts.forEach((row) => { row.introducer!.feeType = "gross10"; });
    correct(before); const projected = calculate(before);
    expect(projected.introducerPayments.every((row) => row.feeType === "gross10")).toBe(true);
    const after = accept(before), accepted = calculate(after);
    expect(accepted.introducerPayments.every((row) => row.feeType === "netSales10")).toBe(true);
    expect(accepted.introducerPayments.find((row) => row.castId === "a")).toMatchObject({ salesBase: 1493750, salesFee: 149375, attendanceAdvisory: 600 });
    expect(accepted.castRewards.map(({ grossPay }) => grossPay)).toEqual(projected.castRewards.map(({ grossPay }) => grossPay));
  });
});
