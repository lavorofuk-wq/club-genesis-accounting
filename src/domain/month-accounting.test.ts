import { describe, expect, it } from "vitest";
import type {
  CastRecord,
  CastReward,
  DailyCast,
  DailyClosing,
  IntroducerRecord,
  MonthlyAdjustments,
  StaffRecord,
  WorkspaceData,
} from "./gms";
import {
  buildMonthlySnapshot,
  calculateIntroducerPayments,
  calculateMonthlyAccounting,
  canFinalizeMonthlyAccounting,
  monthlySourceFingerprint,
  normalizeMonthlyAccountingSnapshot,
  type IntroducerEntryEvent,
} from "./month-accounting";

const month = "2026-09";

function adjustments(overrides: Partial<MonthlyAdjustments> = {}): MonthlyAdjustments {
  return {
    month,
    withholdingByCast: {},
    staffSalesAllowance: {},
    staffBottleAllowance: {},
    driverRemoteAllowance: {},
    fixedExpenses: [],
    cardFee: 0,
    legacyBottleClassifications: {},
    revision: 1,
    updatedAt: "2026-09-30T12:00:00.000Z",
    updatedBy: "accounting-user",
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    casts: [],
    staff: [],
    drivers: [],
    introducers: [],
    liquor: [],
    closings: [],
    adjustments: [],
    cashFloat: 200_000,
    ...overrides,
  };
}

function cast(overrides: Partial<CastRecord> = {}): CastRecord {
  return {
    id: "cast-1",
    name: "花子",
    legalName: "山田花子",
    status: "active",
    hiredAt: "2026-09-01",
    hourlyRates: { [month]: 3_000 },
    note: "",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function staff(overrides: Partial<StaffRecord> = {}): StaffRecord {
  return {
    id: "staff-1",
    name: "スタッフ一郎",
    status: "active",
    hiredAt: "2026-09-02",
    hourlyRate: 2_000,
    note: "",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function introducer(overrides: Partial<IntroducerRecord> = {}): IntroducerRecord {
  return {
    id: "introducer-1",
    name: "紹介者A",
    feeType: "sales10",
    attendanceAdvisoryEnabled: false,
    entryAdvisoryEnabled: true,
    note: "",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function dailyCast(overrides: Partial<DailyCast> = {}): DailyCast {
  return {
    masterId: "cast-1",
    posCastId: "pos-cast-1",
    name: "花子",
    kind: "regular",
    startTime: "20:00",
    endTime: "00:00",
    hours: 4,
    hourlyRate: 3_000,
    honShimeiCount: 0,
    banaiShimeiCount: 0,
    dohanCount: 0,
    dohanBack: 0,
    honShimeiSales: 0,
    jonaiExtensionSales: 0,
    drinkSales: 0,
    drinkAllocations: [],
    bottles: [],
    liquorCost: 0,
    beautyAllowance: 0,
    dailyPayment: 0,
    advancePayment: 0,
    transportFee: 0,
    ...overrides,
  };
}

function approvedClosing(overrides: Partial<DailyClosing> = {}): DailyClosing {
  return {
    id: "closing-1",
    businessDate: "2026-09-02",
    status: "approved",
    submissionId: "submission-1",
    checksum: "a".repeat(64),
    sales: { cashSales: 0, cardSales: 0, totalSales: 0 },
    customers: { groupCount: 0, totalCustomers: 0 },
    nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [],
    staffWork: [],
    drivers: [],
    expenses: [],
    staffDailyPaymentTotal: 0,
    dispatchStaffPayment: 0,
    dispatchCastPayment: 0,
    dispatchFee: 0,
    liquorDeliveryAmount: 0,
    cash: {
      cashSales: 0,
      cardSales: 0,
      totalSales: 0,
      cashFloat: 200_000,
      expenseAndPaymentTotal: 0,
      expectedClosingCash: 200_000,
      cashProfit: 0,
      actualClosingCash: 200_000,
      difference: 0,
    },
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"],
    approvedAt: "2026-09-03T03:00:00.000Z",
    approvedBy: "accounting-user",
    updatedAt: "2026-09-03T03:00:00.000Z",
    ...overrides,
  };
}

describe("月次会計ドメイン", () => {
  it("紹介者報酬は場内延長を含めず、本指名基準・原価引き・総支給を1円単位で算出する", () => {
    const baseReward = {
      id: "cast-1",
      name: "花子",
      advisoryDays: 2,
      honShimeiSales: 1_234_500,
      jonaiExtensionSales: 9_999_900,
      honShimeiLiquorCost: 4_321,
      grossPay: 1_111_111,
      introducer: {
        id: "introducer-1",
        name: "紹介者A",
        feeType: "sales10",
        attendanceAdvisoryEnabled: true,
        attendanceAdvisoryFee: 333,
        entryAdvisoryFee: 0,
      },
    } as CastReward;
    const payment = (feeType: NonNullable<CastReward["introducer"]>["feeType"]) =>
      calculateIntroducerPayments([{
        ...baseReward,
        introducer: { ...baseReward.introducer!, feeType },
      }], workspace(), month)[0];

    expect(payment("sales10")).toMatchObject({
      salesBase: 1_234_500,
      salesFee: 123_450,
      grossFee: 111_111,
      attendanceAdvisory: 666,
      total: 124_116,
    });
    expect(payment("netSales10")).toMatchObject({
      salesBase: 1_230_179,
      salesFee: 123_017,
      total: 123_683,
    });
    expect(payment("gross10")).toMatchObject({ grossBase: 1_111_111, grossFee: 111_111, total: 111_777 });
    expect(payment("higherSalesGross10")).toMatchObject({ adopted: "売上10%", total: 124_116 });
    expect(payment("higherNetSalesGross10")).toMatchObject({ adopted: "酒代原価引き売上10%", total: 123_683 });
  });

  it("入店時イベントと日次の紹介者が違う場合は誤った支払結果を出さず月次確定を止める", () => {
    const currentCast = cast({
      introducerId: "introducer-a",
      entryAdvisoryFee: 30_000,
    });
    const entryEvent: IntroducerEntryEvent = {
      id: currentCast.id,
      month,
      hiredAt: currentCast.hiredAt!,
      castId: currentCast.id,
      castName: currentCast.name,
      introducerId: "introducer-a",
      introducerName: "紹介者A",
      feeType: "sales10",
      amount: 30_000,
      createdAt: "2026-09-01T10:00:00.000Z",
      createdBy: "op-user",
      updatedAt: "2026-09-01T10:00:00.000Z",
      updatedBy: "op-user",
    };
    const closing = approvedClosing({
      casts: [dailyCast({
        introducer: {
          id: "introducer-b",
          name: "紹介者B",
          feeType: "gross10",
          attendanceAdvisoryEnabled: true,
          attendanceAdvisoryFee: 1_000,
          entryAdvisoryFee: 0,
        },
      })],
    });
    const data = {
      ...workspace({
        casts: [currentCast],
        introducers: [
          introducer({ id: "introducer-a", name: "紹介者A" }),
          introducer({ id: "introducer-b", name: "紹介者B", feeType: "gross10" }),
        ],
        closings: [closing],
      }),
      introducerEntryEvents: [entryEvent],
    };

    const result = calculateMonthlyAccounting(data, month, adjustments(), [entryEvent]);
    const finalizeCheck = canFinalizeMonthlyAccounting(data, month, adjustments(), true);

    expect(result.introducerPayments).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("入店時紹介者条件"))).toBe(true);
    expect(finalizeCheck.allowed).toBe(false);
    expect(finalizeCheck.integrityIssues.some((issue) => issue.includes("入店時紹介者条件"))).toBe(true);
  });

  it("入店月に出勤がなくても保存済み入店顧問料を一回だけ計上する", () => {
    const event: IntroducerEntryEvent = {
      id: "entry-event-1",
      month,
      hiredAt: "2026-09-15",
      castId: "cast-no-attendance",
      castName: "新人キャスト",
      introducerId: "introducer-1",
      introducerName: "紹介者A",
      feeType: "sales10",
      amount: 30_000,
      createdAt: "2026-09-15T10:00:00.000Z",
      createdBy: "op-user",
      updatedAt: "2026-09-15T10:00:00.000Z",
      updatedBy: "op-user",
    };
    const result = calculateMonthlyAccounting(
      workspace({ introducers: [introducer()] }),
      month,
      adjustments(),
      [event, { ...event, id: "duplicate-event" }],
    );

    expect(result.approvedDays).toBe(0);
    expect(result.introducerPayments).toHaveLength(1);
    expect(result.introducerPayments[0]).toMatchObject({
      cast: "新人キャスト",
      introducer: "紹介者A",
      salesFee: 0,
      attendanceAdvisory: 0,
      entryAdvisory: 30_000,
      total: 30_000,
    });
    expect(result.balance.introducer).toBe(30_000);
  });

  it("キャストマスタで入店顧問料を取り消した後は古い保存イベントを計上しない", () => {
    const currentCast = cast({
      id: "cast-no-fee",
      introducerId: "introducer-1",
      entryAdvisoryFee: 0,
      updatedAt: "2026-09-20T10:00:00.000Z",
    });
    const staleEvent: IntroducerEntryEvent = {
      id: currentCast.id,
      month,
      hiredAt: currentCast.hiredAt!,
      castId: currentCast.id,
      castName: currentCast.name,
      introducerId: "introducer-1",
      introducerName: "紹介者A",
      feeType: "sales10",
      amount: 30_000,
      createdAt: "2026-09-01T10:00:00.000Z",
      createdBy: "op-user",
      updatedAt: "2026-09-01T10:00:00.000Z",
      updatedBy: "op-user",
    };
    const result = calculateMonthlyAccounting(
      workspace({ casts: [currentCast], introducers: [introducer()] }),
      month,
      adjustments(),
      [staleEvent],
    );

    expect(result.introducerPayments).toEqual([]);
    expect(result.balance.introducer).toBe(0);
  });

  it("作成済み入店顧問料は後日の名称変更・紹介者無効化後も当時情報で保持する", () => {
    const currentCast = cast({
      id: "cast-renamed",
      name: "現在のキャスト名",
      introducerId: "introducer-1",
      entryAdvisoryFee: 30_000,
    });
    const event: IntroducerEntryEvent = {
      id: currentCast.id,
      month,
      hiredAt: currentCast.hiredAt!,
      castId: currentCast.id,
      castName: "入店当時のキャスト名",
      introducerId: "introducer-1",
      introducerName: "入店当時の紹介者名",
      feeType: "sales10",
      amount: 30_000,
      createdAt: "2026-09-01T10:00:00.000Z",
      createdBy: "op-user",
      updatedAt: "2026-09-01T10:00:00.000Z",
      updatedBy: "op-user",
    };
    const renamedAndDisabled = introducer({
      id: "introducer-1",
      name: "現在の紹介者名",
      feeType: "gross10",
      entryAdvisoryEnabled: false,
    });

    const result = calculateMonthlyAccounting(
      workspace({ casts: [currentCast], introducers: [renamedAndDisabled] }),
      month,
      adjustments(),
      [event],
    );

    expect(result.introducerPayments).toHaveLength(1);
    expect(result.introducerPayments[0]).toMatchObject({
      cast: "入店当時のキャスト名",
      introducer: "入店当時の紹介者名",
      feeType: "sales10",
      entryAdvisory: 30_000,
      total: 30_000,
    });
  });

  it("派遣キャスト・派遣スタッフ・派遣手数料を経費へ各一回だけ計上する", () => {
    const closing = approvedClosing({
      sales: { cashSales: 60_000, cardSales: 40_000, totalSales: 100_000 },
      expenses: [{ id: "expense-1", category: "supplies", payee: "備品店", amount: 5_000 }],
      dispatchCastPayment: 10_000,
      dispatchStaffPayment: 20_000,
      dispatchFee: 3_000,
      cash: {
        cashSales: 60_000,
        cardSales: 40_000,
        totalSales: 100_000,
        cashFloat: 200_000,
        expenseAndPaymentTotal: 38_000,
        expectedClosingCash: 222_000,
        cashProfit: 22_000,
        actualClosingCash: 222_000,
        difference: 0,
      },
    });
    const result = calculateMonthlyAccounting(
      workspace({ closings: [closing] }),
      month,
      adjustments(),
    );

    expect(result.expenses).toMatchObject({
      dailyExpenseTotal: 5_000,
      dispatchCast: 10_000,
      dispatchStaff: 20_000,
      dispatchFee: 3_000,
      dispatchTotal: 33_000,
      total: 38_000,
    });
    expect(result.sales).toEqual({ cash: 60_000, card: 40_000, total: 100_000 });
    expect(result.balance).toMatchObject({
      expenses: 38_000,
      totalCosts: 38_000,
      profit: 62_000,
    });
    expect(result.balance.profit).toBe(result.sales.total - result.balance.totalCosts);
  });

  it("酒代納品書の月締め修正・固定経費・カード手数料を収支へ一度ずつ反映する", () => {
    const closing = approvedClosing({
      sales: { cashSales: 60_000, cardSales: 40_000, totalSales: 100_000 },
      liquorDeliveryAmount: 12_000,
    });
    const result = calculateMonthlyAccounting(
      workspace({ closings: [closing] }),
      month,
      adjustments({
        // 日次納品額を月締め後の返品・割引反映額で置き換える。
        liquorDeliveryAmount: 11_000,
        fixedExpenses: [{ id: "rent", account: "家賃", amount: 30_000 }],
        cardFee: 3_000,
      }),
    );

    expect(result.expenses).toMatchObject({
      liquorDelivery: 11_000,
      fixed: 30_000,
      cardFee: 3_000,
      total: 44_000,
    });
    expect(result.balance).toMatchObject({ expenses: 44_000, totalCosts: 44_000, profit: 56_000 });
  });

  it("完全削除後のアーカイブ済みキャストを結合して過去報酬を維持する", () => {
    const archived = cast({
      id: "archived-cast",
      name: "退店キャスト",
      status: "departed",
      departedAt: "2026-09-20",
    });
    const closing = approvedClosing({
      casts: [dailyCast({ masterId: archived.id, posCastId: "pos-archived", name: archived.name })],
    });
    const result = calculateMonthlyAccounting(
      { ...workspace({ closings: [closing] }), archivedCasts: [archived] },
      month,
      adjustments(),
    );

    expect(result.castRewards).toHaveLength(1);
    expect(result.castRewards[0]).toMatchObject({
      id: archived.id,
      name: archived.name,
      hours: 4,
      hourlyPay: 12_000,
      grossPay: 12_000,
    });
    expect(result.castSalesReports[0]).toMatchObject({
      id: archived.id,
      name: archived.name,
      attendanceDays: 1,
    });
    expect(result.balance.cast).toBe(12_000);
  });

  it("同月に体入から在籍化したスタッフを一人へ統合し体入日払いを控除する", () => {
    const activeStaff = staff({
      id: "active-staff",
      name: "統合スタッフ",
      convertedFromTrialId: "trial-staff",
      hiredAt: "2026-09-10",
      hourlyRate: 2_000,
    });
    const trialDay = approvedClosing({
      id: "trial-day",
      businessDate: "2026-09-05",
      staffWork: [{
        staffId: "trial-staff",
        name: "統合スタッフ",
        kind: "trial",
        startTime: "20:00",
        endTime: "00:00",
        hours: 4,
        hourlyRate: 1_500,
        dailyPayment: 6_000,
      }],
      staffDailyPaymentTotal: 6_000,
    });
    const activeDay = approvedClosing({
      id: "active-day",
      businessDate: "2026-09-12",
      staffWork: [{
        staffId: activeStaff.id,
        name: activeStaff.name,
        kind: "regular",
        startTime: "20:00",
        endTime: "00:00",
        hours: 4,
        hourlyRate: 2_000,
        dailyPayment: 0,
      }],
    });
    const result = calculateMonthlyAccounting(
      workspace({ staff: [activeStaff], closings: [trialDay, activeDay] }),
      month,
      adjustments(),
    );

    expect(result.staffPayroll).toHaveLength(1);
    expect(result.staffPayroll[0]).toEqual({
      id: activeStaff.id,
      name: activeStaff.name,
      hours: 8,
      hourly: 14_000,
      sales: 0,
      bottle: 0,
      gross: 14_000,
      daily: 6_000,
      net: 8_000,
    });
    expect(result.balance.staff).toBe(14_000);
  });

  it("論理削除後もアーカイブ済みスタッフの体入→在籍関係を使って一人へ統合する", () => {
    const archivedActive = staff({
      id: "deleted-active-staff",
      name: "削除済み統合スタッフ",
      convertedFromTrialId: "deleted-trial-staff",
      hiredAt: "2026-09-10",
      deletedAt: "2026-10-01T10:00:00.000Z",
      deletedBy: "op-user",
    });
    const trialDay = approvedClosing({
      id: "deleted-trial-day",
      businessDate: "2026-09-05",
      staffWork: [{ staffId: "deleted-trial-staff", name: archivedActive.name, kind: "trial", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 1_500, dailyPayment: 6_000 }],
      staffDailyPaymentTotal: 6_000,
    });
    const activeDay = approvedClosing({
      id: "deleted-active-day",
      businessDate: "2026-09-12",
      staffWork: [{ staffId: archivedActive.id, name: archivedActive.name, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 2_000, dailyPayment: 0 }],
    });

    const result = calculateMonthlyAccounting(
      { ...workspace({ closings: [trialDay, activeDay] }), archivedStaff: [archivedActive] },
      month,
      adjustments(),
    );

    expect(result.staffPayroll).toHaveLength(1);
    expect(result.staffPayroll[0]).toMatchObject({ id: archivedActive.id, hours: 8, hourly: 14_000, daily: 6_000, net: 8_000 });
  });

  it("月次ソースの配列順が違っても同じfingerprintを返す", async () => {
    const castA = cast({ id: "cast-a", updatedAt: "2026-09-01T01:00:00.000Z" });
    const castB = cast({ id: "cast-b", name: "春子", updatedAt: "2026-09-02T01:00:00.000Z" });
    const staffA = staff({ id: "staff-a", updatedAt: "2026-09-01T02:00:00.000Z" });
    const staffB = staff({ id: "staff-b", name: "スタッフ二郎", updatedAt: "2026-09-02T02:00:00.000Z" });
    const introA = introducer({ id: "intro-a", updatedAt: "2026-09-01T03:00:00.000Z" });
    const introB = introducer({ id: "intro-b", name: "紹介者B", updatedAt: "2026-09-02T03:00:00.000Z" });
    const closingA = approvedClosing({ id: "closing-a", businessDate: "2026-09-01", updatedAt: "2026-09-02T03:00:00.000Z" });
    const closingB = approvedClosing({ id: "closing-b", businessDate: "2026-09-02", updatedAt: "2026-09-03T03:00:00.000Z" });
    const eventA: IntroducerEntryEvent = {
      id: "event-a", month, hiredAt: "2026-09-01", castId: "cast-a", castName: "花子",
      introducerId: "intro-a", introducerName: "紹介者A", feeType: "sales10", amount: 10_000,
      createdAt: "2026-09-01T00:00:00.000Z", createdBy: "op", updatedAt: "2026-09-01T00:00:00.000Z", updatedBy: "op",
    };
    const eventB = { ...eventA, id: "event-b", castId: "cast-b", castName: "春子", amount: 20_000, updatedAt: "2026-09-02T00:00:00.000Z" };
    const first = workspace({
      casts: [castA, castB],
      staff: [staffA, staffB],
      introducers: [introA, introB],
      closings: [closingA, closingB],
    });
    const second = workspace({
      casts: [castB, castA],
      staff: [staffB, staffA],
      introducers: [introB, introA],
      closings: [closingB, closingA],
    });

    await expect(monthlySourceFingerprint(first, month, adjustments(), [eventA, eventB]))
      .resolves.toBe(await monthlySourceFingerprint(second, month, adjustments(), [eventB, eventA]));
  });

  it("updatedAtが同じでも計算に使うマスタ実値が変わればfingerprintが変わる", async () => {
    const original = workspace({ casts: [cast()] });
    const edited = workspace({ casts: [cast({ hourlyRates: { [month]: 4_000 } })] });

    expect(await monthlySourceFingerprint(original, month, adjustments())).not.toBe(
      await monthlySourceFingerprint(edited, month, adjustments()),
    );
  });

  it("欠落した空配列を復元し、不正なsummaryを拒否する", () => {
    const storedWithoutEmptyArrays: Record<string, unknown> = {
      schemaVersion: 1,
      calculationVersion: "2.8.0",
      month,
      revision: 4,
      sourceFingerprint: "f".repeat(64),
      adjustmentsRevision: 1,
      approvedDays: 0,
      expenses: {
        dailyExpenseTotal: 0,
        dispatchCast: 0,
        dispatchStaff: 0,
        dispatchFee: 0,
        dispatchTotal: 0,
        liquorDelivery: 0,
        fixed: 0,
        cardFee: 0,
        total: 0,
      },
      sales: { cash: 0, card: 0, total: 0 },
      balance: { cast: 0, introducer: 0, staff: 0, driver: 0, expenses: 0, totalCosts: 0, profit: 0 },
      createdAt: "2026-09-30T23:59:59.000Z",
      createdBy: "accounting-user",
    };
    const normalized = normalizeMonthlyAccountingSnapshot(storedWithoutEmptyArrays, month, 4);

    expect(normalized).toMatchObject({
      revision: 4,
      castSalesReports: [],
      castRewards: [],
      introducerPayments: [],
      staffPayroll: [],
      driverPayroll: [],
      warnings: [],
      approvedClosings: [],
      expenses: { byCategory: {} },
    });
    expect(normalizeMonthlyAccountingSnapshot({
      ...storedWithoutEmptyArrays,
      sales: { cash: 0, card: 0, total: "不正" },
    }, month, 4)).toBeUndefined();
  });

  it("日次キャスト売上の必須日付が欠落した破損スナップショットを拒否する", async () => {
    const closing = approvedClosing({ casts: [dailyCast()] });
    const source = workspace({ casts: [cast()], closings: [closing] });
    const input = adjustments();
    const results = calculateMonthlyAccounting(source, month, input);
    const snapshot = buildMonthlySnapshot(
      month,
      1,
      await monthlySourceFingerprint(source, month, input),
      input,
      results,
      source.closings,
      "accounting-user",
      "2026-09-30T23:59:59.000Z",
    );
    const corrupted = structuredClone(snapshot) as unknown as { castSalesReports: Array<{ days: Array<Record<string, unknown>> }> };
    delete corrupted.castSalesReports[0].days[0].businessDate;

    expect(normalizeMonthlyAccountingSnapshot(corrupted, month, 1)).toBeUndefined();
  });

  it("体入キャストへ即日支給した美容室手当をキャスト売上の日次表示へ反映する", () => {
    const trial = cast({ id: "trial-cast", status: "trial", hiredAt: undefined, trialDate: "2026-09-02", trialHourlyRate: 1_500 });
    const closing = approvedClosing({
      casts: [dailyCast({ masterId: trial.id, posCastId: "pos-trial", name: trial.name, kind: "trial", hourlyRate: 1_500 })],
      expenses: [{ id: "beauty-trial", category: "beautyTrial", payee: trial.name, personId: trial.id, amount: 2_000 }],
    });

    const result = calculateMonthlyAccounting(workspace({ casts: [trial], closings: [closing] }), month, adjustments());

    expect(result.castSalesReports[0].days[0].beautyAllowance).toBe(2_000);
    expect(result.castSalesReports[0].totals.beautyAllowance).toBe(2_000);
    expect(result.castRewards[0].beautyAllowance).toBe(0);
  });

  it("未分類の旧ボトルが一件でもあれば月次確定を拒否する", () => {
    const legacyClosing = approvedClosing({
      id: "legacy-closing",
      posSnapshot: undefined as unknown as DailyClosing["posSnapshot"],
      casts: [dailyCast({
        bottles: [{
          itemId: "legacy-bottle",
          name: "旧ボトル",
          kind: "champagneWine",
          quantity: 1,
          salesAmount: 30_000,
          costAmount: 10_000,
          specialCost: false,
        }],
        liquorCost: 10_000,
      })],
    });
    const result = canFinalizeMonthlyAccounting(
      workspace({ closings: [legacyClosing] }),
      month,
      adjustments(),
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.unclassified).toHaveLength(1);
    expect(result.unclassified[0]).toMatchObject({
      closingId: legacyClosing.id,
      businessDate: legacyClosing.businessDate,
      castName: "花子",
    });
    expect(result.unclassified[0].sourceKey).not.toBe("");
  });

  it("同じ営業日の承認済みデータが複数あれば二重計上を警告して月次確定を拒否する", () => {
    const first = approvedClosing({ id: "daily_20260902" });
    const duplicate = approvedClosing({ id: "legacy-duplicate", submissionId: "submission-duplicate", checksum: "b".repeat(64) });
    const result = canFinalizeMonthlyAccounting(
      workspace({ closings: [first, duplicate] }),
      month,
      adjustments(),
      false,
    );

    expect(result.allowed).toBe(false);
    expect(result.integrityIssues).toContain("2026-09-02の承認済み日次データが複数あります。重複データを差し戻してから確定してください。");
    expect(calculateMonthlyAccounting(workspace({ closings: [first, duplicate] }), month, adjustments()).approvedDays).toBe(1);
  });

  it("同月の体入日と在籍日で出勤顧問料が異なっても在籍条件を採用し体入日の売上・バックを統合する", () => {
    const trial = cast({
      id: "trial-cast",
      status: "trial",
      hiredAt: undefined,
      trialDate: "2026-09-01",
      hourlyRates: {},
      trialHourlyRate: 1_500,
      convertedToCastId: "active-cast",
    });
    const active = cast({
      id: "active-cast",
      convertedFromTrialId: trial.id,
      hiredAt: "2026-09-02",
      introducerId: "introducer-1",
      attendanceAdvisoryFee: 500,
    });
    const trialDay = approvedClosing({
      id: "trial-cast-day",
      businessDate: "2026-09-01",
      submissionId: "trial-cast-submission",
      casts: [dailyCast({
        masterId: trial.id,
        posCastId: "pos-trial-cast",
        kind: "trial",
        hourlyRate: 1_500,
        honShimeiCount: 1,
        honShimeiSales: 10_000,
        introducer: {
          id: "introducer-1",
          name: "紹介者A",
          feeType: "sales10",
          attendanceAdvisoryEnabled: true,
          attendanceAdvisoryFee: 0,
          entryAdvisoryFee: 0,
        },
      })],
    });
    const activeDay = approvedClosing({
      id: "active-cast-day",
      businessDate: "2026-09-02",
      submissionId: "active-cast-submission",
      checksum: "b".repeat(64),
      casts: [dailyCast({
        masterId: active.id,
        posCastId: "pos-active-cast",
        kind: "regular",
        honShimeiCount: 1,
        honShimeiSales: 20_000,
        introducer: {
          id: "introducer-1",
          name: "紹介者A",
          feeType: "sales10",
          attendanceAdvisoryEnabled: true,
          attendanceAdvisoryFee: 500,
          entryAdvisoryFee: 0,
        },
      })],
    });
    const source = workspace({
      casts: [trial, active],
      introducers: [introducer({ attendanceAdvisoryEnabled: true })],
      closings: [trialDay, activeDay],
    });

    const result = calculateMonthlyAccounting(source, month, adjustments());
    const check = canFinalizeMonthlyAccounting(source, month, adjustments(), false);

    expect(result.castRewards).toHaveLength(1);
    expect(result.castRewards[0]).toMatchObject({
      id: active.id,
      days: 2,
      advisoryDays: 1,
      trialOnly: false,
      honShimeiSales: 30_000,
      honShimeiBack: 2_000,
      introducer: { id: "introducer-1", attendanceAdvisoryFee: 500 },
    });
    expect(result.introducerPayments).toHaveLength(1);
    expect(result.introducerPayments[0]).toMatchObject({
      salesBase: 30_000,
      salesFee: 3_000,
      attendanceAdvisory: 500,
      total: 3_500,
    });
    expect(result.warnings.some((issue) => issue.includes("計算方法を確認するまで"))).toBe(false);
    expect(check.allowed).toBe(true);
  });

  it("月途中で紹介者条件が変わった場合は推測計算せず月次確定を止める", () => {
    const first = approvedClosing({
      id: "intro-first",
      casts: [dailyCast({ introducer: { id: "intro-a", name: "紹介者A", feeType: "sales10", attendanceAdvisoryEnabled: true, attendanceAdvisoryFee: 1_000, entryAdvisoryFee: 0 } })],
    });
    const second = approvedClosing({
      id: "intro-second",
      businessDate: "2026-09-03",
      casts: [dailyCast({ introducer: { id: "intro-b", name: "紹介者B", feeType: "gross10", attendanceAdvisoryEnabled: true, attendanceAdvisoryFee: 2_000, entryAdvisoryFee: 0 } })],
    });
    const source = workspace({ casts: [cast()], closings: [first, second] });

    const check = canFinalizeMonthlyAccounting(source, month, adjustments(), false);
    const calculated = calculateMonthlyAccounting(source, month, adjustments());

    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.some((issue) => issue.includes("計算方法を確認するまで"))).toBe(true);
    expect(calculated.warnings.some((issue) => issue.includes("計算方法を確認するまで"))).toBe(true);
    expect(calculated.introducerPayments).toEqual([]);
  });
});
