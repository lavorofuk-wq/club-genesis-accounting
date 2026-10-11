import { describe, expect, it } from "vitest";
import { calculateCastRewards, calculateCastSalesReports } from "./gms";
import type { CastRecord, DailyCast, DailyClosing, WorkspaceData } from "./gms";
import { beautyClosingsForExport } from "./beauty-export";
import { castSalesBeautyValuesForExport } from "./cast-sales-beauty-export";

const month = "2026-09";
function fixture() {
  const regular: CastRecord = { id: "member", name: "花子", legalName: "", note: "", createdAt: "", updatedAt: "", status: "active",
    hiredAt: `${month}-02`, convertedFromTrialId: "trial", hourlyRates: { [month]: 3000 } };
  const trial: CastRecord = { ...regular, id: "trial", status: "trial", hiredAt: undefined, convertedFromTrialId: undefined, convertedToCastId: regular.id };
  const cast: DailyCast = { masterId: regular.id, posCastId: "pos-member", name: regular.name, kind: "regular", startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3000,
    honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: 500, dailyPayment: 0, advancePayment: 0, transportFee: 0 };
  const daily: DailyClosing = { id: "day-2", businessDate: `${month}-02`, status: "approved", submissionId: "submitted", checksum: "a".repeat(64), updatedAt: `${month}-03T00:00:00Z`,
    sales: { cashSales: 0, cardSales: 0, totalSales: 0 }, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [cast], staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000, cashProfit: 0, actualClosingCash: 200000, difference: 0 },
    posSnapshot: { transactions: [] } as unknown as DailyClosing["posSnapshot"] };
  const trialDay = structuredClone(daily);
  trialDay.id = "day-1"; trialDay.businessDate = `${month}-01`;
  trialDay.casts[0] = { ...cast, masterId: trial.id, posCastId: "pos-trial", kind: "trial", hourlyRate: 1500, beautyAllowance: 0 };
  trialDay.expenses = [{ id: "beauty-trial", category: "beautyTrial", payee: trial.name, personId: trial.id, amount: 500 }];
  const zeroDay = structuredClone(daily);
  zeroDay.id = "day-3"; zeroDay.businessDate = `${month}-03`; zeroDay.casts[0].beautyAllowance = 0;
  return { casts: [regular, trial], closings: [trialDay, daily, zeroDay] };
}
function calculate(data: ReturnType<typeof fixture>) {
  return { castSalesReports: calculateCastSalesReports(data.closings, data.casts, month), castRewards: calculateCastRewards(data.closings, data.casts, month) };
}
function project(data: ReturnType<typeof fixture>) {
  return castSalesBeautyValuesForExport(calculate(data), data.closings, data.casts, month);
}

describe("未確定キャスト売上Excelの美容室欄", () => {
  it("同月体入日は空欄、在籍の可は500円・否は0円とし、入力や報酬を変更しない", () => {
    const data = fixture(), results = calculate(data), before = structuredClone({ data, results });
    const values = castSalesBeautyValuesForExport(results, data.closings, data.casts, month);
    expect([...values.get("member")!]).toEqual([[`${month}-01`, null], [`${month}-02`, 500], [`${month}-03`, 0]]);
    expect(results.castSalesReports[0].days.map((day) => day.beautyAllowance)).toEqual([500, 500, 0]);
    expect(results.castSalesReports[0].totals.beautyAllowance).toBe(1000);
    expect(results.castRewards[0].beautyAllowance).toBe(500);
    expect({ data, results }).toEqual(before);
  });

  it("体入美容室経費が0円でも体入欄を空欄にし、在籍の0円と区別する", () => {
    const data = fixture(); data.closings[0].expenses = [];
    expect([...project(data).get("member")!.values()]).toEqual([null, 500, 0]);
  });

  it("同日の複数体入経費を元表示と照合し、本人以外の経費を含めない", () => {
    const data = fixture();
    data.closings[0].expenses.push({ ...data.closings[0].expenses[0], id: "extra", amount: 1500 },
      { ...data.closings[0].expenses[0], id: "other", personId: "other-person", amount: 2000 });
    expect(calculate(data).castSalesReports[0].days[0].beautyAllowance).toBe(2000);
    expect(project(data).get("member")!.get(`${month}-01`)).toBeNull();
  });

  it("体入のみのキャストも元kindを確認して空欄にする", () => {
    const data = fixture(); data.closings = [data.closings[0]]; data.casts = [data.casts[1]];
    delete data.casts[0].convertedToCastId;
    expect([...project(data).get("trial")!]).toEqual([[`${month}-01`, null]]);
  });

  it("体入マスタ削除後も在籍側の同月逆参照で体入日を確認する", () => {
    const data = fixture(); data.casts = [data.casts[0]];
    expect([...project(data).get("member")!.values()]).toEqual([null, 500, 0]);
  });

  it("在籍マスタ削除後も体入側の変換先と同月regular出勤で本人を確認する", () => {
    const data = fixture(); data.casts = [data.casts[1]];
    expect([...project(data).get("member")!.values()]).toEqual([null, 500, 0]);
  });

  it("別月入店では体入と在籍を別IDのまま計算規則どおり出力する", () => {
    const data = fixture(); data.casts[0].hiredAt = "2026-10-01";
    delete data.casts[1].convertedToCastId;
    const values = project(data);
    expect([...values.keys()].sort()).toEqual(["member", "trial"]);
    expect([...values.get("trial")!.values()]).toEqual([null]);
    expect([...values.get("member")!.values()]).toEqual([500, 0]);
  });

  it("同じmasterIdを使う旧履歴でも当日のkindが体入なら空欄にする", () => {
    const data = fixture(); data.closings[0].casts[0].masterId = "member";
    data.closings[0].expenses[0].personId = "member";
    expect([...project(data).get("member")!.values()]).toEqual([null, 500, 0]);
  });

  it("新手当の可否適用後を使い、旧500円を否にした結果と新規可を維持する", () => {
    const data = fixture();
    const workspace: WorkspaceData = { ...data, staff: [], drivers: [], introducers: [], liquor: [], adjustments: [], cashFloat: 200000,
      beautyMonths: { [month]: { revision: 2, casts: { member: {
        [`${month}-02`]: { eligible: false, attendanceClosingId: "day-2", attendanceIndex: 0, attendancePosCastId: "pos-member" },
        [`${month}-03`]: { eligible: true, attendanceClosingId: "day-3", attendanceIndex: 0, attendancePosCastId: "pos-member" },
      } } } } };
    const before = structuredClone(workspace);
    const effective = { casts: data.casts, closings: beautyClosingsForExport(workspace, month) };
    expect([...project(effective).get("member")!.values()]).toEqual([null, 0, 500]);
    expect(workspace).toEqual(before);
  });

  it("未承認日と他月は出力元に含めない", () => {
    const data = fixture();
    const submitted = structuredClone(data.closings[1]); submitted.id = "submitted"; submitted.businessDate = `${month}-04`; submitted.status = "submitted";
    const otherMonth = structuredClone(data.closings[1]); otherMonth.id = "other-month"; otherMonth.businessDate = "2026-10-02";
    data.closings.push(submitted, otherMonth);
    expect([...project(data).get("member")!.values()]).toEqual([null, 500, 0]);
  });

  it.each([0, 500])("旧dispatch出勤の%d円とPOS本人IDを保持し、同月体入日だけを空欄にする", (beauty) => {
    const data = fixture();
    data.closings[1].casts.push({ ...data.closings[1].casts[0], kind: "dispatch", masterId: "", posCastId: "dispatch-pos", name: "派遣花子", beautyAllowance: beauty });
    const results = calculate(data), before = structuredClone({ data, results });
    const output = castSalesBeautyValuesForExport(results, data.closings, data.casts, month);
    expect([...output.get("dispatch-pos")!]).toEqual([[`${month}-02`, beauty]]);
    expect([...output.get("member")!.values()]).toEqual([null, 500, 0]);
    expect(results.castRewards.find((reward) => reward.id === "dispatch-pos")!.beautyAllowance).toBe(beauty);
    expect({ data, results }).toEqual(before);
  });

  it("旧dispatchの保存masterIdと従来表示額を保持し、給与額の検証に表示経費を混ぜない", () => {
    const data = fixture();
    data.closings[1].casts.push({ ...data.closings[1].casts[0], kind: "dispatch", masterId: "dispatch-master", posCastId: "dispatch-pos", beautyAllowance: 500 });
    data.closings[1].expenses.push({ id: "old-expense", category: "beautyTrial", personId: "dispatch-master", payee: "派遣花子", amount: 500 });
    const results = calculate(data), before = structuredClone({ data, results });
    const output = castSalesBeautyValuesForExport(results, data.closings, data.casts, month);
    expect([...output.get("dispatch-master")!]).toEqual([[`${month}-02`, 1000]]);
    expect(results.castRewards.find((reward) => reward.id === "dispatch-master")!.beautyAllowance).toBe(500);
    expect([...output.get("member")!.values()]).toEqual([null, 500, 0]);
    expect({ data, results }).toEqual(before);
  });

  it("空の月は空のMapを返す", () => {
    const data = fixture(); data.closings = [];
    expect(project(data).size).toBe(0);
  });
});

describe("出勤元や金額が不整合のときは空欄で隠さず出力を拒否", () => {
  it("在籍の0円出勤元が消えても体入と推測しない", () => {
    const data = fixture(), results = calculate(data); data.closings.pop();
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/出勤元の日数/);
  });

  it("体入との同月対応付けが失われた場合に既存レポートへ推測で結び付けない", () => {
    const data = fixture(), results = calculate(data);
    delete data.casts[0].convertedFromTrialId; delete data.casts[1].convertedToCastId;
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/対応する売上明細/);
  });

  it("同日に体入と在籍の両方がある場合は1セルへまとめない", () => {
    const data = fixture(); data.closings[0].casts.push(structuredClone(data.closings[1].casts[0]));
    expect(() => project(data)).toThrow(/出勤元が重複/);
  });

  it("同日レポート行の重複を拒否する", () => {
    const data = fixture(), results = calculate(data); results.castSalesReports[0].days[2] = structuredClone(results.castSalesReports[0].days[1]);
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/営業日が不正または重複/);
  });

  it("出勤元のない別日へ明細日が変更されている場合を拒否する", () => {
    const data = fixture(), results = calculate(data); results.castSalesReports[0].days[2].businessDate = `${month}-04`;
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/出勤元を確認できません/);
  });

  it("売上明細から出勤日だけ欠落している場合も拒否する", () => {
    const data = fixture(), results = calculate(data); results.castSalesReports[0].days.pop();
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/出勤元の日数/);
  });

  it.each([0, 1500])("日別表示を%d円へ変えても月額差額から補正しない", (value) => {
    const data = fixture(), results = calculate(data); results.castSalesReports[0].days[0].beautyAllowance = value;
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/出勤・経費元データが一致しません/);
  });

  it("月間報酬の美容室手当が元日額合計と違う場合を拒否する", () => {
    const data = fixture(), results = calculate(data); results.castRewards[0].beautyAllowance = 1000;
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/月間報酬と一致しません/);
  });

  it("月間売上明細の美容室表示合計が元日額合計と違う場合を拒否する", () => {
    const data = fixture(), results = calculate(data); results.castSalesReports[0].totals.beautyAllowance = 500;
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/表示の月合計が一致しません/);
  });

  it("体入出勤の給与分手当が0円でない異常を空欄で隠さない", () => {
    const data = fixture(); data.closings[0].casts[0].beautyAllowance = 500;
    expect(() => project(data)).toThrow(/体入出勤に給与分美容室手当/);
  });

  it("regular出勤のmasterIdが報酬本人と異なる変換を拒否する", () => {
    const data = fixture(); data.closings[1].casts[0].masterId = "trial";
    expect(() => project(data)).toThrow(/在籍出勤と報酬の人物ID/);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("不正金額%sを出力しない", (value) => {
    const data = fixture(), results = calculate(data); data.closings[1].casts[0].beautyAllowance = value;
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/給与分美容室手当が不正/);
  });

  it("承認済み日次の重複を拒否する", () => {
    const data = fixture(); data.closings.push(structuredClone(data.closings[1]));
    expect(() => project(data)).toThrow(/承認済み日次の営業日またはID/);
  });

  it("人物IDの重複・報酬欠落を拒否する", () => {
    const data = fixture(), results = calculate(data);
    expect(() => castSalesBeautyValuesForExport({ ...results, castRewards: [] }, data.closings, data.casts, month)).toThrow(/人物IDが一致しません/);
    expect(() => castSalesBeautyValuesForExport(results, data.closings, [...data.casts, data.casts[0]], month)).toThrow(/人物IDが不正または重複/);
    expect(() => castSalesBeautyValuesForExport({ ...results, castSalesReports: [...results.castSalesReports, results.castSalesReports[0]] }, data.closings, data.casts, month)).toThrow(/人物IDが不正または重複/);
  });

  it("対象月と営業日の不正値を拒否する", () => {
    const data = fixture(), results = calculate(data);
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, "2026-13")).toThrow(/対象月が不正/);
    data.closings[2].businessDate = "2026-09-31";
    expect(() => castSalesBeautyValuesForExport(results, data.closings, data.casts, month)).toThrow(/承認済み日次の営業日/);
  });
});
