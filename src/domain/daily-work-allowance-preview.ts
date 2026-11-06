import { castIdentityForMonth, type CastRecord, type DailyClosing, type WorkspaceData } from "./gms";
import { BEAUTY_ALLOWANCE_AMOUNT, normalizeBeautyMonth } from "./beauty-allowance";
import { normalizeTransportMonth, type CastTransportDay } from "./transport";
import { approvedTrialAttendanceForCancelledEntry, normalizeCastAccountingInputs, resolveCastAccountingInputs } from "./cast-accounting-inputs";

export type DailyWorkAllowancePreview = {
  casts: Array<{ index: number; posCastId: string; beautyAllowance: number | null; transportFee: number | null }>;
  issues: string[];
};
type PreviewData = WorkspaceData & { archivedCasts?: CastRecord[] };
type Field = "beautyAllowance" | "transportFee";
const validAmount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const active = (closing: DailyClosing) => closing.status === "submitted" || closing.status === "approved";
const sourceKey = (id: string, date: string, posId: string) => JSON.stringify([id, date, posId]);

/** 店舗・受信画面だけの金額表示。日次原本や月次計算の入力へ書き戻さない。 */
export function projectDailyWorkAllowances(data: PreviewData, closing: DailyClosing): DailyWorkAllowancePreview {
  const issues: string[] = [];
  const casts = closing.casts.map((row, index) => {
    const value = (field: Field) => {
      if (validAmount(row[field])) return row[field];
      issues.push(`${closing.businessDate}・${row.name}の${field === "beautyAllowance" ? "美容室手当" : "送迎代"}の元金額を確認できません。`);
      return null;
    };
    return { index, posCastId: row.posCastId, beautyAllowance: value("beautyAllowance"), transportFee: value("transportFee") };
  });
  const month = closing.businessDate.slice(0, 7);
  const stored = data.closings.filter((row) => row.id === closing.id && row.businessDate === closing.businessDate);
  const saved = stored.length === 1 ? stored[0] : undefined;
  // 編集中の仮submittedを認めず、実際の送信元と表示中の出勤を両方照合する。
  const matchesSaved = (index: number) => {
    const row = closing.casts[index], original = saved?.casts[index];
    return Boolean(saved && active(saved) && active(closing)
      && closing.submissionId === saved.submissionId && closing.checksum === saved.checksum
      && row && original && row.masterId === original.masterId && row.posCastId === original.posCastId && row.kind === original.kind);
  };
  const fail = (field: Field, indexes: number[], message: string) => {
    indexes.forEach((index) => { casts[index][field] = null; });
    issues.push(message);
  };
  const castById = new Map<string, CastRecord>();
  (data.archivedCasts || []).forEach((row) => castById.set(row.id, row));
  data.casts.forEach((row) => castById.set(row.id, row));
  const masters = [...castById.values()];
  const regularIds = new Set(data.closings.filter((row) => active(row) && row.businessDate.startsWith(`${month}-`))
    .flatMap((row) => row.casts.filter((cast) => cast.kind === "regular").map((cast) => cast.masterId)));
  const identity = (row: DailyClosing["casts"][number]) => castIdentityForMonth(row, castById, masters, month, regularIds);
  const indexesFor = (id: string) => closing.casts.flatMap((row, index) => identity(row) === id ? [index] : []);
  const nameFor = (id: string) => castById.get(id)?.name || closing.casts.find((row) => identity(row) === id)?.name || id;

  try {
    const records = normalizeBeautyMonth(data.beautyMonths?.[month]);
    const days = Object.entries(records.casts).flatMap(([id, entries]) => Object.entries(entries)
      .filter(([date]) => date === closing.businessDate).map(([date, record]) => ({ id, date, record })));
    const suppressed = new Set(days.map(({ date, record }) => sourceKey(record.attendanceClosingId, date, record.attendancePosCastId)));
    closing.casts.forEach((row, index) => {
      if (row.kind !== "regular") return;
      if (records.casts[row.masterId]?.[closing.businessDate] !== undefined || suppressed.has(sourceKey(closing.id, closing.businessDate, row.posCastId))) {
        casts[index].beautyAllowance = saved ? 0 : null;
      }
    });
    const accepted: number[] = [];
    for (const { id, record } of days) {
      const affected = closing.casts.flatMap((row, index) => row.kind === "regular"
        && (row.masterId === id || record.attendanceClosingId === closing.id && row.posCastId === record.attendancePosCastId) ? [index] : []);
      if (!affected.length && record.attendanceClosingId !== closing.id) continue;
      if (!saved) {
        fail("beautyAllowance", affected, `${closing.businessDate}・${nameFor(id)}の美容室手当は保存済みの送信元を確認できません。`);
        continue;
      }
      // 否は取消履歴。差戻しや照合変更後も旧500円を復活させない。
      if (!record.eligible) continue;
      const row = closing.casts[record.attendanceIndex];
      if (record.attendanceClosingId !== closing.id || !matchesSaved(record.attendanceIndex)
        || row?.kind !== "regular" || row.masterId !== id || row.posCastId !== record.attendancePosCastId) {
        fail("beautyAllowance", affected, `${closing.businessDate}・${nameFor(id)}の美容室手当と送信済みの在籍出勤が一致しません。差戻し・再送・キャスト照合を確認してください。`);
        continue;
      }
      accepted.push(record.attendanceIndex);
    }
    // 元の照合先の取消より、現在の本人へ明示的に登録した可を優先する。
    accepted.forEach((index) => { casts[index].beautyAllowance = BEAUTY_ALLOWANCE_AMOUNT; });
  } catch (error) {
    fail("beautyAllowance", closing.casts.flatMap((row, index) => row.kind === "regular" ? [index] : []),
      error instanceof Error ? error.message : "美容室手当の登録を確認できません。");
  }

  try {
    const savedTransport = data.transportMonths?.[month];
    // 今回対象外の遠方手当は、キャスト送迎の表示検証へ持ち込まない。
    const records = normalizeTransportMonth(savedTransport && typeof savedTransport === "object" && !Array.isArray(savedTransport)
      ? { ...savedTransport, drivers: {} } : savedTransport);
    const adjustment = data.adjustments.find((row) => row.month === month);
    const inputs = normalizeCastAccountingInputs(adjustment?.castInputs ?? data.transportLegacyInputs?.[month])
      .filter((row) => row.kind === "transport");
    const consumed = new Set<string>();
    const restoredCastId = (id: string, businessDate: string, record: CastTransportDay) => {
      const source = approvedTrialAttendanceForCancelledEntry(data.closings, castById.get(id), month, { ...record, businessDate });
      return source ? identity(source.row) : undefined;
    };
    for (const [id, days] of Object.entries(records.casts)) {
      for (const [date, record] of Object.entries(days)) {
        for (const inputId of record.legacyInputIds) {
          const input = inputs.find((row) => row.id === inputId);
          if (!input || input.castId !== id || consumed.has(inputId) || !date.startsWith(`${month}-`)
            || input.businessDate !== undefined && input.businessDate !== date) {
            const affected = [...new Set([...indexesFor(restoredCastId(id, date, record) || id),
              ...(input ? indexesFor(input.castId) : [])])];
            if (affected.length) fail("transportFee", affected, `${nameFor(id)}の送迎記録と旧送迎入力の対応が一致しません。`);
            continue;
          }
          consumed.add(inputId);
        }
      }
    }
    // 同一人物・同日の元日額を抑制し、根拠行一つだけへ最新額を表示する。
    const restoredPositive = new Set<string>();
    for (const [id, days] of Object.entries(records.casts)) {
      const record = days[closing.businessDate];
      if (!record) continue;
      const restored = restoredCastId(id, closing.businessDate, record);
      const targetId = restored || id;
      const affected = indexesFor(targetId);
      if (!affected.length && record.attendanceClosingId !== closing.id) continue;
      if (restored && (records.casts[targetId]?.[closing.businessDate] || restoredPositive.has(targetId))) {
        if (record.amount > 0) fail("transportFee", affected,
          `${closing.businessDate}・${nameFor(targetId)}の送迎記録が入店取消後の同じ出勤日に重複しています。送迎画面で確認してください。`);
        continue;
      }
      if (restored && record.amount > 0) restoredPositive.add(targetId);
      const invalidLegacy = affected.some((index) => casts[index].transportFee === null);
      if (!saved) {
        fail("transportFee", affected, `${closing.businessDate}・${nameFor(id)}の送迎代は保存済みの送信元を確認できません。`);
        continue;
      }
      if (!invalidLegacy) affected.forEach((index) => { casts[index].transportFee = 0; });
      if (record.amount === 0) continue;
      const row = closing.casts[record.attendanceIndex];
      if (record.attendanceClosingId !== closing.id || !matchesSaved(record.attendanceIndex) || !row || identity(row) !== targetId) {
        fail("transportFee", affected, `${closing.businessDate}・${nameFor(id)}の送迎代と送信済み出勤が一致しません。差戻し・再送・キャスト照合を確認してください。`);
        continue;
      }
      if (!invalidLegacy) casts[record.attendanceIndex].transportFee = record.amount;
    }
    // 旧月額の無日付入力は、従来どおり最後の承認日に解決する。仮承認で移動させない。
    const resolved = resolveCastAccountingInputs({ month, castInputs: inputs }, data.closings, masters, month).inputs;
    for (const input of inputs) {
      if (consumed.has(input.id) || input.amount === 0) continue;
      const resolvedInput = resolved.find((row) => row.id === input.id);
      const targetId = resolvedInput?.castId || input.castId;
      const affected = indexesFor(targetId);
      if (!affected.length) continue;
      const resolvedDate = resolvedInput?.businessDate;
      const anchor = input.attendanceClosingId ? data.closings.filter((row) => row.id === input.attendanceClosingId) : [];
      const anchorDate = anchor.length === 1 ? anchor[0].businessDate : undefined;
      const date = input.businessDate ?? resolvedDate ?? anchorDate;
      if (!date || !date.startsWith(`${month}-`)) {
        fail("transportFee", affected, `${nameFor(input.castId)}の旧送迎入力「${input.label}」の日付を確認できません。別の日へ推測して表示しません。`);
        continue;
      }
      if (date !== closing.businessDate) continue;
      // 日付未指定の旧入力が承認日へ解決済みなら、古い根拠日へ戻さない。
      const useAnchor = targetId !== input.castId || input.businessDate !== undefined || resolvedDate === undefined;
      const candidates = affected.filter((index) => matchesSaved(index)
        && (!useAnchor || input.attendanceClosingId === undefined || input.attendanceClosingId === closing.id)
        && (!useAnchor || input.attendanceIndex === undefined || input.attendanceIndex === index));
      if (candidates.length !== 1) {
        fail("transportFee", affected, `${closing.businessDate}・${nameFor(input.castId)}の旧送迎入力「${input.label}」の本人の出勤元を一意に確認できません。`);
        continue;
      }
      const target = casts[candidates[0]];
      if (target.transportFee === null) continue;
      const total = target.transportFee + input.amount;
      if (!validAmount(total)) fail("transportFee", affected, `${nameFor(input.castId)}の送迎代合計が処理可能な範囲を超えています。`);
      else target.transportFee = total;
    }
  } catch (error) {
    fail("transportFee", casts.map((row) => row.index), error instanceof Error ? error.message : "送迎代の登録を確認できません。");
  }
  return { casts, issues: [...new Set(issues)] };
}
