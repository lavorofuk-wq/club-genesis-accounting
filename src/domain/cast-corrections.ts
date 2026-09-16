import {
  bottleBackContextCastIds, effectiveBottleBackTargets, hoursBetweenQuarter, posItemOccurrenceKey,
  castIdentityForMonth, compareDailyClosingSubmissionOrder, rateForMonth, splitItemBackPerTarget,
  type CastCorrectionDraft, type CastCorrectionEntry, type CastCorrectionProduct,
  type CastDailyCorrectionDocument, type CastCorrectionHistory, type CastRecord,
  type DailyCast, type DailyClosing, type MonthlyAdjustments, type WorkspaceData,
} from "./gms";

export type CastCorrectionWorkspace = WorkspaceData & {
  archivedCasts?: CastRecord[];
  monthStates?: Array<{ month: string; status: string }>;
};
const fail = (message: string): never => { throw new Error(message); };
const requireValue: (condition: unknown, message: string) => asserts condition = (condition, message) => { if (!condition) fail(message); };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const money = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is string => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const classification = (value: unknown) => value === "honShimei" || value === "jonaiExtension" || value === "excluded";
const list = <T>(value: unknown): T[] => value === undefined || value === null ? []
  : Array.isArray(value) ? value.filter((item) => item !== null) as T[]
    : object(value) ? Object.values(value) as T[] : fail("経理訂正の一覧形式が正しくありません。");
const close = (a: number, b: number) => Math.abs(a - b) < 0.000001;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)])) : value;
function validIntroducer(value: unknown) {
  return value === undefined || object(value) && text(value.id) && text(value.name)
    && ["sales10", "netSales10", "gross10", "higherSalesGross10", "higherNetSalesGross10"].includes(String(value.feeType))
    && money(value.attendanceAdvisoryFee) && money(value.entryAdvisoryFee)
    && (value.attendanceAdvisoryEnabled === undefined || typeof value.attendanceAdvisoryEnabled === "boolean")
    && (value.entryAdvisoryEnabled === undefined || typeof value.entryAdvisoryEnabled === "boolean");
}

function normalizeDraft(value: unknown): CastCorrectionDraft {
  requireValue(object(value), "経理訂正の入力データがありません。");
  const draft = { ...value, entries: list<CastCorrectionEntry>(value.entries).map((entry) => ({
    ...entry, dohan: list<CastCorrectionEntry["dohan"][number]>(entry?.dohan),
  })), products: list<CastCorrectionProduct>(value.products).map((product) => ({
    ...product, targets: list<string>(product?.targets),
  })) } as CastCorrectionDraft;
  requireValue([draft.sourceClosingId, draft.sourceUpdatedAt, draft.sourceSubmissionId].every(text)
    && /^[a-f0-9]{64}$/.test(draft.sourceChecksum), "経理訂正の原本識別情報が不正です。");
  const ids = new Set<string>();
  for (const entry of draft.entries) {
    requireValue(entry && text(entry.id) && !ids.has(entry.id), "経理訂正の出勤行IDが欠落・重複しています。");
    ids.add(entry.id);
    requireValue(text(entry.targetClosingId) && date(entry.businessDate) && text(entry.masterId) && text(entry.name)
      && ["regular", "trial"].includes(entry.kind) && typeof entry.deleted === "boolean"
      && (entry.originalPosCastId === undefined || text(entry.originalPosCastId)), `${entry.name || entry.id}の人物・営業日が不正です。`);
    requireValue(time(entry.startTime) && time(entry.endTime) && money(entry.breakMinutes)
      && entry.breakMinutes <= 1440 && money(entry.hourlyRate) && entry.hourlyRate > 0,
    `${entry.name}の出退勤・休憩・時給を確認してください。`);
    requireValue([entry.honShimeiCount, entry.banaiShimeiCount, entry.honShimeiSales, entry.jonaiExtensionSales, entry.beautyAllowance].every(money)
      && entry.honShimeiSales % 10 === 0 && entry.jonaiExtensionSales % 10 === 0
      && (entry.beautyAllowance === 0 || entry.kind === "regular" && entry.beautyAllowance === 500), `${entry.name}の売上・本数・美容室手当が不正です。`);
    requireValue(entry.dohan.every((item) => item && time(item.arrivalTime) && typeof item.extended === "boolean"
      && money(item.quantity) && item.quantity > 0), `${entry.name}の同伴内訳が不正です。`);
    if (entry.termsSnapshot !== undefined) {
      const terms = entry.termsSnapshot;
      requireValue(object(terms) && terms.masterId === entry.masterId && terms.month === entry.businessDate.slice(0, 7)
        && ["daily", "master"].includes(terms.source) && validIntroducer(terms.introducer)
        && (terms.source === "master" || text(terms.sourceClosingId))
        && (terms.submittedAt === undefined || text(terms.submittedAt) && Number.isFinite(Date.parse(terms.submittedAt)))
        && (terms.submittedAtMs === undefined || money(terms.submittedAtMs)), `${entry.name}の保存済み紹介者条件が不正です。`);
    }
    if (!entry.deleted) requireValue(hoursBetweenQuarter(entry.startTime, entry.endTime, entry.breakMinutes) > 0,
      `${entry.name}の勤務時間は15分以上にしてください。`);
  }
  const productIds = new Set<string>();
  for (const product of draft.products) {
    requireValue(product && text(product.id) && !productIds.has(product.id) && text(product.name), "経理訂正の商品ID・銘柄が欠落または重複しています。");
    productIds.add(product.id);
    requireValue(["champagneWine", "keepBottle", "castDrink"].includes(product.kind) && classification(product.classification)
      && money(product.unitPrice) && money(product.unitCost) && money(product.quantity) && product.quantity > 0
      && money(product.externalTargetCount) && (product.kind !== "castDrink" || product.unitCost === 0), `${product.name}の金額・数量・区分が不正です。`);
    requireValue(new Set(product.targets).size === product.targets.length && product.targets.every((id) => text(id)
      && draft.entries.some((entry) => entry.id === id && !entry.deleted)), `${product.name}の対象キャストが欠落・重複しています。`);
    requireValue(product.targets.length + product.externalTargetCount > 0, `${product.name}の配賦対象人数を指定してください。`);
    requireValue(Number.isSafeInteger(product.unitPrice * product.quantity) && Number.isSafeInteger(product.unitCost * product.quantity), `${product.name}の金額が大きすぎます。`);
  }
  return draft;
}

/** Firebaseの空配列欠落・数値キー配列を正規化。不正履歴は黙って削除しない。 */
export function normalizeCastDailyCorrectionDocument(value: unknown, sourceClosingId: string): CastDailyCorrectionDocument {
  requireValue(object(value) && value.sourceClosingId === sourceClosingId && money(value.revision) && value.revision > 0
    && typeof value.active === "boolean" && (object(value.history) || Array.isArray(value.history)), `${sourceClosingId}の経理訂正履歴が不正です。`);
  const history: Record<string, CastCorrectionHistory> = {};
  for (const [key, item] of Object.entries(value.history)) {
    if (item === null || item === undefined) continue;
    requireValue(object(item) && money(item.revision) && item.revision > 0 && String(item.revision) === key
      && item.revision <= value.revision && typeof item.active === "boolean" && text(item.reason)
      && text(item.createdAt) && Number.isFinite(Date.parse(item.createdAt)) && text(item.createdBy), `${sourceClosingId}の訂正履歴 ${key} が不正です。`);
    const draft = item.active ? normalizeDraft(item.draft) : undefined;
    requireValue(!draft || draft.sourceClosingId === sourceClosingId, "訂正履歴と原本IDが一致しません。");
    requireValue(item.active || item.draft === undefined || item.draft === null, "原本復元履歴に有効な訂正データが混在しています。");
    history[key] = { revision: item.revision, active: item.active, ...(draft ? { draft } : {}), reason: item.reason,
      createdAt: item.createdAt, createdBy: item.createdBy };
  }
  requireValue(Object.keys(history).length === value.revision && Array.from({ length: value.revision }, (_, index) => history[String(index + 1)]).every(Boolean),
    `${sourceClosingId}の経理訂正履歴が途中で欠落しています。`);
  const current = value.active ? normalizeDraft(value.current) : undefined;
  requireValue(value.active || value.current === undefined || value.current === null, "原本復元状態に訂正データが残っています。");
  const latest = history[String(value.revision)];
  requireValue(latest.active === value.active && JSON.stringify(canonical(latest.draft)) === JSON.stringify(canonical(current)), "最新の経理訂正と履歴が一致しません。");
  return { sourceClosingId, revision: value.revision, active: value.active, ...(current ? { current } : {}), history };
}

/** 確定snapshotの計算用キャスト明細。原本から再計算せず保存済み値を検査する。 */
export function normalizeCorrectedDailyCast(value: unknown): DailyCast {
  requireValue(object(value) && text(value.masterId) && text(value.posCastId) && text(value.name)
    && ["regular", "trial"].includes(String(value.kind)) && typeof value.startTime === "string" && typeof value.endTime === "string"
    && /^(?:[0-3]\d|4[0-7]):[0-5]\d$/.test(value.startTime) && /^(?:[0-3]\d|4[0-7]):[0-5]\d$/.test(value.endTime), "確定済みの経理訂正勤務明細が不正です。");
  const row = { ...value, bottles: list<DailyCast["bottles"][number]>(value.bottles),
    drinkAllocations: list<NonNullable<DailyCast["drinkAllocations"]>[number]>(value.drinkAllocations) } as unknown as DailyCast;
  const numeric = (amount: unknown) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
  requireValue(typeof row.hours === "number" && row.hours >= 0 && Number.isSafeInteger(row.hours * 4)
    && [row.hourlyRate, row.honShimeiCount, row.banaiShimeiCount, row.dohanCount, row.dohanBack, row.honShimeiSales,
      row.jonaiExtensionSales, row.beautyAllowance, row.dailyPayment, row.advancePayment, row.transportFee].every(numeric)
    && row.hourlyRate > 0,
  `${row.name}の保存済み勤務・金額が不正です。`);
  requireValue(Number.isFinite(row.drinkSales) && row.drinkSales >= 0 && Number.isFinite(row.liquorCost) && row.liquorCost >= 0,
    `${row.name}の商品合計が不正です。`);
  for (const product of [...row.bottles, ...row.drinkAllocations!]) requireValue(product && text(product.itemId) && text(product.name)
    && typeof product.quantity === "number" && Number.isFinite(product.quantity) && product.quantity > 0
    && Number.isFinite(product.salesAmount) && product.salesAmount >= 0
    && (product.backAmount === undefined || numeric(product.backAmount)), `${row.name}の商品明細が不正です。`);
  for (const bottle of row.bottles) requireValue(["champagneWine", "keepBottle"].includes(bottle.kind)
    && Number.isFinite(bottle.costAmount) && bottle.costAmount >= 0, `${row.name}の酒代原価が不正です。`);
  if (row.accountingCorrection !== undefined) {
    const metadata = row.accountingCorrection;
    requireValue(object(metadata) && text(metadata.sourceClosingId) && text(metadata.sourceEntryId)
      && (metadata.originalSubmittedAt === undefined || text(metadata.originalSubmittedAt) && Number.isFinite(Date.parse(metadata.originalSubmittedAt)))
      && (metadata.originalSubmittedAtMs === undefined || money(metadata.originalSubmittedAtMs)), `${row.name}の経理訂正元が不正です。`);
    const classifications = metadata.productClassifications ?? {};
    requireValue(object(classifications) && Object.values(classifications).every(classification), `${row.name}の商品売上区分が不正です。`);
    row.accountingCorrection = { ...metadata, productClassifications: classifications };
    requireValue([row.honShimeiCount, row.banaiShimeiCount, row.dohanCount, row.dohanBack, row.honShimeiSales,
      row.jonaiExtensionSales, row.beautyAllowance].every(money) && row.honShimeiSales % 10 === 0 && row.jonaiExtensionSales % 10 === 0
      && [...row.bottles, ...row.drinkAllocations!].every((product) => money(product.backAmount) && product.backAmount % 10 === 0),
    `${row.name}の訂正済み本数・売上・バック単位が不正です。`);
    requireValue(row.bottles.every((item) => text(item.sourceKey) && classification(classifications[item.sourceKey!]) && money(item.backAmount))
      && row.drinkAllocations!.every((item) => text(item.sourceKey) && money(item.backAmount))
      && close(row.drinkSales, row.drinkAllocations!.reduce((sum, item) => sum + item.salesAmount, 0))
      && close(row.liquorCost, row.bottles.filter((item) => classifications[item.sourceKey!] !== "excluded").reduce((sum, item) => sum + item.costAmount, 0)),
    `${row.name}の経理訂正の商品明細合計が一致しません。`);
  }
  return row;
}

export function castCorrectionDohanBack(items: CastCorrectionEntry["dohan"]) {
  return items.reduce((sum, item) => {
    const minutes = Number(item.arrivalTime.slice(0, 2)) * 60 + Number(item.arrivalTime.slice(3));
    return sum + (minutes <= 1230 ? 3000 + (item.extended ? 2000 : 0) : minutes <= 1260 ? 2000 : 0) * item.quantity;
  }, 0);
}

export function createCastCorrectionDraft(source: DailyClosing, _adjustments?: MonthlyAdjustments): CastCorrectionDraft {
  requireValue(source.status === "approved", "承認済みの日次だけ経理訂正できます。");
  const pos = source.posSnapshot;
  requireValue(pos && Array.isArray(pos.castWork) && Array.isArray(pos.transactions), "POS原本がなく、勤務・商品内訳を復元できません。店舗へ差し戻して原本を確認してください。");
  const entries: CastCorrectionEntry[] = source.casts.map((row) => {
    const work = pos.castWork.find((item) => item.castId === row.posCastId);
    requireValue(work && close(hoursBetweenQuarter(row.startTime, row.endTime, work.breakMinutes), row.hours), `${row.name}の休憩を含む勤務原本を復元できません。店舗へ差し戻して確認してください。`);
    const dohan = pos.transactions.flatMap((transaction) => transaction.items.filter((item) => item.category === "dohan"
      && item.backTargetCastIds.includes(row.posCastId)).map((item) => ({
      arrivalTime: new Date(transaction.startTime).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }),
      extended: transaction.items.some((entry) => entry.isExtension), quantity: item.quantity,
    })));
    requireValue(dohan.reduce((sum, item) => sum + item.quantity, 0) === row.dohanCount && castCorrectionDohanBack(dohan) === row.dohanBack,
      `${row.name}の同伴本数・バックを原本から復元できません。店舗へ差し戻して確認してください。`);
    return { id: row.posCastId, originalPosCastId: row.posCastId, targetClosingId: source.id, businessDate: source.businessDate,
      masterId: row.masterId, name: row.name, kind: row.kind as "regular" | "trial", startTime: row.startTime, endTime: row.endTime,
      breakMinutes: work.breakMinutes, hourlyRate: row.hourlyRate, honShimeiCount: row.honShimeiCount, banaiShimeiCount: row.banaiShimeiCount,
      honShimeiSales: row.honShimeiSales, jonaiExtensionSales: row.jonaiExtensionSales, beautyAllowance: row.beautyAllowance, dohan, deleted: false };
  });
  const products: CastCorrectionProduct[] = [];
  const consumed = new Set<string>();
  pos.transactions.forEach((transaction) => transaction.items.forEach((item, index) => {
    if (!["champagneWine", "keepBottle", "castDrink"].includes(item.category)) return;
    const targets = item.category === "castDrink" ? item.backTargetCastIds : effectiveBottleBackTargets(transaction, item);
    const internal = targets.filter((id) => entries.some((entry) => entry.id === id));
    if (!internal.length) return;
    const sourceKey = posItemOccurrenceKey(transaction, index);
    let unitCost = 0;
    if (item.category !== "castDrink") {
      const costs = internal.map((id) => {
        const allocation = source.casts.find((row) => row.posCastId === id)?.bottles.find((bottle) => bottle.sourceKey === sourceKey);
        requireValue(allocation && allocation.kind === item.category && allocation.name === item.label && allocation.quantity === item.quantity
          && close(allocation.salesAmount * targets.length, item.price * item.quantity), `${item.label}の共有対象・原価を復元できません。店舗へ差し戻して確認してください。`);
        consumed.add(`${id}\u0000${sourceKey}`);
        return allocation.costAmount * targets.length / item.quantity;
      });
      requireValue(costs.every((cost) => close(cost, costs[0])) && close(costs[0], Math.round(costs[0])), `${item.label}の共有原価が一致しません。店舗へ差し戻してください。`);
      unitCost = Math.round(costs[0]);
    }
    const context = bottleBackContextCastIds(transaction, item);
    products.push({ id: `product-${products.length + 1}`, originalSourceKey: sourceKey, name: item.label,
      kind: item.category as CastCorrectionProduct["kind"], unitPrice: item.price, unitCost, quantity: item.quantity,
      classification: item.category === "castDrink" || !context.length ? "excluded" : transaction.items.some((entry) => entry.isHonShimei) ? "honShimei" : "jonaiExtension",
      targets: internal, externalTargetCount: targets.length - internal.length });
  }));
  for (const row of source.casts) for (const bottle of row.bottles) {
    requireValue(bottle.sourceKey && consumed.has(`${row.posCastId}\u0000${bottle.sourceKey}`), `${row.name}の${bottle.name}の商品原本を特定できません。店舗へ差し戻してください。`);
  }
  return normalizeDraft({ sourceClosingId: source.id, sourceUpdatedAt: source.updatedAt, sourceChecksum: source.checksum,
    sourceSubmissionId: source.submissionId, entries, products });
}

function pinnedPayment(source: DailyClosing, row: DailyCast) {
  return row.dailyPayment !== 0 || row.advancePayment !== 0 || row.transportFee !== 0
    || source.expenses.some((expense) => expense.category === "beautyTrial" && expense.personId === row.masterId && expense.amount !== 0);
}

function retainedEntry(draft: CastCorrectionDraft, entry: CastCorrectionEntry, data: CastCorrectionWorkspace) {
  return data.castCorrections?.find((record) => record.active && record.sourceClosingId === draft.sourceClosingId)?.current?.entries
    .find((saved) => saved.id === entry.id && saved.masterId === entry.masterId && saved.kind === entry.kind
      && saved.businessDate.slice(0, 7) === entry.businessDate.slice(0, 7));
}

function validateDraft(draft: CastCorrectionDraft, data: CastCorrectionWorkspace, checkMonth: boolean) {
  const source = data.closings.find((row) => row.id === draft.sourceClosingId);
  requireValue(source && source.status === "approved", "経理訂正元の承認済み日次がありません。最新データを読み込んでください。");
  requireValue(source.updatedAt === draft.sourceUpdatedAt && source.checksum === draft.sourceChecksum && source.submissionId === draft.sourceSubmissionId,
    `${source.businessDate}の店舗原本が訂正開始時から変更されています。訂正内容を再確認してください。`);
  const originals = new Map(source.casts.map((row) => [row.posCastId, row]));
  const originalIds = draft.entries.flatMap((entry) => entry.originalPosCastId ? [entry.originalPosCastId] : []);
  requireValue(new Set(originalIds).size === originalIds.length && originalIds.length === originals.size && originalIds.every((id) => originals.has(id)),
    "訂正元のキャスト行が欠落・重複しています。削除する行も削除指定として保持してください。");
  const months = new Set([source.businessDate.slice(0, 7)]);
  const masters = new Map([...(data.archivedCasts || []), ...data.casts].map((row) => [row.id, row]));
  for (const entry of draft.entries) {
    const original = entry.originalPosCastId ? originals.get(entry.originalPosCastId) : undefined;
    const target = data.closings.find((row) => row.id === entry.targetClosingId);
    requireValue(target?.status === "approved" && target.businessDate === entry.businessDate, `${entry.name}の変更先は承認済み営業日から選択してください。`);
    months.add(entry.businessDate.slice(0, 7));
    if (original && pinnedPayment(source, original)) requireValue(!entry.deleted && entry.masterId === original.masterId
      && entry.kind === original.kind && entry.targetClosingId === source.id && entry.businessDate === source.businessDate,
    `${original.name}には日払い・立替・送迎または体入美容室の支払記録があります。削除・人物・日付変更は店舗へ差し戻して支払記録と併せて確認してください。`);
    if (entry.deleted) continue;
    const originalPerson = original && entry.masterId === original.masterId && entry.kind === original.kind;
    const member = masters.get(entry.masterId);
    const retained = retainedEntry(draft, entry, data);
    if (checkMonth && !originalPerson && !retained) requireValue(member && !member.deletedAt && member.name === entry.name,
      `${entry.name}の変更先キャストが現在のマスタと一致しません。`);
    const changedDate = entry.businessDate !== source.businessDate;
    if (checkMonth && ((!originalPerson && !retained) || (changedDate && entry.businessDate !== retained?.businessDate))) requireValue(member && (entry.kind === "trial" ? member.status === "trial" && member.trialDate === entry.businessDate
      : member.status !== "trial" && Boolean(member.hiredAt) && member.hiredAt! <= entry.businessDate && (!member.departedAt || member.departedAt >= entry.businessDate)),
    `${entry.name}の在籍区分・採用日・体入日と変更先営業日が一致しません。`);
    if (originalPerson) {
      requireValue(entry.name === original.name, "表示名だけを別人へ変更できません。人物選択から変更してください。");
      requireValue(entry.hourlyRate === original.hourlyRate, `${entry.name}の登録時時給は原本のまま保持してください。月度時給は共通フォームで変更してください。`);
    } else if (checkMonth) {
      if (retained) requireValue(entry.name === retained.name && entry.hourlyRate === retained.hourlyRate,
        `${entry.name}の保存済み氏名・登録時時給を保持してください。人物を変更する場合は選び直してください。`);
      else {
      const expectedRate = entry.kind === "trial" ? member?.trialHourlyRate : rateForMonth(member?.hourlyRates || {}, entry.businessDate.slice(0, 7));
      requireValue(expectedRate && entry.hourlyRate === expectedRate, `${entry.name}の適用時給が対象月のマスタと一致しません。人物を選択し直してください。`);
      }
    }
  }
  if (checkMonth) for (const month of months) requireValue(!data.monthStates?.some((state) => state.month === month && state.status !== "open"),
    `${month}は月次確定中または確定済みです。確定を解除してから訂正してください。`);
  return source;
}

function termsFor(entry: CastCorrectionEntry, original: DailyCast | undefined, source: DailyClosing) {
  if (original && original.masterId === entry.masterId && original.kind === entry.kind) return {
    introducer: original.introducer, submittedAt: source.submittedAt, submittedAtMs: source.submittedAtMs,
  };
  requireValue(entry.termsSnapshot && entry.termsSnapshot.masterId === entry.masterId && entry.termsSnapshot.month === entry.businessDate.slice(0, 7),
    `${entry.name}の紹介者条件が保存時に固定されていません。経理訂正を保存し直してください。`);
  return { introducer: entry.termsSnapshot.introducer, submittedAt: entry.termsSnapshot.submittedAt, submittedAtMs: entry.termsSnapshot.submittedAtMs };
}

function chooseTerms(entry: CastCorrectionEntry, source: DailyClosing, data: CastCorrectionWorkspace): NonNullable<CastCorrectionEntry["termsSnapshot"]> {
  const candidates = data.closings.filter((closing) => closing.status === "approved" && closing.businessDate.startsWith(entry.businessDate.slice(0, 7)))
    .flatMap((closing) => closing.casts.filter((row) => row.masterId === entry.masterId).map((row) => ({ closing, row })))
    .sort((left, right) => compareDailyClosingSubmissionOrder(left.closing, right.closing) || left.closing.id.localeCompare(right.closing.id));
  const latest = candidates.at(-1);
  if (latest) return { masterId: entry.masterId, month: entry.businessDate.slice(0, 7), source: "daily", sourceClosingId: latest.closing.id,
    ...(latest.row.introducer ? { introducer: structuredClone(latest.row.introducer) } : {}),
    submittedAt: latest.closing.submittedAt, submittedAtMs: latest.closing.submittedAtMs };
  const member = new Map([...(data.archivedCasts || []), ...data.casts].map((row) => [row.id, row])).get(entry.masterId);
  const intro = data.introducers.find((row) => row.id === member?.introducerId);
  return { masterId: entry.masterId, month: entry.businessDate.slice(0, 7), source: "master", introducer: intro ? { id: intro.id, name: intro.name, feeType: intro.feeType,
    attendanceAdvisoryEnabled: intro.attendanceAdvisoryEnabled, entryAdvisoryEnabled: intro.entryAdvisoryEnabled,
    attendanceAdvisoryFee: member?.attendanceAdvisoryFee || 0, entryAdvisoryFee: member?.entryAdvisoryFee || 0 } : undefined,
  submittedAt: source.submittedAt, submittedAtMs: source.submittedAtMs };
}

/** 保存前とUI試算で共通使用。呼出元のtermsSnapshotを信用せず、既存履歴か検証済み元データで固定する。 */
export function sealCastCorrectionDraft(value: CastCorrectionDraft, data: CastCorrectionWorkspace): CastCorrectionDraft {
  const draft = normalizeDraft({ ...value, entries: list<CastCorrectionEntry>(value.entries).map((entry) => {
    const { termsSnapshot: _untrusted, ...rest } = entry;
    return rest;
  }) });
  const source = validateDraft(draft, data, true);
  const sealed = { ...draft, entries: draft.entries.map((entry) => {
    const original = source.casts.find((row) => row.posCastId === entry.originalPosCastId);
    if (entry.deleted || original && original.masterId === entry.masterId && original.kind === entry.kind) {
      const { termsSnapshot: _unused, ...rest } = entry;
      return rest;
    }
    const saved = retainedEntry(draft, entry, data)?.termsSnapshot;
    return { ...entry, termsSnapshot: saved ? structuredClone(saved) : chooseTerms(entry, source, data) };
  }) };
  return normalizeDraft(sealed);
}

function correctedRow(entry: CastCorrectionEntry, draft: CastCorrectionDraft, source: DailyClosing, data: CastCorrectionWorkspace): DailyCast {
  const original = source.casts.find((row) => row.posCastId === entry.originalPosCastId);
  const terms = termsFor(entry, original, source);
  const row: DailyCast = { masterId: entry.masterId, posCastId: `accounting_${source.id}_${entry.id}`, name: entry.name, kind: entry.kind,
    startTime: entry.startTime, endTime: entry.endTime, hours: hoursBetweenQuarter(entry.startTime, entry.endTime, entry.breakMinutes),
    hourlyRate: entry.hourlyRate, honShimeiCount: entry.honShimeiCount, banaiShimeiCount: entry.banaiShimeiCount,
    dohanCount: entry.dohan.reduce((sum, item) => sum + item.quantity, 0), dohanBack: castCorrectionDohanBack(entry.dohan),
    honShimeiSales: entry.honShimeiSales, jonaiExtensionSales: entry.jonaiExtensionSales, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: entry.beautyAllowance, dailyPayment: original?.dailyPayment || 0, advancePayment: original?.advancePayment || 0,
    transportFee: original?.transportFee || 0, ...(terms.introducer ? { introducer: terms.introducer } : {}),
    accountingCorrection: { sourceClosingId: source.id, sourceEntryId: entry.id, originalSubmittedAt: terms.submittedAt,
      originalSubmittedAtMs: terms.submittedAtMs, productClassifications: {} } };
  draft.products.forEach((product, index) => {
    if (!product.targets.includes(entry.id)) return;
    const denominator = product.targets.length + product.externalTargetCount;
    const sourceKey = `accounting_${source.id}_${index}`;
    const sales = product.unitPrice * product.quantity;
    const cost = product.unitCost * product.quantity;
    if (product.kind === "castDrink") {
      row.drinkSales += sales / denominator;
      row.drinkAllocations!.push({ itemId: product.id, sourceKey, name: product.name, quantity: product.quantity,
        salesAmount: sales / denominator, backAmount: splitItemBackPerTarget(sales, .1, denominator) });
    } else {
      row.bottles.push({ itemId: product.id, sourceKey, name: product.name, kind: product.kind, quantity: product.quantity,
        salesAmount: sales / denominator, costAmount: cost / denominator, specialCost: true,
        backAmount: product.classification === "excluded" ? 0 : splitItemBackPerTarget(sales - cost, product.kind === "champagneWine" ? .25 : .15, denominator) });
      row.accountingCorrection!.productClassifications[sourceKey] = product.classification;
      if (product.classification !== "excluded") row.liquorCost += cost / denominator;
    }
  });
  return row;
}

function project(data: CastCorrectionWorkspace, drafts: CastCorrectionDraft[]) {
  const sourceIds = new Set(drafts.map((draft) => draft.sourceClosingId));
  requireValue(sourceIds.size === drafts.length, "同じ原本の経理訂正が重複しています。");
  const closings = data.closings.map((closing) => ({ ...closing, casts: sourceIds.has(closing.id) ? [] as DailyCast[] : [...closing.casts] }));
  for (const draft of drafts) {
    const source = data.closings.find((row) => row.id === draft.sourceClosingId)!;
    for (const entry of draft.entries.filter((row) => !row.deleted)) {
      const target = closings.find((row) => row.id === entry.targetClosingId)!;
      requireValue(!target.casts.some((row) => row.masterId === entry.masterId), `${entry.name}は${entry.businessDate}に既に出勤しています。同じ人物・営業日の重複を解消してください。`);
      target.casts.push(correctedRow(entry, draft, source, data));
    }
  }
  const masters = [...(data.archivedCasts || []), ...data.casts];
  const byId = new Map(masters.map((member) => [member.id, member]));
  for (const closing of closings) {
    if (!closing.casts.some((row) => row.accountingCorrection)) continue;
    const regularIds = new Set(closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(closing.businessDate.slice(0, 7)))
      .flatMap((row) => row.casts.filter((cast) => cast.kind === "regular").map((cast) => cast.masterId)));
    const identities = closing.casts.map((row) => castIdentityForMonth(row, byId, masters, closing.businessDate.slice(0, 7), regularIds));
    requireValue(new Set(identities).size === identities.length, `${closing.businessDate}に体入・在籍を含む同一人物の出勤が重複しています。`);
  }
  return closings;
}

export function validateCastCorrectionDraft(value: CastCorrectionDraft, data: CastCorrectionWorkspace): void {
  const draft = sealCastCorrectionDraft(value, data);
  const drafts = (data.castCorrections || []).filter((record) => record.active && record.sourceClosingId !== draft.sourceClosingId)
    .map((record) => { const current = normalizeDraft(record.current); validateDraft(current, data, false); return current; });
  project(data, [...drafts, draft]);
}

/** 訂正が壊れている場合は原本を返し、必ず集計停止用の問題を返す。原本は変更しない。 */
export function applyCastCorrections(data: CastCorrectionWorkspace): { closings: DailyClosing[]; issues: string[] } {
  try {
    const drafts = (data.castCorrections || []).filter((record) => record.active).map((record) => {
      const draft = normalizeDraft(record.current); validateDraft(draft, data, false); return draft;
    });
    return { closings: project(data, drafts), issues: [] };
  } catch (error) {
    return { closings: data.closings, issues: [error instanceof Error ? error.message : "経理訂正データを確認できません。"] };
  }
}
