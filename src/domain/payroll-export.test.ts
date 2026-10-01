import { describe, expect, it } from "vitest";
import type { DailyClosing, DailyStaffWork, MonthlyAdjustments, StaffRecord, WorkspaceData } from "./gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting } from "./month-accounting";
import { buildDriverPaymentExport, buildStaffPaymentExport, type PayrollExportInput } from "./payroll-export";

const month = "2026-09";
const adjustments: MonthlyAdjustments = { month, withholdingByCast: {}, staffSalesAllowance: { staff: 101 },
  staffBottleAllowance: { staff: 202 }, driverRemoteAllowance: { driver: 303 }, fixedExpenses: [], cardFee: 0 };
function work(overrides: Partial<DailyStaffWork> = {}): DailyStaffWork {
  return { staffId: "staff", name: "中村", kind: "regular", startTime: "20:00", endTime: "22:15", hours: 2.25,
    hourlyRate: 1500, dailyPayment: 1000, ...overrides };
}
function master(overrides: Partial<StaffRecord> = {}): StaffRecord {
  return { id: "staff", name: "中村", status: "active", hiredAt: `${month}-01`, hourlyRates: { [month]: 1401 }, note: "",
    createdAt: "", updatedAt: "", ...overrides };
}
function closing(day: number, overrides: Partial<DailyClosing> = {}): DailyClosing {
  const result: DailyClosing = { id: `closing-${day}`, businessDate: `${month}-${String(day).padStart(2, "0")}`, status: "approved",
    submissionId: `submission-${day}`, checksum: "a".repeat(64), updatedAt: "2026-09-30T12:00:00.000Z",
    sales: { cashSales: 0, cardSales: 0, totalSales: 0 }, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [], staffWork: [work()], drivers: [{ driverId: "driver", name: "送迎太郎", dailyRate: 5000, dailyPayment: 1000 }], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000,
      cashProfit: 0, actualClosingCash: 200000, difference: 0 }, posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"], ...overrides };
  result.staffDailyPaymentTotal = result.staffWork.reduce((sum, row) => sum + row.dailyPayment, 0); return result;
}
function fixture(closings = [closing(1), closing(2)], staff = [master()]): PayrollExportInput {
  const data: WorkspaceData = { casts: [], staff, drivers: [], introducers: [], liquor: [], closings, adjustments: [adjustments], cashFloat: 200000 };
  return { results: calculateMonthlyAccounting(data, month, adjustments), closings, staff, month };
}
function frozen(input = fixture()): PayrollExportInput {
  input.snapshot = buildMonthlySnapshot(month, 1, "fingerprint", adjustments, structuredClone(input.results), input.closings, "accounting", "2026-10-01T01:00:00.000Z"); return input;
}
function legacy(input = frozen()): PayrollExportInput {
  input.snapshot!.schemaVersion = 2; input.snapshot!.calculationVersion = "2.19.0";
  input.results.staffPayroll.forEach((row) => { delete row.hourlyByDay; delete row.hourlySources; });
  input.snapshot!.staffPayroll = structuredClone(input.results.staffPayroll); return input;
}

describe("スタッフ支払XLSXの保存値・日次照合", () => {
  it("日ごとの1円切捨て、月次手当・日払い・差引を変更せず出力する", () => {
    const input = fixture(); const before = JSON.stringify(input);
    expect(buildStaffPaymentExport(input)).toEqual({ month, rows: [{ id: "staff", name: "中村", group: "regular", hours: 4.5,
      hourly: 6304, sales: 101, bottle: 202, gross: 6607, daily: 2000, net: 4607, appliedHourlyRates: [1401],
      days: [{ businessDate: `${month}-01`, hours: 2.25, amount: 3152, dailyPayment: 1000 },
        { businessDate: `${month}-02`, hours: 2.25, amount: 3152, dailyPayment: 1000 }], missingDetails: [] }] });
    expect(JSON.stringify(input)).toBe(before);
  });
  it("体入と在籍を分け、同名でもIDで別人として保持する", () => {
    const input = fixture([closing(1, { staffWork: [work(), work({ staffId: "trial", kind: "trial", hourlyRate: 1301, dailyPayment: 2927 })] })]);
    const rows = buildStaffPaymentExport(input).rows;
    expect(rows.map((row) => [row.id, row.name, row.group, row.hourly])).toEqual([["staff", "中村", "regular", 3152], ["trial", "中村", "trial", 2927]]);
  });
  it("同月入店の体入分を保存された時給計算基準に従い在籍へ合算する", () => {
    const input = fixture([closing(1, { staffWork: [work({ staffId: "trial", kind: "trial", hourlyRate: 1301, dailyPayment: 2927 })] }), closing(2)],
      [master({ convertedFromTrialId: "trial", hiredAt: `${month}-02` })]);
    const row = buildStaffPaymentExport(input).rows[0];
    expect(row.group).toBe("regular"); expect(row.appliedHourlyRates).toEqual([1301, 1401]);
    expect(row.days?.map((day) => [day.amount, day.dailyPayment])).toEqual([[2927, 2927], [3152, 1000]]);
    const saved = frozen(input); saved.staff = []; saved.archivedStaff = [];
    expect(buildStaffPaymentExport(saved).rows).toEqual([row]);
  });
  it("体入勤務のみでも同月入店による統合IDなら在籍側へ掲載する", () => {
    const input = fixture([closing(1, { staffWork: [work({ staffId: "trial", kind: "trial" })] })],
      [master({ convertedFromTrialId: "trial", hiredAt: `${month}-02` })]);
    expect(buildStaffPaymentExport(input).rows[0].group).toBe("regular");
  });
  it("承認済み対象月以外を除外し、給与以外の警告は遮断条件にしない", () => {
    const input = fixture([closing(1), closing(2, { status: "returned" }), closing(3, { status: "submitted" }), closing(4, { businessDate: "2026-08-04" })]);
    input.results.warnings = ["キャストの時給が未設定です", "現金補充が未確認です"];
    expect(buildStaffPaymentExport(input).rows[0].days).toHaveLength(1);
  });
  it("未確定月の古い月度時給集計は拒否、確定月は現在マスタ変更に影響されない", () => {
    const input = fixture(); input.staff![0].hourlyRates![month] = 1600;
    expect(() => buildStaffPaymentExport(input)).toThrow(/適用時給/);
    expect(buildStaffPaymentExport(frozen(input)).rows[0].hourly).toBe(6304);
  });
  it.each(["checksum", "updatedAt", "id"] as const)("確定原本の%sが変わった日は日払いだけ未保存とし保存日額を残す", (field) => {
    const input = frozen(); input.closings[0][field] = "different";
    const row = buildStaffPaymentExport(input).rows[0];
    expect(row.days?.[0]).toEqual({ businessDate: `${month}-01`, hours: 2.25, amount: 3152 });
    expect(row.days?.[1].dailyPayment).toBe(1000); expect(row.daily).toBe(2000); expect(row.missingDetails.join(" ")).toContain("日払い");
  });
  it("原本がすべてなくても新確定に保存された日別時給は保持する", () => {
    const input = frozen(); input.closings = [];
    expect(buildStaffPaymentExport(input).rows[0].days?.map((day) => [day.amount, day.dailyPayment])).toEqual([[3152, undefined], [3152, undefined]]);
  });
  it("確定参照が全て揃っているのに保存内訳の日付が原本にない場合は拒否する", () => {
    const input = frozen(); input.results.staffPayroll[0].hourlySources![0].businessDate = `${month}-03`;
    input.results.staffPayroll[0].hourlyByDay![0].businessDate = `${month}-03`;
    input.snapshot!.staffPayroll = structuredClone(input.results.staffPayroll);
    expect(() => buildStaffPaymentExport(input)).toThrow();
  });
  it("原本が一部欠けていても既知の日払いが月額を超えれば拒否する", () => {
    const input = frozen(); input.closings.pop(); input.closings[0].staffWork[0].dailyPayment = 3000;
    input.closings[0].staffDailyPaymentTotal = 3000; expect(() => buildStaffPaymentExport(input)).toThrow(/月額を超え/);
  });
  it("旧確定の時給日別がなければ月額を配分せず時間・支払原本だけを載せる", () => {
    const input = legacy(); const row = buildStaffPaymentExport(input).rows[0];
    expect(row.group).toBe("unknown"); expect(row.hourly).toBe(6304); expect(row.appliedHourlyRates).toBeUndefined();
    expect(row.days?.[0]).toEqual({ businessDate: `${month}-01`, hours: 2.25, dailyPayment: 1000 });
    expect(row.missingDetails).toContain("基本給与");
  });
  it("旧確定で原本がない場合は日別をundefinedとし月額だけを保持する", () => {
    const input = legacy(); input.closings = [];
    const row = buildStaffPaymentExport(input).rows[0]; expect(row.days).toBeUndefined(); expect(row.hourly).toBe(6304); expect(row.daily).toBe(2000);
  });
  it("旧確定の体入在籍対応を現在マスタから推測しない", () => {
    const input = legacy(frozen(fixture([closing(1, { staffWork: [work({ staffId: "trial", kind: "trial" })] }), closing(2)],
      [master({ convertedFromTrialId: "trial", hiredAt: `${month}-02` })])));
    const row = buildStaffPaymentExport(input).rows[0]; expect(row.group).toBe("unknown"); expect(row.days).toBeUndefined(); expect(row.daily).toBe(2000);
  });
  it("時給計算基準未保存の1円日別確定は保存日額と原本を照合する", () => {
    const input = frozen(fixture(undefined, [master({ hourlyRates: { [month]: 1500 } })]));
    input.snapshot!.calculationVersion = "2.24.0"; delete input.results.staffPayroll[0].hourlySources;
    input.snapshot!.staffPayroll = structuredClone(input.results.staffPayroll);
    expect(buildStaffPaymentExport(input).rows[0].days?.[0]).toEqual({ businessDate: `${month}-01`, hours: 2.25, amount: 3375, dailyPayment: 1000 });
  });
  it("保存済みの小数日払い・負の差引支給を丸めず維持する", () => {
    const input = fixture([closing(1, { staffWork: [work({ dailyPayment: 9999.5 })] })]);
    const row = buildStaffPaymentExport(input).rows[0]; expect(row.daily).toBe(9999.5); expect(row.days?.[0].dailyPayment).toBe(9999.5); expect(row.net).toBe(-6544.5);
  });
  const corruption: Array<[string, (input: PayrollExportInput) => void]> = [
    ["総支給", (input) => { input.results.staffPayroll[0].gross += 1; }],
    ["差引支給", (input) => { input.results.staffPayroll[0].net += 1; }],
    ["日額", (input) => { input.results.staffPayroll[0].hourlyByDay![0].amount += 1; }],
    ["保存日払い月額", (input) => { input.results.staffPayroll[0].daily += 1; input.results.staffPayroll[0].net -= 1; }],
    ["原本日払い合計", (input) => { input.closings[0].staffDailyPaymentTotal += 1; }],
    ["原本勤務時間", (input) => { input.closings[0].staffWork[0].hours += .25; }],
    ["原本出退勤時刻", (input) => { input.closings[0].staffWork[0].endTime = "23:15"; }],
    ["原本区分", (input) => { input.closings[0].staffWork[0].kind = "trial"; }],
    ["計算基準の時給", (input) => { input.results.staffPayroll[0].hourlySources![0].hourlyRate += 1; }],
    ["計算基準重複", (input) => { input.results.staffPayroll[0].hourlySources!.push({ ...input.results.staffPayroll[0].hourlySources![0] }); }],
    ["新形式の計算基準欠損", (input) => { delete input.results.staffPayroll[0].hourlySources; }],
    ["新形式の日別欠損", (input) => { delete input.results.staffPayroll[0].hourlyByDay; }],
    ["原本ID重複", (input) => { input.closings[0].staffWork.push({ ...input.closings[0].staffWork[0] }); }],
    ["給与ID重複", (input) => { input.results.staffPayroll.push({ ...input.results.staffPayroll[0] }); }],
    ["不正営業日", (input) => { input.closings[0].businessDate = "2026-09-31"; }],
    ["承認日数", (input) => { input.results.approvedDays += 1; }],
    ["無限金額", (input) => { input.results.staffPayroll[0].sales = Infinity; }],
    ["疎な内訳配列", (input) => { delete input.results.staffPayroll[0].hourlyByDay![0]; }],
    ["新しい不明勤務", (input) => { input.closings[0].staffWork.push(work({ staffId: "other" })); }],
  ];
  it.each(corruption)("不整合を空欄で隠さず拒否する：%s", (_, corrupt) => { const input = fixture(); corrupt(input); expect(() => buildStaffPaymentExport(input)).toThrow(); });
  it("確定給与と表示結果の違いは拒否する", () => {
    const input = frozen(); input.results.staffPayroll[0].name = "別人";
    expect(() => buildStaffPaymentExport(input)).toThrow(/確定時/);
  });
  it("空対象は出力しない", () => { expect(() => buildStaffPaymentExport(fixture([]))).toThrow(/出力対象/); });
});

describe("ドライバー支払XLSXの保存値・日次照合", () => {
  it("日給・遠方手当・日払い・差引を保存値のまま出力する", () => {
    const input = fixture(); const before = JSON.stringify(input);
    expect(buildDriverPaymentExport(input)).toEqual({ month, rows: [{ id: "driver", name: "送迎太郎", daysCount: 2, basic: 10000,
      remote: 303, gross: 10303, dailyPayment: 2000, net: 8303,
      days: [{ businessDate: `${month}-01`, amount: 5000 }, { businessDate: `${month}-02`, amount: 5000 }], missingDetails: [] }] });
    expect(JSON.stringify(input)).toBe(before);
  });
  it("確定時の原本が一部欠損したら日別を推定せず月額を保持する", () => {
    const input = frozen(); input.closings.pop(); const row = buildDriverPaymentExport(input).rows[0];
    expect(row.days).toBeUndefined(); expect(row.basic).toBe(10000); expect(row.dailyPayment).toBe(2000); expect(row.missingDetails).toContain("基本給与");
  });
  it("原本が一部欠けていても既知の基本給与が月額を超えれば拒否する", () => {
    const input = frozen(); input.closings.pop(); input.closings[0].drivers[0].dailyRate = 12000;
    expect(() => buildDriverPaymentExport(input)).toThrow(/月額・日数を超え/);
  });
  it.each(["checksum", "updatedAt", "id"] as const)("確定原本の%s不一致でも月額は変更しない", (field) => {
    const input = frozen(); input.closings[0][field] = "changed";
    expect(buildDriverPaymentExport(input).rows[0].days).toBeUndefined();
  });
  it("差戻し・他月は除外する", () => {
    const input = fixture([closing(1), closing(2, { status: "returned" }), closing(3, { businessDate: "2026-08-03" })]);
    expect(buildDriverPaymentExport(input).rows[0].daysCount).toBe(1);
  });
  it.each(["basic", "remote", "gross", "dailyPayment", "net", "days"] as const)("給与の%s不一致を拒否する", (field) => {
    const input = fixture(); input.results.driverPayroll[0][field] += 1;
    expect(() => buildDriverPaymentExport(input)).toThrow();
  });
  it("原本日給の違いを拒否する", () => { const input = fixture(); input.closings[0].drivers[0].dailyRate += 1; expect(() => buildDriverPaymentExport(input)).toThrow(/基本給与合計/); });
  it("重複勤務を拒否する", () => { const input = fixture(); input.closings[0].drivers.push({ ...input.closings[0].drivers[0] }); expect(() => buildDriverPaymentExport(input)).toThrow(/重複/); });
  it("保存日払い小数・負の差引支給をそのまま出力する", () => {
    const input = fixture([closing(1, { drivers: [{ driverId: "driver", name: "送迎太郎", dailyRate: 5000, dailyPayment: 9000.5 }] })]);
    const row = buildDriverPaymentExport(input).rows[0]; expect(row.dailyPayment).toBe(9000.5); expect(row.net).toBe(-3697.5);
  });
  it("空対象は出力しない", () => { expect(() => buildDriverPaymentExport(fixture([]))).toThrow(/出力対象/); });
});
