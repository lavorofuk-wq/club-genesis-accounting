import { describe, expect, it } from "vitest";
import { calculateCastRewards, calculateCastSalesReports, calculateDriverPayroll, type CastAccountingInput, type CastRecord, type DailyCast, type DailyClosing, type MonthlyAdjustments, type WorkspaceData } from "./gms";
import { applyTransport, normalizeTransportMonth, normalizeTransportSettings, transportAttendance, transportCastDays, transportUnresolvedLegacyInputs, type CastTransportDay } from "./transport";

const month = "2026-09";
const cast: CastRecord = { id: "cast-1", name: "花子", legalName: "花子", status: "active", hourlyRates: { [month]: 3000 }, note: "", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
function dailyCast(overrides: Partial<DailyCast> = {}): DailyCast {
  return { masterId: cast.id, posCastId: "pos-1", name: cast.name, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000,
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [],
    bottles: [], liquorCost: 0, beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 500, ...overrides };
}
function closing(day = "02", overrides: Partial<DailyClosing> = {}): DailyClosing {
  return { id: `closing-${day}`, businessDate: `${month}-${day}`, status: "approved", casts: [dailyCast()], drivers: [{ driverId: "driver-1", name: "太郎", dailyRate: 10000, dailyPayment: 0 }], expenses: [], ...overrides } as DailyClosing;
}
function adjustments(castInputs: CastAccountingInput[] = []): MonthlyAdjustments {
  return { month, castInputs, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: { "driver-1": 7500 }, fixedExpenses: [], cardFee: 0 };
}
function legacy(id: string, businessDate?: string): CastAccountingInput {
  return { id, castId: cast.id, castName: cast.name, kind: "transport", label: "旧送迎", amount: 1000, ...(businessDate ? { businessDate } : {}) };
}
function workspace(closings = [closing()], settings = adjustments()): WorkspaceData {
  return { casts: [cast], staff: [], drivers: [], introducers: [], liquor: [], closings, adjustments: [settings], cashFloat: 0 };
}
function record(amount: number, ids: string[] = [], day = "02"): CastTransportDay {
  return { amount, legacyInputIds: ids, attendanceClosingId: `closing-${day}`, attendanceIndex: 0 };
}
function withRecord(data: WorkspaceData, value: CastTransportDay, day = "02") {
  data.transportMonths = { [month]: { revision: 1, casts: { [cast.id]: { [`${month}-${day}`]: value } }, drivers: {} } };
  return data;
}
function reward(data: WorkspaceData, settings = data.adjustments[0]) {
  const applied = applyTransport(data, month, settings);
  return { applied, rewards: calculateCastRewards(applied.closings, data.casts, month, applied.adjustments),
    sales: calculateCastSalesReports(applied.closings, data.casts, month, applied.adjustments) };
}

describe("送迎の保存形式と出勤日", () => {
  it("Firebaseの空map・配列表現を復元する", () => {
    expect(normalizeTransportSettings(null)).toEqual({ revision: 0, castRegistrations: {}, remoteAmounts: [] });
    expect(normalizeTransportSettings({ revision: 2, castRegistrations: { [cast.id]: { amounts: { 0: 1500, 1: 500 } } }, remoteAmounts: [500, null, 2000] }))
      .toEqual({ revision: 2, castRegistrations: { [cast.id]: { amounts: [500, 1500] } }, remoteAmounts: [500, 2000] });
    expect(normalizeTransportMonth({ casts: { [cast.id]: { [`${month}-02`]: { amount: 0, attendanceClosingId: "closing-02", attendanceIndex: 0 } } } }).casts[cast.id][`${month}-02`].legacyInputIds).toEqual([]);
    expect(normalizeTransportMonth({ drivers: { "driver-1": { [`${month}-02`]: { attendanceClosingId: "closing-02", attendanceIndex: 0 } } } }).drivers["driver-1"][`${month}-02`].entries).toEqual({});
  });
  it("不正な保存金額・日付・出勤根拠を黙示削除しない", () => {
    expect(() => normalizeTransportSettings({ castRegistrations: { [cast.id]: { amounts: [500, 500] } } })).toThrow();
    expect(() => normalizeTransportSettings({ remoteAmounts: [2500] })).toThrow();
    for (const value of [record(999), { ...record(500), attendanceIndex: -1 }, { ...record(500), legacyInputIds: ["bad/id"] }]) {
      expect(() => normalizeTransportMonth({ casts: { [cast.id]: { [`${month}-02`]: value } } })).toThrow();
    }
    expect(() => normalizeTransportMonth({ casts: { [cast.id]: { "2026-09-31": record(500) } } })).toThrow();
  });
  it("送信済み・承認済みだけを選択でき、他人・差戻し・取下げを除く", () => {
    const data = workspace([closing("02"), closing("03", { status: "submitted" }), closing("04", { status: "returned" }), closing("05", { status: "withdrawn" })]);
    expect(transportAttendance(data, month, cast.id, "cast").map((row) => row.businessDate)).toEqual([`${month}-02`, `${month}-03`]);
    expect(transportAttendance(data, month, "driver-1", "driver").map((row) => row.businessDate)).toEqual([`${month}-02`, `${month}-03`]);
    expect(transportAttendance(data, month, "other", "cast")).toEqual([]);
  });
});

describe("旧送迎と新送迎の統合", () => {
  it("未編集なら旧日次・日付指定追加・月額追加の原額を合算する", () => {
    const settings = adjustments([legacy("fixed", `${month}-02`), legacy("floating")]);
    const data = workspace([closing("02"), closing("03")], settings);
    expect(transportCastDays(data, month, cast.id)).toEqual([
      { businessDate: `${month}-02`, amount: 1500, legacyInputIds: ["fixed"], hasRecord: true },
      { businessDate: `${month}-03`, amount: 1500, legacyInputIds: ["floating"], hasRecord: true },
    ]);
    const calculated = reward(data);
    expect(calculated.rewards[0].transportFee).toBe(3000);
    expect(calculated.sales[0].totals.transportFee).toBe(3000);
  });
  it("同日に複数出勤行があっても新記録を一度だけ控除し、保存元を変更しない", () => {
    const data = withRecord(workspace([closing("02", { casts: [dailyCast(), dailyCast()] })], adjustments([legacy("fixed", `${month}-02`)])), record(1500, ["fixed"]));
    const before = structuredClone(data);
    const calculated = reward(data);
    expect(calculated.applied.issues).toEqual([]);
    expect(calculated.rewards[0].transportFee).toBe(1500);
    expect(calculated.rewards[0].netPay).toBe(calculated.rewards[0].grossPay - 1500);
    expect(calculated.sales[0].days.map((day) => day.transportFee)).toEqual([1500, 0]);
    expect(data).toEqual(before);
  });
  it("編集済み月額追加は後日の承認で解決日が移動しても再計上しない", () => {
    const data = withRecord(workspace([closing("02"), closing("03", { casts: [dailyCast({ transportFee: 0 })] })], adjustments([legacy("floating")])), record(500, ["floating"]));
    expect(reward(data).rewards[0].transportFee).toBe(500);
    expect(transportCastDays(data, month, cast.id).map((day) => day.amount)).toEqual([500, 0]);
  });
  it("削除は0円履歴を残し、日次再承認や未指定日の移動で旧額が復活しない", () => {
    const data = withRecord(workspace([closing()], adjustments([legacy("floating")])), record(0, ["floating"]));
    expect(reward(data).rewards[0].transportFee).toBe(0);
    expect(transportCastDays(data, month, cast.id)[0]).toMatchObject({ amount: 0, hasRecord: false });
    data.closings[0].status = "returned";
    expect(applyTransport(data, month, data.adjustments[0]).issues).toEqual([]);
    data.closings[0].status = "approved";
    expect(reward(data).rewards[0].transportFee).toBe(0);
  });
  it("差戻し後も旧記録を表示する", () => {
    const data = workspace([closing("02", { status: "returned" })], adjustments([legacy("fixed", `${month}-02`)]));
    expect(transportCastDays(data, month, cast.id)[0]).toMatchObject({ amount: 1500, hasRecord: true });
  });
  it("未指定旧入力は承認日がなくても保存根拠日を表示し、根拠も欠損なら明示する", () => {
    const input = { ...legacy("floating"), attendanceClosingId: "closing-02", attendanceIndex: 0 };
    const data = workspace([closing("02", { status: "returned" })], adjustments([input]));
    expect(transportCastDays(data, month, cast.id)[0]).toMatchObject({ amount: 1500, legacyInputIds: ["floating"] });
    expect(transportUnresolvedLegacyInputs(data, month, cast.id)).toEqual([]);
    data.closings = [];
    expect(transportCastDays(data, month, cast.id)).toEqual([]);
    expect(transportUnresolvedLegacyInputs(data, month, cast.id)).toEqual([input]);
  });
  it("未消費の旧入力が編集後に追加されても表示額と給与額を一致させる", () => {
    const data = withRecord(workspace([closing()], adjustments([legacy("extra", month + "-02")])), record(500));
    expect(transportCastDays(data, month, cast.id)[0]).toMatchObject({ amount: 1500, legacyInputIds: ["extra"] });
    expect(reward(data).rewards[0].transportFee).toBe(1500);
  });
  it("店舗向け投影からも経理と同じ旧送迎合計を表示する", () => {
    const data = workspace();
    data.adjustments = [];
    data.transportLegacyInputs = { [month]: [legacy("fixed", `${month}-02`)] };
    expect(transportCastDays(data, month, cast.id)[0].amount).toBe(1500);
  });
  it("承認待ちは未反映を通知し、差戻しや本人変更は不整合を通知する", () => {
    const data = withRecord(workspace([closing("02", { status: "submitted" })]), record(1500));
    expect(reward(data).applied.issues.join()).toContain("承認待ち");
    expect(reward(data).rewards).toEqual([]);
    data.closings[0].status = "returned";
    expect(reward(data).applied.issues.join()).toContain("差戻し");
    data.closings[0].status = "approved";
    data.closings[0].casts[0].masterId = "other";
    expect(reward(data).applied.issues.join()).toContain("出勤変更");
  });
  it("別人入力IDの抑制・月外記録を警告する", () => {
    const settings = adjustments([{ ...legacy("other"), castId: "other" }]);
    const data = withRecord(workspace([closing()], settings), record(500, ["other"]));
    expect(applyTransport(data, month, settings).issues.join()).toContain("対応が一致しません");
    data.transportMonths![month].casts[cast.id]["2026-10-01"] = record(500);
    expect(applyTransport(data, month, settings).issues.join()).toContain("対象月");
  });
});

describe("ドライバー遠方手当", () => {
  it("同日複数回を旧月額に加算し、0件への編集で新記録だけを削除する", () => {
    const data = workspace();
    data.transportMonths = { [month]: { revision: 1, casts: {}, drivers: { "driver-1": { [`${month}-02`]: { entries: { first: 500, second: 1500, third: 500 }, attendanceClosingId: "closing-02", attendanceIndex: 0 } } } } };
    let applied = applyTransport(data, month, data.adjustments[0]);
    expect(calculateDriverPayroll(applied.closings, applied.adjustments.driverRemoteAllowance)[0]).toMatchObject({ remote: 10000, gross: 20000 });
    data.transportMonths[month].drivers["driver-1"][`${month}-02`].entries = {};
    applied = applyTransport(data, month, data.adjustments[0]);
    expect(applied.adjustments.driverRemoteAllowance["driver-1"]).toBe(7500);
    expect(data.adjustments[0].driverRemoteAllowance["driver-1"]).toBe(7500);
  });
  it("未承認遠方手当は旧月額を変えず、警告する", () => {
    const data = workspace([closing("02", { status: "submitted" })]);
    data.transportMonths = { [month]: { revision: 1, casts: {}, drivers: { "driver-1": { [`${month}-02`]: { entries: { first: 2000 }, attendanceClosingId: "closing-02", attendanceIndex: 0 } } } } };
    const applied = applyTransport(data, month, data.adjustments[0]);
    expect(applied.adjustments.driverRemoteAllowance["driver-1"]).toBe(7500);
    expect(applied.issues.join()).toContain("遠方手当は日次の承認待ち");
  });
});


describe("既存給与を保持する送迎境界条件", () => {
  it.each(["active", "departed"] as const)("新記録がない%sキャストは旧集計への全入力・給与を変更しない", (status) => {
    const settings = adjustments([
      legacy("dated", month + "-02"), legacy("floating"),
      { ...legacy("sale", month + "-02"), kind: "sales", label: "追加売上", amount: 100010 },
      { ...legacy("allowance"), kind: "allowance", label: "手当", amount: 321 },
    ]);
    const first = closing("02", { casts: [dailyCast({ hours: 4.25, endTime: "00:15", hourlyRate: 3123,
      honShimeiSales: 1110010, jonaiExtensionSales: 20000, honShimeiCount: 2, banaiShimeiCount: 3,
      dohanBack: 3500, beautyAllowance: 500, dailyPayment: 5432, advancePayment: 123, transportFee: 1500 })] });
    const second = closing("05", { casts: [dailyCast({ transportFee: 2000, dailyPayment: 2500 })] });
    const pending = closing("06", { status: "submitted", casts: [dailyCast({ transportFee: 500 })] });
    const returned = closing("07", { status: "returned", casts: [dailyCast({ transportFee: 500 })] });
    const data = workspace([returned, second, pending, first], settings);
    data.casts = [{ ...cast, status }];
    settings.withholdingByCast = { [cast.id]: 1234 };
    const original = structuredClone(data);
    const beforeRewards = calculateCastRewards(data.closings, data.casts, month, settings);
    const beforeSales = calculateCastSalesReports(data.closings, data.casts, month, settings);
    const beforeDrivers = calculateDriverPayroll(data.closings.filter((row) => row.status === "approved"), settings.driverRemoteAllowance);
    for (const records of [undefined, { [month]: { revision: 0, casts: {}, drivers: {} } }]) {
      data.transportMonths = records;
      const applied = applyTransport(data, month, settings);
      expect(applied.issues).toEqual([]);
      expect(applied.closings).toEqual(original.closings);
      expect(applied.adjustments).toEqual(settings);
      expect(calculateCastRewards(applied.closings, data.casts, month, applied.adjustments)).toEqual(beforeRewards);
      expect(calculateCastSalesReports(applied.closings, data.casts, month, applied.adjustments)).toEqual(beforeSales);
      expect(calculateDriverPayroll(applied.closings.filter((row) => row.status === "approved"), applied.adjustments.driverRemoteAllowance)).toEqual(beforeDrivers);
    }
    expect(beforeRewards[0].transportFee).toBe(5500);
    expect(beforeSales[0].days.map((day) => day.transportFee)).toEqual([2500, 3000]);
    expect(settings).toEqual(original.adjustments[0]);
    expect(data.closings).toEqual(original.closings);
  });

  it("送迎保存後に退店しても承認済みの記録と控除額を保持する", () => {
    const data = withRecord(workspace(), record(1500));
    data.casts = [{ ...cast, status: "departed", departedAt: month + "-03" }];
    expect(reward(data).applied.issues).toEqual([]);
    expect(reward(data).rewards[0].transportFee).toBe(1500);
  });

  it("同月在籍化した体入日の旧送迎・新送迎は在籍IDへ一度だけ集約する", () => {
    const data = withRecord(workspace([closing("02", { casts: [dailyCast({ masterId: "trial-1", kind: "trial", transportFee: 1000 })] }), closing("03")]), record(1500));
    data.casts = [{ ...cast, hiredAt: month + "-03", convertedFromTrialId: "trial-1" }];
    expect(transportAttendance(data, month, cast.id, "cast").map((row) => row.businessDate)).toEqual([month + "-02", month + "-03"]);
    expect(reward(data).applied.issues).toEqual([]);
    expect(reward(data).rewards).toHaveLength(1);
    expect(reward(data).rewards[0].transportFee).toBe(2000);
    expect(transportCastDays(data, month, cast.id).map((row) => row.amount)).toEqual([1500, 500]);
  });

  it("再送で出勤位置が変わった記録は同額で根拠を更新すれば復旧する", () => {
    const data = withRecord(workspace([closing("02", { casts: [dailyCast({ masterId: "other", posCastId: "other", transportFee: 0 }), dailyCast()] })]), record(1500));
    expect(reward(data).applied.issues.join()).toContain("出勤変更");
    data.transportMonths![month].casts[cast.id][month + "-02"].attendanceIndex = 1;
    const restored = reward(data);
    expect(restored.applied.issues).toEqual([]);
    expect(restored.rewards.find((row) => row.id === cast.id)!.transportFee).toBe(1500);
  });

  it("複数日の遠方手当は削除した日の新規分だけ減り、旧月額と別日分を保持する", () => {
    const data = workspace([closing("02"), closing("03")]);
    data.transportMonths = { [month]: { revision: 1, casts: {}, drivers: { "driver-1": {
      [month + "-02"]: { entries: { first: 500, second: 1500 }, attendanceClosingId: "closing-02", attendanceIndex: 0 },
      [month + "-03"]: { entries: { third: 2000 }, attendanceClosingId: "closing-03", attendanceIndex: 0 },
    } } } };
    const before = applyTransport(data, month, data.adjustments[0]);
    expect(before.adjustments.driverRemoteAllowance["driver-1"]).toBe(11500);
    data.transportMonths[month].drivers["driver-1"][month + "-02"].entries = {};
    const after = applyTransport(data, month, data.adjustments[0]);
    expect(after.issues).toEqual([]);
    expect(after.adjustments.driverRemoteAllowance["driver-1"]).toBe(9500);
    expect(data.adjustments[0].driverRemoteAllowance["driver-1"]).toBe(7500);
  });
});
