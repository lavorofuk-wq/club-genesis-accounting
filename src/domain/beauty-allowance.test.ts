import { describe, expect, it } from "vitest";
import { calculateCastRewards, calculateCastSalesReports, mergeReconciledDailyCastInputs, type CastRecord, type DailyCast, type DailyClosing, type WorkspaceData } from "./gms";
import { applyBeautyAllowances, beautyAttendance, beautyCastDays, normalizeBeautyMonth, type BeautyDay } from "./beauty-allowance";

const month = "2026-09";
const cast: CastRecord = { id: "cast-1", name: "花子", legalName: "花子", status: "active", hourlyRates: { [month]: 3000 }, note: "", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" };
function dailyCast(overrides: Partial<DailyCast> = {}): DailyCast {
  return { masterId: cast.id, posCastId: "pos-1", name: cast.name, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000,
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [],
    bottles: [], liquorCost: 0, beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0, ...overrides };
}
function closing(day = "02", overrides: Partial<DailyClosing> = {}): DailyClosing {
  return { id: "closing-" + day, businessDate: month + "-" + day, status: "approved", casts: [dailyCast()], drivers: [], expenses: [], ...overrides } as DailyClosing;
}
function workspace(closings = [closing()]): WorkspaceData {
  return { casts: [cast], staff: [], drivers: [], introducers: [], liquor: [], closings, adjustments: [], cashFloat: 0 };
}
function record(eligible: boolean, day = "02", index = 0, posCastId = "pos-1"): BeautyDay {
  return { eligible, attendanceClosingId: "closing-" + day, attendanceIndex: index, attendancePosCastId: posCastId };
}
function withRecord(data: WorkspaceData, value: BeautyDay, day = "02", id = cast.id) {
  data.beautyMonths = { [month]: { revision: 1, casts: { [id]: { [month + "-" + day]: value } } } };
  return data;
}

describe("在籍美容室手当の保存と出勤根拠", () => {
  it("空mapと数値キーを復元し、falseを未登録へ戻さない", () => {
    expect(normalizeBeautyMonth(undefined)).toEqual({ revision: 0, casts: {} });
    expect(normalizeBeautyMonth({ revision: 0, casts: [] })).toEqual({ revision: 0, casts: {} });
    const saved = normalizeBeautyMonth({ revision: 2, casts: [null, { [month + "-02"]: record(false) }] });
    expect(saved.casts["1"][month + "-02"]).toEqual(record(false));
  });
  it.each([
    { eligible: 500 }, { eligible: "true" }, { attendanceIndex: -1 }, { attendanceIndex: 0.5 },
    { attendanceClosingId: "bad/id" }, { attendancePosCastId: "" }, { attendancePosCastId: 123 },
  ])("不正な日別保存値を黙って捨てない %j", (invalid) => {
    expect(() => normalizeBeautyMonth({ casts: { [cast.id]: { [month + "-02"]: { ...record(true), ...invalid } } } })).toThrow();
  });
  it("存在しない日付・不正な人物ID・保存世代を拒否する", () => {
    expect(() => normalizeBeautyMonth({ casts: { [cast.id]: { "2026-09-31": record(true) } } })).toThrow();
    expect(() => normalizeBeautyMonth({ casts: { "bad/id": { [month + "-02"]: record(true) } } })).toThrow();
    expect(() => normalizeBeautyMonth({ revision: -1 })).toThrow();
  });
  it("本人の送信済み・承認済みの在籍出勤だけを返す", () => {
    const data = workspace([closing("02"), closing("03", { status: "submitted" }), closing("04", { status: "returned" }),
      closing("05", { status: "withdrawn" }), closing("06", { casts: [dailyCast({ kind: "trial" })] }),
      closing("07", { casts: [dailyCast({ masterId: "other", name: cast.name }), dailyCast()] })]);
    expect(beautyAttendance(data, month, cast.id)).toEqual([
      { businessDate: month + "-02", closingId: "closing-02", index: 0, posCastId: "pos-1" },
      { businessDate: month + "-03", closingId: "closing-03", index: 0, posCastId: "pos-1" },
      { businessDate: month + "-07", closingId: "closing-07", index: 1, posCastId: "pos-1" },
    ]);
    expect(beautyAttendance(data, "2026-10", cast.id)).toEqual([]);
  });
});

describe("旧日次からの引継ぎと明示的な可否", () => {
  it("旧500円と差戻し・取下げ後の旧記録を表示し、旧0円は未登録とする", () => {
    const data = workspace([closing("02"), closing("03", { casts: [dailyCast({ beautyAllowance: 500 })] }),
      closing("04", { status: "returned", casts: [dailyCast({ beautyAllowance: 500 })] }),
      closing("05", { status: "withdrawn", casts: [dailyCast({ beautyAllowance: 500 })] })]);
    expect(beautyCastDays(data, month, cast.id)).toEqual([
      { businessDate: month + "-02", eligible: null, hasRecord: false, legacy: false },
      { businessDate: month + "-03", eligible: true, hasRecord: true, legacy: true },
      { businessDate: month + "-04", eligible: true, hasRecord: true, legacy: true },
      { businessDate: month + "-05", eligible: true, hasRecord: true, legacy: true },
    ]);
  });
  it("保存したなしを旧500円より優先し、差戻しでも維持する", () => {
    const data = withRecord(workspace([closing("02", { status: "returned", casts: [dailyCast({ beautyAllowance: 500 })] })]), record(false));
    expect(beautyCastDays(data, month, cast.id)).toEqual([{ businessDate: month + "-02", eligible: false, hasRecord: true, legacy: false }]);
    const result = applyBeautyAllowances(data, month);
    expect(result.issues).toEqual([]);
    expect(result.closings[0].casts[0].beautyAllowance).toBe(0);
    expect(data.closings[0].casts[0].beautyAllowance).toBe(500);
  });
  it("旧記録未編集なら元の500円を保持し、新記録と二重加算しない", () => {
    const data = workspace([closing("02", { casts: [dailyCast({ beautyAllowance: 500 })] })]);
    expect(applyBeautyAllowances(data, month).closings[0].casts[0].beautyAllowance).toBe(500);
    withRecord(data, record(true));
    const before = structuredClone(data);
    const result = applyBeautyAllowances(data, month);
    expect(result.issues).toEqual([]);
    expect(calculateCastRewards(result.closings, data.casts, month)[0].beautyAllowance).toBe(500);
    expect(calculateCastSalesReports(result.closings, data.casts, month)[0].totals.beautyAllowance).toBe(500);
    expect(data).toEqual(before);
    expect(applyBeautyAllowances({ ...data, closings: result.closings }, month)).toEqual(result);
  });
  it("同じ日に本人の行が複数あっても参照された1行だけに加算する", () => {
    const data = withRecord(workspace([closing("02", { casts: [dailyCast({ beautyAllowance: 500 }), dailyCast({ posCastId: "pos-2", beautyAllowance: 500 })] })]), record(true, "02", 1, "pos-2"));
    const result = applyBeautyAllowances(data, month);
    expect(result.closings[0].casts.map((row) => row.beautyAllowance)).toEqual([0, 500]);
    expect(calculateCastRewards(result.closings, data.casts, month)[0].beautyAllowance).toBe(500);
  });
  it.each(["submitted", "returned", "withdrawn"] as const)("承認前・差戻しの%sは未加算とし問題を返す", (status) => {
    const data = withRecord(workspace([closing("02", { status, casts: [dailyCast({ beautyAllowance: 500 })] })]), record(true));
    const result = applyBeautyAllowances(data, month);
    expect(result.closings[0].casts[0].beautyAllowance).toBe(0);
    expect(result.issues.length).toBe(1);
    expect(calculateCastRewards(result.closings, data.casts, month)).toEqual([]);
  });
  it("他人の出勤・存在しないindex・日次IDを根拠として使わない", () => {
    const data = workspace([closing("02", { casts: [dailyCast({ masterId: "other" }), dailyCast({ beautyAllowance: 500 })] })]);
    for (const saved of [record(true), record(true, "02", 5), { ...record(true, "02", 1), attendanceClosingId: "missing" }]) {
      const result = applyBeautyAllowances(withRecord(data, saved), month);
      expect(result.issues[0]).toContain("対応する送信済みの在籍出勤がありません");
      expect(result.closings[0].casts[1].beautyAllowance).toBe(0);
    }
  });
  it("同月在籍化しても体入日の手当・経費を在籍手当へ移さない", () => {
    const trial: CastRecord = { ...cast, id: "trial-1", status: "trial", convertedToCastId: cast.id };
    const expenses: DailyClosing["expenses"] = [{ id: "expense-1", category: "beautyTrial", payee: cast.name, personId: trial.id, amount: 2000 }];
    const data = workspace([closing("02", { casts: [dailyCast({ masterId: trial.id, kind: "trial" })], expenses }),
      closing("03")]);
    data.casts = [trial, { ...cast, hiredAt: month + "-03", convertedFromTrialId: trial.id }];
    expect(beautyAttendance(data, month, cast.id).map((row) => row.businessDate)).toEqual([month + "-03"]);
    expect(beautyCastDays(data, month, cast.id)).toEqual([{ businessDate: month + "-03", eligible: null, hasRecord: false, legacy: false }]);
    withRecord(data, record(true), "02");
    const result = applyBeautyAllowances(data, month);
    expect(result.issues).toHaveLength(1);
    expect(result.closings[0].expenses).toBe(expenses);
    expect(result.closings[0].casts[0].beautyAllowance).toBe(0);
    expect(calculateCastRewards(result.closings, data.casts, month)[0].beautyAllowance).toBe(0);
    expect(calculateCastSalesReports(result.closings, data.casts, month)[0].totals.beautyAllowance).toBe(2000);
  });
  it("誤った対象月や保存形式は集計警告にする", () => {
    const data = withRecord(workspace(), record(true));
    data.beautyMonths![month].casts[cast.id]["2026-10-02"] = record(false);
    expect(applyBeautyAllowances(data, month).issues[0]).toContain("対象月");
    expect(() => beautyCastDays(data, month, cast.id)).toThrow("対象月");
    data.beautyMonths![month].revision = -1;
    expect(applyBeautyAllowances(data, month).issues[0]).toContain("保存世代");
  });
});

describe("美容室手当の人物照合変更と取消し保持", () => {
  it("Aの旧500円を否にした後、同じPOS人物がBへ照合されても旧額を復活させない", () => {
    const original = dailyCast({ beautyAllowance: 500 });
    const data = withRecord(workspace([closing("02", { casts: [original] })]), record(false));
    const before = structuredClone(data);
    data.casts.push({ ...cast, id: "cast-2" });
    data.closings[0].casts = mergeReconciledDailyCastInputs([original], [dailyCast({ masterId: "cast-2" })]).rows;
    expect(data.closings[0].casts[0].beautyAllowance).toBe(500);
    const applied = applyBeautyAllowances(data, month);
    expect(applied.issues).toEqual([]);
    expect(applied.closings[0].casts[0]).toMatchObject({ masterId: "cast-2", beautyAllowance: 0 });
    expect(calculateCastRewards(applied.closings, data.casts, month)[0].beautyAllowance).toBe(0);
    expect(beautyCastDays(data, month, "cast-2")).toEqual([{ businessDate: month + "-02", eligible: null, hasRecord: false, legacy: false }]);
    expect(beautyCastDays(data, month, cast.id)).toEqual([{ businessDate: month + "-02", eligible: false, hasRecord: true, legacy: false }]);
    expect(original).toEqual(before.closings[0].casts[0]);
    expect(data.closings[0].casts[0].beautyAllowance).toBe(500);
  });

  it("照合先Bの新しい可をAの否より優先し、未解決のAの可だけを警告する", () => {
    const data = withRecord(workspace([closing("02", { casts: [dailyCast({ masterId: "cast-2", beautyAllowance: 500 })] })]), record(true));
    data.casts.push({ ...cast, id: "cast-2" });
    let applied = applyBeautyAllowances(data, month);
    expect(applied.issues).toHaveLength(1);
    expect(applied.closings[0].casts[0].beautyAllowance).toBe(0);
    data.beautyMonths![month].casts["cast-2"] = { [month + "-02"]: record(true) };
    applied = applyBeautyAllowances(data, month);
    expect(applied.issues).toHaveLength(1);
    expect(applied.closings[0].casts[0].beautyAllowance).toBe(500);
    data.beautyMonths![month].casts[cast.id][month + "-02"].eligible = false;
    applied = applyBeautyAllowances(data, month);
    expect(applied.issues).toEqual([]);
    expect(applied.closings[0].casts[0].beautyAllowance).toBe(500);
    expect(beautyCastDays(data, month, "cast-2")).toEqual([{ businessDate: month + "-02", eligible: true, hasRecord: true, legacy: false }]);
    expect(applyBeautyAllowances({ ...data, closings: applied.closings }, month)).toEqual(applied);
  });

  it("行順序が変わっても取消しは元のPOS行だけへ効き、別人物・別日を抑制しない", () => {
    const data = withRecord(workspace([
      closing("02", { casts: [dailyCast({ masterId: "other", posCastId: "pos-other", beautyAllowance: 500 }),
        dailyCast({ masterId: "cast-2", beautyAllowance: 500 })] }),
      closing("03", { id: "closing-02", casts: [dailyCast({ masterId: "cast-2", beautyAllowance: 500 })] }),
    ]), record(false));
    const applied = applyBeautyAllowances(data, month);
    expect(applied.issues).toEqual([]);
    expect(applied.closings[0].casts.map((row) => row.beautyAllowance)).toEqual([500, 0]);
    expect(applied.closings[1].casts[0].beautyAllowance).toBe(500);
    expect(beautyCastDays(data, month, "cast-2")).toEqual([
      { businessDate: month + "-02", eligible: null, hasRecord: false, legacy: false },
      { businessDate: month + "-03", eligible: true, hasRecord: true, legacy: true },
    ]);
  });

  it("同じmasterIdとindexでもPOS人物IDが変われば可を加算せず、正しい行へ再指定後に一度だけ加算する", () => {
    const data = withRecord(workspace([closing("02", { casts: [
      dailyCast({ posCastId: "different-pos", beautyAllowance: 500 }), dailyCast({ beautyAllowance: 500 }),
    ] })]), record(true));
    let applied = applyBeautyAllowances(data, month);
    expect(applied.issues).toHaveLength(1);
    expect(applied.closings[0].casts.map((row) => row.beautyAllowance)).toEqual([0, 0]);
    data.beautyMonths![month].casts[cast.id][month + "-02"].attendanceIndex = 1;
    applied = applyBeautyAllowances(data, month);
    expect(applied.issues).toEqual([]);
    expect(applied.closings[0].casts.map((row) => row.beautyAllowance)).toEqual([0, 500]);
  });

  it("POS人物IDはキー用正規表現で制限せず保存値として完全一致を使う", () => {
    const data = withRecord(workspace([closing("02", { casts: [dailyCast({ posCastId: "POS/花子" })] })]), record(true, "02", 0, "POS/花子"));
    expect(normalizeBeautyMonth(data.beautyMonths![month]).casts[cast.id][month + "-02"].attendancePosCastId).toBe("POS/花子");
    expect(applyBeautyAllowances(data, month).closings[0].casts[0].beautyAllowance).toBe(500);
  });
});
