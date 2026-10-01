import type { CastRecord, CastReward, CastSalesReport } from "./gms";
import type { MonthlyAccountingResults } from "./month-accounting";

export type CastSalesRankingRoster = { schemaVersion: 1; entries: Array<{ id: string; name: string }> };
export type CastSalesRankingRow = {
  rank: number;
  id: string;
  name: string;
  honShimeiSales: number;
  jonaiExtensionSales: number;
  additionalSales: number;
  totalSales: number;
  honShimeiCount: number;
  banaiShimeiCount: number;
  dohanCount: number;
  hours: number;
};
export type RankingRow = CastSalesRankingRow;
export type CastSalesRanking = { rows: CastSalesRankingRow[]; rosterMissing: boolean };
type Results = Pick<MonthlyAccountingResults, "castRewards" | "castSalesReports"> & { month?: string };

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function named(value: unknown, label: string): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label}が保存されていません。`);
}

/** 未保存と、Firebaseが空entriesを省略した保存済み名簿を区別する。 */
export function normalizeCastSalesRankingRoster(value: unknown): CastSalesRankingRoster | undefined {
  if (value === undefined || value === null) return undefined;
  requireValue(record(value) && value.schemaVersion === 1
    && Object.keys(value).every((key) => key === "schemaVersion" || key === "entries"), "売上順位表の在籍者名簿の形式が正しくありません。");
  const raw = value.entries;
  requireValue(raw === undefined || raw === null || Array.isArray(raw)
    || (record(raw) && Object.keys(raw).every((key) => /^(0|[1-9]\d*)$/.test(key))), "売上順位表の在籍者名簿を確認できません。");
  const entries: CastSalesRankingRoster["entries"] = [];
  const ids = new Set<string>();
  for (const entry of raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : Object.values(raw)) {
    requireValue(record(entry) && Object.keys(entry).every((key) => key === "id" || key === "name"), "売上順位表の在籍者情報が正しくありません。");
    named(entry.id, "売上順位表のキャストID");
    named(entry.name, "売上順位表のキャスト名");
    requireValue(!ids.has(entry.id), "売上順位表の在籍者名簿に同じキャストIDが重複しています。");
    ids.add(entry.id);
    entries.push({ id: entry.id, name: entry.name });
  }
  return { schemaVersion: 1, entries };
}

function monthBounds(month: string) {
  requireValue(typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month), "対象月が正しくありません。");
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${lastDay}` };
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function amount(value: unknown, label: string): number {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER, `${label}を確認できません。`);
  return value;
}

function count(value: unknown, label: string): number {
  requireValue(Number.isSafeInteger(value) && Number(value) >= 0, `${label}を確認できません。`);
  return Number(value);
}

function same(actual: unknown, expected: number, label: string) {
  const value = amount(actual, label);
  amount(expected, label);
  requireValue(Math.abs(value - expected) <= Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(expected)) * 16,
    `${label}が保存済み内訳と一致しません。月次データを確認してください。`);
}

function index<T extends { id: string }>(rows: T[], label: string): Map<string, T> {
  requireValue(Array.isArray(rows), `${label}が保存されていません。`);
  const result = new Map<string, T>();
  for (const row of rows) {
    named(row?.id, `${label}のキャストID`);
    requireValue(!result.has(row.id), `${label}のキャストIDが重複しています。`);
    result.set(row.id, row);
  }
  return result;
}

const totalKeys = ["honShimeiSales", "jonaiExtensionSales", "additionalSales", "totalSales", "honShimeiCount", "banaiShimeiCount", "dohanCount", "hours"] as const;
const countKeys = new Set<string>(["honShimeiCount", "banaiShimeiCount", "dohanCount"]);
const labels: Record<typeof totalKeys[number], string> = {
  honShimeiSales: "本指名売上", jonaiExtensionSales: "場内延長売上", additionalSales: "追加売上", totalSales: "売上合計",
  honShimeiCount: "本指名本数", banaiShimeiCount: "場内指名本数", dohanCount: "同伴本数", hours: "勤務時間",
};

function regularRow(reward: CastReward, report: CastSalesReport | undefined, month: string): CastSalesRankingRow {
  requireValue(report, `${reward.name || reward.id}のキャスト売上が保存されていません。`);
  named(report.name, `${reward.id}のキャスト名`);
  const label = report.name;
  requireValue(report.totals && Array.isArray(report.days), `${label}の売上内訳が保存されていません。`);
  const values = {} as Pick<CastSalesRankingRow, typeof totalKeys[number]>;
  for (const key of totalKeys) {
    // 追加売上がない時代の保存結果だけは0円として扱う。必須項目の欠損は補完しない。
    const raw = key === "additionalSales" && report.totals[key] === undefined ? 0 : report.totals[key];
    values[key] = (countKeys.has(key) ? count : amount)(raw, `${label}の${labels[key]}`);
  }
  same(values.totalSales, values.honShimeiSales + values.jonaiExtensionSales + values.additionalSales, `${label}の売上合計`);
  const sums = Object.fromEntries(totalKeys.map((key) => [key, 0])) as typeof values;
  const dates = new Set<string>();
  for (const day of report.days) {
    requireValue(day && validDate(day.businessDate) && day.businessDate.startsWith(`${month}-`), `${label}の営業日が対象月と一致しません。`);
    dates.add(day.businessDate);
    for (const key of totalKeys) {
      const raw = key === "additionalSales" && day[key] === undefined ? 0 : day[key];
      sums[key] += (countKeys.has(key) ? count : amount)(raw, `${label} ${day.businessDate}の${labels[key]}`);
    }
    same(day.totalSales, day.honShimeiSales + day.jonaiExtensionSales + (day.additionalSales ?? 0), `${label} ${day.businessDate}の売上合計`);
  }
  for (const key of totalKeys) same(values[key], sums[key], `${label}の${labels[key]}月合計`);
  same(count(report.attendanceDays, `${label}の出勤日数`), dates.size, `${label}の出勤日数`);
  same(count(report.totals.attendanceDays, `${label}の合計出勤日数`), dates.size, `${label}の合計出勤日数`);
  same(count(reward.days, `${label}の報酬出勤日数`), dates.size, `${label}の報酬出勤日数`);
  same(reward.hours, values.hours, `${label}の報酬勤務時間`);
  same(reward.honShimeiSales, values.honShimeiSales, `${label}の報酬本指名売上`);
  same(reward.jonaiExtensionSales, values.jonaiExtensionSales, `${label}の報酬場内延長売上`);
  same(reward.additionalSales === undefined ? 0 : reward.additionalSales, values.additionalSales, `${label}の報酬追加売上`);
  return { rank: 0, id: report.id, name: report.name, ...values };
}

function sourceRows(results: Results, month: string) {
  monthBounds(month);
  requireValue(results && (results.month === undefined || results.month === month), "保存済み月次データの対象月が一致しません。");
  const rewards = index(results.castRewards, "キャスト報酬");
  const reports = index(results.castSalesReports, "キャスト売上");
  for (const id of reports.keys()) requireValue(rewards.has(id), `キャスト売上のID「${id}」と報酬データが一致しません。`);
  const rows: CastSalesRankingRow[] = [];
  for (const reward of rewards.values()) {
    requireValue(typeof reward.trialOnly === "boolean", `${reward.name || reward.id}の在籍・体入区分を確認できません。`);
    if (!reward.trialOnly) rows.push(regularRow(reward, reports.get(reward.id), month));
  }
  return { rows, rewards };
}

/** 未確定月の名簿を作成する。勤務済みの名前は月次結果から保持し、未出勤者だけ対象月の在籍期間で補う。 */
export function buildCastSalesRankingRoster(results: Results, casts: CastRecord[], month: string): CastSalesRankingRoster {
  const { rows, rewards } = sourceRows(results, month);
  const bounds = monthBounds(month);
  const entries = new Map(rows.map((row) => [row.id, { id: row.id, name: row.name }]));
  for (const cast of index(casts, "キャスト名簿").values()) {
    if (entries.has(cast.id) || rewards.get(cast.id)?.trialOnly || cast.status === "trial" || cast.deletedAt || cast.convertedToCastId) continue;
    requireValue(cast.status === "active" || cast.status === "departed", `${cast.name || cast.id}の在籍区分を確認できません。`);
    named(cast.name, `${cast.id}のキャスト名`);
    requireValue(validDate(cast.hiredAt), `${cast.name}の採用日を確認できないため、売上順位表の対象月の在籍を判定できません。`);
    if (cast.departedAt !== undefined) {
      requireValue(validDate(cast.departedAt) && cast.departedAt >= cast.hiredAt, `${cast.name}の退店日を確認できません。`);
    }
    requireValue(cast.status !== "departed" || !!cast.departedAt, `${cast.name}の退店日が保存されていません。`);
    if (cast.hiredAt <= bounds.last && (!cast.departedAt || cast.departedAt >= bounds.first)) entries.set(cast.id, { id: cast.id, name: cast.name });
  }
  return { schemaVersion: 1, entries: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

/** 保存された売上を転記するだけとし、給与・売上の再計算や丸めを行わない。 */
export function buildCastSalesRanking(results: Results, month: string, roster?: CastSalesRankingRoster): CastSalesRanking {
  const { rows, rewards } = sourceRows(results, month);
  const normalized = normalizeCastSalesRankingRoster(roster);
  const included = new Set(rows.map((row) => row.id));
  if (normalized) {
    const rosterIds = new Set(normalized.entries.map((entry) => entry.id));
    for (const row of rows) requireValue(rosterIds.has(row.id), `${row.name}が保存済み売上順位表名簿に見つかりません。`);
    for (const entry of normalized.entries) {
      requireValue(!rewards.get(entry.id)?.trialOnly, `${entry.name}の体入区分と売上順位表名簿が一致しません。`);
      if (included.has(entry.id)) continue;
      rows.push({ rank: 0, id: entry.id, name: entry.name, honShimeiSales: 0, jonaiExtensionSales: 0, additionalSales: 0,
        totalSales: 0, honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, hours: 0 });
    }
  }
  rows.sort((a, b) => b.totalSales - a.totalSales || a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id));
  rows.forEach((row, index) => { row.rank = index && rows[index - 1].totalSales === row.totalSales ? rows[index - 1].rank : index + 1; });
  return { rows, rosterMissing: normalized === undefined };
}
