import type { CastDailyCorrectionDocument, CastInputRevision, CastReturnHandoff, DailyCast, DailyClosing } from "./gms";
import { applyCastCorrections, materializeCastCorrectionRows, normalizeCastCorrectionDraft, type CastCorrectionWorkspace } from "./cast-corrections";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) throw new Error(message); };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function normalizeCastInputRevision(value: unknown): CastInputRevision {
  requireValue(object(value) && value.schema === 1 && text(value.handoffId)
    && Number.isSafeInteger(value.sourceCorrectionRevision) && Number(value.sourceCorrectionRevision) > 0,
  "差戻しで引き継いだキャスト入力の識別情報が不正です。");
  const originalCasts = value.originalCasts === undefined || value.originalCasts === null ? []
    : Array.isArray(value.originalCasts) ? value.originalCasts.filter(Boolean) : object(value.originalCasts) ? Object.values(value.originalCasts) : null;
  requireValue(originalCasts && originalCasts.every((row) => object(row) && [row.posCastId, row.masterId, row.name].every(text)
    && ["regular", "trial"].includes(String(row.kind)) && [row.honShimeiCount, row.banaiShimeiCount, row.dohanCount].every((count) => Number.isSafeInteger(count) && Number(count) >= 0))
    && new Set(originalCasts.map((row) => row.posCastId)).size === originalCasts.length,
  "引継ぎ前の店舗全体本数を確認できません。");
  return { schema: 1, handoffId: value.handoffId, sourceCorrectionRevision: Number(value.sourceCorrectionRevision),
    draft: normalizeCastCorrectionDraft(value.draft), originalCasts: originalCasts as CastInputRevision["originalCasts"] };
}

export function normalizeCastReturnHandoff(value: unknown, sourceClosingId: string, id: string): CastReturnHandoff {
  requireValue(object(value) && value.schema === 1 && value.id === id && value.sourceClosingId === sourceClosingId,
    "キャスト修正の引継ぎ先が一致しません。");
  const revision = normalizeCastInputRevision({ schema: 1, handoffId: id, sourceCorrectionRevision: value.sourceCorrectionRevision, draft: value.draft, originalCasts: [] });
  requireValue([value.sourceUpdatedAt, value.sourceSubmissionId, value.sourceChecksum, value.returnedAt,
    value.reason, value.createdAt, value.createdBy, value.sourceRecordJson].every(text)
    && [value.sourceUpdatedAt, value.returnedAt, value.createdAt].every((date) => Number.isFinite(Date.parse(String(date)))),
  "キャスト修正の引継ぎ記録が不完全です。");
  const source = JSON.parse(String(value.sourceRecordJson)) as DailyClosing;
  requireValue(source.id === sourceClosingId && source.updatedAt === value.sourceUpdatedAt
    && source.checksum === value.sourceChecksum && source.submissionId === value.sourceSubmissionId
    && revision.draft.sourceClosingId === sourceClosingId && revision.draft.sourceUpdatedAt === source.updatedAt
    && revision.draft.sourceChecksum === source.checksum && revision.draft.sourceSubmissionId === source.submissionId,
  "キャスト修正の引継ぎ原本が一致しません。");
  requireValue(revision.draft.entries.every((entry) => entry.targetClosingId === source.id && entry.businessDate === source.businessDate),
    "別営業日へ移動した経理修正は単日の差戻しで引き継げません。関連営業日の修正内容を確認してください。");
  return { ...value, draft: revision.draft } as CastReturnHandoff;
}

export function castReturnHandoffBlockReason(data: CastCorrectionWorkspace, closingId: string): string {
  const source = data.closings.find((row) => row.id === closingId);
  if (!source) return "差戻し対象の営業日が見つかりません。最新データを読み込んでください。";
  const related = (data.castCorrections || []).filter((doc) => doc.active && doc.current && (doc.sourceClosingId === source.id
    || doc.current.entries.some((entry) => entry.targetClosingId === source.id)));
  const affected = new Set(related.flatMap((doc) => doc.current!.entries.filter((entry) => entry.targetClosingId !== source.id)
    .map((entry) => entry.businessDate)));
  related.filter((doc) => doc.sourceClosingId !== source.id).forEach((doc) => {
    affected.add(data.closings.find((row) => row.id === doc.sourceClosingId)?.businessDate || doc.sourceClosingId);
  });
  return affected.size ? `${source.businessDate}の経理修正は別営業日（${[...affected].sort().join("、")}）と関連しています。単日の差戻しでは解除せず、関連営業日の修正内容を確認してください。` : "";
}

export function createCastReturnHandoff(
  source: DailyClosing, correction: CastDailyCorrectionDocument, data: CastCorrectionWorkspace,
  meta: Pick<CastReturnHandoff, "id" | "returnedAt" | "reason" | "createdAt" | "createdBy">,
): CastReturnHandoff {
  requireValue(correction.active && correction.current && correction.sourceClosingId === source.id,
    "差戻し対象の経理修正が見つかりません。最新データを読み込んでください。");
  const blockReason = castReturnHandoffBlockReason(data, source.id);
  requireValue(!blockReason, blockReason);
  const result = applyCastCorrections(data);
  requireValue(result.issues.length === 0, result.issues.join("\n"));
  return normalizeCastReturnHandoff({ schema: 1, ...meta, sourceClosingId: source.id, sourceUpdatedAt: source.updatedAt,
    sourceChecksum: source.checksum, sourceSubmissionId: source.submissionId, sourceCorrectionRevision: correction.revision,
    sourceRecordJson: JSON.stringify(source), draft: structuredClone(correction.current) }, source.id, meta.id);
}

/** 原本POS・支払・現金照合は触らず、経理確認済みの入力だけ再編集の初期値へ載せる。 */
export function materializeCastReturnHandoff(source: DailyClosing, value: CastReturnHandoff): DailyClosing {
  const handoff = normalizeCastReturnHandoff(value, source.id, value.id);
  requireValue(source.castReturnHandoffId === handoff.id && source.checksum === handoff.sourceChecksum
    && source.submissionId === handoff.sourceSubmissionId && source.returnedAt === handoff.returnedAt,
  "差戻しの引継ぎ記録が最新の店舗データと一致しません。最新データを読み込んでください。");
  const original = JSON.parse(handoff.sourceRecordJson) as DailyClosing;
  const casts = materializeCastCorrectionRows(handoff.draft, original);
  // 派生した支払額の変化を許さない（旧追加/削除/別人変更も元の支払保護を検査）。
  for (const row of original.casts) {
    if (row.dailyPayment || row.advancePayment || row.transportFee
      || original.expenses.some((expense) => expense.category === "beautyTrial" && expense.personId === row.masterId && expense.amount)) {
      const next = casts.find((candidate) => candidate.posCastId === row.posCastId && candidate.masterId === row.masterId && candidate.kind === row.kind);
      requireValue(next && next.dailyPayment === row.dailyPayment && next.advancePayment === row.advancePayment && next.transportFee === row.transportFee,
        `${row.name}の支払記録を変更する経理修正は自動で引き継げません。`);
    }
  }
  return { ...source, casts, castInputRevision: { schema: 1, handoffId: handoff.id,
    sourceCorrectionRevision: handoff.sourceCorrectionRevision, draft: structuredClone(handoff.draft),
    originalCasts: original.castInputRevision?.originalCasts || original.casts.map(({ posCastId, masterId, name, kind, honShimeiCount, banaiShimeiCount, dohanCount }) =>
      ({ posCastId, masterId, name, kind, honShimeiCount, banaiShimeiCount, dohanCount })) } };
}

const storeEditableFields = new Set<keyof DailyCast>(["honShimeiSales", "jonaiExtensionSales", "beautyAllowance", "dailyPayment", "advancePayment", "transportFee"]);
const protectedRow = (row: DailyCast) => Object.fromEntries(Object.entries(row).filter(([key]) => !storeEditableFields.has(key as keyof DailyCast)));

/** 保存済みの受入入力も、勤務・商品の計算結果と突き合わせて破損を検知する。 */
export function validateAcceptedCastInputRows(closing: DailyClosing): void {
  if (!closing.castInputRevision) return;
  const revision = normalizeCastInputRevision(closing.castInputRevision);
  requireValue(revision.draft.sourceClosingId === closing.id && revision.draft.sourceChecksum === closing.checksum
    && revision.draft.sourceSubmissionId === closing.submissionId
    && revision.draft.entries.every((entry) => entry.targetClosingId === closing.id && entry.businessDate === closing.businessDate),
  "受入済みキャスト入力と店舗原本の識別情報が一致しません。");
  const expected = materializeCastCorrectionRows(revision.draft, closing);
  requireValue(expected.length === closing.casts.length && closing.casts.every((row) => {
    const rows = expected.filter((candidate) => candidate.posCastId === row.posCastId);
    return rows.length === 1 && equal(protectedRow(row), protectedRow(rows[0]));
  }) && new Set(closing.casts.map((row) => row.posCastId)).size === closing.casts.length,
  "受入済みキャスト入力の勤務・本数・商品明細が保存内容と一致しません。");
}

/** repositoryはサーバー取得したbefore/handoffを渡す。利用者が送ったrevisionは信用しない。 */
export function validateCastReturnSubmission(value: DailyClosing, before: DailyClosing | null, handoff?: CastReturnHandoff | null): void {
  if (!before) {
    requireValue(!value.castInputRevision && !value.castReturnHandoffId, "新規の日次へ経理修正の引継ぎ情報を指定できません。");
    return;
  }
  if (before.castReturnHandoffId) requireValue(handoff && handoff.id === before.castReturnHandoffId,
    "経理修正の引継ぎ記録がありません。最新データを読み込んでください。");
  const baseline = before.castReturnHandoffId ? materializeCastReturnHandoff(before, handoff!) : before;
  if (before.checksum !== value.checksum || before.submissionId !== value.submissionId) {
    requireValue(!value.castInputRevision, "新しいPOS原本と以前の経理修正を混在させることはできません。再照合してください。");
    return;
  }
  if (!baseline.castInputRevision) {
    requireValue(!value.castInputRevision, "検証済みの引継ぎ原本がありません。");
    return;
  }
  requireValue(value.castInputRevision && equal(normalizeCastInputRevision(value.castInputRevision), baseline.castInputRevision),
    "経理修正の引継ぎ入力が変更・欠落しています。最新データを読み込んでください。");
  requireValue(value.casts.length === baseline.casts.length && value.casts.every((row) => {
    const matches = baseline.casts.filter((candidate) => candidate.posCastId === row.posCastId);
    return matches.length === 1 && equal(protectedRow(row), protectedRow(matches[0]));
  }) && new Set(value.casts.map((row) => row.posCastId)).size === value.casts.length,
  "引継ぎ済みの勤務・本数・商品情報が元の記録と一致しません。変更する場合は修正したPOS JSONを再取込してください。");
}

export function prepareCastReturnReedit(source: DailyClosing, handoffs: CastReturnHandoff[] = []) {
  if (!source.castReturnHandoffId) return source;
  const handoff = handoffs.find((row) => row.sourceClosingId === source.id && row.id === source.castReturnHandoffId);
  requireValue(handoff, "経理修正の引継ぎ記録を読み込めません。最新データを読み込んでください。");
  return materializeCastReturnHandoff(source, handoff);
}
