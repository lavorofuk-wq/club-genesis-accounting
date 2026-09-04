import { describe, expect, it } from "vitest";
import type {
  CastRecord,
  CastReward,
  DailyCast,
  DailyClosing,
  IntroducerDeletionCommit,
  IntroducerRecord,
  IntroducerMonthEvent,
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
  normalizeIntroducerDeletionCommit,
  normalizeIntroducerMonthEvent,
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

function introducerMonthEvent(overrides: Partial<IntroducerMonthEvent> = {}): IntroducerMonthEvent {
  return {
    id: "cast-1",
    month,
    castId: "cast-1",
    castName: "花子",
    state: "deleted",
    deletedIntroducerId: "introducer-1",
    deletedIntroducerName: "紹介者A",
    deletedAt: "2026-09-15T03:00:00.000Z",
    deletedBy: "op-user",
    revision: 1,
    createdAt: "2026-09-15T03:00:00.000Z",
    createdBy: "op-user",
    updatedAt: "2026-09-15T03:00:00.000Z",
    updatedBy: "op-user",
    ...overrides,
  };
}

function introducerDeletionCommit(overrides: Partial<IntroducerDeletionCommit> = {}): IntroducerDeletionCommit {
  return {
    id: "introducer-1",
    introducerId: "introducer-1",
    introducerName: "紹介者A",
    month,
    token: "delete-token",
    owner: "op-user",
    deletedAtMs: Date.parse("2026-09-15T03:00:00.000Z"),
    completedAt: "2026-09-15T03:00:00.000Z",
    completedAtMs: Date.parse("2026-09-15T03:00:00.000Z") + 1,
    linkedCastIds: ["cast-1"],
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

  it("入店時イベントと日次条件が違う場合は最後に保存された日次条件を月全体へ適用する", () => {
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
          entryAdvisoryEnabled: true,
          attendanceAdvisoryFee: 1_000,
          entryAdvisoryFee: 12_345,
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

    expect(result.castRewards[0].introducer).toMatchObject({ id: "introducer-b", feeType: "gross10", entryAdvisoryFee: 12_345 });
    expect(result.introducerPayments).toHaveLength(1);
    expect(result.introducerPayments[0]).toMatchObject({
      introducer: "紹介者B",
      feeType: "gross10",
      attendanceAdvisory: 1_000,
      entryAdvisory: 12_345,
    });
    expect(result.warnings.some((warning) => warning.includes("入店時紹介者条件"))).toBe(false);
    expect(finalizeCheck.allowed).toBe(true);
    expect(finalizeCheck.integrityIssues).toEqual([]);
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

  it("在籍側マスタが旧版で物理削除済みでも体入側の変換先と同月regular日次を一人へ統合する", () => {
    const trial = cast({
      id: "remaining-trial-cast", status: "trial", hiredAt: undefined, trialDate: "2026-09-05",
      hourlyRates: {}, trialHourlyRate: 1_500, convertedToCastId: "removed-active-cast",
    });
    const trialDay = approvedClosing({
      id: "physical-delete-trial-day", businessDate: "2026-09-05", submittedAtMs: 100,
      casts: [dailyCast({ masterId: trial.id, posCastId: "pos-trial", name: trial.name, kind: "trial", hourlyRate: 1_500 })],
    });
    const regularDay = approvedClosing({
      id: "physical-delete-regular-day", businessDate: "2026-09-12", submittedAtMs: 200,
      casts: [dailyCast({ masterId: "removed-active-cast", posCastId: "pos-regular", name: trial.name, kind: "regular", hourlyRate: 2_000 })],
    });

    const result = calculateMonthlyAccounting(
      workspace({ casts: [trial], closings: [trialDay, regularDay] }),
      month,
      adjustments(),
    );

    expect(result.castRewards).toHaveLength(1);
    expect(result.castRewards[0]).toMatchObject({ id: "removed-active-cast", days: 2, hours: 8, hourlyPay: 14_000 });
    expect(result.castSalesReports).toHaveLength(1);
    expect(result.castSalesReports[0]).toMatchObject({ id: "removed-active-cast", attendanceDays: 2 });
  });

  it("変換先IDの日次がregularでなければ物理削除済み在籍キャストへ誤統合しない", () => {
    const trial = cast({
      id: "source-trial-only", status: "trial", hiredAt: undefined, trialDate: "2026-09-05",
      hourlyRates: {}, trialHourlyRate: 1_500, convertedToCastId: "target-with-trial-only",
    });
    const closing = approvedClosing({
      submittedAtMs: 100,
      casts: [
        dailyCast({ masterId: trial.id, posCastId: "pos-source", name: "体入A", kind: "trial", hourlyRate: 1_500 }),
        dailyCast({ masterId: "target-with-trial-only", posCastId: "pos-target", name: "体入B", kind: "trial", hourlyRate: 1_500 }),
      ],
    });
    const result = calculateMonthlyAccounting(workspace({ casts: [trial], closings: [closing] }), month, adjustments());

    expect(result.castRewards.map((row) => row.id).sort()).toEqual(["source-trial-only", "target-with-trial-only"]);
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

  it("在籍スタッフ側マスタが物理削除済みでも体入側の変換先と同月regular勤務を統合する", () => {
    const trial = staff({
      id: "remaining-trial-staff", status: "trial", hiredAt: undefined, trialDate: "2026-09-05",
      trialHourlyRate: 1_500, convertedToStaffId: "removed-active-staff",
    });
    const trialDay = approvedClosing({
      id: "physical-staff-trial", businessDate: "2026-09-05",
      staffWork: [{ staffId: trial.id, name: trial.name, kind: "trial", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 1_500, dailyPayment: 6_000 }],
    });
    const regularDay = approvedClosing({
      id: "physical-staff-regular", businessDate: "2026-09-12",
      staffWork: [{ staffId: "removed-active-staff", name: trial.name, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 2_000, dailyPayment: 0 }],
    });
    const result = calculateMonthlyAccounting(
      workspace({ staff: [trial], closings: [trialDay, regularDay] }),
      month,
      adjustments(),
    );

    expect(result.staffPayroll).toHaveLength(1);
    expect(result.staffPayroll[0]).toMatchObject({ id: "removed-active-staff", hours: 8, hourly: 14_000, daily: 6_000, net: 8_000 });
  });

  it("変換先IDの勤務がregularでなければ物理削除済み在籍スタッフへ誤統合しない", () => {
    const trial = staff({
      id: "source-trial-staff", status: "trial", hiredAt: undefined, trialDate: "2026-09-05",
      trialHourlyRate: 1_500, convertedToStaffId: "target-trial-staff",
    });
    const closing = approvedClosing({
      staffWork: [
        { staffId: trial.id, name: "体入スタッフA", kind: "trial", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 1_500, dailyPayment: 6_000 },
        { staffId: "target-trial-staff", name: "体入スタッフB", kind: "trial", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 1_500, dailyPayment: 6_000 },
      ],
    });
    const result = calculateMonthlyAccounting(workspace({ staff: [trial], closings: [closing] }), month, adjustments());

    expect(result.staffPayroll.map((row) => row.id).sort()).toEqual(["source-trial-staff", "target-trial-staff"]);
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

  it("POS商品行のバック対象人数が変われば同じupdatedAtでもfingerprintが変わる", async () => {
    const originalClosing = approvedClosing({
      posSnapshot: {
        transactions: [{
          transactionId: "tx-1",
          items: [{
            itemId: "drink-1",
            category: "castDrink",
            price: 10_000,
            quantity: 1,
            backTargetCastIds: ["p1", "p2", "p3"],
          }],
        }],
      } as unknown as DailyClosing["posSnapshot"],
    });
    const changedClosing = structuredClone(originalClosing);
    changedClosing.posSnapshot.transactions[0].items[0].backTargetCastIds = ["p1", "p2"];

    expect(await monthlySourceFingerprint(workspace({ closings: [originalClosing] }), month, adjustments())).not.toBe(
      await monthlySourceFingerprint(workspace({ closings: [changedClosing] }), month, adjustments()),
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
    expect(snapshot.calculationVersion).toBe("2.10.0");
    const corrupted = structuredClone(snapshot) as unknown as { castSalesReports: Array<{ days: Array<Record<string, unknown>> }> };
    delete corrupted.castSalesReports[0].days[0].businessDate;

    expect(normalizeMonthlyAccountingSnapshot(corrupted, month, 1)).toBeUndefined();
  });

  it("1円単位で保存する商品バックに小数がある破損スナップショットを拒否する", async () => {
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
    const corrupted = structuredClone(snapshot);
    corrupted.castSalesReports[0].days[0].backs.find((row) => row.key === "bottle")!.amount = 0.5;
    corrupted.castSalesReports[0].days[0].backTotal = 0.5;

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

  it.each([
    ["確認待ち", "submitted"],
    ["差戻し中", "returned"],
    ["店舗編集中（取下げ）", "withdrawn"],
  ] as const)("%sの日次が1件でもあれば月次確定を拒否する", (_label, status) => {
    const unresolved = approvedClosing({ status });
    const result = canFinalizeMonthlyAccounting(
      workspace({ closings: [unresolved] }),
      month,
      adjustments(),
      true,
    );

    expect(result.allowed).toBe(false);
    expect(result.unresolvedDaily).toHaveLength(1);
    expect(result.unresolvedDaily[0].status).toBe(status);
  });

  it("同月の体入日と在籍日では最後に保存された在籍日条件を採用し体入日の売上・バックを統合する", () => {
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
      submittedAt: "2026-09-01T03:00:00.000Z",
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
      submittedAt: "2026-09-02T03:00:00.000Z",
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

  it("体入後に同月在籍化して在籍出勤がなくても同じ紹介者の入店顧問料を一回計上する", () => {
    const trial = cast({
      id: "trial-before-hire",
      status: "trial",
      hiredAt: undefined,
      trialDate: "2026-09-01",
      hourlyRates: {},
      trialHourlyRate: 1_500,
      convertedToCastId: "active-after-trial",
      introducerId: "introducer-1",
    });
    const active = cast({
      id: "active-after-trial",
      convertedFromTrialId: trial.id,
      hiredAt: "2026-09-02",
      introducerId: "introducer-1",
      entryAdvisoryFee: 30_000,
    });
    const trialDay = approvedClosing({
      id: "trial-only-day",
      businessDate: "2026-09-01",
      submittedAtMs: 100,
      submissionId: "trial-only-submission",
      casts: [dailyCast({
        masterId: trial.id,
        posCastId: "pos-trial-only",
        kind: "trial",
        hourlyRate: 1_500,
        introducer: {
          id: "introducer-1",
          name: "紹介者A",
          feeType: "sales10",
          attendanceAdvisoryEnabled: false,
          entryAdvisoryEnabled: true,
          attendanceAdvisoryFee: 0,
          entryAdvisoryFee: 0,
        },
      })],
    });
    const entry: IntroducerEntryEvent = {
      id: active.id,
      month,
      hiredAt: active.hiredAt!,
      castId: active.id,
      castName: active.name,
      introducerId: "introducer-1",
      introducerName: "紹介者A",
      feeType: "sales10",
      amount: 30_000,
      createdAt: "2026-09-02T03:00:00.000Z",
      createdBy: "op-user",
      updatedAt: "2026-09-02T03:00:00.000Z",
      updatedBy: "op-user",
    };
    const result = calculateMonthlyAccounting(
      workspace({ casts: [trial, active], introducers: [introducer()], closings: [trialDay] }),
      month,
      adjustments(),
      [entry],
    );

    expect(result.castRewards).toHaveLength(1);
    expect(result.castRewards[0]).toMatchObject({ id: active.id, advisoryDays: 0, trialOnly: false });
    expect(result.introducerPayments).toHaveLength(1);
    expect(result.introducerPayments[0]).toMatchObject({
      introducer: "紹介者A",
      entryAdvisory: 30_000,
      total: 30_000,
    });

    const differentActive = {
      ...active,
      introducerId: "introducer-2",
      updatedAt: "2026-09-02T04:00:00.000Z",
    };
    const differentEntry = {
      ...entry,
      introducerId: "introducer-2",
      introducerName: "紹介者B",
    };
    const conflict = canFinalizeMonthlyAccounting(
      workspace({
        casts: [trial, differentActive],
        introducers: [introducer(), introducer({ id: "introducer-2", name: "紹介者B" })],
        closings: [trialDay],
      }),
      month,
      adjustments(),
      false,
      [differentEntry],
    );
    expect(conflict.allowed).toBe(false);
    expect(conflict.integrityIssues).toContain("花子は体入日の紹介者（紹介者A）と入店時の紹介者（紹介者B）が異なるため、入店顧問料を確定できません。適用する紹介者を確認してください。");
  });

  it("月途中で紹介者条件が変わった場合は営業日順ではなく最後の保存時刻を月全体へ適用する", () => {
    const first = approvedClosing({
      id: "intro-first",
      businessDate: "2026-09-20",
      submittedAt: "2026-09-20T03:00:00.000Z",
      casts: [dailyCast({ honShimeiSales: 100_000, introducer: { id: "intro-a", name: "紹介者A", feeType: "sales10", attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: false, attendanceAdvisoryFee: 1_000, entryAdvisoryFee: 0 } })],
    });
    const second = approvedClosing({
      id: "intro-second",
      businessDate: "2026-09-03",
      submittedAt: "2026-09-30T03:00:00.000Z",
      casts: [dailyCast({ honShimeiSales: 100_000, introducer: { id: "intro-b", name: "紹介者B", feeType: "gross10", attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: false, attendanceAdvisoryFee: 2_000, entryAdvisoryFee: 0 } })],
    });
    const source = workspace({ casts: [cast()], closings: [second, first] });

    const check = canFinalizeMonthlyAccounting(source, month, adjustments(), false);
    const calculated = calculateMonthlyAccounting(source, month, adjustments());

    expect(check.allowed).toBe(true);
    expect(check.integrityIssues).toEqual([]);
    expect(calculated.castRewards[0].introducer).toMatchObject({ id: "intro-b", feeType: "gross10", attendanceAdvisoryFee: 2_000 });
    expect(calculated.introducerPayments[0]).toMatchObject({ introducer: "紹介者B", feeType: "gross10", attendanceAdvisory: 4_000 });
  });

  it("端末時刻ではなくFirebaseサーバー保存時刻で最後の日次条件を選ぶ", () => {
    const olderOnServer = approvedClosing({
      id: "server-old", businessDate: "2026-09-20",
      submittedAt: "2026-09-30T03:00:00.000Z", submittedAtMs: 100,
      casts: [dailyCast({ introducer: {
        id: "intro-a", name: "紹介者A", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const newerOnServer = approvedClosing({
      id: "server-new", businessDate: "2026-09-01",
      submittedAt: "2026-09-01T03:00:00.000Z", submittedAtMs: 200,
      casts: [dailyCast({ introducer: {
        id: "intro-b", name: "紹介者B", feeType: "gross10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const source = workspace({ casts: [cast()], closings: [newerOnServer, olderOnServer] });

    expect(calculateMonthlyAccounting(source, month, adjustments()).castRewards[0].introducer)
      .toMatchObject({ id: "intro-b", feeType: "gross10" });
    expect(canFinalizeMonthlyAccounting(source, month, adjustments(), false).allowed).toBe(true);
  });

  it("保存順を復元できない旧日次に紹介者条件差があればupdatedAtで推測せず確定を止める", () => {
    const first = approvedClosing({
      id: "legacy-first", businessDate: "2026-09-01", submittedAt: undefined,
      updatedAt: "2026-09-30T03:00:00.000Z",
      casts: [dailyCast({ introducer: {
        id: "intro-a", name: "紹介者A", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const second = approvedClosing({
      id: "legacy-second", businessDate: "2026-09-02", submittedAt: undefined,
      updatedAt: "2026-09-02T03:00:00.000Z",
      casts: [dailyCast({ introducer: {
        id: "intro-b", name: "紹介者B", feeType: "gross10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });

    const check = canFinalizeMonthlyAccounting(
      workspace({ casts: [cast()], closings: [first, second] }),
      month,
      adjustments(),
      false,
    );
    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.some((issue) => issue.includes("旧日次に店舗保存順がない"))).toBe(true);
  });

  it("同一サーバー保存時刻の日次条件が競合する場合は確定を止める", () => {
    const first = approvedClosing({
      id: "same-ms-a", businessDate: "2026-09-01", submittedAtMs: 500,
      casts: [dailyCast({ introducer: {
        id: "intro-a", name: "紹介者A", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const second = approvedClosing({
      id: "same-ms-b", businessDate: "2026-09-02", submittedAtMs: 500,
      casts: [dailyCast({ introducer: {
        id: "intro-b", name: "紹介者B", feeType: "gross10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });

    const check = canFinalizeMonthlyAccounting(
      workspace({ casts: [cast()], closings: [first, second] }),
      month,
      adjustments(),
      false,
    );
    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.some((issue) => issue.includes("同じ店舗保存時刻で競合"))).toBe(true);
  });

  it("同月入店者は通常日より後に再保存された体入日の紹介者条件を採用する", () => {
    const trial = cast({
      id: "trial-1", status: "trial", hiredAt: undefined, trialDate: "2026-09-01",
      hourlyRates: {}, trialHourlyRate: 2_000, convertedToCastId: "active-1",
    });
    const active = cast({
      id: "active-1", hiredAt: "2026-09-05", convertedFromTrialId: trial.id,
    });
    const regularDay = approvedClosing({
      id: "regular-day", businessDate: "2026-09-10", submittedAt: "2026-09-10T03:00:00.000Z",
      casts: [dailyCast({ masterId: active.id, kind: "regular", introducer: {
        id: "intro-a", name: "紹介者A", feeType: "sales10", attendanceAdvisoryEnabled: true,
        entryAdvisoryEnabled: false, attendanceAdvisoryFee: 1_000, entryAdvisoryFee: 0,
      } })],
    });
    const resavedTrialDay = approvedClosing({
      id: "trial-day", businessDate: "2026-09-01", submittedAt: "2026-09-20T03:00:00.000Z",
      casts: [dailyCast({ masterId: trial.id, kind: "trial", introducer: {
        id: "intro-b", name: "紹介者B", feeType: "gross10", attendanceAdvisoryEnabled: false,
        entryAdvisoryEnabled: false, attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const result = calculateMonthlyAccounting(
      workspace({ casts: [trial, active], closings: [regularDay, resavedTrialDay] }),
      month,
      adjustments(),
    );

    expect(result.castRewards).toHaveLength(1);
    expect(result.castRewards[0].introducer).toMatchObject({ id: "intro-b", attendanceAdvisoryFee: 0 });
    expect(result.introducerPayments[0]).toMatchObject({ introducer: "紹介者B", attendanceAdvisory: 0 });
  });

  it("紹介者を削除した月は歩合・出勤顧問料・入店顧問料をすべて停止する", () => {
    const member = cast({ introducerId: "introducer-1", attendanceAdvisoryFee: 500, entryAdvisoryFee: 30_000 });
    const entry: IntroducerEntryEvent = {
      id: member.id, month, hiredAt: member.hiredAt!, castId: member.id, castName: member.name,
      introducerId: "introducer-1", introducerName: "紹介者A", feeType: "sales10", amount: 30_000,
      createdAt: "2026-09-01T01:00:00.000Z", createdBy: "op-user",
      updatedAt: "2026-09-01T01:00:00.000Z", updatedBy: "op-user",
    };
    const closing = approvedClosing({
      submittedAt: "2026-09-10T03:00:00.000Z", submittedAtMs: 400,
      casts: [dailyCast({ honShimeiSales: 500_000, introducer: {
        id: "introducer-1", name: "紹介者A", feeType: "sales10", attendanceAdvisoryEnabled: true,
        entryAdvisoryEnabled: true, attendanceAdvisoryFee: 500, entryAdvisoryFee: 30_000,
      } })],
    });
    const deleted = introducerMonthEvent();
    const source = {
      ...workspace({ casts: [member], closings: [closing] }),
      introducerEntryEvents: [entry],
      introducerMonthEvents: [deleted],
    };
    const result = calculateMonthlyAccounting(source, month, adjustments(), [entry]);

    expect(result.castRewards[0].introducer).toBeUndefined();
    expect(result.introducerPayments).toEqual([]);
    expect(result.balance.introducer).toBe(0);
  });

  it("個別イベントが欠落しても削除commitを正本として削除月の紹介者支払を停止する", () => {
    const member = cast({ introducerId: "introducer-1", entryAdvisoryFee: 30_000 });
    const closing = approvedClosing({
      submittedAtMs: 100,
      casts: [dailyCast({ honShimeiSales: 500_000, introducer: {
        id: "introducer-1", name: "紹介者A", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: true,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 30_000,
      } })],
    });
    const commit = introducerDeletionCommit();
    const result = calculateMonthlyAccounting(
      workspace({ casts: [member], closings: [closing] }),
      month,
      adjustments(),
      [],
      [],
      [commit],
    );

    expect(result.castRewards[0].introducer).toBeUndefined();
    expect(result.introducerPayments).toEqual([]);
    expect(result.balance.introducer).toBe(0);
  });

  it("削除時の対象者一覧から除外した完全削除済みキャストの過去報酬はcommitで変更しない", () => {
    const archived = cast({ deletedAt: "2026-09-10T03:00:00.000Z", deletedBy: "op-user" });
    const closing = approvedClosing({
      submittedAtMs: 100,
      casts: [dailyCast({ introducer: {
        id: "introducer-1", name: "紹介者A", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const source = { ...workspace({ closings: [closing] }), archivedCasts: [archived] };
    const commit = introducerDeletionCommit({ linkedCastIds: [] });
    const result = calculateMonthlyAccounting(source, month, adjustments(), [], [], [commit]);

    expect(result.castRewards[0].introducer).toMatchObject({ id: "introducer-1" });
    expect(result.introducerPayments).toHaveLength(1);
  });

  it("旧版でキャストマスタが物理削除済みでも保存日次と入店eventから当時の入店顧問料を維持する", () => {
    const closing = approvedClosing({
      submittedAtMs: 100,
      casts: [dailyCast({ introducer: {
        id: "introducer-1", name: "紹介者A", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: true,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 30_000,
      } })],
    });
    const entry: IntroducerEntryEvent = {
      id: "cast-1", month, hiredAt: "2026-09-01", castId: "cast-1", castName: "花子",
      introducerId: "introducer-1", introducerName: "紹介者A", feeType: "sales10", amount: 30_000,
      createdAt: "2026-09-01T03:00:00.000Z", createdBy: "op-user",
      updatedAt: "2026-09-01T03:00:00.000Z", updatedBy: "op-user",
    };
    const result = calculateMonthlyAccounting(
      workspace({ closings: [closing] }),
      month,
      adjustments(),
      [entry],
      [],
      [introducerDeletionCommit({ linkedCastIds: [] })],
    );

    expect(result.introducerPayments[0]).toMatchObject({ entryAdvisory: 30_000 });
  });

  it("採用月後の紹介者変更で採用月の保存済み入店顧問料を上書きしない", () => {
    const current = cast({
      introducerId: "intro-b", entryAdvisoryFee: 12_000,
      updatedAt: "2026-10-05T03:00:00.000Z",
    });
    const stored: IntroducerEntryEvent = {
      id: current.id, month, hiredAt: "2026-09-01", castId: current.id, castName: current.name,
      introducerId: "intro-a", introducerName: "紹介者A", feeType: "sales10", amount: 30_000,
      createdAt: "2026-09-01T03:00:00.000Z", createdBy: "op-user",
      updatedAt: "2026-09-01T03:00:00.000Z", updatedBy: "op-user",
    };
    const result = calculateMonthlyAccounting(
      workspace({ casts: [current], introducers: [introducer({ id: "intro-b", name: "紹介者B" })] }),
      month,
      adjustments(),
      [stored],
    );

    expect(result.introducerPayments).toHaveLength(1);
    expect(result.introducerPayments[0]).toMatchObject({ introducer: "紹介者A", entryAdvisory: 30_000, total: 30_000 });
  });

  it("現存する紐づきキャストが削除commitの対象一覧から欠落していれば確定を止める", () => {
    const member = cast({ introducerId: "introducer-1" });
    const check = canFinalizeMonthlyAccounting(
      workspace({ casts: [member] }),
      month,
      adjustments(),
      false,
      [],
      [],
      [introducerDeletionCommit({ linkedCastIds: [] })],
    );

    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.some((issue) => issue.includes("対象者一覧から欠落"))).toBe(true);
  });

  it("削除月に紹介者を再設定すると再設定時snapshotを月全体へ遡及適用する", () => {
    const member = cast({ introducerId: "intro-b", attendanceAdvisoryFee: 700, entryAdvisoryFee: 12_000 });
    const closing = approvedClosing({
      submittedAt: "2026-09-10T03:00:00.000Z", submittedAtMs: 400,
      casts: [dailyCast({ honShimeiSales: 500_000, introducer: {
        id: "introducer-1", name: "削除前紹介者", feeType: "sales10", attendanceAdvisoryEnabled: true,
        entryAdvisoryEnabled: true, attendanceAdvisoryFee: 500, entryAdvisoryFee: 30_000,
      } })],
    });
    const reassigned = introducerMonthEvent({
      state: "reassigned", revision: 2, updatedAt: "2026-09-20T03:00:00.000Z", updatedAtMs: Date.parse("2026-09-20T03:00:00.000Z"), updatedBy: "op-user",
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedAtMs: Date.parse("2026-09-20T03:00:00.000Z"), reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "再設定紹介者", feeType: "gross10", attendanceAdvisoryEnabled: true,
        entryAdvisoryEnabled: true, attendanceAdvisoryFee: 700, entryAdvisoryFee: 12_000,
      },
    });
    const source = { ...workspace({ casts: [member], closings: [closing] }), introducerMonthEvents: [reassigned] };
    const result = calculateMonthlyAccounting(
      source,
      month,
      adjustments(),
      [],
      [reassigned],
      [introducerDeletionCommit()],
    );

    expect(result.castRewards[0].introducer).toMatchObject({ id: "intro-b", feeType: "gross10" });
    expect(result.introducerPayments[0]).toMatchObject({
      introducer: "再設定紹介者", feeType: "gross10", attendanceAdvisory: 700, entryAdvisory: 12_000,
    });
  });

  it("削除月より後の紹介者変更は削除月のevent・commit整合性を壊さない", () => {
    const current = cast({
      introducerId: "intro-b",
      updatedAt: "2026-10-05T03:00:00.000Z",
    });
    const deleted = introducerMonthEvent({ updatedAtMs: Date.parse("2026-09-15T03:00:00.000Z") });
    const commit = introducerDeletionCommit();
    const source = workspace({
      casts: [current],
      introducers: [introducer({ id: "intro-b", name: "紹介者B" })],
    });

    const result = calculateMonthlyAccounting(source, month, adjustments(), [], [deleted], [commit]);
    const check = canFinalizeMonthlyAccounting(source, month, adjustments(), false, [], [deleted], [commit]);

    expect(result.introducerPayments).toEqual([]);
    expect(check.allowed).toBe(true);
    expect(check.integrityIssues).toEqual([]);
  });

  it("後月の同一紹介者条件変更は過去月の再設定snapshotを同期漏れにしない", () => {
    const current = cast({
      introducerId: "intro-b", attendanceAdvisoryFee: 900,
      updatedAt: "2026-10-05T03:00:00.000Z",
    });
    const reassigned = introducerMonthEvent({
      state: "reassigned", revision: 2,
      updatedAt: "2026-09-20T03:00:00.000Z", updatedAtMs: Date.parse("2026-09-20T03:00:00.000Z"),
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedAtMs: Date.parse("2026-09-20T03:00:00.000Z"), reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B（9月）", feeType: "sales10",
        attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 500, entryAdvisoryFee: 0,
      },
    });
    const source = workspace({
      casts: [current],
      introducers: [introducer({
        id: "intro-b", name: "紹介者B（10月）", attendanceAdvisoryEnabled: true,
      })],
    });
    const check = canFinalizeMonthlyAccounting(source, month, adjustments(), false, [], [reassigned]);

    expect(check.allowed).toBe(true);
    expect(check.integrityIssues).toEqual([]);
  });

  it("再設定後に同じ紹介者を削除し個別eventが欠落しても新しい削除commitを優先する", () => {
    const member = cast({ introducerId: "intro-b" });
    const reassigned = introducerMonthEvent({
      state: "reassigned", updatedAtMs: 400, reassignedAtMs: 400,
      reassignedAt: "2026-09-10T03:00:00.000Z", reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      },
    });
    const closing = approvedClosing({
      submittedAtMs: 450,
      casts: [dailyCast({ introducer: reassigned.introducer })],
    });
    const commit = introducerDeletionCommit({
      id: "intro-b", introducerId: "intro-b", introducerName: "紹介者B", completedAtMs: 500,
    });
    const source = workspace({ casts: [member], closings: [closing] });
    const result = calculateMonthlyAccounting(source, month, adjustments(), [], [reassigned], [commit]);

    expect(result.castRewards[0].introducer).toBeUndefined();
    expect(result.introducerPayments).toEqual([]);
  });

  it("削除commitと再設定が同じサーバー時刻で競合すれば確定を止める", () => {
    const member = cast({ introducerId: "intro-b" });
    const reassigned = introducerMonthEvent({
      state: "reassigned", updatedAtMs: 500, reassignedAtMs: 500,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      },
    });
    const check = canFinalizeMonthlyAccounting(
      workspace({ casts: [member], introducers: [introducer({ id: "intro-b", name: "紹介者B" })] }),
      month,
      adjustments(),
      false,
      [],
      [reassigned],
      [introducerDeletionCommit({ id: "intro-b", introducerId: "intro-b", introducerName: "紹介者B", completedAtMs: 500 })],
    );

    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.some((issue) => issue.includes("削除・再設定が同じサーバー時刻で競合"))).toBe(true);
  });

  it("同月に紹介者A削除・B再設定・B削除が続いても古いA削除commitを誤って不整合にしない", () => {
    const member = cast({ introducerId: "intro-b" });
    const latestDeleted = introducerMonthEvent({
      state: "deleted", revision: 3, updatedAtMs: 300,
      deletedIntroducerId: "intro-b", deletedIntroducerName: "紹介者B",
      deletedAt: "2026-09-25T03:00:00.000Z", updatedAt: "2026-09-25T03:00:00.000Z",
    });
    const commitA = introducerDeletionCommit({ completedAtMs: 100 });
    const commitB = introducerDeletionCommit({
      id: "intro-b", introducerId: "intro-b", introducerName: "紹介者B", completedAtMs: 300,
    });
    const check = canFinalizeMonthlyAccounting(
      workspace({ casts: [member] }),
      month,
      adjustments(),
      false,
      [],
      [latestDeleted],
      [commitA, commitB],
    );

    expect(check.allowed).toBe(true);
    expect(check.integrityIssues).toEqual([]);
  });

  it("再設定後に保存した日次があれば、その日次条件と紹介者なしを再設定snapshotより優先する", () => {
    const member = cast({ introducerId: "intro-c" });
    const reassigned = introducerMonthEvent({
      state: "reassigned", revision: 2, updatedAt: "2026-09-20T03:00:00.000Z", updatedBy: "op-user",
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "再設定紹介者", feeType: "sales10", attendanceAdvisoryEnabled: true,
        entryAdvisoryEnabled: false, attendanceAdvisoryFee: 700, entryAdvisoryFee: 0,
      },
    });
    const afterReassignment = approvedClosing({
      submittedAt: "2026-09-21T03:00:00.000Z",
      casts: [dailyCast({ honShimeiSales: 100_000, introducer: {
        id: "intro-c", name: "後続日次の紹介者", feeType: "gross10", attendanceAdvisoryEnabled: true,
        entryAdvisoryEnabled: false, attendanceAdvisoryFee: 900, entryAdvisoryFee: 0,
      } })],
    });
    const assignedSource = { ...workspace({ casts: [member], closings: [afterReassignment] }), introducerMonthEvents: [reassigned] };
    const assigned = calculateMonthlyAccounting(assignedSource, month, adjustments());
    expect(assigned.castRewards[0].introducer).toMatchObject({ id: "intro-c", attendanceAdvisoryFee: 900 });
    expect(assigned.introducerPayments[0]).toMatchObject({ introducer: "後続日次の紹介者", attendanceAdvisory: 900 });

    const noIntroducerDay = approvedClosing({
      ...afterReassignment,
      casts: [dailyCast({ honShimeiSales: 100_000, introducer: undefined })],
    });
    const noIntroducer = calculateMonthlyAccounting(
      { ...assignedSource, closings: [noIntroducerDay] },
      month,
      adjustments(),
    );
    expect(noIntroducer.castRewards[0].introducer).toBeUndefined();
    expect(noIntroducer.introducerPayments).toEqual([]);
  });

  it("体入時の削除履歴だけが残る在籍キャストは再設定履歴が同期されるまで確定を止める", () => {
    const trial = cast({
      id: "trial-1", status: "trial", hiredAt: undefined, trialDate: "2026-09-01",
      hourlyRates: {}, trialHourlyRate: 2_000, introducerId: "introducer-1", convertedToCastId: "active-1",
    });
    const active = cast({
      id: "active-1", convertedFromTrialId: trial.id, introducerId: "intro-b",
      attendanceAdvisoryFee: 700, entryAdvisoryFee: 12_000,
    });
    const deletedOnTrial = introducerMonthEvent({
      id: trial.id, castId: trial.id, castName: trial.name, updatedAtMs: 100,
    });
    const introB = introducer({ id: "intro-b", name: "紹介者B" });
    const source = workspace({ casts: [trial, active], introducers: [introB] });

    const missingDirectEvent = canFinalizeMonthlyAccounting(source, month, adjustments(), false, [], [deletedOnTrial]);
    expect(missingDirectEvent.allowed).toBe(false);
    expect(missingDirectEvent.integrityIssues[0]).toContain("再設定履歴が同期されていません");

    const reassignedOnActive = introducerMonthEvent({
      id: active.id, castId: active.id, castName: active.name, sourceCastId: trial.id,
      state: "reassigned", revision: 1,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedBy: "op-user",
      updatedAt: "2026-09-20T03:00:00.000Z", updatedAtMs: 200, reassignedAtMs: 200,
      introducer: {
        id: introB.id, name: introB.name, feeType: introB.feeType,
        attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: true,
        attendanceAdvisoryFee: 700, entryAdvisoryFee: 12_000,
      },
    });
    const synchronized = canFinalizeMonthlyAccounting(
      source,
      month,
      adjustments(),
      false,
      [],
      [deletedOnTrial, reassignedOnActive],
    );
    expect(synchronized.allowed).toBe(true);
    expect(synchronized.integrityIssues).toEqual([]);
  });

  it("体入・在籍IDに分かれた履歴はdirect優先にせず最後のサーバー保存イベントを採用する", () => {
    const trial = cast({
      id: "trial-event", status: "trial", hiredAt: undefined, trialDate: "2026-09-01",
      hourlyRates: {}, trialHourlyRate: 2_000, convertedToCastId: "active-event",
    });
    const active = cast({
      id: "active-event", convertedFromTrialId: trial.id, introducerId: "intro-b",
    });
    const oldDirectDeleted = introducerMonthEvent({
      id: active.id, castId: active.id, castName: active.name,
      updatedAt: "2026-09-10T03:00:00.000Z", updatedAtMs: 100,
    });
    const newerTrialReassignment = introducerMonthEvent({
      id: trial.id, castId: trial.id, castName: trial.name,
      state: "reassigned", revision: 2,
      updatedAt: "2026-09-20T03:00:00.000Z", updatedAtMs: 200,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedAtMs: 200,
      reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      },
    });
    const closing = approvedClosing({
      submittedAtMs: 50,
      casts: [dailyCast({ masterId: active.id, introducer: undefined })],
    });
    const introB = introducer({ id: "intro-b", name: "紹介者B" });
    const source = workspace({ casts: [trial, active], introducers: [introB], closings: [closing] });
    const result = calculateMonthlyAccounting(
      source,
      month,
      adjustments(),
      [],
      [oldDirectDeleted, newerTrialReassignment],
    );
    const check = canFinalizeMonthlyAccounting(
      source,
      month,
      adjustments(),
      false,
      [],
      [oldDirectDeleted, newerTrialReassignment],
    );

    expect(result.castRewards[0].introducer).toMatchObject({ id: "intro-b" });
    expect(check.allowed).toBe(true);
  });

  it("再設定イベントより後のサーバー保存日次があれば現在マスタとの差より日次条件を優先する", () => {
    const member = cast({ introducerId: "intro-b" });
    const event = introducerMonthEvent({
      state: "reassigned", revision: 2,
      updatedAt: "2026-09-20T03:00:00.000Z", updatedAtMs: 200,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedAtMs: 200,
      reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      },
    });
    const laterDaily = approvedClosing({
      submittedAt: "2000-01-01T00:00:00.000Z", submittedAtMs: 300,
      casts: [dailyCast({ introducer: {
        id: "intro-c", name: "紹介者C", feeType: "gross10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const source = workspace({
      casts: [member],
      introducers: [introducer({ id: "intro-b", name: "紹介者B" })],
      closings: [laterDaily],
    });

    const check = canFinalizeMonthlyAccounting(source, month, adjustments(), false, [], [event]);
    const result = calculateMonthlyAccounting(source, month, adjustments(), [], [event]);
    expect(check.allowed).toBe(true);
    expect(result.castRewards[0].introducer).toMatchObject({ id: "intro-c" });
  });

  it("日次と有効イベントが同一サーバー時刻で異なる条件なら確定を止める", () => {
    const member = cast({ introducerId: "intro-b" });
    const event = introducerMonthEvent({
      state: "reassigned", revision: 2, updatedAtMs: 200,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedAtMs: 200,
      reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      },
    });
    const closing = approvedClosing({
      submittedAtMs: 200,
      casts: [dailyCast({ introducer: {
        id: "intro-c", name: "紹介者C", feeType: "gross10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      } })],
    });
    const check = canFinalizeMonthlyAccounting(
      workspace({ casts: [member], closings: [closing] }),
      month,
      adjustments(),
      false,
      [],
      [event],
    );

    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.some((issue) => issue.includes("同じサーバー時刻で競合"))).toBe(true);
  });

  it("出勤なし入店者でもaliasイベントが同一サーバー時刻で競合すれば確定を止める", () => {
    const trial = cast({
      id: "trial-no-work", status: "trial", hiredAt: undefined, trialDate: "2026-09-01",
      hourlyRates: {}, trialHourlyRate: 2_000, convertedToCastId: "active-no-work",
    });
    const active = cast({
      id: "active-no-work", convertedFromTrialId: trial.id, introducerId: "intro-b",
    });
    const deleted = introducerMonthEvent({
      id: trial.id, castId: trial.id, castName: trial.name, updatedAtMs: 500,
    });
    const reassigned = introducerMonthEvent({
      id: active.id, castId: active.id, castName: active.name,
      state: "reassigned", updatedAtMs: 500, reassignedAtMs: 500,
      reassignedAt: "2026-09-15T03:00:00.000Z", reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: true,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 12_000,
      },
    });
    const check = canFinalizeMonthlyAccounting(
      workspace({ casts: [trial, active] }),
      month,
      adjustments(),
      false,
      [],
      [deleted, reassigned],
    );

    expect(check.allowed).toBe(false);
    expect(check.integrityIssues.some((issue) => issue.includes("変更履歴が同じサーバー保存時刻で競合"))).toBe(true);
  });

  it("再設定履歴と現在の紹介者IDまたは紹介者マスタが一致しなければ確定を止める", () => {
    const member = cast({ introducerId: "intro-c" });
    const reassigned = introducerMonthEvent({
      state: "reassigned", revision: 2,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      },
    });
    const mismatch = canFinalizeMonthlyAccounting(
      workspace({ casts: [member], introducers: [introducer({ id: "intro-c" })] }),
      month,
      adjustments(),
      false,
      [],
      [reassigned],
    );
    expect(mismatch.allowed).toBe(false);
    expect(mismatch.integrityIssues[0]).toContain("一致しません");

    const missingMaster = canFinalizeMonthlyAccounting(
      workspace({ casts: [cast({ introducerId: "intro-b" })] }),
      month,
      adjustments(),
      false,
      [],
      [reassigned],
    );
    expect(missingMaster.allowed).toBe(false);
    expect(missingMaster.integrityIssues[0]).toContain("一致しません");
  });

  it("再設定後の日次がないまま同一紹介者の顧問料同期だけ失敗した場合も確定を止める", () => {
    const member = cast({
      introducerId: "intro-b", attendanceAdvisoryFee: 900, entryAdvisoryFee: 15_000,
      updatedAt: "2026-09-21T03:00:00.000Z",
    });
    const introB = introducer({
      id: "intro-b", name: "紹介者B", attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: true,
    });
    const reassigned = introducerMonthEvent({
      state: "reassigned", revision: 2,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedBy: "op-user",
      updatedAt: "2026-09-20T03:00:00.000Z",
      introducer: {
        id: introB.id, name: introB.name, feeType: introB.feeType,
        attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: true,
        attendanceAdvisoryFee: 700, entryAdvisoryFee: 12_000,
      },
    });
    const source = workspace({ casts: [member], introducers: [introB] });
    const stale = canFinalizeMonthlyAccounting(source, month, adjustments(), false, [], [reassigned]);
    expect(stale.allowed).toBe(false);
    expect(stale.integrityIssues[0]).toContain("紹介者条件変更");

    const synchronizedWithDifferentKeyOrder: IntroducerMonthEvent = {
      ...reassigned,
      introducer: {
        entryAdvisoryFee: 15_000,
        attendanceAdvisoryFee: 900,
        entryAdvisoryEnabled: true,
        attendanceAdvisoryEnabled: true,
        feeType: introB.feeType,
        name: introB.name,
        id: introB.id,
      },
    };
    const synchronized = canFinalizeMonthlyAccounting(
      source,
      month,
      adjustments(),
      false,
      [],
      [synchronizedWithDifferentKeyOrder],
    );
    expect(synchronized.allowed).toBe(true);

    const laterDaily = approvedClosing({
      submittedAt: "2026-09-22T03:00:00.000Z",
      casts: [dailyCast({ introducer: {
        id: introB.id, name: introB.name, feeType: "gross10",
        attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: true,
        attendanceAdvisoryFee: 800, entryAdvisoryFee: 13_000,
      } })],
    });
    const dailyWins = canFinalizeMonthlyAccounting(
      workspace({ casts: [member], introducers: [introB], closings: [laterDaily] }),
      month,
      adjustments(),
      false,
      [],
      [reassigned],
    );
    expect(dailyWins.allowed).toBe(true);
  });

  it("出勤のない同月入店者も再設定snapshotの入店顧問料を安全に計上する", () => {
    const member = cast({ introducerId: "intro-b", entryAdvisoryFee: 12_000 });
    const reassigned = introducerMonthEvent({
      state: "reassigned", revision: 2,
      reassignedAt: "2026-09-20T03:00:00.000Z", reassignedBy: "op-user",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: true,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 12_000,
      },
    });
    const result = calculateMonthlyAccounting(
      { ...workspace({ casts: [member] }), introducerMonthEvents: [reassigned] },
      month,
      adjustments(),
    );

    expect(result.introducerPayments).toHaveLength(1);
    expect(result.introducerPayments[0]).toMatchObject({
      introducer: "紹介者B", cast: member.name, entryAdvisory: 12_000, total: 12_000,
    });
  });

  it("紹介者月次イベントを検証し、source fingerprintにも反映する", async () => {
    const deleted = introducerMonthEvent();
    expect(normalizeIntroducerMonthEvent(deleted, month, "cast-1")).toEqual(deleted);
    expect(normalizeIntroducerMonthEvent({ ...deleted, revision: 0 }, month, "cast-1")).toBeUndefined();
    expect(normalizeIntroducerMonthEvent({ ...deleted, deletedAt: "zzz" }, month, "cast-1")).toBeUndefined();
    expect(normalizeIntroducerMonthEvent({ ...deleted, createdAt: "2026-09-31T03:00:00.000Z" }, month, "cast-1")).toBeUndefined();
    expect(normalizeIntroducerMonthEvent({ ...deleted, updatedAt: "2026-09-14T03:00:00.000Z" }, month, "cast-1")).toBeUndefined();
    expect(normalizeIntroducerMonthEvent({ ...deleted, updatedAtMs: -1 }, month, "cast-1")).toBeUndefined();
    expect(normalizeIntroducerMonthEvent({ ...deleted, updatedAtMs: 1.5 }, month, "cast-1")).toBeUndefined();
    expect(() => normalizeIntroducerMonthEvent({ ...deleted, updatedAtMs: Number.MAX_SAFE_INTEGER }, month, "cast-1")).not.toThrow();
    expect(normalizeIntroducerMonthEvent({ ...deleted, updatedAtMs: Number.MAX_SAFE_INTEGER }, month, "cast-1")).toBeUndefined();
    expect(normalizeIntroducerMonthEvent({
      ...deleted,
      updatedAtMs: Date.parse("2026-09-15T03:00:00.000Z"),
    }, month, "cast-1")).toBeDefined();
    expect(normalizeIntroducerMonthEvent({
      ...deleted,
      updatedAtMs: Date.parse("2026-08-15T03:00:00.000Z"),
    }, month, "cast-1")).toBeDefined();
    expect(normalizeIntroducerMonthEvent({
      ...deleted,
      updatedAt: "2026-10-01T03:00:00.000Z",
    }, month, "cast-1")).toBeUndefined();
    expect(normalizeIntroducerMonthEvent({
      ...deleted,
      state: "reassigned",
      introducer: {
        id: "intro-b", name: "紹介者B", feeType: "sales10",
        attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false,
        attendanceAdvisoryFee: 0, entryAdvisoryFee: 0,
      },
      reassignedAt: "zzz",
      reassignedBy: "op-user",
    }, month, "cast-1")).toBeUndefined();
    const source = workspace();
    const withoutEvent = await monthlySourceFingerprint(source, month, adjustments(), [], []);
    const withEvent = await monthlySourceFingerprint({ ...source, introducerMonthEvents: [deleted] }, month, adjustments(), []);
    expect(withEvent).not.toBe(withoutEvent);

    const storedCommit = {
      ...introducerDeletionCommit(),
      linkedCastIds: { "cast-1": true },
    };
    expect(normalizeIntroducerDeletionCommit(storedCommit, "introducer-1")).toMatchObject({
      linkedCastIds: ["cast-1"],
    });
    expect(normalizeIntroducerDeletionCommit({ ...storedCommit, completedAt: "zzz" }, "introducer-1")).toBeUndefined();
    expect(normalizeIntroducerDeletionCommit({ ...storedCommit, completedAtMs: -1 }, "introducer-1")).toBeUndefined();
    expect(() => normalizeIntroducerDeletionCommit({ ...storedCommit, deletedAtMs: Number.MAX_SAFE_INTEGER }, "introducer-1")).not.toThrow();
    expect(normalizeIntroducerDeletionCommit({ ...storedCommit, deletedAtMs: Number.MAX_SAFE_INTEGER }, "introducer-1")).toBeUndefined();
    expect(normalizeIntroducerDeletionCommit({ ...storedCommit, linkedCastIds: "cast-1" }, "introducer-1")).toBeUndefined();
    const withCommit = await monthlySourceFingerprint(
      { ...source, introducerDeletionCommits: [introducerDeletionCommit()] },
      month,
      adjustments(),
    );
    expect(withCommit).not.toBe(withoutEvent);
  });
});
