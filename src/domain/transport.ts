import { castIdentityForMonth, type CastAccountingInput, type DailyClosing, type MonthlyAdjustments, type WorkspaceData } from "./gms";
import { normalizeCastAccountingInputs, resolveCastAccountingInputs } from "./cast-accounting-inputs";

export const TRANSPORT_AMOUNTS = [500, 1000, 1500, 2000] as const;
export type TransportSettings = {
  revision: number;
  castRegistrations: Record<string, { amounts: number[] }>;
  remoteAmounts: number[];
  updatedAt?: string;
  updatedBy?: string;
};
export type CastTransportDay = {
  amount: number;
  legacyInputIds: string[];
  attendanceClosingId: string;
  attendanceIndex: number;
};
export type DriverTransportDay = {
  entries: Record<string, number>;
  attendanceClosingId: string;
  attendanceIndex: number;
};
export type TransportMonth = {
  revision: number;
  casts: Record<string, Record<string, CastTransportDay>>;
  drivers: Record<string, Record<string, DriverTransportDay>>;
  updatedAt?: string;
  updatedBy?: string;
};

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const amount = (value: unknown): value is number => typeof value === "number" && (TRANSPORT_AMOUNTS as readonly number[]).includes(value);
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function map(value: unknown, label: string): Record<string, unknown> {
  if (value == null) return {};
  requireValue(object(value) || Array.isArray(value), `${label}の保存形式が不正です。`);
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child != null));
}
function list(value: unknown, label: string): unknown[] { return Object.values(map(value, label)); }
function amounts(value: unknown, label: string, required = false): number[] {
  const rows = list(value, label);
  requireValue((!required || rows.length > 0) && rows.every(amount) && new Set(rows).size === rows.length,
    `${label}は500円・1,000円・1,500円・2,000円から重複なく選択してください。`);
  return (rows as number[]).sort((a, b) => a - b);
}
function metadata(value: Record<string, unknown>) {
  requireValue(value.revision === undefined || Number.isSafeInteger(value.revision) && Number(value.revision) >= 0, "送迎の保存世代が不正です。");
  requireValue(value.updatedAt === undefined || typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)), "送迎の更新日時が不正です。");
  requireValue(value.updatedBy === undefined || typeof value.updatedBy === "string" && value.updatedBy.length > 0, "送迎の更新者が不正です。");
  return { revision: Number(value.revision || 0),
    ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt as string }),
    ...(value.updatedBy === undefined ? {} : { updatedBy: value.updatedBy as string }) };
}

/** Firebaseの空map・数値キーの配列表現を復元し、不正金額は黙って除去しない。 */
export function normalizeTransportSettings(value: unknown): TransportSettings {
  if (value == null) return { revision: 0, castRegistrations: {}, remoteAmounts: [] };
  requireValue(object(value), "送迎設定の保存形式が不正です。");
  const castRegistrations = Object.fromEntries(Object.entries(map(value.castRegistrations, "キャスト送迎登録")).map(([id, row]) => {
    requireValue(identifier(id) && object(row), "キャスト送迎登録の人物IDが不正です。");
    return [id, { amounts: amounts(row.amounts, "キャスト送迎金額", true) }];
  }));
  return { ...metadata(value), castRegistrations, remoteAmounts: amounts(value.remoteAmounts, "遠方手当金額") };
}

export function normalizeTransportMonth(value: unknown): TransportMonth {
  if (value == null) return { revision: 0, casts: {}, drivers: {} };
  requireValue(object(value), "送迎記録の保存形式が不正です。");
  const people = <T>(source: unknown, parse: (row: Record<string, unknown>) => T): Record<string, Record<string, T>> =>
    Object.fromEntries(Object.entries(map(source, "送迎記録")).map(([id, days]) => {
      requireValue(identifier(id), "送迎記録の人物IDが不正です。");
      return [id, Object.fromEntries(Object.entries(map(days, "送迎日別記録")).map(([businessDate, row]) => {
        requireValue(date(businessDate) && object(row), "送迎記録の日付・保存形式が不正です。");
        requireValue(identifier(row.attendanceClosingId) && Number.isSafeInteger(row.attendanceIndex) && Number(row.attendanceIndex) >= 0,
          "送迎記録の出勤根拠が不正です。");
        return [businessDate, parse(row)];
      }))];
    }));
  const attendance = (row: Record<string, unknown>) => ({ attendanceClosingId: row.attendanceClosingId as string, attendanceIndex: row.attendanceIndex as number });
  const casts = people(value.casts, (row): CastTransportDay => {
    const ids = list(row.legacyInputIds, "旧送迎入力ID");
    requireValue((row.amount === 0 || amount(row.amount)) && ids.every(identifier) && new Set(ids).size === ids.length,
      "送迎記録の金額・旧送迎入力IDが不正です。");
    return { ...attendance(row), amount: row.amount as number, legacyInputIds: ids as string[] };
  });
  const drivers = people(value.drivers, (row): DriverTransportDay => {
    const entries = map(row.entries, "遠方手当の内訳");
    requireValue(Object.entries(entries).every(([id, value]) => identifier(id) && amount(value)), "遠方手当の内訳金額が不正です。");
    return { ...attendance(row), entries: entries as Record<string, number> };
  });
  return { ...metadata(value), casts, drivers };
}

function castIdentity(data: WorkspaceData, month: string) {
  const casts = data.casts;
  const byId = new Map(casts.map((cast) => [cast.id, cast]));
  const regularIds = new Set(data.closings.filter((closing) => closing.businessDate.startsWith(`${month}-`)
    && (closing.status === "approved" || closing.status === "submitted"))
    .flatMap((closing) => (closing.casts || []).filter((cast) => cast.kind === "regular").map((cast) => cast.masterId)));
  return (row: DailyClosing["casts"][number]) => castIdentityForMonth(row, byId, casts, month, regularIds);
}

export function transportAttendance(data: WorkspaceData, month: string, id: string, kind: "cast" | "driver") {
  const identity = castIdentity(data, month);
  return data.closings.filter((closing) => date(closing.businessDate) && closing.businessDate.startsWith(`${month}-`)
    && (closing.status === "submitted" || closing.status === "approved")).flatMap((closing) =>
    kind === "cast" ? (closing.casts || []).flatMap((row, index) => identity(row) === id
      ? [{ businessDate: closing.businessDate, closingId: closing.id, index }] : [])
      : (closing.drivers || []).flatMap((row, index) => row.driverId === id
        ? [{ businessDate: closing.businessDate, closingId: closing.id, index }] : []))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.closingId.localeCompare(b.closingId) || a.index - b.index);
}

function legacyInputs(data: WorkspaceData, month: string) {
  const adjustment = data.adjustments.find((row) => row.month === month);
  return normalizeCastAccountingInputs(adjustment?.castInputs ?? data.transportLegacyInputs?.[month]);
}

function legacyInputDate(data: WorkspaceData, month: string, input: CastAccountingInput, resolved: Array<CastAccountingInput & { businessDate: string }>) {
  const businessDate = input.businessDate ?? resolved.find((row) => row.id === input.id)?.businessDate
    ?? data.closings.find((row) => row.id === input.attendanceClosingId)?.businessDate;
  return businessDate?.startsWith(month + "-") ? businessDate : undefined;
}

/** 日付を推測できない旧送迎は警告・削除制限に使い、カレンダーから黙って失わせない。 */
export function transportUnresolvedLegacyInputs(data: WorkspaceData, month: string, castId: string): CastAccountingInput[] {
  const overrides = normalizeTransportMonth(data.transportMonths?.[month]).casts[castId] || {};
  const consumedIds = new Set(Object.values(overrides).flatMap((day) => day.legacyInputIds));
  const inputs = legacyInputs(data, month).filter((input) => input.kind === "transport" && input.castId === castId);
  const resolved = resolveCastAccountingInputs({ month, castInputs: inputs }, data.closings, data.casts, month).inputs;
  return inputs.filter((input) => input.amount > 0 && !consumedIds.has(input.id) && !legacyInputDate(data, month, input, resolved));
}

/** 旧日次・旧追加入力と編集後の額を一つの日別明細として表示する。0円の上書きは削除履歴。 */
export function transportCastDays(data: WorkspaceData, month: string, castId: string) {
  const overrides = normalizeTransportMonth(data.transportMonths?.[month]).casts[castId] || {};
  const consumedIds = new Set(Object.values(overrides).flatMap((day) => day.legacyInputIds));
  const result = new Map<string, { businessDate: string; amount: number; legacyInputIds: string[]; hasRecord: boolean }>();
  const getDay = (businessDate: string) => {
    let row = result.get(businessDate);
    if (!row) { row = { businessDate, amount: 0, legacyInputIds: [], hasRecord: false }; result.set(businessDate, row); }
    return row;
  };
  const identity = castIdentity(data, month);
  // 差戻し・取下げ後も保存済みの旧額を確認・削除できる。給与計算は別途承認日だけを採用する。
  for (const closing of data.closings.filter((row) => row.businessDate.startsWith(`${month}-`))) {
    for (const row of closing.casts || []) if (identity(row) === castId && row.transportFee > 0) {
      getDay(closing.businessDate).amount += row.transportFee;
    }
  }
  for (const source of transportAttendance(data, month, castId, "cast")) getDay(source.businessDate);
  for (const [businessDate, override] of Object.entries(overrides)) {
    const day = getDay(businessDate);
    day.amount = override.amount;
    day.legacyInputIds = [...override.legacyInputIds];
  }
  const inputs = legacyInputs(data, month).filter((input) => input.kind === "transport" && input.castId === castId);
  const resolved = resolveCastAccountingInputs({ month, castInputs: inputs }, data.closings, data.casts, month).inputs;
  // 指定済みの旧記録は差戻し後も見えるよう保持する。日付未指定分だけ従来の最終承認日へ解決する。
  for (const input of inputs) {
    if (consumedIds.has(input.id)) continue;
    const businessDate = legacyInputDate(data, month, input, resolved);
    if (!businessDate || !businessDate.startsWith(`${month}-`)) continue;
    const day = getDay(businessDate);
    day.amount += input.amount;
    day.legacyInputIds.push(input.id);
  }
  return [...result.values()].map((day) => ({ ...day, hasRecord: day.amount > 0 }))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}

/** 永続化した旧データには触れず、月次計算への入力だけを置き換える。 */
export function applyTransport(data: WorkspaceData, month: string, adjustments: MonthlyAdjustments): {
  closings: DailyClosing[]; adjustments: MonthlyAdjustments; issues: string[];
} {
  try {
    const records = normalizeTransportMonth(data.transportMonths?.[month]);
    const inputs = normalizeCastAccountingInputs(adjustments.castInputs);
    const issues: string[] = [];
    const consumed = new Set<string>();
    const added: CastAccountingInput[] = [];
    const identity = castIdentity(data, month);
    const checkSource = (id: string, businessDate: string, kind: "cast" | "driver", record: CastTransportDay | DriverTransportDay, nonzero: boolean) => {
      if (!businessDate.startsWith(`${month}-`)) { issues.push(`${businessDate}の送迎記録が対象月と一致しません。`); return false; }
      if (!nonzero) return false;
      const source = transportAttendance(data, month, id, kind).find((row) => row.businessDate === businessDate
        && row.closingId === record.attendanceClosingId && row.index === record.attendanceIndex);
      const name = (kind === "cast" ? data.casts : data.drivers).find((row) => row.id === id)?.name || id;
      const label = kind === "cast" ? "送迎記録" : "遠方手当";
      if (!source) { issues.push(`${businessDate}・${name}の${label}に対応する送信済み出勤がありません。差戻し・出勤変更を確認してください。`); return false; }
      if (data.closings.find((row) => row.id === source.closingId)?.status !== "approved") {
        issues.push(`${businessDate}・${name}の${label}は日次の承認待ちのため給与へ未反映です。`); return false;
      }
      return true;
    };
    for (const [castId, days] of Object.entries(records.casts)) for (const [businessDate, record] of Object.entries(days)) {
      for (const id of record.legacyInputIds) {
        const input = inputs.find((row) => row.id === id);
        if (!input || input.kind !== "transport" || input.castId !== castId) {
          issues.push(`${businessDate}の送迎記録と旧送迎入力の対応が一致しません。`); continue;
        }
        if (consumed.has(id)) issues.push(`${input.castName}の旧送迎入力が複数の送迎記録に関連付いています。`);
        consumed.add(id);
      }
      if (!checkSource(castId, businessDate, "cast", record, record.amount > 0)) continue;
      const id = `transport_${castId}_${businessDate}`;
      if (inputs.some((input) => input.id === id)) { issues.push("送迎記録とキャスト入力のIDが重複しています。"); continue; }
      added.push({ id, castId, castName: data.casts.find((row) => row.id === castId)?.name || castId,
        kind: "transport", label: "送迎代", amount: record.amount, businessDate,
        attendanceClosingId: record.attendanceClosingId, attendanceIndex: record.attendanceIndex });
    }
    const closings = data.closings.map((closing) => !closing.businessDate.startsWith(`${month}-`) ? closing : {
      ...closing, casts: (closing.casts || []).map((row) => records.casts[identity(row)]?.[closing.businessDate] === undefined
        ? row : { ...row, transportFee: 0 }),
    });
    const driverRemoteAllowance = { ...adjustments.driverRemoteAllowance };
    for (const [driverId, days] of Object.entries(records.drivers)) for (const [businessDate, record] of Object.entries(days)) {
      const total = Object.values(record.entries).reduce((sum, amount) => sum + amount, 0);
      if (!Number.isSafeInteger(total)) { issues.push(`${businessDate}の遠方手当合計が処理可能な範囲を超えています。`); continue; }
      if (checkSource(driverId, businessDate, "driver", record, total > 0)) {
        driverRemoteAllowance[driverId] = (driverRemoteAllowance[driverId] || 0) + total;
        if (!Number.isSafeInteger(driverRemoteAllowance[driverId])) issues.push(`${driverId}の遠方手当月額が処理可能な範囲を超えています。`);
      }
    }
    return { closings, adjustments: { ...adjustments, driverRemoteAllowance,
      ...(adjustments.castInputs !== undefined || added.length ? { castInputs: [...inputs.filter((input) => !consumed.has(input.id)), ...added] } : {}) }, issues };
  } catch (error) {
    return { closings: data.closings, adjustments, issues: [error instanceof Error ? error.message : "送迎記録を確認できません。"] };
  }
}
