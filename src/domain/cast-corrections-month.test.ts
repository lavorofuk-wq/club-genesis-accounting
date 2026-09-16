import { describe, expect, it } from "vitest";
import { createCastCorrectionDraft, sealCastCorrectionDraft, validateCastCorrectionDraft } from "./cast-corrections";
import { buildBalanceExportReport } from "./balance-export";
import { calculateCash, posItemOccurrenceKey, type CastCorrectionDraft, type CastDailyCorrectionDocument,
  type DailyCast, type DailyClosing, type MonthlyAdjustments, type PosClosingV3, type PosItem, type WorkspaceData } from "./gms";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
import { buildMonthlySnapshot, calculateMonthlyAccounting, canFinalizeMonthlyAccounting, castAccountingClosings,
  monthlySourceFingerprint, normalizeMonthlyAccountingSnapshot, type MonthlyAccountingResults } from "./month-accounting";

const september = "2026-09";
const october = "2026-10";
const settings = (month = september): MonthlyAdjustments => ({ month, withholdingByCast: {}, staffSalesAllowance: {},
  staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0, revision: 1 });

function cast(id = "cast-a"): DailyCast {
  return { masterId: id, posCastId: `pos-${id}`, name: id, kind: "regular", startTime: "20:00", endTime: "00:00",
    hours: 4, hourlyRate: 3000, honShimeiCount: 1, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
    honShimeiSales: 100000, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0,
    introducer: { id: "introducer", name: "紹介者", feeType: "sales10", attendanceAdvisoryEnabled: true,
      entryAdvisoryEnabled: false, attendanceAdvisoryFee: 300, entryAdvisoryFee: 0 } };
}

function item(id: string, values: Partial<PosItem> = {}): PosItem {
  return { itemId: id, label: id, category: "honShimei", quantity: 1, price: 2000,
    isHonShimei: true, isBanaiShimei: false, isSet: false, isExtension: false, isBanaiExtension: false, isDiscount: false,
    backTargetCastIds: [], backTargetCastNames: [], banaiExtCastIds: [], ...values };
}

function daily(businessDate: string, casts: DailyCast[] = [cast()]): DailyClosing {
  const id = `daily_${businessDate.replaceAll("-", "")}`;
  const generatedAt = `${businessDate}T18:00:00.000Z`;
  const sales = { cashSales: 500000, cardSales: 250000, totalSales: 750000 };
  const customers = { groupCount: 1, totalCustomers: 2 };
  const nominations = { honShimeiCount: casts.reduce((sum, row) => sum + row.honShimeiCount, 0), jonaiCount: 0 };
  const posSnapshot: PosClosingV3 = {
    schema: "club-genesis-pos-closing", schemaVersion: 3, status: "closed", businessDate, sales, customers, nominations,
    transactions: [{ transactionId: `${id}_tx`, startTime: Date.parse(`${businessDate}T20:00:00+09:00`),
      items: casts.map((row) => item(`hon-${row.posCastId}`, { castId: row.posCastId,
        quantity: row.honShimeiCount, backTargetCastIds: [row.posCastId], backTargetCastNames: [row.name] })) } as PosClosingV3["transactions"][number]],
    castWork: casts.map((row) => ({ castId: row.posCastId, castName: row.name, castType: row.kind, isTrial: false,
      startTime: row.startTime, endTime: row.endTime, breakMinutes: 0, hours: row.hours })),
    castSales: casts.map((row) => ({ castId: row.posCastId, castName: row.name, honShimeiSales: row.honShimeiSales,
      jonaiExtensionSales: row.jonaiExtensionSales, drinkSales: row.drinkSales, totalAttributedSales: row.honShimeiSales + row.jonaiExtensionSales })),
    enteredCasts: [], exitedCasts: [], trialCasts: [], rosterSnapshot: { complete: true, capturedAt: generatedAt, casts: [] },
    lifecycleEvents: [], submissionId: `submission_${id}`, generatedAt, checksumAlgorithm: "sha256",
    checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
  };
  const result: DailyClosing = {
    id, businessDate, status: "approved", submissionId: posSnapshot.submissionId, checksum: posSnapshot.checksum,
    submittedAt: generatedAt, submittedAtMs: Date.parse(generatedAt), updatedAt: generatedAt,
    casts, sales, customers, nominations, posSnapshot,
    staffWork: [{ staffId: "staff", name: "従業員", kind: "regular", startTime: "20:00", endTime: "02:00",
      hours: 6, hourlyRate: 1400, dailyPayment: 2000 }],
    drivers: [{ driverId: "driver", name: "ドライバー", dailyRate: 5000, dailyPayment: 1000 }],
    staffDailyPaymentTotal: 2000, dispatchCastPayment: 0, dispatchStaffPayment: 4000, dispatchFee: 500,
    liquorDeliveryAmount: 600, expenses: [{ id: "expense", category: "supplies", payee: "商店", amount: 1200 }],
    cash: {} as DailyClosing["cash"],
  };
  return result;
}

function workspace(closings = [daily("2026-09-01"), daily("2026-09-02", []), daily("2026-10-01", [])]): WorkspaceData {
  const previous: DailyClosing[] = [];
  for (const row of [...closings].sort((a, b) => a.businessDate.localeCompare(b.businessDate))) {
    const input = { sales: row.sales, cashFloat: 200000, expenses: row.expenses.reduce((sum, expense) => sum + expense.amount, 0),
      regularDailyPayments: row.casts.filter((cast) => cast.kind === "regular").reduce((sum, cast) => sum + cast.dailyPayment, 0),
      trialDailyPayments: row.casts.filter((cast) => cast.kind === "trial").reduce((sum, cast) => sum + cast.dailyPayment, 0),
      staffDailyPayments: 2000, driverDailyPayments: 1000, dispatchCastPayment: row.dispatchCastPayment,
      dispatchStaffPayment: row.dispatchStaffPayment, dispatchFee: row.dispatchFee, actualClosingCash: 0 };
    const baseline = calculateCash(input);
    const funding = calculateCashFunding(cashFundingContext(previous, row.businessDate, 200000),
      { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, baseline.cashProfit, true);
    row.cash = calculateCash({ ...input, funding });
    previous.push(row);
  }
  return { closings, casts: ["cast-a", "cast-b", "cast-c"].map((id) => ({ id, name: id, legalName: "", status: "active",
    hiredAt: "2026-08-01", hourlyRates: { "2026-08": 3000 }, introducerId: "introducer", attendanceAdvisoryFee: 300,
    entryAdvisoryFee: 0, note: "", createdAt: "2026-08-01T01:00:00.000Z", updatedAt: "2026-08-01T01:00:00.000Z" })),
  staff: [{ id: "staff", name: "従業員", status: "active", hiredAt: "2026-08-01", hourlyRate: 1400,
    hourlyRates: { [september]: 1400 }, note: "", createdAt: "2026-08-01T01:00:00.000Z", updatedAt: "2026-08-01T01:00:00.000Z" }],
  drivers: [], introducers: [{ id: "introducer", name: "紹介者", feeType: "sales10", attendanceAdvisoryEnabled: true,
    entryAdvisoryEnabled: false, note: "", createdAt: "2026-08-01T01:00:00.000Z", updatedAt: "2026-08-01T01:00:00.000Z" }],
  liquor: [], adjustments: [settings(), settings(october)], cashFloat: 200000 };
}

function saveCorrection(data: WorkspaceData, draft: CastCorrectionDraft) {
  const sealed = sealCastCorrectionDraft(draft, data);
  validateCastCorrectionDraft(sealed, data);
  const before = data.castCorrections?.find((record) => record.sourceClosingId === draft.sourceClosingId);
  const revision = (before?.revision || 0) + 1;
  const stored = structuredClone(sealed);
  const document: CastDailyCorrectionDocument = { sourceClosingId: draft.sourceClosingId, revision, active: true, current: stored,
    history: { ...before?.history, [String(revision)]: { revision, active: true, draft: structuredClone(stored),
      reason: "月次統合テストの明示訂正", createdAt: `2026-10-02T01:00:${String(revision).padStart(2, "0")}.000Z`, createdBy: "accountant" } } };
  data.castCorrections = [...(data.castCorrections || []).filter((record) => record.sourceClosingId !== draft.sourceClosingId), document];
}

function results(data: WorkspaceData, month = september) { return calculateMonthlyAccounting(data, month, settings(month)); }
function report(data: WorkspaceData, monthly: MonthlyAccountingResults, month = september) {
  return buildBalanceExportReport({ results: monthly, month, adjustments: settings(month), closings: data.closings,
    castClosings: castAccountingClosings(monthly, data.closings, month), staff: data.staff });
}

/** Firebaseの空オブジェクト/配列削除と数値キー配列を再現する。 */
function firebaseValue(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const entries = value.map(firebaseValue).map((child, index) => [String(index), child] as const).filter(([, child]) => child !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([key, child]) => [key, firebaseValue(child)] as const).filter(([, child]) => child !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

describe("キャスト経理修正の月次計算・帳票・確定統合", () => {
  it("既払維持のまま差引支給がマイナスになったら返金と推定せず月次確定・収支帳票を停止", () => {
    const paid = cast(); paid.dailyPayment = 12000;
    const data = workspace([daily("2026-09-01", [paid])]);
    const original = structuredClone(data.closings);
    const before = results(data);
    expect(before.castRewards[0]).toMatchObject({ grossPay: 13000, dailyPayment: 12000, netPay: 1000 });
    expect(before.warnings).toEqual([]);
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].endTime = "21:00";
    saveCorrection(data, draft);
    const corrected = results(data);
    expect(corrected.castRewards[0]).toMatchObject({ grossPay: 4000, dailyPayment: 12000, netPay: -8000 });
    expect(corrected.warnings.some((warning) => warning.includes("マイナス") && warning.includes("返金済みとは扱わず"))).toBe(true);
    const finalization = canFinalizeMonthlyAccounting(data, september, settings(), true);
    expect(finalization.allowed).toBe(false);
    expect(finalization.integrityIssues.some((issue) => issue.includes("マイナス"))).toBe(true);
    expect(() => report(data, corrected)).toThrow("警告を解消");
    expect(data.closings).toEqual(original);
    expect(corrected.cashFunding).toEqual(before.cashFunding);
    expect(corrected.sales).toEqual(before.sales);
  });

  it("出勤追加は選択人物の条件を固定して報酬・紹介料・人数へ一度だけ反映し現金支払を生成しない", () => {
    const data = workspace([daily("2026-09-01")]);
    const original = structuredClone(data.closings);
    const before = results(data);
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries.push({ ...draft.entries[0], id: "additional-cast-b", originalPosCastId: undefined,
      masterId: "cast-b", name: "cast-b", endTime: "22:00", honShimeiCount: 2, honShimeiSales: 200000, beautyAllowance: 500 });
    saveCorrection(data, draft);
    expect(data.castCorrections![0].current!.entries[1].termsSnapshot).toMatchObject({ masterId: "cast-b", month: september, source: "master" });
    const corrected = results(data);
    expect(corrected.warnings).toEqual([]);
    expect(corrected.castRewards.find((row) => row.id === "cast-b")).toMatchObject({ days: 1, hours: 2, hourlyPay: 6000,
      honShimeiBack: 2000, beautyAllowance: 500, grossPay: 8500, dailyPayment: 0, advancePayment: 0, transportFee: 0, netPay: 8500 });
    expect(corrected.balance.cast).toBe(before.balance.cast + 8500);
    expect(corrected.balance.introducer).toBe(before.balance.introducer + 20300);
    expect(corrected.castSalesReports.find((row) => row.id === "cast-b")?.attendanceDays).toBe(1);
    expect(report(data, corrected).days[0]).toMatchObject({ castCount: 2, honShimeiCount: 3, castHourly: 21500 });
    expect(canFinalizeMonthlyAccounting(data, september, settings(), true).allowed).toBe(true);
    expect(data.closings).toEqual(original);
    expect(corrected.cashFunding).toEqual(before.cashFunding);
    expect(corrected.expenses).toEqual(before.expenses);
  });

  it("人物変更は旧人物を残して二重計上せず、変更先の対象月最新店舗条件を月次全体へ適用", () => {
    const first = daily("2026-09-01");
    const second = daily("2026-09-02", [cast("cast-b")]);
    second.casts[0].introducer = { ...second.casts[0].introducer!, feeType: "gross10" };
    const data = workspace([first, second]);
    const original = structuredClone(data.closings);
    const draft = createCastCorrectionDraft(first);
    Object.assign(draft.entries[0], { masterId: "cast-b", name: "cast-b" });
    saveCorrection(data, draft);
    expect(data.castCorrections![0].current!.entries[0].termsSnapshot).toMatchObject({ masterId: "cast-b", month: september,
      source: "daily", sourceClosingId: second.id, introducer: { feeType: "gross10" } });
    const corrected = results(data);
    expect(corrected.warnings).toEqual([]);
    expect(corrected.castRewards).toHaveLength(1);
    expect(corrected.castRewards[0]).toMatchObject({ id: "cast-b", days: 2, hours: 8, grossPay: 26000, dailyPayment: 0 });
    expect(corrected.castSalesReports).toHaveLength(1);
    expect(corrected.castSalesReports[0]).toMatchObject({ id: "cast-b", attendanceDays: 2 });
    expect(corrected.introducerPayments).toHaveLength(1);
    expect(corrected.introducerPayments[0]).toMatchObject({ castId: "cast-b", feeType: "gross10", grossBase: 26000, grossFee: 2600,
      attendanceAdvisory: 600, total: 3200 });
    expect(report(data, corrected).days.map((day) => ({ count: day.castCount, gross: day.castHourly })))
      .toEqual([{ count: 1, gross: 13000 }, { count: 1, gross: 13000 }]);
    expect(canFinalizeMonthlyAccounting(data, september, settings(), true).allowed).toBe(true);
    expect(data.closings).toEqual(original);
  });

  it("元出勤の削除は報酬・紹介料・収支を同期し、POS・現金・従業員給与を変えない", () => {
    const data = workspace([daily("2026-09-01"), daily("2026-09-02", [cast(), cast("cast-b")])]);
    const original = structuredClone(data.closings);
    const before = results(data);
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].deleted = true;
    saveCorrection(data, draft);
    const corrected = results(data);
    expect(corrected.warnings).toEqual([]);
    expect(corrected.castRewards.find((row) => row.id === "cast-a")).toMatchObject({ days: 1, grossPay: 13000 });
    expect(corrected.balance.cast).toBe(before.balance.cast - 13000);
    expect(corrected.balance.introducer).toBe(before.balance.introducer - 10300);
    expect(corrected.balance.profit).toBe(before.balance.profit + 23300);
    expect(corrected.sales).toEqual(before.sales);
    expect(corrected.expenses).toEqual(before.expenses);
    expect(corrected.staffPayroll).toEqual(before.staffPayroll);
    expect(corrected.driverPayroll).toEqual(before.driverPayroll);
    expect(corrected.cashFunding).toEqual(before.cashFunding);
    expect(data.closings).toEqual(original);
    const sheet = report(data, corrected);
    expect(sheet.days.map((day) => day.castCount)).toEqual([0, 2]);
    expect(sheet.days.map((day) => day.honShimeiCount)).toEqual([0, 2]);
    expect(sheet.days.map((day) => day.castHourly)).toEqual([0, 26000]);
  });

  it("他月へ移した出勤の報酬・紹介料は元月から除き移動先月へ一度だけ計上する", () => {
    const data = workspace();
    const beforeSource = results(data), beforeTarget = results(data, october);
    const original = structuredClone(data.closings);
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].targetClosingId = data.closings[2].id;
    draft.entries[0].businessDate = data.closings[2].businessDate;
    saveCorrection(data, draft);
    const source = results(data), target = results(data, october);
    expect(source.warnings).toEqual([]);
    expect(target.warnings).toEqual([]);
    expect(source.castRewards).toEqual([]);
    expect(source.introducerPayments).toEqual([]);
    expect(target.castRewards[0]).toMatchObject({ id: "cast-a", days: 1, grossPay: 13000 });
    expect(target.introducerPayments[0]).toMatchObject({ total: 10300 });
    expect(source.balance.profit - beforeSource.balance.profit).toBe(23300);
    expect(target.balance.profit - beforeTarget.balance.profit).toBe(-23300);
    expect(source.cashFunding).toEqual(beforeSource.cashFunding);
    expect(target.cashFunding).toEqual(beforeTarget.cashFunding);
    expect(report(data, source).days.map((day) => day.castCount)).toEqual([0, 0]);
    expect(report(data, target, october).days[0]).toMatchObject({ castCount: 1, honShimeiCount: 1, castHourly: 13000 });
    expect(canFinalizeMonthlyAccounting(data, september, settings(), true).allowed).toBe(true);
    expect(canFinalizeMonthlyAccounting(data, october, settings(october), true).allowed).toBe(true);
    expect(data.closings).toEqual(original);
  });

  it("修正確定snapshotをFirebase往復して空勤務・商品配列を復元し原本から帳票を出力できる", () => {
    const data = workspace();
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].targetClosingId = data.closings[1].id;
    draft.entries[0].businessDate = data.closings[1].businessDate;
    draft.entries[0].endTime = "00:15";
    draft.entries[0].beautyAllowance = 500;
    saveCorrection(data, draft);
    const calculated = results(data);
    const expected = report(data, calculated);
    const snapshot = buildMonthlySnapshot(september, 1, "b".repeat(64), settings(), calculated, data.closings, "op", "2026-10-02T01:00:00.000Z");
    const restored = normalizeMonthlyAccountingSnapshot(firebaseValue(snapshot), september, 1);
    expect(restored).toBeDefined();
    expect(restored!.castAccountingDays?.[0].casts).toEqual([]);
    expect(restored!.castAccountingDays?.[1].casts[0]).toMatchObject({ bottles: [], drinkAllocations: [], beautyAllowance: 500 });
    const output = buildBalanceExportReport({ results: restored!, snapshot: restored!, month: september, adjustments: settings(),
      closings: data.closings, castClosings: castAccountingClosings(restored!, data.closings, september), staff: data.staff });
    expect(output).toEqual(expected);
    // 後日の現在マスタ/訂正変更は確定snapshotの数値へ持ち込まない。
    data.casts[0].hourlyRates[september] = 9000;
    data.castCorrections![0].current!.entries[0].beautyAllowance = 0;
    expect(buildBalanceExportReport({ results: restored!, snapshot: restored!, month: september, adjustments: settings(),
      closings: data.closings, castClosings: castAccountingClosings(restored!, data.closings, september), staff: data.staff })).toEqual(expected);
  });

  it.each([
    ["勤務明細欠落", (days: Record<string, { businessDate: string; casts?: Record<string, DailyCast> }>) => { delete days["0"].casts; }],
    ["勤務時間改変", (days: Record<string, { businessDate: string; casts?: Record<string, DailyCast> }>) => { days["0"].casts!["0"].hours += .25; }],
    ["別月の日次", (days: Record<string, { businessDate: string; casts?: Record<string, DailyCast> }>) => { days["0"].businessDate = "2026-10-01"; }],
    ["同月の架空出勤日", (days: Record<string, { businessDate: string; casts?: Record<string, DailyCast> }>) => { days["0"].businessDate = "2026-09-03"; }],
  ] as const)("確定snapshotの%sを給与・売上明細と一致した根拠として使わない", (_label, corrupt) => {
    const data = workspace();
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].honShimeiSales += 1000;
    saveCorrection(data, draft);
    const snapshot = buildMonthlySnapshot(september, 1, "b".repeat(64), settings(), results(data), data.closings, "op", "2026-10-02T01:00:00.000Z");
    const stored = firebaseValue(snapshot) as { castAccountingDays: Record<string, { businessDate: string; casts?: Record<string, DailyCast> }> };
    corrupt(stored.castAccountingDays);
    expect(normalizeMonthlyAccountingSnapshot(stored, september, 1)).toBeUndefined();
  });

  it("出勤ゼロの確定根拠日でも原本にない営業日へ入れ替えたら帳票投影を停止する", () => {
    const data = workspace();
    saveCorrection(data, createCastCorrectionDraft(data.closings[0]));
    const calculated = results(data);
    calculated.castAccountingDays![1].businessDate = "2026-09-03";
    expect(() => castAccountingClosings(calculated, data.closings, september)).toThrow("承認済み営業日が一致しません");
  });

  it("流出元・流入先とも修正世代と元日次変更をfingerprintへ含み、無関係未来月は変更しない", async () => {
    const data = workspace();
    const before = await Promise.all([september, october, "2026-11"].map((month) => monthlySourceFingerprint(data, month, settings(month))));
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].targetClosingId = data.closings[2].id;
    draft.entries[0].businessDate = data.closings[2].businessDate;
    saveCorrection(data, draft);
    const after = await Promise.all([september, october, "2026-11"].map((month) => monthlySourceFingerprint(data, month, settings(month))));
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    draft.entries[0].honShimeiSales += 1000;
    saveCorrection(data, draft);
    expect(await monthlySourceFingerprint(data, september, settings())).not.toBe(after[0]);
    expect(await monthlySourceFingerprint(data, october, settings(october))).not.toBe(after[1]);
    const incoming = await monthlySourceFingerprint(data, october, settings(october));
    data.closings[0].casts[0].honShimeiSales += 10;
    expect(await monthlySourceFingerprint(data, october, settings(october))).not.toBe(incoming);
  });

  it("旧確定snapshotには修正を後付けせず、保存済み給与・本数・帳票を保持する", () => {
    const data = workspace();
    const oldResults = results(data);
    const old = buildMonthlySnapshot(september, 1, "c".repeat(64), settings(), oldResults, data.closings, "op", "2026-09-30T18:00:00.000Z");
    old.calculationVersion = "2.25.0";
    const restored = normalizeMonthlyAccountingSnapshot(firebaseValue(old), september, 1)!;
    expect(restored).toBeDefined();
    expect(restored.castAccountingDays).toBeUndefined();
    const expected = buildBalanceExportReport({ results: restored, snapshot: restored, month: september, adjustments: settings(), closings: data.closings, staff: data.staff });
    const draft = createCastCorrectionDraft(data.closings[0]);
    draft.entries[0].endTime = "01:00";
    saveCorrection(data, draft);
    expect(results(data).balance.cast).not.toBe(oldResults.balance.cast);
    expect(castAccountingClosings(restored, data.closings, september)).toBeUndefined();
    expect(buildBalanceExportReport({ results: restored, snapshot: restored, month: september, adjustments: settings(), closings: data.closings, staff: data.staff })).toEqual(expected);
  });

  it("同伴・共有商品訂正は報酬と帳票へ反映し、POS売上を変更しない", () => {
    const source = daily("2026-09-01", [cast(), cast("cast-b")]);
    const transaction = source.posSnapshot.transactions[0];
    transaction.items.push(item("bottle", { label: "シャンパン", category: "champagneWine", price: 35000, isHonShimei: false,
      backTargetCastIds: source.casts.map((row) => row.posCastId), backTargetCastNames: source.casts.map((row) => row.name) }));
    const sourceKey = posItemOccurrenceKey(transaction, transaction.items.length - 1);
    source.casts.forEach((row) => { row.bottles = [{ itemId: "bottle", sourceKey, name: "シャンパン", kind: "champagneWine",
      quantity: 1, salesAmount: 17500, costAmount: 6250, backAmount: 2810, specialCost: false }]; row.liquorCost = 6250; });
    const data = workspace([source]);
    const original = structuredClone(data.closings);
    const draft = createCastCorrectionDraft(source);
    draft.products[0].unitPrice = 4000;
    draft.products[0].unitCost = 0;
    draft.products[0].externalTargetCount = 1;
    draft.entries[0].dohan = [{ arrivalTime: "20:30", extended: true, quantity: 1 }];
    draft.entries[1].dohan = [{ arrivalTime: "20:31", extended: true, quantity: 1 }];
    saveCorrection(data, draft);
    const corrected = results(data);
    expect(corrected.warnings).toEqual([]);
    expect(corrected.castRewards.map((row) => row.bottleBack)).toEqual([330, 330]);
    expect(corrected.castRewards.map((row) => row.dohanBack)).toEqual([5000, 2000]);
    expect(corrected.balance.cast).toBe(33660);
    expect(report(data, corrected).days[0]).toMatchObject({ dohanCount: 2, castHourly: 33660, totalSales: 750000 });
    expect(data.closings).toEqual(original);
  });
});
