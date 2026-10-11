import { castIdentityForMonth } from "./gms";
import type { CastRecord, DailyCast, DailyClosing } from "./gms";
import type { MonthlyAccountingResults } from "./month-accounting";

export type CastSalesBeautyExportValues = Map<string, Map<string, number | null>>;
type ExportResults = Pick<MonthlyAccountingResults, "castSalesReports" | "castRewards">;
type AttendanceSource = { closing: DailyClosing; row: DailyCast };

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function amount(value: unknown, label: string): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${label}が不正です。`);
  return value;
}

function indexed<T extends { id: string }>(values: T[], label: string): Map<string, T> {
  requireValue(Array.isArray(values), `${label}を読み込めません。`);
  const result = new Map<string, T>();
  for (const value of values) {
    requireValue(value && typeof value.id === "string" && value.id.trim().length > 0 && !result.has(value.id),
      `${label}の人物IDが不正または重複しています。`);
    result.set(value.id, value);
  }
  return result;
}

/**
 * 未確定月のExcel美容室欄だけを投影する。確定済み帳票には使用しない。
 * closingsには月次計算と同じ美容室手当適用済みの日次を渡す。
 * 体入日の空欄は出勤元のkindで確認し、月額差額から推測・配賦しない。
 */
export function castSalesBeautyValuesForExport(
  results: ExportResults,
  closings: DailyClosing[],
  casts: CastRecord[],
  month: string,
): CastSalesBeautyExportValues {
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "美容室欄の出力対象月が不正です。");
  requireValue(results && Array.isArray(closings), "美容室欄の元データを読み込めません。");
  const castById = indexed(casts, "キャストマスタ");
  const reports = indexed(results.castSalesReports, "キャスト売上明細");
  const rewards = indexed(results.castRewards, "キャスト報酬");
  requireValue(reports.size === rewards.size && [...reports.keys()].every((id) => rewards.has(id)),
    "キャスト売上明細と報酬の人物IDが一致しません。");
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const validDate = (value: unknown): value is string => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value) && value.startsWith(`${month}-`)
    && Number(value.slice(8)) >= 1 && Number(value.slice(8)) <= daysInMonth;
  const approved: DailyClosing[] = [];
  const closingIds = new Set<string>();
  const dates = new Set<string>();
  for (const closing of closings) {
    requireValue(closing && typeof closing.businessDate === "string", "日次の営業日を確認できません。");
    if (closing.status !== "approved" || !closing.businessDate.startsWith(month)) continue;
    requireValue(validDate(closing.businessDate) && typeof closing.id === "string" && closing.id.length > 0
      && !closingIds.has(closing.id) && !dates.has(closing.businessDate), "承認済み日次の営業日またはIDが不正・重複しています。");
    requireValue(Array.isArray(closing.casts) && (closing.expenses === undefined || Array.isArray(closing.expenses)),
      `${closing.businessDate}の出勤・経費データを読み込めません。`);
    closingIds.add(closing.id);
    dates.add(closing.businessDate);
    approved.push(closing);
  }
  const regularMasterIds = new Set(approved.flatMap((closing) => closing.casts
    .filter((row) => row?.kind === "regular").map((row) => row.masterId)));
  const sources = new Map<string, Map<string, AttendanceSource>>();
  for (const closing of approved) {
    for (const row of closing.casts) {
      requireValue(row && (row.kind === "regular" || row.kind === "trial" || row.kind === "dispatch")
        && typeof row.masterId === "string" && (row.masterId.trim().length > 0
          || row.kind === "dispatch" && row.masterId === "" && typeof row.posCastId === "string" && row.posCastId.trim().length > 0),
      `${closing.businessDate}のキャスト出勤区分または人物IDを確認できません。`);
      const id = castIdentityForMonth(row, castById, casts, month, regularMasterIds);
      requireValue(reports.has(id), `${closing.businessDate}のキャスト出勤に対応する売上明細がありません。`);
      const byDate = sources.get(id) || new Map<string, AttendanceSource>();
      requireValue(!byDate.has(closing.businessDate), `${row.name} ${closing.businessDate}の出勤元が重複しています。`);
      byDate.set(closing.businessDate, { closing, row });
      sources.set(id, byDate);
    }
  }
  const output: CastSalesBeautyExportValues = new Map();
  for (const [id, report] of reports) {
    const reward = rewards.get(id)!;
    const sourceDays = sources.get(id);
    requireValue(Array.isArray(report.days) && report.days.length > 0 && sourceDays?.size === report.days.length,
      `${report.name}の売上明細と出勤元の日数が一致しません。`);
    const byDate = new Map<string, number | null>();
    let payrollBeauty = 0;
    let displayBeauty = 0;
    for (const day of report.days) {
      requireValue(day && validDate(day.businessDate) && !byDate.has(day.businessDate),
        `${report.name}の売上明細の営業日が不正または重複しています。`);
      const source = sourceDays.get(day.businessDate);
      requireValue(source, `${report.name} ${day.businessDate}の出勤元を確認できません。`);
      const label = `${report.name} ${day.businessDate}`;
      const dailyBeauty = amount(source.row.beautyAllowance, `${label}の給与分美容室手当`);
      const trialBeauty = (source.closing.expenses || [])
        .filter((expense) => expense.category === "beautyTrial" && expense.personId === source.row.masterId)
        .reduce((sum, expense) => amount(sum + amount(expense.amount, `${label}の体入美容室経費`), `${label}の体入美容室経費合計`), 0);
      const displayed = amount(day.beautyAllowance, `${label}の美容室手当表示`);
      requireValue(displayed === amount(dailyBeauty + trialBeauty, `${label}の美容室手当表示元`),
        `${label}の美容室手当表示と出勤・経費元データが一致しません。`);
      requireValue(source.row.kind !== "regular" || source.row.masterId === reward.id,
        `${label}の在籍出勤と報酬の人物IDが一致しません。`);
      requireValue(source.row.kind !== "trial" || dailyBeauty === 0,
        `${label}の体入出勤に給与分美容室手当が含まれています。`);
      // 旧承認済み派遣出勤も月次集計の対象。今回の空欄化対象に含めず表示額を保持する。
      const value = source.row.kind === "trial" ? null : source.row.kind === "dispatch" ? displayed : dailyBeauty;
      requireValue((value ?? 0) <= displayed, `${label}の給与分美容室手当が日別表示額を超えています。`);
      byDate.set(day.businessDate, value);
      payrollBeauty = amount(payrollBeauty + dailyBeauty, `${report.name}の給与分美容室手当合計`);
      displayBeauty = amount(displayBeauty + displayed, `${report.name}の美容室手当表示合計`);
    }
    requireValue(payrollBeauty === amount(reward.beautyAllowance, `${report.name}の月間美容室手当`),
      `${report.name}の給与分美容室手当合計が月間報酬と一致しません。`);
    requireValue(report.totals && displayBeauty === amount(report.totals.beautyAllowance, `${report.name}の月間美容室手当表示`),
      `${report.name}の美容室手当表示の月合計が一致しません。`);
    output.set(id, byDate);
  }
  return output;
}
