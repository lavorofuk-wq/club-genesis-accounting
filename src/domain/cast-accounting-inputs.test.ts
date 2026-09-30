import { removeNewExpensesForLegacy } from "./legacy-expense-fixture.test-helper";
import { describe, expect, it } from "vitest";
import { castAccountingAttendanceDays, castAccountingAttendanceSources, castAccountingInputAmount,
  normalizeCastAccountingInputs, resolveCastAccountingInputs } from "./cast-accounting-inputs";
import { calculateCastRewards, calculateCastSalesReports, normalizeMonthlyAdjustments,
  type CastAccountingInput, type CastRecord, type DailyCast, type DailyClosing, type IntroducerFeeType,
  type MonthlyAdjustments, type WorkspaceData } from "./gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting, canFinalizeMonthlyAccounting,
  monthlySourceFingerprint, normalizeMonthlyAccountingSnapshot, MONTHLY_CALCULATION_VERSION } from "./month-accounting";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";

const month = "2026-09";
const member: CastRecord = { id: "cast-1", name: "花子", legalName: "", status: "active", hiredAt: "2026-09-01",
  hourlyRates: { [month]: 3500 }, note: "", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
function input(overrides: Partial<CastAccountingInput> = {}): CastAccountingInput {
  return { id: "input-1", castId: member.id, castName: member.name, kind: "sales", label: "追加売上", amount: 10000,
    businessDate: "2026-09-02", ...overrides };
}
function adjustments(castInputs?: CastAccountingInput[]): MonthlyAdjustments {
  return { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
    fixedExpenses: [], cardFee: 0, revision: 1, ...(castInputs === undefined ? {} : { castInputs }) };
}
function dailyCast(overrides: Partial<DailyCast> = {}): DailyCast {
  return { masterId: member.id, posCastId: "pos-1", name: member.name, kind: "regular", startTime: "20:00", endTime: "00:15",
    hours: 4.25, hourlyRate: 3500, honShimeiCount: 1, banaiShimeiCount: 2, dohanCount: 1, dohanBack: 3000,
    honShimeiSales: 1200000, jonaiExtensionSales: 0, drinkSales: 0, bottles: [], liquorCost: 0, beautyAllowance: 500,
    dailyPayment: 0, advancePayment: 0, transportFee: 500,
    introducer: { id: "intro-1", name: "紹介者", feeType: "sales10", attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 }, ...overrides };
}
function closing(date: string, casts: DailyCast[] = [dailyCast()]): DailyClosing {
  return { id: `day_${date.replaceAll("-", "")}`, businessDate: date, status: "approved", submissionId: `submission_${date}`,
    checksum: "a".repeat(64), updatedAt: `${date}T20:00:00Z`, submittedAt: `${date}T19:00:00Z`,
    sales: { cashSales: 0, cardSales: 0, totalSales: 0 }, customers: { groupCount: 0, totalCustomers: 0 },
    nominations: { honShimeiCount: 1, jonaiCount: 2 }, casts, staffWork: [], drivers: [], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0,
      expectedClosingCash: 200000, cashProfit: 0, actualClosingCash: 200000, difference: 0 },
    posSnapshot: { businessDate: date, transactions: [] } as unknown as DailyClosing["posSnapshot"] };
}
function workspace(closings = [closing("2026-09-02"), closing("2026-09-04", [dailyCast({ hours: 2.25, endTime: "22:15",
  honShimeiSales: 0, honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, beautyAllowance: 0, transportFee: 0 })])]): WorkspaceData {
  const previous: DailyClosing[] = [];
  for (const row of [...closings].sort((a, b) => a.businessDate.localeCompare(b.businessDate))) {
    row.cash.funding = calculateCashFunding(cashFundingContext(previous, row.businessDate, 200000),
      { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, 0, true);
    previous.push(row);
  }
  return { casts: [structuredClone(member)], staff: [], drivers: [], introducers: [], liquor: [], closings, adjustments: [], cashFloat: 200000 };
}
const allInputs = () => [input(), input({ id: "allowance", kind: "allowance", label: "特別手当", amount: 1001, businessDate: undefined }),
  input({ id: "transport", kind: "transport", label: "追加送迎", amount: 1000, businessDate: undefined })];

describe("キャスト経理入力の保存検証", () => {
  it("売上だけ入力時に10円未満を切捨て、0円を許容する", () => {
    expect(castAccountingInputAmount("sales", 12349.9)).toBe(12340);
    expect(castAccountingInputAmount("allowance", 1001)).toBe(1001);
    expect(castAccountingInputAmount("transport", 1500)).toBe(1500);
    for (const kind of ["sales", "allowance", "transport"] as const) expect(castAccountingInputAmount(kind, 0)).toBe(0);
  });
  it.each([["allowance", 1.5], ["transport", 499], ["transport", 500.5], ["sales", -1], ["sales", Infinity]] as const)
    ("%s の不正金額 %s を丸めず拒否する", (kind, amount) => expect(() => castAccountingInputAmount(kind, amount)).toThrow());
  it("Firebaseの入力IDマップを復元し保存済額を再丸めしない", () => {
    const row = input();
    expect(normalizeCastAccountingInputs({ [row.id]: row })).toEqual([row]);
    expect(normalizeMonthlyAdjustments({ ...adjustments(), castInputs: { [row.id]: row } as unknown as CastAccountingInput[] }).castInputs).toEqual([row]);
    expect(() => normalizeCastAccountingInputs({ wrong: row })).toThrow("保存キー");
    expect(() => normalizeCastAccountingInputs([input({ amount: 10009 })])).toThrow("保存金額");
  });
  it.each([
    ["重複ID", [input(), input()]], ["売上日なし", [input({ businessDate: undefined })]],
    ["架空日", [input({ businessDate: "2026-09-31" })]], ["負数", [input({ amount: -10 })]],
    ["手当小数", [input({ kind: "allowance", amount: .1 })]], ["送迎単位", [input({ kind: "transport", amount: 510 })]],
    ["空名目", [input({ label: " " })]], ["長い名目", [input({ label: "あ".repeat(101) })]],
    ["壊れた行", [null, { broken: true }]], ["不正一覧", "bad"],
  ])("保存済み%sを黙って修正しない", (_label, value) => expect(() => normalizeCastAccountingInputs(value)).toThrow());
});

describe("本人出勤日への解決", () => {
  it("承認済み本人出勤だけを対象にし、0時間勤務行も既存基準で認める", () => {
    const zero = closing("2026-09-06", [dailyCast({ hours: 0 })]);
    const data = workspace([...workspace().closings, zero, { ...closing("2026-09-07"), status: "returned" },
      closing("2026-09-08", [dailyCast({ masterId: "other" })]), closing("2026-10-01")]);
    expect(castAccountingAttendanceDays(data.closings, data.casts, month, member.id)).toEqual(["2026-09-02", "2026-09-04", "2026-09-06"]);
    expect(castAccountingAttendanceSources(data.closings, data.casts, month, member.id).at(-1))
      .toMatchObject({ closingId: zero.id, castIndex: 0, businessDate: zero.businessDate, masterId: member.id });
  });
  it("日付未指定は承認済み最終出勤に追従し、入力そのものに日付を書かない", () => {
    const data = workspace(); const settings = adjustments(allInputs()); const before = structuredClone(settings);
    expect(resolveCastAccountingInputs(settings, data.closings, data.casts, month).inputs.map((row) => row.businessDate))
      .toEqual(["2026-09-02", "2026-09-04", "2026-09-04"]);
    data.closings.push(closing("2026-09-09"));
    expect(resolveCastAccountingInputs(settings, data.closings, data.casts, month).inputs.map((row) => row.businessDate))
      .toEqual(["2026-09-02", "2026-09-09", "2026-09-09"]);
    expect(settings).toEqual(before);
  });
  it("指定日の差戻し・別月・本人出勤なしは入力を保持して警告と確定禁止にする", () => {
    for (const mutation of ["returned", "other-month", "no-attendance"] as const) {
      const data = workspace(); const settings = adjustments([input()]);
      if (mutation === "returned") data.closings[0].status = "returned";
      if (mutation === "other-month") settings.castInputs![0].businessDate = "2026-10-01";
      if (mutation === "no-attendance") data.closings.forEach((day) => { day.casts = []; });
      const before = structuredClone(settings);
      expect(resolveCastAccountingInputs(settings, data.closings, data.casts, month).issues.length).toBeGreaterThan(0);
      expect(calculateMonthlyAccounting(data, month, settings).warnings.length).toBeGreaterThan(0);
      expect(canFinalizeMonthlyAccounting(data, month, settings, false).allowed).toBe(false);
      expect(settings).toEqual(before);
    }
  });
  it("保存後に退店しても金額を消さず、同月在籍化した体入勤務のIDも解決する", () => {
    const data = workspace([closing("2026-09-02", [dailyCast({ masterId: "trial-1", kind: "trial" })])]);
    data.casts[0].status = "departed"; data.casts[0].convertedFromTrialId = "trial-1";
    data.casts[0].hiredAt = "2026-09-04";
    const result = resolveCastAccountingInputs(adjustments([input()]), data.closings, data.casts, month);
    expect(result.issues).toEqual([]); expect(result.inputs[0].castId).toBe(member.id);
  });
});

describe("追加売上・手当・送迎の月次反映", () => {
  it("追加金額単体が整数範囲内でも合算後の範囲超過は警告・確定禁止にする", () => {
    const data = workspace(); const settings = adjustments([input({ amount: Math.floor(Number.MAX_SAFE_INTEGER / 10) * 10 })]);
    expect(calculateMonthlyAccounting(data, month, settings).warnings.some((warning) => warning.includes("範囲を超え"))).toBe(true);
    expect(canFinalizeMonthlyAccounting(data, month, settings, true).allowed).toBe(false);
  });
  it("追加手当をA-B比較へ混ぜず、採用方式決定後だけに加える", () => {
    const data = workspace(); const base = calculateCastRewards(data.closings, data.casts, month, adjustments())[0];
    const settings = adjustments([input({ kind: "allowance", label: "特別手当", amount: 50001, businessDate: undefined })]);
    const reward = calculateCastRewards(data.closings, data.casts, month, settings)[0];
    expect(reward.hourlyAndBack).toBe(base.hourlyAndBack); expect(reward.salesRewardBase).toBe(base.salesRewardBase);
    expect(reward.adoptedSystem).toBe(base.adoptedSystem); expect(reward.grossPay).toBe(base.grossPay + 50001);
  });
  it("売上報酬の基準・率だけへ追加売上を加え、手当は比較後・送迎は追加控除する", () => {
    const data = workspace(); const before = structuredClone(data); const settings = adjustments(allInputs());
    const reward = calculateCastRewards(data.closings, data.casts, month, settings)[0];
    expect(reward).toMatchObject({ honShimeiSales: 1200000, jonaiExtensionSales: 0, additionalSales: 10000,
      additionalAllowance: 1001, additionalTransportFee: 1000, honShimeiBack: 1000, banaiShimeiBack: 1000,
      dohanBack: 3000, hourlyPay: 22750, hourlyAndBack: 27750, salesRewardBase: 1210000,
      rewardRate: .6, salesReward: 726000, adoptedSystem: "salesReward", grossPay: 727501, transportFee: 1500, netPay: 726001 });
    const results = calculateMonthlyAccounting(data, month, settings);
    expect(results.sales).toEqual({ cash: 0, card: 0, total: 0 });
    expect(results.introducerPayments[0]).toMatchObject({ salesBase: 1200000, salesFee: 120000, total: 120000 });
    expect(results.warnings).toEqual([]); expect(data).toEqual(before);
  });
  it.each(["gross10", "higherSalesGross10", "higherNetSalesGross10", "netSales10"] as IntroducerFeeType[])
    ("%s の総支給基準に追加手当を含め、売上基準に追加売上を混ぜない", (feeType) => {
      const data = workspace(); data.closings.forEach((row) => { row.casts[0].introducer!.feeType = feeType; });
      const payment = calculateMonthlyAccounting(data, month, adjustments(allInputs())).introducerPayments[0];
      expect(payment.grossBase).toBe(727501); expect(payment.grossFee).toBe(72750);
      expect(payment.salesBase).toBe(1200000); expect(payment.salesFee).toBe(120000);
    });
  it("日次明細と月合計を分離表示できるよう保持し、同日複数行でも一度だけ加算する", () => {
    const data = workspace(); data.closings[0].casts.push(dailyCast({ honShimeiSales: 0, beautyAllowance: 0 }));
    const report = calculateCastSalesReports(data.closings, data.casts, month, adjustments(allInputs()))[0];
    expect(report.totals).toMatchObject({ honShimeiSales: 1200000, additionalSales: 10000, totalSales: 1210000,
      additionalAllowance: 1001, additionalTransportFee: 1000 });
    expect(report.days.flatMap((day) => day.accountingInputs || [])).toHaveLength(3);
    expect(report.days.filter((day) => day.businessDate === "2026-09-02").reduce((sum, day) => sum + (day.additionalSales || 0), 0)).toBe(10000);
  });
  it("確定snapshotは解決済み日付・名目・金額を保存し、その後のマスタや出勤変更から独立する", () => {
    const data = workspace(); const settings = adjustments(allInputs());
    const results = calculateMonthlyAccounting(data, month, settings);
    const snapshot = buildMonthlySnapshot(month, 1, "a".repeat(64), settings, results, data.closings, "op", "2026-10-01T00:00:00Z");
    const before = structuredClone(snapshot);
    expect(snapshot.schemaVersion).toBe(3); expect(snapshot.calculationVersion).toBe(MONTHLY_CALCULATION_VERSION);
    data.casts[0].hourlyRates[month] = 9999; data.closings[1].status = "returned";
    const restored = normalizeMonthlyAccountingSnapshot(snapshot, month, 1)!;
    expect(restored).toBeDefined(); expect(restored.castRewards).toEqual(before.castRewards);
    expect(restored.castSalesReports).toEqual(before.castSalesReports);
    expect(restored.castSalesReports[0].totals.accountingInputs![1].businessDate).toBe("2026-09-04");
    expect(snapshot).toEqual(before);
  });
  it.each(["allowance", "transport", "sales", "day", "cast", "missing-detail"] as const)
    ("確定保存の%sの破損を推測補正せず拒否する", (target) => {
      const data = workspace(); const settings = adjustments(allInputs());
      const snapshot = buildMonthlySnapshot(month, 1, "a".repeat(64), settings, calculateMonthlyAccounting(data, month, settings), data.closings, "op", "2026-10-01T00:00:00Z");
      if (target === "allowance") snapshot.castRewards[0].additionalAllowance! += 1;
      if (target === "transport") snapshot.castRewards[0].additionalTransportFee = 999;
      if (target === "sales") snapshot.castSalesReports[0].totals.additionalSales! += 10;
      if (target === "day") snapshot.castSalesReports[0].days[0].accountingInputs![0].businessDate = "2026-09-04";
      if (target === "cast") snapshot.castSalesReports[0].days[0].accountingInputs![0].castId = "other";
      if (target === "missing-detail") delete snapshot.castSalesReports[0].days[0].accountingInputs;
      expect(normalizeMonthlyAccountingSnapshot(snapshot, month, 1)).toBeUndefined();
    });
  it("追加項目のない旧確定月は金額も保存形式も変更しない", () => {
    const data = workspace(); const settings = adjustments();
    const snapshot = buildMonthlySnapshot(month, 1, "a".repeat(64), settings, calculateMonthlyAccounting(data, month, settings), data.closings, "op", "2026-10-01T00:00:00Z");
    snapshot.calculationVersion = "2.36.0"; removeNewExpensesForLegacy(snapshot); const before = structuredClone(snapshot);
    const restored = normalizeMonthlyAccountingSnapshot(snapshot, month, 1)!;
    expect(restored.castRewards).toEqual(before.castRewards); expect(restored.castSalesReports).toEqual(before.castSalesReports);
    expect(restored.castRewards[0]).not.toHaveProperty("additionalSales");
  });
  it("旧計算版へ追加入力を後付けした不整合snapshotを拒否する", () => {
    const data = workspace(); const settings = adjustments(allInputs());
    const snapshot = buildMonthlySnapshot(month, 1, "a".repeat(64), settings, calculateMonthlyAccounting(data, month, settings), data.closings, "op", "2026-10-01T00:00:00Z");
    snapshot.calculationVersion = "2.36.0"; removeNewExpensesForLegacy(snapshot);
    expect(normalizeMonthlyAccountingSnapshot(snapshot, month, 1)).toBeUndefined();
  });
  it("追加金額・指定日・最終出勤の変更を月次確定の競合ハッシュで検知する", async () => {
    const data = workspace(); const settings = adjustments(allInputs());
    const original = await monthlySourceFingerprint(data, month, settings);
    settings.castInputs![0].amount += 10;
    expect(await monthlySourceFingerprint(data, month, settings)).not.toBe(original);
    settings.castInputs![0].amount -= 10; settings.castInputs![0].businessDate = "2026-09-04";
    expect(await monthlySourceFingerprint(data, month, settings)).not.toBe(original);
    settings.castInputs![0].businessDate = "2026-09-02"; data.closings.push(closing("2026-09-06"));
    expect(await monthlySourceFingerprint(data, month, settings)).not.toBe(original);
  });
});
