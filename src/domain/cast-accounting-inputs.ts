import { castIdentityForMonth, type CastAccountingInput, type CastRecord, type DailyClosing,
  type MonthlyAdjustments, type ResolvedCastAccountingInput } from "./gms";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const kind = (value: unknown): value is CastAccountingInput["kind"] => value === "sales" || value === "allowance" || value === "transport";
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** 入力時だけ売上を10円未満切捨てる。手当・送迎は単位不正を丸めず通知する。 */
export function castAccountingInputAmount(type: CastAccountingInput["kind"], value: number): number {
  requireValue(kind(type) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER,
    "キャストデータ入力の金額は0円以上の数値で入力してください。");
  if (type === "sales") return Math.floor(value / 10) * 10;
  requireValue(Number.isSafeInteger(value), "手当・送迎は1円未満の金額を入力できません。");
  requireValue(type !== "transport" || value % 500 === 0, "送迎は500円単位で入力してください。");
  return value;
}

/** 保存済み配列の検証。補正・再丸め・不正行の黙示削除は行わない。 */
export function normalizeCastAccountingInputs(value: unknown): CastAccountingInput[] {
  if (value === undefined || value === null) return [];
  requireValue(Array.isArray(value) || object(value), "キャストデータ入力の保存形式が不正です。");
  if (!Array.isArray(value)) requireValue(Object.entries(value).every(([key, row]) => object(row) && row.id === key),
    "キャストデータ入力の保存キーと入力IDが一致しません。");
  const rows: unknown[] = Array.isArray(value) ? value.filter((row) => row != null) : Object.values(value);
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const label = `キャストデータ入力${index + 1}件目`;
    requireValue(object(row) && identifier(row.id) && identifier(row.castId) && text(row.castName)
      && kind(row.kind) && text(row.label) && row.label.length <= 100, `${label}のID・キャスト・区分・名目が不正です。`);
    requireValue(!seen.has(row.id), `${label}の入力IDが重複しています。`);
    seen.add(row.id);
    requireValue(typeof row.amount === "number" && Number.isSafeInteger(row.amount) && row.amount >= 0
      && (row.kind !== "sales" || row.amount % 10 === 0) && (row.kind !== "transport" || row.amount % 500 === 0),
    `${row.castName}「${row.label}」の保存金額の単位が不正です。`);
    requireValue(row.businessDate === undefined || date(row.businessDate), `${row.castName}「${row.label}」の日付が不正です。`);
    requireValue(row.kind !== "sales" || row.businessDate !== undefined, `${row.castName}「${row.label}」の売上には日付が必要です。`);
    requireValue(row.attendanceClosingId === undefined || identifier(row.attendanceClosingId), `${label}の出勤根拠IDが不正です。`);
    requireValue(row.attendanceIndex === undefined || Number.isSafeInteger(row.attendanceIndex) && Number(row.attendanceIndex) >= 0,
      `${label}の出勤根拠位置が不正です。`);
    return { id: row.id, castId: row.castId, castName: row.castName, kind: row.kind, label: row.label, amount: row.amount,
      ...(row.businessDate === undefined ? {} : { businessDate: row.businessDate as string }),
      ...(row.attendanceClosingId === undefined ? {} : { attendanceClosingId: row.attendanceClosingId as string }),
      ...(row.attendanceIndex === undefined ? {} : { attendanceIndex: row.attendanceIndex as number }) };
  });
}

export type CastAccountingAttendanceSource = {
  businessDate: string; closingId: string; castIndex: number; masterId: string; posCastId: string; castId: string; castName: string;
};

export function castAccountingAttendanceSources(closings: DailyClosing[], casts: CastRecord[], month: string, castId: string): CastAccountingAttendanceSource[] {
  const approved = closings.filter((closing) => closing.status === "approved" && date(closing.businessDate) && closing.businessDate.startsWith(`${month}-`));
  const byId = new Map(casts.map((cast) => [cast.id, cast]));
  const regularIds = new Set(approved.flatMap((closing) => (closing.casts || []).filter((cast) => cast.kind === "regular").map((cast) => cast.masterId)));
  return approved.flatMap((closing) => (closing.casts || []).flatMap((cast, castIndex) => {
    const identity = castIdentityForMonth(cast, byId, casts, month, regularIds);
    return identity === castId ? [{ businessDate: closing.businessDate, closingId: closing.id, castIndex,
      masterId: cast.masterId, posCastId: cast.posCastId, castId: identity, castName: cast.name }] : [];
  })).sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.closingId.localeCompare(b.closingId) || a.castIndex - b.castIndex);
}

export function castAccountingAttendanceDays(closings: DailyClosing[], casts: CastRecord[], month: string, castId: string): string[] {
  return [...new Set(castAccountingAttendanceSources(closings, casts, month, castId).map((source) => source.businessDate))];
}

export function resolveCastAccountingInputs(adjustments: Pick<MonthlyAdjustments, "month" | "castInputs"> | undefined,
  closings: DailyClosing[], casts: CastRecord[], month: string): { inputs: ResolvedCastAccountingInput[]; issues: string[] } {
  if (adjustments?.castInputs === undefined) return { inputs: [], issues: [] };
  try {
    requireValue(adjustments.month === month, "キャストデータ入力と計算対象月が一致しません。");
    const inputs = normalizeCastAccountingInputs(adjustments.castInputs);
    const resolved: ResolvedCastAccountingInput[] = [];
    const issues: string[] = [];
    const attendanceByCast = new Map<string, string[]>();
    for (const input of inputs) {
      const label = `${input.castName}「${input.label}」`;
      const days = attendanceByCast.get(input.castId) ?? castAccountingAttendanceDays(closings, casts, month, input.castId);
      attendanceByCast.set(input.castId, days);
      if (!days.length) { issues.push(`${label}に対応する当月の承認済み出勤がありません。キャストデータ入力を確認してください。`); continue; }
      if (input.businessDate !== undefined && (!input.businessDate.startsWith(`${month}-`) || !days.includes(input.businessDate))) {
        issues.push(`${label}の指定日${input.businessDate}は本人の当月承認済み出勤日ではありません。差戻し状態または入力日付を確認してください。`); continue;
      }
      resolved.push({ ...input, businessDate: input.businessDate ?? days.at(-1)! });
    }
    castAccountingInputTotals(resolved);
    return { inputs: resolved, issues };
  } catch (error) { return { inputs: [], issues: [error instanceof Error ? error.message : "キャストデータ入力を確認できません。"] }; }
}

export function castAccountingInputTotals(inputs: readonly CastAccountingInput[]) {
  const total = (type: CastAccountingInput["kind"]) => inputs.filter((input) => input.kind === type).reduce((sum, input) => sum + input.amount, 0);
  const result = { additionalSales: total("sales"), additionalAllowance: total("allowance"), additionalTransportFee: total("transport") };
  requireValue(Object.values(result).every((amount) => Number.isSafeInteger(amount) && amount >= 0), "キャストデータ入力の合計金額が処理可能な範囲を超えています。");
  return result;
}
