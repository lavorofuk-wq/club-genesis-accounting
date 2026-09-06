import { describe, expect, it } from "vitest";
import type { CastRecord, DailyCast, DailyClosing, DailyStaffWork, MonthlyAdjustments, StaffRecord, WorkspaceData } from "./gms";
import { calculateMonthlyAccounting } from "./month-accounting";
import { allocateBalancePayroll, type BalancePayrollAllocationInput } from "./balance-allocation";

const month = "2026-09";

function cast(overrides: Partial<DailyCast> = {}): DailyCast {
  return { masterId: "cast-1", posCastId: "pos-1", name: "花子", kind: "regular", startTime: "20:00", endTime: "00:00",
    hours: 4, hourlyRate: 3_000, honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
    honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0, ...overrides };
}

function staffWork(overrides: Partial<DailyStaffWork> = {}): DailyStaffWork {
  return { staffId: "staff-1", name: "従業員", kind: "regular", startTime: "20:00", endTime: "00:00",
    hours: 4, hourlyRate: 1_500, dailyPayment: 0, ...overrides };
}

function closing(day: number, overrides: Partial<DailyClosing> = {}): DailyClosing {
  return { id: `day-${day}`, businessDate: `${month}-${String(day).padStart(2, "0")}`, status: "approved",
    submissionId: `submission-${day}`, checksum: "a".repeat(64), updatedAt: "2026-09-30T12:00:00Z",
    sales: { cashSales: 0, cardSales: 0, totalSales: 0 }, customers: { groupCount: 0, totalCustomers: 0 },
    nominations: { honShimeiCount: 0, jonaiCount: 0 }, casts: [], staffWork: [], drivers: [], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200_000, expenseAndPaymentTotal: 0,
      expectedClosingCash: 200_000, cashProfit: 0, actualClosingCash: 200_000, difference: 0 },
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"], ...overrides };
}

function master(overrides: Partial<CastRecord> = {}): CastRecord {
  return { id: "cast-1", name: "花子", legalName: "", status: "active", hiredAt: `${month}-01`,
    hourlyRates: { [month]: 3_000 }, note: "", createdAt: "", updatedAt: "", ...overrides };
}

function staffMaster(overrides: Partial<StaffRecord> = {}): StaffRecord {
  return { id: "staff-1", name: "従業員", status: "active", hiredAt: `${month}-02`, hourlyRate: 1_500,
    note: "", createdAt: "", updatedAt: "", ...overrides };
}

function fixture(closings: DailyClosing[], options: {
  casts?: CastRecord[]; staff?: StaffRecord[]; archivedStaff?: StaffRecord[]; adjustments?: Partial<MonthlyAdjustments>;
} = {}): BalancePayrollAllocationInput {
  const adjustments: MonthlyAdjustments = { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {},
    driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0, ...options.adjustments };
  const data: WorkspaceData & { archivedStaff?: StaffRecord[] } = { casts: options.casts || [], staff: options.staff || [],
    archivedStaff: options.archivedStaff, drivers: [], introducers: [], liquor: [], closings, adjustments: [adjustments], cashFloat: 200_000 };
  return { results: calculateMonthlyAccounting(data, month, adjustments), closings, month,
    staff: options.staff, archivedStaff: options.archivedStaff };
}

describe("収支表の日別給与配分", () => {
  it("給与のない月は空、未承認・差戻し・他月は対象外にする", () => {
    expect(allocateBalancePayroll(fixture([]))).toEqual({ byDate: [] });
    const input = fixture([closing(2), closing(1), closing(3, { status: "returned" }), closing(4, { status: "submitted" }),
      closing(5, { businessDate: "2026-08-05" })]);
    expect(allocateBalancePayroll(input).byDate).toEqual([
      { businessDate: "2026-09-01", castHourly: 0, castSalesReward: 0, employeeGross: 0 },
      { businessDate: "2026-09-02", castHourly: 0, castSalesReward: 0, employeeGross: 0 },
    ]);
  });

  it("月間変更後の時給報酬を時間比で配分し、バックと美容室手当は発生日に計上する", () => {
    const input = fixture([
      closing(2, { casts: [cast({ hours: 2, hourlyRate: 1_000, banaiShimeiCount: 1, beautyAllowance: 500 })] }),
      closing(1, { casts: [cast({ hours: 4, hourlyRate: 1_000, honShimeiCount: 2, dohanCount: 1, dohanBack: 3_000 })] }),
    ], { casts: [master({ hourlyRates: { [month]: 3_007 } })] });
    // 月額18,040円を4:2で12,020円・6,020円へ配分。日次の旧時給へ戻さない。
    expect(allocateBalancePayroll(input).byDate.map((day) => day.castHourly)).toEqual([17_020, 7_020]);
    expect(input.results.castRewards[0].grossPay).toBe(24_040);
  });

  it("日別売上比で月額の売上報酬を配分し、採用されない時給・バックは加算しない", () => {
    const input = fixture([
      closing(1, { casts: [cast({ honShimeiSales: 600_010, honShimeiCount: 3 })] }),
      closing(4, { casts: [cast({ jonaiExtensionSales: 610_010, beautyAllowance: 500 })] }),
      closing(5),
    ]);
    const reward = input.results.castRewards[0];
    expect(reward.adoptedSystem).toBe("salesReward");
    const expectedFirst = Math.floor(reward.salesReward * 600_010 / 1_210_020 / 10) * 10;
    const output = allocateBalancePayroll(input).byDate;
    expect(output.map((day) => day.castHourly)).toEqual([0, 0, 0]);
    expect(output.map((day) => day.castSalesReward)).toEqual([expectedFirst, reward.salesReward - expectedFirst + 500, 0]);
  });

  it("同月体入→在籍は保存済みの統合報酬で配分し、体入の美容室経費を二重加算しない", () => {
    const trial = cast({ masterId: "trial-1", kind: "trial", hourlyRate: 1_500, honShimeiCount: 1, dailyPayment: 6_000 });
    const input = fixture([
      closing(1, { casts: [trial], expenses: [{ id: "beauty", category: "beautyTrial", payee: "花子", personId: "trial-1", amount: 500 }] }),
      closing(2, { casts: [cast({ beautyAllowance: 500 })] }),
    ], { casts: [master({ convertedFromTrialId: "trial-1", hiredAt: `${month}-02` })] });
    expect(input.results.castSalesReports[0].totals.beautyAllowance).toBe(1_000);
    expect(input.results.castRewards[0].beautyAllowance).toBe(500);
    const output = allocateBalancePayroll(input).byDate;
    // 体入と在籍の時給が違っても、確認済みの月額×時間比を使う。
    expect(output.map((day) => day.castHourly)).toEqual([10_000, 9_500]);
    expect(output.reduce((sum, day) => sum + day.castHourly, 0)).toBe(input.results.castRewards[0].grossPay);
  });

  it("体入のみは各日の体入時給額を維持し、保存月額との端数差だけ最終出勤日に置く", () => {
    const input = fixture([
      closing(1, { casts: [cast({ kind: "trial", hours: 4.25, hourlyRate: 2_007, dailyPayment: 8_520, honShimeiCount: 1 })] }),
      closing(2, { casts: [cast({ kind: "trial", hours: 4.25, hourlyRate: 3_007, dailyPayment: 12_770 })] }),
    ]);
    const reward = input.results.castRewards[0];
    expect(reward.trialOnly).toBe(true);
    expect(reward.hourlyPay).toBe(21_300);
    expect(allocateBalancePayroll(input).byDate.map((day) => day.castHourly)).toEqual([8_520, 12_780]);
  });

  it("旧100円単位の体入月額を維持し、保存時給の改変を端数調整で隠さない", () => {
    const input = fixture([closing(1, { casts: [cast({ kind: "trial", hours: 4.25, hourlyRate: 2_007 })] })]);
    const reward = input.results.castRewards[0];
    reward.hourlyPay = reward.hourlyAndBack = reward.adoptedReward = reward.grossPay = reward.netPay = 8_500;
    expect(allocateBalancePayroll(input).byDate[0].castHourly).toBe(8_500);
    input.closings[0].casts[0].hourlyRate += 1_000;
    expect(() => allocateBalancePayroll(input)).toThrow("端数差として配分できません");
  });

  it("旧確定データの1円単位月額・バックを新ルールで丸め直さない", () => {
    const input = fixture([closing(1, { casts: [cast()] }), closing(3, { casts: [cast()] })]);
    const reward = input.results.castRewards[0];
    reward.hourlyPay = 24_003;
    reward.bottleBack = 333;
    reward.hourlyAndBack = reward.adoptedReward = reward.grossPay = reward.netPay = 24_336;
    const report = input.results.castSalesReports[0];
    report.days[0].backs.find((back) => back.key === "bottle")!.amount = 333;
    report.days[0].backTotal = 333;
    report.totals.backs.find((back) => back.key === "bottle")!.amount = 333;
    report.totals.backTotal = 333;
    const before = structuredClone(input);
    expect(allocateBalancePayroll(input).byDate.map((day) => day.castHourly)).toEqual([12_333, 12_003]);
    expect(input).toEqual(before);
  });

  it("スタッフの日次生値・ドライバー日給を使用し、手当と端数は各本人の最終出勤日に置く", () => {
    const input = fixture([
      closing(1, { staffWork: [staffWork({ hours: 4.25, hourlyRate: 1_507, dailyPayment: 3_000 })],
        drivers: [{ driverId: "driver-1", name: "運転手", dailyRate: 5_000, dailyPayment: 2_000 }], dispatchStaffPayment: 99_999 }),
      closing(2, { staffWork: [staffWork({ hours: 2.25, hourlyRate: 1_607 })] }),
      closing(3, { drivers: [{ driverId: "driver-1", name: "運転手", dailyRate: 6_000, dailyPayment: 0 }] }),
      closing(4),
    ], { adjustments: { staffSalesAllowance: { "staff-1": 400 }, staffBottleAllowance: { "staff-1": 200 }, driverRemoteAllowance: { "driver-1": 1_000 } } });
    const output = allocateBalancePayroll(input).byDate;
    expect(output.map((day) => day.employeeGross)).toEqual([11_404.75, 4_195.25, 7_000, 0]);
    expect(output.reduce((sum, day) => sum + day.employeeGross, 0)).toBe(22_600);
  });

  it("同月体入→在籍スタッフは明示IDのみを使い、退店・削除済みアーカイブでも配分できる", () => {
    const staff = staffMaster({ convertedFromTrialId: "trial-staff", hourlyRate: 2_000 });
    const input = fixture([
      closing(1, { staffWork: [staffWork({ staffId: "trial-staff", kind: "trial", dailyPayment: 6_000 })] }),
      closing(2, { staffWork: [staffWork({ hourlyRate: 2_000 })] }),
    ], { archivedStaff: [staff], adjustments: { staffSalesAllowance: { "staff-1": 1_000 } } });
    expect(allocateBalancePayroll(input).byDate.map((day) => day.employeeGross)).toEqual([6_000, 9_000]);
    input.archivedStaff = [];
    expect(() => allocateBalancePayroll(input)).toThrow("体入・在籍スタッフID");
  });

  it("月次確定後の同名マスタ・別の時給を給与へ適用しない", () => {
    const input = fixture([closing(1, { staffWork: [staffWork()], casts: [cast()] })]);
    input.staff = [staffMaster({ id: "other-staff", hourlyRate: 99_999, name: "従業員" })];
    expect(allocateBalancePayroll(input).byDate[0]).toMatchObject({ castHourly: 12_000, employeeGross: 6_000 });
  });

  it("在籍スタッフが物理削除済みでも体入の明示変換先が同月regular勤務にあれば復元できる", () => {
    const trial = staffMaster({ id: "trial-staff", status: "trial", convertedToStaffId: "staff-1" });
    const input = fixture([
      closing(1, { staffWork: [staffWork({ staffId: trial.id, kind: "trial" })] }),
      closing(2, { staffWork: [staffWork()] }),
    ], { staff: [trial] });
    expect(allocateBalancePayroll(input).byDate.map((day) => day.employeeGross)).toEqual([6_000, 6_000]);
  });

  it("同じ体入IDに複数の在籍先が保存されている場合は推測せず停止する", () => {
    const active = staffMaster({ convertedFromTrialId: "trial-staff" });
    const other = staffMaster({ id: "other-staff", convertedFromTrialId: "trial-staff" });
    const input = fixture([
      closing(1, { staffWork: [staffWork({ staffId: "trial-staff", kind: "trial" })] }),
      closing(2, { staffWork: [staffWork(), staffWork({ staffId: "other-staff" })] }),
    ], { staff: [active] });
    input.staff = [active, other];
    expect(() => allocateBalancePayroll(input)).toThrow("一意に確認できません");
  });

  it("保存済みドライバー日給の不一致・同日の重複を検出する", () => {
    const input = fixture([closing(1, { drivers: [{ driverId: "driver", name: "運転手", dailyRate: 5_000, dailyPayment: 1_000 }] })]);
    input.closings[0].drivers[0].dailyRate += 100;
    expect(() => allocateBalancePayroll(input)).toThrow("ドライバー基本給与");
    input.closings[0].drivers[0].dailyRate -= 100;
    input.closings[0].drivers.push({ ...input.closings[0].drivers[0] });
    expect(() => allocateBalancePayroll(input)).toThrow("重複");
  });

  it("後月の在籍化マスタで過去の体入月の人物IDを置き換えない", () => {
    const input = fixture([closing(1, { staffWork: [staffWork({ staffId: "trial-staff", kind: "trial" })] })]);
    input.staff = [staffMaster({ convertedFromTrialId: "trial-staff", hiredAt: "2026-10-01" })];
    expect(allocateBalancePayroll(input).byDate[0].employeeGross).toBe(6_000);
  });

  it("勤務なしの手当行は勝手に月末へ置かず最終出勤日不明で停止する", () => {
    const input = fixture([closing(1)]);
    input.results.staffPayroll.push({ id: "staff-1", name: "従業員", hours: 0, hourly: 0, sales: 1_000, bottle: 0, gross: 1_000, daily: 0, net: 1_000 });
    expect(() => allocateBalancePayroll(input)).toThrow("最終出勤日がありません");
  });

  it("日次の変更で保存済みスタッフ月額・日払いと一致しなければ停止する", () => {
    const input = fixture([closing(1, { staffWork: [staffWork()] })]);
    input.closings[0].staffWork[0].hourlyRate += 100;
    expect(() => allocateBalancePayroll(input)).toThrow("月間基本給与");
    input.closings[0].staffWork[0].hourlyRate -= 100;
    input.closings[0].staffWork[0].dailyPayment += 10;
    expect(() => allocateBalancePayroll(input)).toThrow("日払い合計");
  });

  it("保存済み美容室のIDが復元不能なら名前で推測しない", () => {
    const input = fixture([closing(1, { casts: [cast({ beautyAllowance: 500 })] })]);
    input.closings[0].casts[0].masterId = "same-name-other-id";
    expect(() => allocateBalancePayroll(input)).toThrow("保存ID確認が必要");
  });

  it("報酬と日別バック・ID・営業日の不一致を残差で隠さない", () => {
    const input = fixture([closing(1, { casts: [cast({ honShimeiCount: 1 })] })]);
    input.results.castSalesReports[0].days[0].backs[0].amount += 10;
    expect(() => allocateBalancePayroll(input)).toThrow("バック合計");
    input.results.castSalesReports[0].days[0].backs[0].amount -= 10;
    input.results.castSalesReports[0].id = "wrong-id";
    expect(() => allocateBalancePayroll(input)).toThrow("人物ID");
    input.results.castSalesReports[0].id = "cast-1";
    input.closings.push(closing(1));
    expect(() => allocateBalancePayroll(input)).toThrow("重複");
  });

  it("配分基準ゼロで月額が正の場合は停止する", () => {
    const input = fixture([closing(1, { casts: [cast({ hours: 0 })] })]);
    const reward = input.results.castRewards[0];
    reward.hourlyPay = reward.hourlyAndBack = reward.adoptedReward = reward.grossPay = 10;
    expect(() => allocateBalancePayroll(input)).toThrow("配分基準が0");
  });
});
