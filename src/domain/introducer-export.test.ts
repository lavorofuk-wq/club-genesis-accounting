import { removeNewExpensesForLegacy } from "./legacy-expense-fixture.test-helper";
import { describe, expect, it } from "vitest";
import { legacyBottleSourceKey, type CastReward, type CastSalesDay, type CastSalesReport, type DailyCast,
  type DailyClosing, type IntroducerFeeType, type MonthlyAdjustments, type WorkspaceData } from "./gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting, normalizeMonthlyAccountingSnapshot,
  type IntroducerPaymentRow } from "./month-accounting";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
import { buildIntroducerExport, type IntroducerExportResults } from "./introducer-export";

const month = "2026-09";

function day(date: string, sales: number, cost: number, count = 1): CastSalesDay {
  return { businessDate: date, startTime: "20:00", endTime: "21:00", hours: 1,
    honShimeiSales: sales, honShimeiLiquorCost: cost, honShimeiCount: count,
    jonaiExtensionSales: 5000, totalSales: sales + 5000, jonaiExtensionLiquorCost: 500,
    totalLiquorCost: cost + 500, banaiShimeiCount: 1, nominationCount: count + 1,
    dohanCount: 0, backs: [], backTotal: 0, bottles: [], beautyAllowance: 0 };
}

function fixture(feeType: IntroducerFeeType = "gross10", dates = [day(`${month}-01`, 20000, 5000), day(`${month}-02`, 10000, 2000)]): IntroducerExportResults {
  const total = (key: "honShimeiSales" | "honShimeiLiquorCost" | "honShimeiCount") => dates.reduce((sum, row) => sum + row[key], 0);
  const attendanceDays = new Set(dates.map((row) => row.businessDate)).size;
  const reward: CastReward = {
    id: "cast_1", name: "保存された花子", days: attendanceDays, advisoryDays: attendanceDays, hours: 2, trialOnly: false,
    hourlyPay: 1200, honShimeiSales: total("honShimeiSales"), jonaiExtensionSales: 10000,
    liquorCost: total("honShimeiLiquorCost") + 1000, honShimeiLiquorCost: total("honShimeiLiquorCost"),
    honShimeiBack: 100, banaiShimeiBack: 50, dohanBack: 50, bottleBack: 50, drinkBack: 50,
    hourlyAndBack: 1500, rewardRate: 0, salesRewardBase: 35000, salesReward: 0,
    adoptedSystem: "hourlyAndBack", adoptedReward: 1500, beautyAllowance: 500, grossPay: 2000,
    dailyPayment: 100, advancePayment: 200, transportFee: 500, withholding: 10, netPay: 1190,
    introducer: { id: "intro_1", name: "保存された紹介者", feeType, attendanceAdvisoryFee: 50, entryAdvisoryFee: 500 },
  };
  const report: CastSalesReport = { id: reward.id, name: reward.name, attendanceDays, days: dates,
    totals: { ...day("", total("honShimeiSales"), total("honShimeiLiquorCost"), total("honShimeiCount")), attendanceDays } };
  const net = feeType === "netSales10" || feeType === "higherNetSalesGross10";
  const salesBase = Math.max(0, reward.honShimeiSales - (net ? reward.honShimeiLiquorCost : 0));
  const salesFee = Math.floor(salesBase / 10);
  const grossFee = 200;
  const grossWins = feeType === "gross10" || (feeType.startsWith("higher") && grossFee > salesFee);
  const payment: IntroducerPaymentRow = {
    id: "intro_1_cast_1", introducerId: "intro_1", castId: "cast_1", introducer: "保存された紹介者", cast: "保存された花子", feeType,
    honShimeiLiquorCost: reward.honShimeiLiquorCost, salesBase, salesFee, grossBase: 2000, grossFee,
    adopted: grossWins ? "総支給額10%" : net ? "酒代原価引き売上10%" : "売上10%",
    attendanceAdvisory: 100, entryAdvisory: 500, advisory: 600, total: (grossWins ? grossFee : salesFee) + 600,
  };
  return { castRewards: [reward], castSalesReports: [report], introducerPayments: [payment], warnings: [],
    balance: { cast: 2000, introducer: payment.total, staff: 0, driver: 0, expenses: 0, totalCosts: 2000 + payment.total, profit: 0 } };
}

const first = (input: IntroducerExportResults) => buildIntroducerExport(input, month).sheets[0].casts[0];
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

describe("紹介者支払明細の月次結果転記", () => {
  it.each([
    ["gross10", "gross"], ["sales10", "sales"], ["netSales10", "sales"],
    ["higherSalesGross10", "comparison"], ["higherNetSalesGross10", "comparison"],
  ] as const)("%sを%s様式へ分け、契約名や原価を出力用データに残さない", (feeType, layout) => {
    const exported = first(fixture(feeType));
    expect(exported.layout).toBe(layout);
    expect(exported).toMatchObject({ name: "保存された花子", attendanceDays: 2, advisory: 600 });
    expect(JSON.stringify(exported)).not.toMatch(/feeType|LiquorCost|原価|netSales|intro_1|cast_1/);
    if (layout === "gross") expect(exported).not.toHaveProperty("days");
    if (layout === "sales") expect(exported).not.toHaveProperty("remuneration");
  });

  it("総支給額型は全バック、美容室、日払い・立替・送迎、源泉、差引を保存額で出す", () => {
    expect(first(fixture())).toEqual({ name: "保存された花子", attendanceDays: 2, adopted: "総支給額10%", advisory: 600, total: 800,
      layout: "gross", grossFee: 200, remuneration: { baseLabel: "基本給 計", basePay: 1200, backs: 300,
        allowance: 500, grossPay: 2000, deductions: 800, withholding: 10, netPay: 1190 } });
  });

  it("売上型は本指名売上だけを出し、場内延長売上・場内延長原価を含めない", () => {
    const input = fixture("sales10");
    input.castSalesReports[0].days[0].jonaiExtensionSales = 987654;
    input.castSalesReports[0].days[0].jonaiExtensionLiquorCost = 876543;
    const result = first(input);
    expect(result).toMatchObject({ salesTotal: 30000, honShimeiCount: 2, salesFee: 3000,
      days: [{ businessDate: `${month}-01`, honShimeiCount: 1, sales: 20000 }, { businessDate: `${month}-02`, honShimeiCount: 1, sales: 10000 }] });
    expect(JSON.stringify(result)).not.toMatch(/987654|876543/);
  });

  it("本指名売上から本指名原価だけを引いた日別額を、本指名売上と同じ項目で出す", () => {
    expect(first(fixture("higherNetSalesGross10"))).toMatchObject({ adopted: "売上10%", salesTotal: 23000, salesFee: 2300,
      grossFee: 200, total: 2900, days: [{ sales: 15000 }, { sales: 8000 }] });
  });

  it("日別の負値を0に置換せず、月合計と保存済み紹介料に整合する", () => {
    const input = fixture("netSales10", [day(`${month}-01`, 10000, 15000), day(`${month}-02`, 20000, 5000)]);
    expect(first(input)).toMatchObject({ days: [{ sales: -5000 }, { sales: 15000 }], salesTotal: 10000, salesFee: 1000, total: 1600 });
  });

  it("月全体が負の場合も日別合計は負のまま、保存済み紹介料0円を維持する", () => {
    const input = fixture("netSales10", [day(`${month}-01`, 10000, 15000), day(`${month}-02`, 1000, 3000)]);
    expect(first(input)).toMatchObject({ days: [{ sales: -5000 }, { sales: -2000 }], salesTotal: -7000, salesFee: 0, total: 600 });
  });

  it("同一営業日の体入・在籍等の複数行は合計し、営業日は並べ替え出勤日数は重複しない", () => {
    const input = fixture("sales10", [day(`${month}-02`, 1000, 100, 2), day(`${month}-01`, 2000, 200, 1), day(`${month}-02`, 3000, 300, 3)]);
    expect(first(input)).toMatchObject({ attendanceDays: 2, honShimeiCount: 6, salesTotal: 6000,
      days: [{ businessDate: `${month}-01`, honShimeiCount: 1, sales: 2000 }, { businessDate: `${month}-02`, honShimeiCount: 5, sales: 4000 }] });
  });

  it("売上報酬採用者は基本給欄を売上報酬に替え、バック欄を空欄用nullとする", () => {
    const input = fixture("higherSalesGross10");
    Object.assign(input.castRewards[0], { adoptedSystem: "salesReward", salesReward: 50000, adoptedReward: 50000, grossPay: 50500, netPay: 49690 });
    Object.assign(input.introducerPayments[0], { grossBase: 50500, grossFee: 5050, adopted: "総支給額10%", total: 5650 });
    input.balance.introducer = 5650;
    expect(first(input)).toMatchObject({ adopted: "総支給額10%", grossFee: 5050, total: 5650,
      remuneration: { baseLabel: "売上報酬", basePay: 50000, backs: null, allowance: 500, grossPay: 50500, netPay: 49690 } });
  });

  it("全紹介者をID別sheetデータに分け、同名紹介者や同名キャストを勝手に統合しない", () => {
    const input = fixture();
    const reward = input.castRewards[0];
    const payment = input.introducerPayments[0];
    input.castRewards.push({ ...reward, id: "cast_2" }, { ...reward, id: "cast_3" });
    input.introducerPayments.push({ ...payment, id: "intro_1_cast_2", castId: "cast_2" },
      { ...payment, id: "intro_2_cast_3", introducerId: "intro_2", castId: "cast_3" });
    input.balance.introducer = 2400;
    const output = buildIntroducerExport(input, month);
    expect(output.sheets).toHaveLength(2);
    expect(output.sheets.map((sheet) => [sheet.name, sheet.total, sheet.casts.length])).toEqual([
      ["保存された紹介者", 1600, 2], ["保存された紹介者", 800, 1],
    ]);
  });

  it("旧確定の人物IDは保存済み報酬だけと照合し、当時の名前・1円小数額を再計算しない", () => {
    const input = fixture("gross10");
    input.month = month;
    Object.assign(input.castRewards[0], { hourlyPay: 1200.5, hourlyAndBack: 1500.5, adoptedReward: 1500.5, grossPay: 2000.5, netPay: 1190.5 });
    Object.assign(input.introducerPayments[0], { grossBase: 2000.5, grossFee: 201, total: 801 });
    delete input.introducerPayments[0].introducerId;
    delete input.introducerPayments[0].castId;
    input.balance.introducer = 801;
    const before = structuredClone(input);
    const output = first(freeze(input));
    expect(output).toMatchObject({ grossFee: 201, total: 801, remuneration: { basePay: 1200.5, grossPay: 2000.5, netPay: 1190.5 } });
    expect(input).toEqual(before);
  });

  it.each(["gross10", "sales10", "netSales10", "higherSalesGross10", "higherNetSalesGross10"] as const)("%sの出勤なし入店顧問料も保存契約の様式で掲載する", (feeType) => {
    const input = fixture(feeType);
    input.castRewards = [];
    input.castSalesReports = [];
    Object.assign(input.introducerPayments[0], { honShimeiLiquorCost: 0, salesBase: 0, salesFee: 0, grossBase: 0, grossFee: 0,
      attendanceAdvisory: 0, entryAdvisory: 500, advisory: 500, total: 500, adopted: "入店顧問料のみ" });
    input.balance.introducer = 500;
    expect(first(input)).toMatchObject({ attendanceDays: 0, adopted: "入店顧問料のみ", advisory: 500, total: 500 });
  });

  it("人物ID未保存の旧入店顧問料はGMSの厳密なID形式のみを復元する", () => {
    const input = fixture("gross10");
    input.castRewards = [];
    input.castSalesReports = [];
    Object.assign(input.introducerPayments[0], { id: `introducer_${"a".repeat(32)}_cast_${"b".repeat(32)}`,
      honShimeiLiquorCost: 0, salesBase: 0, salesFee: 0, grossBase: 0, grossFee: 0, attendanceAdvisory: 0,
      entryAdvisory: 500, advisory: 500, total: 500, adopted: "入店顧問料のみ" });
    delete input.introducerPayments[0].introducerId;
    delete input.introducerPayments[0].castId;
    input.balance.introducer = 500;
    expect(first(input)).toMatchObject({ adopted: "入店顧問料のみ", total: 500 });
  });

  it("総支給額型に不要な日別内訳が未保存でも、月次報酬の確かな内訳は出力できる", () => {
    const input = fixture();
    input.castSalesReports = [];
    expect(first(input)).toMatchObject({ layout: "gross", total: 800 });
  });

  it("報酬方式に関係なく体入者を任意に除外せず、保存された紹介者支払対象を出す", () => {
    const input = fixture();
    input.castRewards[0].trialOnly = true;
    expect(first(input)).toMatchObject({ name: "保存された花子", total: 800 });
  });
});

describe("紹介者支払明細の欠損・不整合検査", () => {
  const cases: Array<[string, (input: IntroducerExportResults) => void, string]> = [
    ["未保存契約", (input) => { input.introducerPayments[0].feeType = ""; }, "報酬形態"],
    ["日次明細欠損", (input) => { input.castSalesReports = []; }, "日別売上明細が保存"],
    ["報酬欠損", (input) => { input.castRewards = []; }, "キャスト報酬が保存"],
    ["原価内訳欠損", (input) => { input.castSalesReports[0].days[0].honShimeiLiquorCost = undefined as never; }, "計算内訳"],
    ["月合計欠損", (input) => { input.castSalesReports[0].totals = undefined as never; }, "月合計が保存"],
    ["売上不一致", (input) => { input.castSalesReports[0].days[0].honShimeiSales += 10; }, "本指名売上合計"],
    ["原価不一致", (input) => { input.castSalesReports[0].days[0].honShimeiLiquorCost += 10; }, "計算内訳"],
    ["本数不一致", (input) => { input.castSalesReports[0].days[0].honShimeiCount += 1; }, "本指名本数合計"],
    ["小数本数", (input) => { input.castSalesReports[0].days[0].honShimeiCount = .5; }, "本指名本数"],
    ["別月日次", (input) => { input.castSalesReports[0].days[0].businessDate = "2026-08-01"; }, "営業日"],
    ["存在しない日付", (input) => { input.castSalesReports[0].days[0].businessDate = "2026-09-31"; }, "営業日"],
    ["出勤日数不一致", (input) => { input.castRewards[0].days = 5; }, "出勤日数"],
    ["未保存採用方式", (input) => { input.introducerPayments[0].adopted = "総支給額10%"; }, "採用方式"],
    ["支払額不一致", (input) => { input.introducerPayments[0].total++; }, "支払合計"],
    ["顧問料不一致", (input) => { input.introducerPayments[0].entryAdvisory++; }, "顧問料合計"],
    ["月次総額不一致", (input) => { input.balance.introducer++; }, "月次の紹介者支払総額"],
    ["報酬重複", (input) => { input.castRewards.push(input.castRewards[0]); }, "IDが重複"],
    ["明細重複", (input) => { input.castSalesReports.push(input.castSalesReports[0]); }, "IDが重複"],
    ["異常値", (input) => { input.introducerPayments[0].salesFee = NaN; }, "金額"],
    ["警告あり", (input) => { input.warnings.push("計算不可"); }, "警告を解消"],
    ["確定月違い", (input) => { input.month = "2026-08"; }, "対象月が一致"],
  ];
  it.each(cases)("%sを推測補完せず出力を止める", (_name, mutate, error) => {
    const input = fixture("netSales10");
    mutate(input);
    expect(() => buildIntroducerExport(input, month)).toThrow(error);
  });

  it.each(["grossPay", "netPay", "hourlyAndBack", "adoptedReward"] as const)("月次報酬の%s不整合は出力を止める", (key) => {
    const input = fixture();
    input.castRewards[0][key] += 1;
    expect(() => first(input)).toThrow("一致しません");
  });

  it("高い方の保存採用方式が比較額と矛盾する時は勝手に選び直さない", () => {
    const input = fixture("higherSalesGross10");
    input.introducerPayments[0].adopted = "総支給額10%";
    expect(() => first(input)).toThrow("採用額");
  });

  it("空月・不正月は出力しない", () => {
    expect(() => buildIntroducerExport(fixture(), "2026-13")).toThrow("対象月");
    const input = fixture();
    input.introducerPayments = [];
    expect(() => first(input)).toThrow("支払データがありません");
  });
});

describe("実際の月次計算・確定snapshotから紹介者明細への結合", () => {
  function source() {
    const intro = { id: "introducer-generated", name: "紹介者A", feeType: "higherNetSalesGross10" as const,
      attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: true, note: "", createdAt: `${month}-01T00:00:00Z`, updatedAt: `${month}-01T00:00:00Z` };
    const base = { name: "同月入店花子", legalName: "保存本名", note: "", introducerId: intro.id,
      createdAt: `${month}-01T00:00:00Z`, updatedAt: `${month}-02T00:00:00Z` };
    const data: WorkspaceData = { casts: [
      { ...base, id: "trial-generated", status: "trial", trialDate: `${month}-01`, hourlyRates: {}, trialHourlyRate: 1500, convertedToCastId: "active-generated" },
      { ...base, id: "active-generated", status: "active", hiredAt: `${month}-02`, hourlyRates: { [month]: 3000 },
        convertedFromTrialId: "trial-generated", attendanceAdvisoryFee: 500, entryAdvisoryFee: 3000 },
    ], introducers: [intro], staff: [], drivers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200000 };
    const adjustment: MonthlyAdjustments = { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {},
      driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0, legacyBottleClassifications: {}, revision: 1,
      updatedAt: `${month}-30T12:00:00Z`, updatedBy: "test-accounting" };
    function addClosing(date: string, kind: "trial" | "regular", savedAt: number, feeType: IntroducerFeeType) {
      const row: DailyCast = { masterId: kind === "trial" ? "trial-generated" : "active-generated", posCastId: `pos-${kind}`,
        name: base.name, kind, startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: kind === "trial" ? 1500 : 3000,
        honShimeiCount: 1, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
        honShimeiSales: kind === "trial" ? 10000 : 20000, jonaiExtensionSales: 5000, drinkSales: 0,
        bottles: [{ itemId: `bottle-${kind}`, name: "テスト銘柄", kind: "champagneWine", quantity: 1,
          salesAmount: kind === "trial" ? 5000 : 15000, costAmount: kind === "trial" ? 2000 : 5000, specialCost: false }],
        liquorCost: kind === "trial" ? 2000 : 5000, beautyAllowance: kind === "trial" ? 0 : 500,
        dailyPayment: 0, advancePayment: 0, transportFee: 0,
        introducer: { id: intro.id, name: intro.name, feeType, attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: true,
          attendanceAdvisoryFee: 500, entryAdvisoryFee: kind === "trial" && savedAt === 100 ? 0 : 3000 } };
      const closing: DailyClosing = { id: `closing-${kind}`, businessDate: date, status: "approved", submittedAtMs: savedAt,
        submissionId: `submission-${kind}`, checksum: "a".repeat(64), sales: { cashSales: 0, cardSales: 0, totalSales: 0 },
        customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 1, jonaiCount: 0 },
        casts: [row], staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0,
        dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
        cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0,
          expectedClosingCash: 200000, cashProfit: 0, actualClosingCash: 200000, difference: 0 },
        posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"],
        approvedAt: `${date}T03:00:00Z`, approvedBy: "test-accounting", updatedAt: `${date}T03:00:00Z` };
      closing.cash.funding = calculateCashFunding(cashFundingContext(data.closings, date, 200000),
        { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, 0, true);
      adjustment.legacyBottleClassifications![legacyBottleSourceKey(closing, row, 0)] = "honShimei";
      data.closings.push(closing);
    }
    return { data, adjustment, addClosing };
  }

  it("体入→在籍の日別を統合し、営業日でなく最終保存条件を全月へ適用した実計算とsnapshotを出力できる", () => {
    const { data, adjustment, addClosing } = source();
    addClosing(`${month}-01`, "trial", 300, "higherNetSalesGross10");
    addClosing(`${month}-02`, "regular", 200, "gross10");
    const results = calculateMonthlyAccounting(data, month, adjustment);
    expect(results.warnings).toEqual([]);
    expect(results.castRewards).toHaveLength(1);
    expect(results.castRewards[0]).toMatchObject({ id: "active-generated", days: 2, advisoryDays: 1, trialOnly: false });
    expect(results.castSalesReports[0]).toMatchObject({ id: "active-generated", attendanceDays: 2, totals: { attendanceDays: 2 } });
    const exported = buildIntroducerExport(results, month);
    expect(exported.sheets[0].casts[0]).toMatchObject({ layout: "comparison", attendanceDays: 2, adopted: "総支給額10%",
      days: [{ businessDate: `${month}-01`, sales: 8000 }, { businessDate: `${month}-02`, sales: 15000 }],
      salesTotal: 23000, salesFee: 2300, grossFee: 2375, advisory: 3500, total: 5875 });
    const snapshot = buildMonthlySnapshot(month, 1, "b".repeat(64), adjustment, results, data.closings, "test-user", `${month}-30T12:00:00Z`);
    const restored = normalizeMonthlyAccountingSnapshot(JSON.parse(JSON.stringify(snapshot)), month, 1);
    expect(restored).toBeDefined();
    expect(buildIntroducerExport(restored!, month)).toEqual(exported);
  });

  it("入店後の在籍勤務がない者と全く出勤のない入店者も、実計算と旧snapshotで顧問料を保持する", () => {
    const { data, adjustment, addClosing } = source();
    addClosing(`${month}-01`, "trial", 100, "higherNetSalesGross10");
    data.casts.push({ ...data.casts[1], id: "new-without-work", name: "未出勤入店者", convertedFromTrialId: undefined,
      entryAdvisoryFee: 4000 });
    const results = calculateMonthlyAccounting(data, month, adjustment);
    expect(results.warnings).toEqual([]);
    const output = buildIntroducerExport(results, month);
    expect(output.sheets).toHaveLength(1);
    expect(output.sheets[0].casts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "同月入店花子", attendanceDays: 1, advisory: 3000, total: 3800 }),
      expect.objectContaining({ name: "未出勤入店者", attendanceDays: 0, adopted: "入店顧問料のみ", advisory: 4000, total: 4000 }),
    ]));
    const snapshot = buildMonthlySnapshot(month, 1, "c".repeat(64), adjustment, results, data.closings, "test-user", `${month}-30T12:00:00Z`);
    snapshot.schemaVersion = 1;
    snapshot.calculationVersion = "2.11.0"; removeNewExpensesForLegacy(snapshot);
    for (const reward of snapshot.castRewards) { delete reward.hourlyByDay; delete reward.appliedHourlyRates; }
    // 出勤済み旧snapshotは保存rewardの紹介者IDから同一人物を復元する。
    const workingPayment = snapshot.introducerPayments.find((payment) => payment.castId === "active-generated")!;
    delete workingPayment.introducerId;
    delete workingPayment.castId;
    const restored = normalizeMonthlyAccountingSnapshot(JSON.parse(JSON.stringify(snapshot)), month, 1);
    expect(restored).toBeDefined();
    expect(buildIntroducerExport(restored!, month)).toEqual(output);
  });
});
