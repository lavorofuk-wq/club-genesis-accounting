import type { DailyClosing, WorkspaceData } from "./gms";

export const BEAUTY_ALLOWANCE_AMOUNT = 500;
export type BeautyDay = {
  eligible: boolean;
  attendanceClosingId: string;
  attendanceIndex: number;
  /** 日次の照合先が変わっても旧額を復活させないためのPOS人物ID。 */
  attendancePosCastId: string;
};
export type BeautyMonth = {
  revision: number;
  casts: Record<string, Record<string, BeautyDay>>;
  updatedAt?: string;
  updatedBy?: string;
};

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function map(value: unknown, label: string): Record<string, unknown> {
  if (value == null) return {};
  requireValue(object(value) || Array.isArray(value), label + "の保存形式が不正です。");
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child != null));
}

/** Firebaseの空map・数値キー配列を復元する。「なし」のfalseも保存済みの明示指定として保持する。 */
export function normalizeBeautyMonth(value: unknown): BeautyMonth {
  if (value == null) return { revision: 0, casts: {} };
  requireValue(object(value), "美容室手当の保存形式が不正です。");
  requireValue(value.revision === undefined || Number.isSafeInteger(value.revision) && Number(value.revision) >= 0, "美容室手当の保存世代が不正です。");
  requireValue(value.updatedAt === undefined || typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)), "美容室手当の更新日時が不正です。");
  requireValue(value.updatedBy === undefined || typeof value.updatedBy === "string" && value.updatedBy.length > 0, "美容室手当の更新者が不正です。");
  const casts = Object.fromEntries(Object.entries(map(value.casts, "美容室手当のキャスト記録")).map(([id, days]) => {
    requireValue(identifier(id), "美容室手当のキャストIDが不正です。");
    return [id, Object.fromEntries(Object.entries(map(days, "美容室手当の日別記録")).map(([businessDate, row]) => {
      requireValue(date(businessDate) && object(row), "美容室手当の日付・保存形式が不正です。");
      requireValue(typeof row.eligible === "boolean", "美容室手当の可否が不正です。");
      requireValue(identifier(row.attendanceClosingId) && Number.isSafeInteger(row.attendanceIndex) && Number(row.attendanceIndex) >= 0,
        "美容室手当の出勤根拠が不正です。");
      requireValue(typeof row.attendancePosCastId === "string" && row.attendancePosCastId.length > 0, "美容室手当のPOS人物IDが不正です。");
      return [businessDate, { eligible: row.eligible, attendanceClosingId: row.attendanceClosingId, attendanceIndex: row.attendanceIndex as number, attendancePosCastId: row.attendancePosCastId }];
    }))];
  }));
  return { revision: Number(value.revision || 0), casts,
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt as string }),
    ...(value.updatedBy === undefined ? {} : { updatedBy: value.updatedBy as string }) };
}

/** 現在の在籍状態ではなく、保存された出勤日の在籍区分とmasterIdで対象を特定する。 */
export function beautyAttendance(data: WorkspaceData, month: string, castId: string) {
  return data.closings.filter((closing) => date(closing.businessDate) && closing.businessDate.startsWith(month + "-")
    && (closing.status === "submitted" || closing.status === "approved"))
    .flatMap((closing) => (closing.casts || []).flatMap((row, index) => row.kind === "regular" && row.masterId === castId
      ? [{ businessDate: closing.businessDate, closingId: closing.id, index, posCastId: row.posCastId }] : []))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.closingId.localeCompare(b.closingId) || a.index - b.index);
}

const sourceKey = (closingId: string, businessDate: string, posCastId: string) => JSON.stringify([closingId, businessDate, posCastId]);
function recordedSources(records: BeautyMonth, month: string) {
  return new Set(Object.values(records.casts).flatMap((days) => Object.entries(days)
    .filter(([businessDate]) => businessDate.startsWith(month + "-"))
    .map(([businessDate, row]) => sourceKey(row.attendanceClosingId, businessDate, row.attendancePosCastId))));
}

/** 旧在籍手当を日別に引き継ぎ、明示的な「なし」を旧500円より優先する。体入経費には触れない。 */
export function beautyCastDays(data: WorkspaceData, month: string, castId: string): Array<{
  businessDate: string; eligible: boolean | null; hasRecord: boolean; legacy: boolean;
}> {
  const records = normalizeBeautyMonth(data.beautyMonths?.[month]);
  const overrides = records.casts[castId] || {};
  const suppressedSources = recordedSources(records, month);
  const result = new Map<string, { businessDate: string; eligible: boolean | null; hasRecord: boolean; legacy: boolean }>();
  for (const source of beautyAttendance(data, month, castId)) {
    result.set(source.businessDate, { businessDate: source.businessDate, eligible: null, hasRecord: false, legacy: false });
  }
  // 差戻し・取下げ後も旧手当の存在を隠さない。給与への採用可否はapplyBeautyAllowancesで判定する。
  for (const closing of data.closings.filter((row) => date(row.businessDate) && row.businessDate.startsWith(month + "-"))) {
    for (const row of closing.casts || []) {
      if (row.kind !== "regular" || row.masterId !== castId || !row.beautyAllowance
        || suppressedSources.has(sourceKey(closing.id, closing.businessDate, row.posCastId))) continue;
      requireValue(row.beautyAllowance === BEAUTY_ALLOWANCE_AMOUNT, closing.businessDate + "・" + row.name + "の旧美容室手当が500円ではありません。");
      result.set(closing.businessDate, { businessDate: closing.businessDate, eligible: true, hasRecord: true, legacy: true });
    }
  }
  for (const [businessDate, override] of Object.entries(overrides)) {
    requireValue(businessDate.startsWith(month + "-"), businessDate + "の美容室手当が対象月と一致しません。");
    result.set(businessDate, { businessDate, eligible: override.eligible, hasRecord: true, legacy: false });
  }
  return [...result.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}

/** 日次原本と体入経費を保持し、月次計算に渡す在籍手当だけを新しい日別指定で置き換える。 */
export function applyBeautyAllowances(data: WorkspaceData, month: string): { closings: DailyClosing[]; issues: string[] } {
  try {
    const records = normalizeBeautyMonth(data.beautyMonths?.[month]);
    const issues: string[] = [];
    const suppressedSources = recordedSources(records, month);
    const accepted = new Map<string, { closingId: string; index: number }>();
    for (const [castId, days] of Object.entries(records.casts)) {
      for (const [businessDate, record] of Object.entries(days)) {
        if (!businessDate.startsWith(month + "-")) { issues.push(businessDate + "の美容室手当が対象月と一致しません。"); continue; }
        // 「なし」は旧額の取消しとして、差戻し・出勤変更後も有効なまま保持する。
        if (!record.eligible) continue;
        const source = beautyAttendance(data, month, castId).find((row) => row.businessDate === businessDate
          && row.closingId === record.attendanceClosingId && row.index === record.attendanceIndex
          && row.posCastId === record.attendancePosCastId);
        const name = data.casts.find((row) => row.id === castId)?.name || castId;
        if (!source) { issues.push(businessDate + "・" + name + "の美容室手当に対応する送信済みの在籍出勤がありません。差戻し・出勤変更を確認してください。"); continue; }
        if (data.closings.find((row) => row.id === source.closingId)?.status !== "approved") {
          issues.push(businessDate + "・" + name + "の美容室手当は日次の承認待ちのため報酬へ未反映です。"); continue;
        }
        accepted.set(castId + "/" + businessDate, { closingId: source.closingId, index: source.index });
      }
    }
    const closings = data.closings.map((closing) => !closing.businessDate.startsWith(month + "-") ? closing : {
      ...closing, casts: (closing.casts || []).map((row, index) => {
        if (row.kind !== "regular") return row;
        const source = accepted.get(row.masterId + "/" + closing.businessDate);
        // 元の人物Aの取消しより、照合修正後の人物Bが明示的に登録した可を優先する。
        if (source?.closingId === closing.id && source.index === index) return { ...row, beautyAllowance: BEAUTY_ALLOWANCE_AMOUNT };
        const suppressed = records.casts[row.masterId]?.[closing.businessDate] !== undefined
          || suppressedSources.has(sourceKey(closing.id, closing.businessDate, row.posCastId));
        return suppressed ? { ...row, beautyAllowance: 0 } : row;
      }),
    });
    return { closings, issues };
  } catch (error) {
    return { closings: data.closings, issues: [error instanceof Error ? error.message : "美容室手当を確認できません。"] };
  }
}
