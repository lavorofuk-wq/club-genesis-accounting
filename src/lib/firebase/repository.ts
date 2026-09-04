"use client";

import { get, runTransaction, set, update, ref } from "firebase/database";
import type { User } from "firebase/auth";
import { database, rootRef } from "./client";
import { normalizeDailyClosing, normalizeMonthlyAdjustments, parsePosClosingV3 } from "@/domain/gms";
import {
  buildMonthlySnapshot,
  calculateMonthlyAccounting,
  monthlySourceFingerprint,
  normalizeMonthlyAccountingSnapshot,
} from "@/domain/month-accounting";
import type {
  CastRecord,
  DailyClosing,
  DriverRecord,
  IntroducerRecord,
  LiquorRecord,
  MonthlyAdjustments,
  Role,
  StaffRecord,
  WorkspaceData as DomainWorkspaceData
} from "@/domain/gms";
import type {
  AccountingMonthState,
  AccountingWorkspaceData,
  IntroducerEntryEvent,
  MonthlyAccountingSnapshot,
} from "@/domain/month-accounting";

export type WorkspaceData = AccountingWorkspaceData;
export type ClosingRevision = Pick<DailyClosing, "businessDate" | "updatedAt" | "checksum" | "submissionId">;

const emptyData: AccountingWorkspaceData = {
  casts: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200000,
  archivedCasts: [], archivedStaff: [], introducerEntryEvents: [], monthStates: [], monthSnapshots: [],
};

type AccountingFinalizeLock = {
  operationId: string;
  owner: string;
  month: string;
  acquiredAt: number;
  expiresAt: number;
};
const ACCOUNTING_FINALIZE_LOCK_TTL_MS = 10 * 60 * 1000;

type ConversionLock = {
  operationId: string;
  token: string;
  owner: string;
  expiresAt: number;
};
type ConversionLockCarrier = { conversionLock?: ConversionLock };
type ConversionLockHandle<T> = ConversionLock & { path: string; record: T };
const CONVERSION_LOCK_TTL_MS = 120_000;

const asArray = <T extends { id: string }>(value: unknown): T[] => {
  if (!value || typeof value !== "object") return [];
  // 保存データ内に旧版由来のidが残っていても、FirebaseのパスIDを正とする。
  return Object.entries(value as Record<string, Omit<T, "id">>).map(([id, row]) => ({ ...row, id } as T));
};
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const now = () => new Date().toISOString();
const entityId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const validDate = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const nonNegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const withoutId = <T extends { id?: string }>(value: T) => {
  const { id: _id, ...rest } = value;
  return rest;
};
const withoutInternalFields = <T extends { id?: string }>(value: T) => {
  const { id: _id, conversionLock: _conversionLock, ...rest } = value as T & ConversionLockCarrier;
  return rest;
};
const assertFresh = (existing: { updatedAt?: string } | null, expectedUpdatedAt?: string) => {
  if (existing && (!expectedUpdatedAt || existing.updatedAt !== expectedUpdatedAt)) {
    throw new Error("別の端末で更新されています。最新データを読み込んでからやり直してください。");
  }
};
const assertConversionUnlocked = (value: ConversionLockCarrier | null | undefined, operationId = "") => {
  const lock = value?.conversionLock;
  if (lock && Number(lock.expiresAt || 0) > Date.now() && lock.operationId !== operationId) {
    throw new Error("このデータは別の端末で在籍化処理中です。少し待ってから最新データを読み込んでください。");
  }
};
const assertClosingRevision = (existing: DailyClosing, expected: ClosingRevision) => {
  if (existing.businessDate !== expected.businessDate || existing.updatedAt !== expected.updatedAt || existing.checksum !== expected.checksum || existing.submissionId !== expected.submissionId) {
    throw new Error("店舗データが更新されています。最新データを読み込み、内容を再確認してください。");
  }
};
const claimKey = (...parts: unknown[]) => parts.map((part) =>
  encodeURIComponent(String(part ?? "").normalize("NFKC").trim().toLocaleLowerCase("ja")).replaceAll(".", "%2E"),
).join("~");

type ClaimValue = string | { id: string; state: "pending" | "committed"; token?: string; expiresAt?: number };
type ClaimHandle = { path: string; key: string; id: string; token: string; created: boolean };
const CLAIM_PENDING_TTL_MS = 120_000;

function claimId(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return "";
}

async function acquireClaim(path: string, key: string, id: string): Promise<ClaimHandle> {
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + CLAIM_PENDING_TTL_MS;
  let created = false;
  await runTransaction(rootRef(`${path}/${key}`), (current) => {
    const stored = current as ClaimValue | null;
    if (stored && typeof stored !== "string" && stored.state === "pending" && Number(stored.expiresAt || 0) <= Date.now()) {
      created = true;
      return { id, state: "pending", token, expiresAt };
    }
    const ownerId = claimId(stored);
    if (ownerId && ownerId !== id) throw new Error("同じ内容のデータがすでに登録されています。");
    if (typeof stored === "string" || (stored && stored.state === "committed")) {
      created = false;
      return current;
    }
    if (stored?.state === "pending" && stored.token !== token && Number(stored.expiresAt || 0) > Date.now()) {
      throw new Error("同じデータを別の処理で更新中です。少し待ってから最新データを読み込んでください。");
    }
    created = true;
    return { id, state: "pending", token, expiresAt };
  }, { applyLocally: false });
  return { path, key, id, token, created };
}

async function commitClaim(handle: ClaimHandle) {
  if (!handle.created) return;
  await runTransaction(rootRef(`${handle.path}/${handle.key}`), (current) => {
    const stored = current as ClaimValue | null;
    if (!stored || typeof stored === "string" || stored.id !== handle.id || stored.state !== "pending" || stored.token !== handle.token) {
      throw new Error("重複防止情報が別の処理で更新されています。最新データを読み込んでください。");
    }
    return { id: handle.id, state: "committed" };
  }, { applyLocally: false });
}

async function commitClaimAfterEntitySaved(handle: ClaimHandle, entityLabel: string) {
  if (!handle.created) return;
  const isCommitted = async () => {
    const stored = (await get(rootRef(`${handle.path}/${handle.key}`))).val() as ClaimValue | null;
    return typeof stored === "string"
      ? stored === handle.id
      : Boolean(stored && stored.id === handle.id && stored.state === "committed");
  };
  try {
    await commitClaim(handle);
    return;
  } catch {
    if (await isCommitted().catch(() => false)) return;
  }
  try {
    await commitClaim(handle);
    return;
  } catch {
    if (await isCommitted().catch(() => false)) return;
  }
  throw new Error(`${entityLabel}本体は保存されましたが、重複防止情報を確定できませんでした。通信状態を確認し、最新データを読み込んでから同じデータを保存し直してください。`);
}

async function releasePendingClaim(handle: ClaimHandle) {
  if (!handle.created) return;
  await runTransaction(rootRef(`${handle.path}/${handle.key}`), (current) => {
    const stored = current as ClaimValue | null;
    return stored && typeof stored !== "string" && stored.id === handle.id && stored.state === "pending" && stored.token === handle.token
      ? null
      : current;
  }, { applyLocally: false });
}

async function releaseClaim(path: string, key: string, id: string) {
  await runTransaction(rootRef(`${path}/${key}`), (current) => claimId(current) === id ? null : current, { applyLocally: false });
}

async function releaseClaimAfterEntitySaved(path: string, key: string, id: string, entityLabel: string) {
  const isReleased = async () => claimId((await get(rootRef(`${path}/${key}`))).val()) !== id;
  try {
    await releaseClaim(path, key, id);
    return;
  } catch {
    if (await isReleased().catch(() => false)) return;
  }
  try {
    await releaseClaim(path, key, id);
    return;
  } catch {
    if (await isReleased().catch(() => false)) return;
  }
  throw new Error(`${entityLabel}本体は更新されましたが、旧い重複防止情報を解放できませんでした。通信状態を確認し、管理者へ連絡してください。`);
}

function claimAcquisitionError(error: unknown, duplicateMessage: string) {
  const message = error instanceof Error ? error.message : String(error || "");
  const code = String((error as { code?: unknown } | null)?.code || "");
  if (message.includes("同じ内容のデータがすでに登録されています")) return new Error(duplicateMessage);
  if (message.includes("同じデータを別の処理で更新中です")) return new Error(message);
  if (/permission.?denied/i.test(`${code} ${message}`)) {
    return new Error("重複防止情報へのアクセスが拒否されました。Firebaseの権限設定を確認してください。");
  }
  return new Error("重複防止情報を確認できませんでした。通信状態を確認し、最新データを読み込んでからやり直してください。");
}

async function acquireConversionLock<T extends { status: string; updatedAt?: string }>(
  path: string,
  expectedUpdatedAt: string | undefined,
  convertedId: (value: T) => string | undefined,
  missingMessage: string,
  user: User,
): Promise<ConversionLockHandle<T>> {
  const operationId = crypto.randomUUID();
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + CONVERSION_LOCK_TTL_MS;
  const result = await runTransaction(rootRef(path), (current) => {
    const row = current as (T & ConversionLockCarrier) | null;
    if (!row || row.status !== "trial") throw new Error(missingMessage);
    if (convertedId(row)) throw new Error("この体入データはすでに在籍登録されています。");
    assertFresh(row, expectedUpdatedAt);
    assertConversionUnlocked(row, operationId);
    return clean({ ...row, conversionLock: { operationId, token, owner: user.uid, expiresAt } });
  }, { applyLocally: false });
  if (!result.committed) throw new Error("在籍化処理を開始できませんでした。最新データを読み込んでください。");
  return {
    operationId,
    token,
    owner: user.uid,
    expiresAt,
    path,
    record: result.snapshot.val() as T,
  };
}

async function assertConversionLockOwned<T>(handle: ConversionLockHandle<T>) {
  const row = (await get(rootRef(handle.path))).val() as ConversionLockCarrier | null;
  const lock = row?.conversionLock;
  if (!lock || lock.operationId !== handle.operationId || lock.token !== handle.token
    || lock.owner !== handle.owner || Number(lock.expiresAt || 0) <= Date.now()) {
    throw new Error("在籍化処理の排他情報が失われました。最新データを読み込んでやり直してください。");
  }
}

async function releaseConversionLock<T>(handle: ConversionLockHandle<T>) {
  await runTransaction(rootRef(handle.path), (current) => {
    if (!current || typeof current !== "object") return current;
    const row = current as Record<string, unknown> & ConversionLockCarrier;
    const lock = row.conversionLock;
    if (!lock || lock.operationId !== handle.operationId || lock.token !== handle.token || lock.owner !== handle.owner) return current;
    const next = { ...row };
    delete next.conversionLock;
    return clean(next);
  }, { applyLocally: false });
}

function validateDailyClosingForSubmission(value: DailyClosing) {
  const require = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const money = (amount: unknown) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0;
  const unique = (values: string[]) => new Set(values).size === values.length;
  require(validDate(value.businessDate), "営業日が正しくありません。");
  require(value.posSnapshot && value.posSnapshot.businessDate === value.businessDate, "POS原本と営業日が一致しません。");
  require(value.posSnapshot?.submissionId === value.submissionId && value.posSnapshot?.checksum === value.checksum, "POS原本の識別情報が一致しません。");
  require(Array.isArray(value.casts) && Array.isArray(value.staffWork) && Array.isArray(value.drivers) && Array.isArray(value.expenses), "店舗入力データが不完全です。");
  require(unique(value.casts.map((row) => row.posCastId)), "同じキャストの店舗データが重複しています。");
  require(unique(value.staffWork.map((row) => row.staffId)), "同じスタッフの勤務データが重複しています。");
  require(unique(value.drivers.map((row) => row.driverId)), "同じドライバーの勤務データが重複しています。");
  require(money(value.sales.totalSales) && money(value.sales.cashSales) && money(value.sales.cardSales), "売上金額が正しくありません。");
  require(value.sales.cashSales + value.sales.cardSales === value.sales.totalSales, "現金売上とカード売上の合計が総売上と一致しません。");
  require(value.sales.totalSales === value.posSnapshot.sales.totalSales
    && value.sales.cashSales === value.posSnapshot.sales.cashSales
    && value.sales.cardSales === value.posSnapshot.sales.cardSales,
  "店舗売上がPOS原本と一致しません。JSONを再取込してください。");
  require(value.customers.groupCount === value.posSnapshot.customers.groupCount
    && value.customers.totalCustomers === value.posSnapshot.customers.totalCustomers,
  "来客数がPOS原本と一致しません。JSONを再取込してください。");
  require(value.nominations.honShimeiCount === value.posSnapshot.nominations.honShimeiCount
    && value.nominations.jonaiCount === value.posSnapshot.nominations.jonaiCount,
  "指名本数がPOS原本と一致しません。JSONを再取込してください。");
  value.casts.forEach((row) => {
    require((row.kind === "regular" || row.kind === "trial") && Boolean(row.masterId) && Boolean(row.posCastId) && Boolean(row.name), "キャストデータの識別情報が正しくありません。");
    require(money(row.hours) && row.hours > 0 && Number.isInteger(row.hours * 4), `${row.name}の勤務時間が15分単位ではありません。`);
    [row.hourlyRate, row.honShimeiCount, row.banaiShimeiCount, row.dohanCount, row.dohanBack,
      row.honShimeiSales, row.jonaiExtensionSales, row.drinkSales, row.liquorCost, row.beautyAllowance,
      row.dailyPayment, row.advancePayment, row.transportFee].forEach((amount) => require(money(amount), `${row.name}に不正な金額または本数があります。`));
    require(row.honShimeiSales % 100 === 0 && row.jonaiExtensionSales % 100 === 0, `${row.name}の売上は100円単位で入力してください。`);
    require(row.transportFee % 500 === 0, `${row.name}の送迎代は500円単位で入力してください。`);
    require(row.beautyAllowance === 0 || (row.kind === "regular" && row.beautyAllowance === 500), `${row.name}の美容室手当が正しくありません。`);
    require(Array.isArray(row.bottles), `${row.name}のボトル明細が不完全です。`);
    row.bottles.forEach((bottle) => {
      require(Boolean(bottle.itemId) && Boolean(bottle.name) && money(bottle.quantity) && bottle.quantity > 0, `${row.name}のボトル明細が正しくありません。`);
      require(money(bottle.salesAmount) && money(bottle.costAmount), `${row.name}のボトル金額が正しくありません。`);
    });
    const bottleCost = row.bottles.reduce((sum, bottle) => sum + bottle.costAmount, 0);
    require(Math.abs(bottleCost - row.liquorCost) < 0.001, `${row.name}の酒代原価合計が明細と一致しません。`);
  });
  value.staffWork.forEach((row) => {
    require((row.kind === "regular" || row.kind === "trial") && Boolean(row.staffId) && Boolean(row.name) && money(row.hours) && row.hours > 0 && Number.isInteger(row.hours * 4), `${row.name}のスタッフ勤務が正しくありません。`);
    require(money(row.hourlyRate) && money(row.dailyPayment), `${row.name}のスタッフ給与金額が正しくありません。`);
    if (row.kind === "trial") require(row.dailyPayment === Math.floor(row.hourlyRate * row.hours / 100) * 100, `${row.name}の体入給与は当日の基本給与全額を日払いにしてください。`);
  });
  value.drivers.forEach((row) => {
    require(Boolean(row.driverId) && Boolean(row.name) && money(row.dailyRate) && money(row.dailyPayment), `${row.name}のドライバー給与金額が正しくありません。`);
  });
  value.expenses.forEach((row) => require(Boolean(row.id) && Boolean(row.payee?.trim()) && money(row.amount) && row.amount > 0, "経費の支払先または金額が正しくありません。"));
  [value.dispatchStaffPayment, value.dispatchCastPayment, value.dispatchFee, value.liquorDeliveryAmount,
    value.cash.cashSales, value.cash.cardSales, value.cash.totalSales, value.cash.cashFloat,
    value.cash.expenseAndPaymentTotal, value.cash.actualClosingCash].forEach((amount) => require(money(amount), "現金照合に不正な金額があります。"));
  const staffDaily = value.staffWork.reduce((sum, row) => sum + row.dailyPayment, 0);
  require(value.staffDailyPaymentTotal === staffDaily, "スタッフ日払い合計が勤務明細と一致しません。");
  const expenseTotal = value.expenses.reduce((sum, row) => sum + row.amount, 0);
  const castDaily = value.casts.reduce((sum, row) => sum + row.dailyPayment, 0);
  const driverDaily = value.drivers.reduce((sum, row) => sum + row.dailyPayment, 0);
  const paymentTotal = expenseTotal + castDaily + staffDaily + driverDaily
    + value.dispatchStaffPayment + value.dispatchCastPayment + value.dispatchFee;
  const expectedClosingCash = value.sales.cashSales + value.cash.cashFloat - paymentTotal;
  require(value.cash.cashSales === value.sales.cashSales && value.cash.cardSales === value.sales.cardSales && value.cash.totalSales === value.sales.totalSales, "現金照合の売上がPOS売上と一致しません。");
  require(value.cash.expenseAndPaymentTotal === paymentTotal, "経費・日払い・派遣支払の合計が現金照合と一致しません。");
  require(value.cash.expectedClosingCash === expectedClosingCash && value.cash.cashProfit === expectedClosingCash - value.cash.cashFloat, "計算上の現金残額が一致しません。");
  require(value.cash.difference === value.cash.actualClosingCash - expectedClosingCash, "現金照合差額が一致しません。");
  require((value.integrityIssues?.length || 0) === 0, "不完全な店舗データは送信できません。");
}

type EntryEventPlan = Record<string, IntroducerEntryEvent | null>;

async function entryEventPlanApplied(plan: EntryEventPlan) {
  const checks = await Promise.all(Object.entries(plan).map(async ([path, expected]) => {
    const actual = (await get(rootRef(path))).val();
    if (expected === null) return actual === null;
    return JSON.stringify(canonicalComparisonValue(actual)) === JSON.stringify(canonicalComparisonValue(expected));
  }));
  return checks.every(Boolean);
}

async function applyEntryEventPlanAfterCastSaved(plan: EntryEventPlan) {
  if (!Object.keys(plan).length) return;
  try {
    await update(rootRef(), clean(plan));
    return;
  } catch {
    // 応答だけ失われた場合は、同じupdatedAtで再更新してrulesに拒否される前に保存結果を確認する。
    if (await entryEventPlanApplied(plan).catch(() => false)) return;
  }
  try {
    await update(rootRef(), clean(plan));
    return;
  } catch {
    if (await entryEventPlanApplied(plan).catch(() => false)) return;
  }
  throw new Error("キャスト本体は保存されましたが、入店顧問料履歴を同期できませんでした。最新データを読み込み、同じキャストをもう一度保存してください。");
}

class AmbiguousConversionWriteError extends Error {}

async function applyConversionPlanWithVerification(
  plan: Record<string, unknown>,
  isApplied: () => Promise<boolean>,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await update(rootRef(), clean(plan));
      return;
    } catch (error) {
      lastError = error;
      try {
        if (await isApplied()) return;
      } catch {
        if (attempt === 1) {
          throw new AmbiguousConversionWriteError(
            "在籍化の保存結果を確認できませんでした。通信状態を確認し、最新データを読み込んでから在籍・体入データの状態を確認してください。",
          );
        }
      }
    }
  }
  throw lastError;
}

async function conversionPlanApplied(
  activePath: string,
  expectedActive: Record<string, unknown>,
  trialPath: string,
  convertedField: "convertedToCastId" | "convertedToStaffId",
  activeId: string,
  entryEventPlan: EntryEventPlan = {},
) {
  const [activeSnapshot, trialSnapshot, eventsApplied] = await Promise.all([
    get(rootRef(activePath)),
    get(rootRef(trialPath)),
    entryEventPlanApplied(entryEventPlan),
  ]);
  const active = activeSnapshot.val();
  const trial = trialSnapshot.val() as (Record<string, unknown> & ConversionLockCarrier) | null;
  return Boolean(
    active
      && JSON.stringify(canonicalComparisonValue(active)) === JSON.stringify(canonicalComparisonValue(expectedActive))
      && trial?.[convertedField] === activeId
      && !trial.conversionLock
      && eventsApplied,
  );
}

function entryEventFinancialFields(value: Partial<CastRecord> | null) {
  return [value?.hiredAt || "", value?.introducerId || "", Number(value?.entryAdvisoryFee || 0)].join("\u0000");
}

async function prepareEntryEventPlan(
  before: CastRecord | null,
  next: CastRecord,
  introducer: IntroducerRecord | null,
  user: User,
): Promise<EntryEventPlan> {
  const financialFieldsUnchanged = Boolean(before
    && entryEventFinancialFields(before) === entryEventFinancialFields(next));
  const [eventsSnapshot, statesSnapshot] = await Promise.all([
    get(rootRef("introducerEntryEvents")),
    get(rootRef("accountingMonthStates")),
  ]);
  const allEvents = (eventsSnapshot.val() || {}) as Record<string, Record<string, IntroducerEntryEvent>>;
  const states = (statesSnapshot.val() || {}) as Record<string, AccountingMonthState>;
  const existing = Object.entries(allEvents).flatMap(([month, rows]) => {
    const event = rows?.[next.id];
    return event ? [{ month, event }] : [];
  });
  const desiredMonth = validDate(next.hiredAt) ? next.hiredAt!.slice(0, 7) : "";
  const unchangedHistoricalFee = Boolean(before
    && before.hiredAt === next.hiredAt
    && before.introducerId === next.introducerId
    && Number(before.entryAdvisoryFee || 0) === Number(next.entryAdvisoryFee || 0)
    && Number(next.entryAdvisoryFee || 0) > 0);
  const shouldStore = Boolean(
    desiredMonth && next.introducerId && introducer && (introducer.entryAdvisoryEnabled || unchangedHistoricalFee)
      && nonNegative(next.entryAdvisoryFee) && Number(next.entryAdvisoryFee) > 0,
  );
  if (financialFieldsUnchanged) {
    const current = existing.find((row) => row.month === desiredMonth)?.event;
    const currentMatches = Boolean(current
      && current.castId === next.id
      && current.hiredAt === next.hiredAt
      && current.introducerId === next.introducerId
      && current.amount === Number(next.entryAdvisoryFee));
    // 作成済みイベントは当時の紹介者名・報酬形態・キャスト名を保持する。
    // マスタの名称変更・無効化・物理削除やキャスト名だけの変更では過去イベントを書き換えない。
    if ((currentMatches && existing.length === 1) || (!shouldStore && existing.length === 0)) return {};
  }
  const affectedMonths = new Set(existing.map((row) => row.month));
  if (shouldStore) affectedMonths.add(desiredMonth);
  for (const month of affectedMonths) {
    if (states[month] && states[month].status !== "open") {
      // 財務条件が変わらない編集では、確定月の履歴を補正・削除せずそのまま保持する。
      // 不足・旧形式イベントは計算側で現マスタとの一致を検証し、名称や備考の編集だけを妨げない。
      if (financialFieldsUnchanged) return {};
      throw new Error(`${month}は月次確定処理中または確定済みのため、入店顧問料に関わる採用日・紹介者・金額を変更できません。`);
    }
  }
  const plan: EntryEventPlan = {};
  existing.forEach(({ month }) => { plan[`introducerEntryEvents/${month}/${next.id}`] = null; });
  if (shouldStore && introducer) {
    const previous = existing.find((row) => row.month === desiredMonth)?.event;
    const timestamp = now();
    plan[`introducerEntryEvents/${desiredMonth}/${next.id}`] = {
      id: next.id,
      month: desiredMonth,
      hiredAt: next.hiredAt!,
      castId: next.id,
      castName: next.name,
      introducerId: introducer.id,
      introducerName: introducer.name,
      feeType: introducer.feeType,
      amount: Number(next.entryAdvisoryFee),
      createdAt: previous?.createdAt || timestamp,
      createdBy: previous?.createdBy || user.uid,
      updatedAt: timestamp,
      updatedBy: user.uid,
    };
  }
  return plan;
}

async function requireUser(user: User, roles?: Role[]) {
  const role = await userRole(user);
  if (roles && !roles.includes(role)) throw new Error("この操作を実行する権限がありません。");
  return role;
}

export async function userRole(user: User): Promise<Role> {
  const snapshot = await get(ref(database, `users/${user.uid}/role`));
  const role = String(snapshot.val() || "");
  if (role === "shop" || role === "accounting" || role === "op") return role;
  throw new Error("Firebaseのusers/{uid}/roleにshop、accounting、opのいずれかを設定してください。");
}

export async function loadWorkspaceData(role?: Role): Promise<AccountingWorkspaceData> {
  const accountingAccess = role === "accounting" || role === "op";
  const [casts, staff, drivers, introducers, liquor, closings, cashFloat, adjustments, entryEvents, monthStates, monthSnapshots] = await Promise.all([
    get(rootRef("casts")), get(rootRef("staff")), get(rootRef("drivers")), get(rootRef("introducers")),
    get(rootRef("liquorCosts")), get(rootRef("history")), get(rootRef("config/cashFloat")),
    accountingAccess ? get(rootRef("accountingAdjustments")) : Promise.resolve(null),
    accountingAccess ? get(rootRef("introducerEntryEvents")) : Promise.resolve(null),
    get(rootRef("accountingMonthStates")),
    accountingAccess ? get(rootRef("accountingMonthSnapshots")) : Promise.resolve(null),
  ]);
  const allCastRows = asArray<CastRecord & { deletedAt?: string }>(casts.val());
  const allStaffRows = asArray<StaffRecord & { deletedAt?: string }>(staff.val());
  const entryEventRows = Object.entries((entryEvents?.val() || {}) as Record<string, Record<string, IntroducerEntryEvent>>)
    .flatMap(([month, rows]) => Object.entries(rows || {}).map(([id, row]) => ({ ...row, id, month })));
  const monthStateRows = Object.entries((monthStates?.val() || {}) as Record<string, Omit<AccountingMonthState, "month">>)
    .map(([month, row]) => ({ ...row, month }));
  const monthSnapshotRows = Object.entries((monthSnapshots?.val() || {}) as Record<string, Record<string, MonthlyAccountingSnapshot>>)
    .flatMap(([month, rows]) => Object.entries(rows || {}).flatMap(([revision, row]) => {
      const normalized = normalizeMonthlyAccountingSnapshot(row, month, Number(revision));
      return normalized ? [normalized] : [];
    }));
  return {
    casts: allCastRows.filter((row) => !row.deletedAt).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja")),
    staff: allStaffRows.filter((row) => !row.deletedAt).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja")),
    drivers: asArray<DriverRecord>(drivers.val()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja")),
    introducers: asArray<IntroducerRecord>(introducers.val()).sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ja")),
    liquor: asArray<LiquorRecord>(liquor.val()).sort((a, b) => String(a.kind || "").localeCompare(String(b.kind || "")) || String(a.name || "").localeCompare(String(b.name || ""), "ja")),
    closings: asArray<DailyClosing>(closings.val()).map(normalizeDailyClosing).sort((a, b) => b.businessDate.localeCompare(a.businessDate)),
    adjustments: Object.entries((adjustments?.val() || {}) as Record<string, Omit<MonthlyAdjustments, "month">>)
      .map(([month, row]) => normalizeMonthlyAdjustments({ month, ...row } as MonthlyAdjustments)),
    cashFloat: Number(cashFloat.val() ?? 200000),
    archivedCasts: accountingAccess ? allCastRows.filter((row) => Boolean(row.deletedAt)) : [],
    archivedStaff: accountingAccess ? allStaffRows.filter((row) => Boolean(row.deletedAt)) : [],
    introducerEntryEvents: entryEventRows,
    monthStates: monthStateRows,
    monthSnapshots: monthSnapshotRows,
  };
}

async function loadIntroducer(introducerId: string | undefined) {
  if (!introducerId) return null;
  const row = (await get(rootRef(`introducers/${introducerId}`))).val() as Omit<IntroducerRecord, "id"> | null;
  // Firebase内のマスタはパスをIDとして保存するため、参照時に必ず復元する。
  return row ? { ...row, id: introducerId } as IntroducerRecord : null;
}

function normalizeCastAdvisoryFees(
  value: Partial<CastRecord>,
  before: CastRecord | null,
  introducerId: string | undefined,
  introducer: IntroducerRecord | null,
) {
  if (value.attendanceAdvisoryFee !== undefined && !nonNegative(value.attendanceAdvisoryFee)) {
    throw new Error("出勤顧問料が正しくありません。");
  }
  if (value.entryAdvisoryFee !== undefined && !nonNegative(value.entryAdvisoryFee)) {
    throw new Error("入店顧問料が正しくありません。");
  }
  if (!introducerId || value.status === "trial") {
    return { attendanceAdvisoryFee: undefined, entryAdvisoryFee: undefined };
  }
  if (!introducer) {
    // 紹介者が旧版で物理削除済みでも、既存キャストの非財務編集は許可して当時条件を保持する。
    if (!before || before.introducerId !== introducerId) {
      throw new Error("選択された紹介者データが見つかりません。紹介者を選び直してください。");
    }
    if ((Object.hasOwn(value, "attendanceAdvisoryFee") && value.attendanceAdvisoryFee !== before.attendanceAdvisoryFee)
      || (Object.hasOwn(value, "entryAdvisoryFee") && value.entryAdvisoryFee !== before.entryAdvisoryFee)) {
      throw new Error("削除済みの紹介者に紐づく顧問料は変更できません。紹介者を選び直してください。");
    }
    return {
      attendanceAdvisoryFee: before.attendanceAdvisoryFee,
      entryAdvisoryFee: before.entryAdvisoryFee,
    };
  }
  return {
    attendanceAdvisoryFee: introducer.attendanceAdvisoryEnabled
      ? value.attendanceAdvisoryFee ?? before?.attendanceAdvisoryFee
      : undefined,
    // 既に発生済みの一回限りの入店顧問料は、紹介者マスタを後日無効化しても消さない。
    entryAdvisoryFee: introducer.entryAdvisoryEnabled
      || (before?.introducerId === introducerId && Number(before.entryAdvisoryFee || 0) > 0)
      ? value.entryAdvisoryFee ?? before?.entryAdvisoryFee
      : undefined,
  };
}

export async function saveCast(value: Partial<CastRecord> & Pick<CastRecord, "name" | "legalName" | "status">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("cast");
  const timestamp = now();
  const [existingSnapshot, allSnapshot] = await Promise.all([get(rootRef(`casts/${id}`)), get(rootRef("casts"))]);
  const before = existingSnapshot.val() as CastRecord | null;
  if (value.id && !before) throw new Error("対象のキャストデータが見つかりません。最新データを読み込んでください。");
  if ((before as (CastRecord & { deletedAt?: string }) | null)?.deletedAt) throw new Error("このキャストデータは削除されています。最新データを読み込んでください。");
  assertConversionUnlocked(before as (CastRecord & ConversionLockCarrier) | null);
  assertFresh(before, value.updatedAt);
  const name = value.name.trim();
  const legalName = value.legalName.trim();
  if (!name || !legalName) throw new Error("キャスト名と本名を入力してください。");
  if (value.status === "active" && !validDate(value.hiredAt || before?.hiredAt)) throw new Error("採用日が正しくありません。");
  if (value.status === "trial" && !validDate(value.trialDate || before?.trialDate)) throw new Error("体入日が正しくありません。");
  if (value.status === "departed" && (!validDate(value.hiredAt || before?.hiredAt) || !validDate(value.departedAt || before?.departedAt))) throw new Error("採用日または退店日が正しくありません。");
  if (value.status === "departed" && String(value.departedAt || before?.departedAt) < String(value.hiredAt || before?.hiredAt)) throw new Error("退店日は採用日以降にしてください。");
  const hourlyRates = value.hourlyRates || before?.hourlyRates || {};
  if (!Object.entries(hourlyRates).every(([month, amount]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && nonNegative(amount))) throw new Error("月度時給が正しくありません。");
  if (value.status !== "trial" && Object.keys(hourlyRates).some((month) => month < String(value.hiredAt || before?.hiredAt).slice(0, 7))) throw new Error("採用月より前の月度時給は登録できません。");
  if (value.trialHourlyRate !== undefined && !nonNegative(value.trialHourlyRate)) throw new Error("体入時給が正しくありません。");
  const introducerId = String(Object.hasOwn(value, "introducerId") ? value.introducerId || "" : before?.introducerId || "").trim() || undefined;
  const introducer = await loadIntroducer(introducerId);
  const advisoryFees = normalizeCastAdvisoryFees(value, before, introducerId, introducer);
  const proposed = clean({
    ...withoutInternalFields(before || {}), ...withoutInternalFields(value), id, name, legalName, hourlyRates, introducerId,
    ...advisoryFees,
    note: value.note ?? "",
    createdAt: before?.createdAt || timestamp, updatedAt: timestamp,
  }) as CastRecord;
  const entryEventPlan = await prepareEntryEventPlan(before, proposed, introducer, user);
  const oldClaim = before?.status === "active" ? claimKey(before.name) : "";
  const newClaim = value.status === "active" ? claimKey(name) : "";
  let newClaimHandle: ClaimHandle | undefined;
  if (newClaim) {
    const duplicate = asArray<CastRecord & { deletedAt?: string }>(allSnapshot.val()).some((row) => !row.deletedAt && row.id !== id && row.status === "active" && String(row.name || "").trim() === name);
    if (duplicate) throw new Error("同じキャスト名の在籍キャストは登録できません。");
    try {
      newClaimHandle = await acquireClaim("castNameClaims", newClaim, id);
    } catch (error) {
      throw claimAcquisitionError(error, "同じキャスト名の在籍キャストは登録できません。");
    }
  }
  try {
    await runTransaction(rootRef(`casts/${id}`), (current) => {
      const existing = current as CastRecord | null;
      if (value.id && !existing) throw new Error("対象のキャストデータが見つかりません。最新データを読み込んでください。");
      if ((existing as (CastRecord & { deletedAt?: string }) | null)?.deletedAt) throw new Error("このキャストデータは削除されています。最新データを読み込んでください。");
      assertConversionUnlocked(existing as (CastRecord & ConversionLockCarrier) | null);
      assertFresh(existing, value.updatedAt);
      return clean(withoutInternalFields(proposed));
    }, { applyLocally: false });
  } catch (error) {
    if (newClaimHandle) await releasePendingClaim(newClaimHandle).catch(() => undefined);
    throw error;
  }
  if (newClaimHandle) await commitClaimAfterEntitySaved(newClaimHandle, "キャスト");
  await applyEntryEventPlanAfterCastSaved(entryEventPlan);
  if (oldClaim && oldClaim !== newClaim) await releaseClaimAfterEntitySaved("castNameClaims", oldClaim, id, "キャスト");
  return id;
}

export async function convertTrialCast(trialId: string, value: Partial<CastRecord> & Pick<CastRecord, "hiredAt">, user: User) {
  await requireUser(user);
  const activeId = entityId("cast");
  const timestamp = now();
  const [trialSnapshot, allSnapshot] = await Promise.all([get(rootRef(`casts/${trialId}`)), get(rootRef("casts"))]);
  const initialTrial = trialSnapshot.val() as (CastRecord & ConversionLockCarrier) | null;
  if (!initialTrial || initialTrial.status !== "trial") throw new Error("体入キャストが見つかりません。");
  if (initialTrial.deletedAt) throw new Error("この体入キャストは削除されています。");
  if (initialTrial.convertedToCastId) throw new Error("この体入キャストはすでに在籍登録されています。");
  assertConversionUnlocked(initialTrial);
  assertFresh(initialTrial, value.updatedAt);
  const incoming = withoutInternalFields(value);
  const name = String(incoming.name || initialTrial.name || "").trim();
  if (!name) throw new Error("キャスト名を入力してください。");
  const legalName = String(incoming.legalName || initialTrial.legalName || "").trim();
  if (!legalName) throw new Error("本名を入力してください。");
  const hiredAt = incoming.hiredAt || "";
  if (!validDate(hiredAt)) throw new Error("採用日が正しくありません。");
  if (validDate(initialTrial.trialDate) && hiredAt < initialTrial.trialDate!) throw new Error("採用日は体入日以降にしてください。");
  if (!Object.entries(incoming.hourlyRates || {}).every(([month, amount]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && nonNegative(amount))) {
    throw new Error("月度時給が正しくありません。");
  }
  if (Object.keys(incoming.hourlyRates || {}).some((month) => month < hiredAt.slice(0, 7))) throw new Error("採用月より前の月度時給は登録できません。");
  if (asArray<CastRecord & { deletedAt?: string }>(allSnapshot.val()).some((row) => !row.deletedAt && row.status === "active" && String(row.name || "").trim() === name)) {
    throw new Error("同じキャスト名の在籍キャストは登録できません。");
  }
  let conversionLock: ConversionLockHandle<CastRecord> | undefined;
  let nameClaimHandle: ClaimHandle | undefined;
  try {
    conversionLock = await acquireConversionLock<CastRecord>(
      `casts/${trialId}`,
      value.updatedAt,
      (row) => row.convertedToCastId,
      "体入キャストが見つかりません。",
      user,
    );
    const trial = conversionLock.record;
    if (trial.deletedAt) throw new Error("この体入キャストは削除されています。");
    const introducerId = String(Object.hasOwn(incoming, "introducerId") ? incoming.introducerId || "" : trial.introducerId || "").trim() || undefined;
    const introducer = await loadIntroducer(introducerId);
    const advisoryFees = normalizeCastAdvisoryFees({ ...incoming, status: "active" }, trial, introducerId, introducer);
    const proposed = clean({
      ...withoutInternalFields(trial), ...incoming, id: activeId, name, legalName, status: "active",
      hourlyRates: incoming.hourlyRates || {}, introducerId, ...advisoryFees,
      convertedFromTrialId: trialId, convertedToCastId: undefined, departedAt: undefined,
      createdAt: timestamp, updatedAt: timestamp,
    }) as CastRecord;
    const entryEventPlan = await prepareEntryEventPlan(null, proposed, introducer, user);
    try {
      nameClaimHandle = await acquireClaim("castNameClaims", claimKey(name), activeId);
    } catch (error) {
      throw claimAcquisitionError(error, "同じキャスト名の在籍キャストは登録できません。");
    }
    await assertConversionLockOwned(conversionLock);
    const storedActive = clean(withoutInternalFields(proposed)) as Record<string, unknown>;
    const conversionPlan = {
      [`casts/${activeId}`]: {
        ...storedActive,
      },
      [`casts/${trialId}/convertedToCastId`]: activeId,
      [`casts/${trialId}/updatedAt`]: timestamp,
      [`casts/${trialId}/conversionLock`]: null,
      ...entryEventPlan,
    };
    await applyConversionPlanWithVerification(
      conversionPlan,
      () => conversionPlanApplied(
        `casts/${activeId}`,
        storedActive,
        `casts/${trialId}`,
        "convertedToCastId",
        activeId,
        entryEventPlan,
      ),
    );
  } catch (error) {
    // 保存結果自体を確認できない通信障害では、成功済みデータのclaimを誤って解放しない。
    // 排他情報はTTLで自動失効し、再読込後に実データを確認できる。
    if (!(error instanceof AmbiguousConversionWriteError)) {
      if (nameClaimHandle) await releasePendingClaim(nameClaimHandle).catch(() => undefined);
      if (conversionLock) await releaseConversionLock(conversionLock).catch(() => undefined);
    }
    throw error;
  }
  if (nameClaimHandle) await commitClaimAfterEntitySaved(nameClaimHandle, "在籍キャスト");
  return activeId;
}

export async function departCast(id: string, date: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  if (!validDate(date)) throw new Error("退店日はYYYY-MM-DD形式の実在する日付で入力してください。");
  const timestamp = now();
  const result = await runTransaction(rootRef(`casts/${id}`), (current) => {
    const existing = current as (CastRecord & ConversionLockCarrier) | null;
    if (!existing || existing.status !== "active" || existing.deletedAt) throw new Error("在籍キャストが見つかりません。最新データを読み込んでください。");
    assertConversionUnlocked(existing);
    assertFresh(existing, expectedUpdatedAt);
    if (existing.hiredAt && date < existing.hiredAt) throw new Error("退店日は採用日以降にしてください。");
    return clean({ ...withoutInternalFields(existing), status: "departed", departedAt: date, updatedAt: timestamp });
  }, { applyLocally: false });
  const departed = result.snapshot.val() as CastRecord | null;
  if (!departed) throw new Error("退店登録を完了できませんでした。最新データを読み込んでください。");
  await releaseClaimAfterEntitySaved("castNameClaims", claimKey(departed.name), id, "キャスト退店");
}
export async function restoreCast(id: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  const timestamp = now();
  const [targetSnapshot, allSnapshot] = await Promise.all([get(rootRef(`casts/${id}`)), get(rootRef("casts"))]);
  const target = targetSnapshot.val() as CastRecord | null;
  if (!target || target.status !== "departed") throw new Error("退店キャストが見つかりません。");
  assertFresh(target, expectedUpdatedAt);
  if (asArray<CastRecord & { deletedAt?: string }>(allSnapshot.val()).some((row) => !row.deletedAt && row.id !== id && row.status === "active" && String(row.name || "").trim() === String(target.name || "").trim())) {
    throw new Error("同じキャスト名の在籍キャストがいるため、退店取消できません。");
  }
  const nameClaim = claimKey(target.name);
  let nameClaimHandle: ClaimHandle | undefined;
  try {
    nameClaimHandle = await acquireClaim("castNameClaims", nameClaim, id);
  } catch (error) {
    throw claimAcquisitionError(error, "同じキャスト名の在籍キャストがいるため、退店取消できません。");
  }
  try {
    await runTransaction(rootRef(`casts/${id}`), (current) => {
      const existing = current as CastRecord | null;
      if (!existing || existing.status !== "departed") throw new Error("退店キャストが更新されています。最新データを読み込んでください。");
      assertConversionUnlocked(existing as CastRecord & ConversionLockCarrier);
      assertFresh(existing, expectedUpdatedAt);
      const restored = { ...withoutInternalFields(existing), status: "active" as const, updatedAt: timestamp };
      delete restored.departedAt;
      return restored;
    }, { applyLocally: false });
  } catch (error) {
    if (nameClaimHandle) await releasePendingClaim(nameClaimHandle).catch(() => undefined);
    throw error;
  }
  if (nameClaimHandle) await commitClaimAfterEntitySaved(nameClaimHandle, "退店取消後のキャスト");
}
export async function deleteCast(id: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  const existing = (await get(rootRef(`casts/${id}`))).val() as CastRecord | null;
  if (!existing) return;
  if (existing.deletedAt) return;
  assertConversionUnlocked(existing as CastRecord & ConversionLockCarrier);
  assertFresh(existing, expectedUpdatedAt);
  const deletedAt = now();
  await runTransaction(rootRef(`casts/${id}`), (current) => {
    const row = current as (CastRecord & ConversionLockCarrier) | null;
    if (!row) throw new Error("このキャストデータはすでに削除されています。");
    if (row.deletedAt) return row;
    assertConversionUnlocked(row);
    assertFresh(row, expectedUpdatedAt);
    return clean({ ...withoutInternalFields(row), deletedAt, deletedBy: user.uid, updatedAt: deletedAt });
  }, { applyLocally: false });
  if (existing.status === "active") await releaseClaimAfterEntitySaved("castNameClaims", claimKey(existing.name), id, "キャスト削除");
}

export async function saveStaff(value: Partial<StaffRecord> & Pick<StaffRecord, "name" | "status">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("staff");
  const timestamp = now();
  await runTransaction(rootRef(`staff/${id}`), (current) => {
    const existing = current as (StaffRecord & ConversionLockCarrier) | null;
    if (value.id && !existing) throw new Error("対象のスタッフデータが見つかりません。最新データを読み込んでください。");
    if (existing?.deletedAt) throw new Error("このスタッフデータは削除されています。最新データを読み込んでください。");
    assertConversionUnlocked(existing);
    assertFresh(existing, value.updatedAt);
    const name = value.name.trim();
    if (!name) throw new Error("スタッフ名を入力してください。");
    if (value.status === "active" && !validDate(value.hiredAt || existing?.hiredAt)) throw new Error("採用日が正しくありません。");
    if (value.status === "trial" && !validDate(value.trialDate || existing?.trialDate)) throw new Error("体入日が正しくありません。");
    if (value.status === "departed" && (!validDate(value.hiredAt || existing?.hiredAt) || !validDate(value.departedAt || existing?.departedAt))) throw new Error("採用日または退店日が正しくありません。");
    if (value.status === "departed" && String(value.departedAt || existing?.departedAt) < String(value.hiredAt || existing?.hiredAt)) throw new Error("退店日は採用日以降にしてください。");
    if (value.hourlyRate !== undefined && !nonNegative(value.hourlyRate)) throw new Error("時給が正しくありません。");
    if (value.trialHourlyRate !== undefined && !nonNegative(value.trialHourlyRate)) throw new Error("体入時給が正しくありません。");
    return clean({ ...withoutInternalFields(existing || {}), ...withoutInternalFields(value), name, note: value.note ?? "", createdAt: existing?.createdAt || timestamp, updatedAt: timestamp });
  }, { applyLocally: false });
  return id;
}

export async function convertTrialStaff(trialId: string, value: Partial<StaffRecord> & Pick<StaffRecord, "hiredAt" | "hourlyRate">, user: User) {
  await requireUser(user);
  const activeId = entityId("staff");
  const timestamp = now();
  const initialTrial = (await get(rootRef(`staff/${trialId}`))).val() as (StaffRecord & ConversionLockCarrier) | null;
  if (!initialTrial || initialTrial.status !== "trial" || initialTrial.deletedAt) throw new Error("体入スタッフが見つかりません。");
  if (initialTrial.convertedToStaffId) throw new Error("この体入スタッフはすでに在籍登録されています。");
  assertConversionUnlocked(initialTrial);
  assertFresh(initialTrial, value.updatedAt);
  const incoming = withoutInternalFields(value);
  const hiredAt = incoming.hiredAt || "";
  if (!validDate(hiredAt)) throw new Error("採用日が正しくありません。");
  if (validDate(initialTrial.trialDate) && hiredAt < initialTrial.trialDate!) throw new Error("採用日は体入日以降にしてください。");
  if (!nonNegative(incoming.hourlyRate)) throw new Error("時給が正しくありません。");
  const name = String(incoming.name || initialTrial.name || "").trim();
  if (!name) throw new Error("スタッフ名を入力してください。");
  let conversionLock: ConversionLockHandle<StaffRecord> | undefined;
  try {
    conversionLock = await acquireConversionLock<StaffRecord>(
      `staff/${trialId}`,
      value.updatedAt,
      (row) => row.convertedToStaffId,
      "体入スタッフが見つかりません。",
      user,
    );
    const trial = conversionLock.record;
    if (trial.deletedAt) throw new Error("この体入スタッフは削除されています。");
    await assertConversionLockOwned(conversionLock);
    const storedActive = clean({
      ...withoutInternalFields(trial), ...incoming, name, status: "active", convertedFromTrialId: trialId,
      convertedToStaffId: undefined, departedAt: undefined, createdAt: timestamp, updatedAt: timestamp,
    }) as Record<string, unknown>;
    const conversionPlan = {
      [`staff/${activeId}`]: storedActive,
      [`staff/${trialId}/convertedToStaffId`]: activeId,
      [`staff/${trialId}/updatedAt`]: timestamp,
      [`staff/${trialId}/conversionLock`]: null,
    };
    await applyConversionPlanWithVerification(
      conversionPlan,
      () => conversionPlanApplied(
        `staff/${activeId}`,
        storedActive,
        `staff/${trialId}`,
        "convertedToStaffId",
        activeId,
      ),
    );
  } catch (error) {
    if (!(error instanceof AmbiguousConversionWriteError) && conversionLock) {
      await releaseConversionLock(conversionLock).catch(() => undefined);
    }
    throw error;
  }
  return activeId;
}

export async function departStaff(id: string, date: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  if (!validDate(date)) throw new Error("退店日はYYYY-MM-DD形式の実在する日付で入力してください。");
  const timestamp = now();
  await runTransaction(rootRef(`staff/${id}`), (current) => {
    const existing = current as (StaffRecord & ConversionLockCarrier) | null;
    if (!existing || existing.status !== "active" || existing.deletedAt) throw new Error("在籍スタッフが見つかりません。最新データを読み込んでください。");
    assertConversionUnlocked(existing);
    assertFresh(existing, expectedUpdatedAt);
    if (existing.hiredAt && date < existing.hiredAt) throw new Error("退店日は採用日以降にしてください。");
    return clean({ ...withoutInternalFields(existing), status: "departed", departedAt: date, updatedAt: timestamp });
  }, { applyLocally: false });
}
export async function restoreStaff(id: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  const timestamp = now();
  await runTransaction(rootRef(`staff/${id}`), (current) => {
    const existing = current as (StaffRecord & ConversionLockCarrier) | null;
    if (!existing || existing.status !== "departed" || existing.deletedAt) throw new Error("退店スタッフが見つかりません。最新データを読み込んでください。");
    assertConversionUnlocked(existing);
    assertFresh(existing, expectedUpdatedAt);
    return clean({ ...withoutInternalFields(existing), status: "active", departedAt: undefined, updatedAt: timestamp });
  }, { applyLocally: false });
}
export async function deleteStaff(id: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  const deletedAt = now();
  await runTransaction(rootRef(`staff/${id}`), (current) => {
    const existing = current as (StaffRecord & ConversionLockCarrier) | null;
    if (!existing) return null;
    if (existing.deletedAt) return existing;
    assertConversionUnlocked(existing);
    assertFresh(existing, expectedUpdatedAt);
    return clean({ ...withoutInternalFields(existing), deletedAt, deletedBy: user.uid, updatedAt: deletedAt });
  }, { applyLocally: false });
}

export async function saveDriver(value: Partial<DriverRecord> & Pick<DriverRecord, "name" | "hiredAt" | "dailyRate" | "status">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("driver");
  const timestamp = now();
  await runTransaction(rootRef(`drivers/${id}`), (current) => {
    const existing = current as DriverRecord | null;
    if (value.id && !existing) throw new Error("対象のドライバーデータが見つかりません。最新データを読み込んでください。");
    assertFresh(existing, value.updatedAt);
    if (!value.name.trim()) throw new Error("ドライバー名を入力してください。");
    if (!validDate(value.hiredAt)) throw new Error("採用日が正しくありません。");
    if (value.departedAt !== undefined && !validDate(value.departedAt)) throw new Error("退店日が正しくありません。");
    if (value.departedAt && value.departedAt < value.hiredAt) throw new Error("退店日は採用日以降にしてください。");
    if (!nonNegative(value.dailyRate)) throw new Error("日給が正しくありません。");
    return clean({ ...existing, ...withoutId(value), name: value.name.trim(), note: value.note ?? "", createdAt: existing?.createdAt || timestamp, updatedAt: timestamp });
  }, { applyLocally: false });
  return id;
}
export async function deleteDriver(id: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  await runTransaction(rootRef(`drivers/${id}`), (current) => {
    const existing = current as DriverRecord | null;
    if (!existing) return null;
    assertFresh(existing, expectedUpdatedAt);
    return null;
  }, { applyLocally: false });
}

export async function saveIntroducer(value: Partial<IntroducerRecord> & Pick<IntroducerRecord, "name" | "feeType">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("introducer");
  const timestamp = now();
  await runTransaction(rootRef(`introducers/${id}`), (current) => {
    const existing = current as IntroducerRecord | null;
    if (value.id && !existing) throw new Error("対象の紹介者データが見つかりません。最新データを読み込んでください。");
    assertFresh(existing, value.updatedAt);
    if (!value.name.trim()) throw new Error("紹介者名を入力してください。");
    return clean({ ...existing, ...withoutId(value), name: value.name.trim(), note: value.note ?? "", attendanceAdvisoryEnabled: Boolean(value.attendanceAdvisoryEnabled), entryAdvisoryEnabled: Boolean(value.entryAdvisoryEnabled), createdAt: existing?.createdAt || timestamp, updatedAt: timestamp });
  }, { applyLocally: false });
  return id;
}
export async function deleteIntroducer(id: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  const [introducerSnapshot, castsSnapshot, eventsSnapshot, statesSnapshot] = await Promise.all([
    get(rootRef(`introducers/${id}`)),
    get(rootRef("casts")),
    get(rootRef("introducerEntryEvents")),
    get(rootRef("accountingMonthStates")),
  ]);
  const existing = introducerSnapshot.val() as IntroducerRecord | null;
  if (!existing) return;
  assertFresh(existing, expectedUpdatedAt);
  const events = (eventsSnapshot.val() || {}) as Record<string, Record<string, IntroducerEntryEvent>>;
  const states = (statesSnapshot.val() || {}) as Record<string, AccountingMonthState>;
  const eventPlan: EntryEventPlan = {};
  const timestamp = now();
  const referencedCasts = asArray<CastRecord>(castsSnapshot.val()).filter((cast) =>
    cast.introducerId === id && validDate(cast.hiredAt) && Number(cast.entryAdvisoryFee || 0) > 0);
  for (const cast of referencedCasts) {
    const month = cast.hiredAt!.slice(0, 7);
    const event = events[month]?.[cast.id];
    const eventMatches = event
      && event.id === cast.id
      && event.castId === cast.id
      && event.hiredAt === cast.hiredAt
      && event.introducerId === id
      && Number(event.amount) === Number(cast.entryAdvisoryFee)
      && Boolean(String(event.castName || "").trim())
      && Boolean(String(event.introducerName || "").trim());
    if (eventMatches) continue;
    const existsInAnotherMonth = Object.entries(events).some(([eventMonth, rows]) => eventMonth !== month && Boolean(rows?.[cast.id]));
    if (existsInAnotherMonth) {
      throw new Error(`${cast.name}の入店顧問料履歴が現在のマスタと一致しません。紹介者を削除する前に対象キャストを保存し直してください。`);
    }
    if (states[month] && states[month].status !== "open") {
      throw new Error(`${month}は月次確定処理中または確定済みで、${cast.name}の入店顧問料履歴を補完できません。先に月次確定を解除して対象キャストを保存してください。`);
    }
    eventPlan[`introducerEntryEvents/${month}/${cast.id}`] = {
      id: cast.id,
      month,
      hiredAt: cast.hiredAt!,
      castId: cast.id,
      castName: cast.name,
      introducerId: id,
      introducerName: existing.name,
      feeType: existing.feeType,
      amount: Number(cast.entryAdvisoryFee),
      createdAt: event?.createdAt || timestamp,
      createdBy: event?.createdBy || user.uid,
      updatedAt: timestamp,
      updatedBy: user.uid,
    };
  }
  if (Object.keys(eventPlan).length) {
    const latest = (await get(rootRef(`introducers/${id}`))).val() as IntroducerRecord | null;
    if (!latest) return;
    assertFresh(latest, expectedUpdatedAt);
    await update(rootRef(), clean({ ...eventPlan, [`introducers/${id}`]: null }));
    return;
  }
  await runTransaction(rootRef(`introducers/${id}`), (current) => {
    const row = current as IntroducerRecord | null;
    if (!row) return null;
    assertFresh(row, expectedUpdatedAt);
    return null;
  }, { applyLocally: false });
}

export async function saveLiquor(value: Partial<LiquorRecord> & Pick<LiquorRecord, "name" | "kind" | "salePrice" | "costPrice">, user: User) {
  await requireUser(user);
  const id = value.id || entityId("liquor");
  const timestamp = now();
  const [existingSnapshot, allSnapshot] = await Promise.all([get(rootRef(`liquorCosts/${id}`)), get(rootRef("liquorCosts"))]);
  const before = existingSnapshot.val() as LiquorRecord | null;
  if (value.id && !before) throw new Error("対象の酒代原価データが見つかりません。最新データを読み込んでください。");
  assertFresh(before, value.updatedAt);
  const name = value.name.trim();
  if (!name) throw new Error("ボトル名を入力してください。");
  if (!nonNegative(value.salePrice) || !nonNegative(value.costPrice)) throw new Error("販売金額と酒代原価が正しくありません。");
  if (asArray<LiquorRecord>(allSnapshot.val()).some((row) => row.id !== id && row.kind === value.kind && String(row.name || "").trim() === name && Number(row.salePrice) === value.salePrice)) {
    throw new Error("同じ区分・ボトル名・販売金額の酒代原価がすでに登録されています。");
  }
  const oldClaim = before ? claimKey(before.kind, before.name, before.salePrice) : "";
  const newClaim = claimKey(value.kind, name, value.salePrice);
  let newClaimHandle: ClaimHandle | undefined;
  try {
    newClaimHandle = await acquireClaim("liquorClaims", newClaim, id);
  } catch (error) {
    throw claimAcquisitionError(error, "同じ区分・ボトル名・販売金額の酒代原価がすでに登録されています。");
  }
  try {
    await runTransaction(rootRef(`liquorCosts/${id}`), (current) => {
      const existing = current as LiquorRecord | null;
      if (value.id && !existing) throw new Error("対象の酒代原価データが見つかりません。最新データを読み込んでください。");
      assertFresh(existing, value.updatedAt);
      return clean({ ...existing, ...withoutId(value), name, createdAt: existing?.createdAt || timestamp, updatedAt: timestamp });
    }, { applyLocally: false });
  } catch (error) {
    if (newClaimHandle) await releasePendingClaim(newClaimHandle).catch(() => undefined);
    throw error;
  }
  if (newClaimHandle) await commitClaimAfterEntitySaved(newClaimHandle, "酒代原価");
  if (oldClaim && oldClaim !== newClaim) await releaseClaimAfterEntitySaved("liquorClaims", oldClaim, id, "酒代原価");
  return id;
}
export async function deleteLiquor(id: string, expectedUpdatedAt: string, user: User) {
  await requireUser(user);
  const existing = (await get(rootRef(`liquorCosts/${id}`))).val() as LiquorRecord | null;
  if (!existing) return;
  assertFresh(existing, expectedUpdatedAt);
  await runTransaction(rootRef(`liquorCosts/${id}`), (current) => {
    const row = current as LiquorRecord | null;
    if (!row) return null;
    assertFresh(row, expectedUpdatedAt);
    return null;
  }, { applyLocally: false });
  await releaseClaimAfterEntitySaved("liquorClaims", claimKey(existing.kind, existing.name, existing.salePrice), id, "酒代原価削除");
}

export async function saveCashFloat(amount: number, user: User) {
  await requireUser(user); await set(rootRef("config/cashFloat"), amount);
}

export async function submitClosing(value: DailyClosing, user: User, expectedUpdatedAt?: string) {
  await requireUser(user, ["shop", "op"]);
  if (!value.posSnapshot) throw new Error("POS原本がありません。POS JSONを取り込み直してください。");
  await parsePosClosingV3(value.posSnapshot);
  validateDailyClosingForSubmission(value);
  if (!validDate(value.businessDate)) throw new Error("営業日が正しくありません。");
  await assertMonthOpen(value.businessDate.slice(0, 7));
  const timestamp = now();
  const [existingSnapshot, allSnapshot] = await Promise.all([get(rootRef(`history/${value.id}`)), get(rootRef("history"))]);
  const before = existingSnapshot.val() as DailyClosing | null;
  const canonicalId = `daily_${value.businessDate.replaceAll("-", "")}`;
  if (!before && value.id !== canonicalId) {
    throw new Error(`新規の日次データIDが営業日と一致しません。${value.businessDate}のJSONを読み込み直してください。`);
  }
  if (before && !expectedUpdatedAt) throw new Error("再編集元データが確認できません。最新データを読み込んでやり直してください。");
  assertFresh(before, expectedUpdatedAt);
  if (before && before.businessDate !== value.businessDate) throw new Error("再送時に営業日は変更できません。元の営業日データから再編集してください。");
  if (before && !["returned", "withdrawn"].includes(before.status)) throw new Error("差戻しまたは取下げ済みのデータだけ再送できます。");
  const sameBusinessDate = asArray<DailyClosing>(allSnapshot.val()).find((row) => row.id !== value.id && row.businessDate === value.businessDate);
  if (sameBusinessDate) {
    throw new Error(`${value.businessDate}の店舗データはすでに存在します。既存データを開いて再編集してください。`);
  }
  const duplicate = asArray<DailyClosing>(allSnapshot.val()).find((row) => row.id !== value.id && row.submissionId === value.submissionId && row.checksum === value.checksum);
  if (duplicate) throw new Error(`${duplicate.businessDate}に同じPOS JSONが送信済みです。`);
  const oldClaim = before ? claimKey(before.submissionId, before.checksum) : "";
  const newClaim = claimKey(value.submissionId, value.checksum);
  let newClaimHandle: ClaimHandle | undefined;
  try {
    newClaimHandle = await acquireClaim("posSubmissionClaims", newClaim, value.id);
  } catch (error) {
    throw claimAcquisitionError(error, "同じPOS JSONがすでに送信されています。最新データを読み込んで確認してください。");
  }
  try {
    await runTransaction(rootRef(`history/${value.id}`), (current) => {
      const existing = current as DailyClosing | null;
      if (existing && !expectedUpdatedAt) throw new Error("再編集元データが確認できません。最新データを読み込んでやり直してください。");
      assertFresh(existing, expectedUpdatedAt);
      if (existing && !["returned", "withdrawn"].includes(existing.status)) throw new Error("差戻しまたは取下げ済みのデータだけ再送できます。");
      return clean({
        ...withoutId(value),
        businessMonth: value.businessDate.slice(0, 7),
        status: "submitted",
        approvedAt: undefined,
        approvedBy: undefined,
        withdrawnAt: undefined,
        returnedAt: undefined,
        returnedBy: undefined,
        returnedFromStatus: undefined,
        returnReason: undefined,
        submittedAt: timestamp,
        submittedBy: user.uid,
        updatedAt: timestamp,
      });
    }, { applyLocally: false });
  } catch (error) {
    if (newClaimHandle) await releasePendingClaim(newClaimHandle).catch(() => undefined);
    throw error;
  }
  if (newClaimHandle) await commitClaimAfterEntitySaved(newClaimHandle, "店舗送信データ");
  if (oldClaim && oldClaim !== newClaim) await releaseClaimAfterEntitySaved("posSubmissionClaims", oldClaim, value.id, "店舗送信データ");
}
export async function withdrawClosing(id: string, expected: ClosingRevision, user: User) {
  await requireUser(user, ["shop", "op"]);
  await assertMonthOpen(expected.businessDate.slice(0, 7));
  const timestamp = now();
  await runTransaction(rootRef(`history/${id}`), (current) => {
    const existing = current as DailyClosing | null;
    if (!existing || !["submitted", "returned"].includes(existing.status)) throw new Error("このデータは取り下げできません。");
    assertClosingRevision(existing, expected);
    return clean({
      ...existing,
      businessMonth: existing.businessDate.slice(0, 7),
      status: "withdrawn",
      approvedAt: undefined,
      approvedBy: undefined,
      withdrawnAt: timestamp,
      updatedAt: timestamp,
    });
  }, { applyLocally: false });
}
export async function approveClosing(id: string, expected: ClosingRevision, user: User) {
  await requireUser(user, ["accounting", "op"]);
  await assertMonthOpen(expected.businessDate.slice(0, 7));
  const timestamp = now();
  await runTransaction(rootRef(`history/${id}`), (current) => {
    const existing = current as DailyClosing | null;
    if (!existing || existing.status !== "submitted") throw new Error("経理確認待ちのデータだけ承認できます。");
    assertClosingRevision(existing, expected);
    const issues = normalizeDailyClosing(existing).integrityIssues || [];
    if (issues.length) throw new Error(`データ不備が${issues.length}件あるため承認できません。詳細を確認し、店舗へ差し戻してください。`);
    return clean({
      ...existing,
      businessMonth: existing.businessDate.slice(0, 7),
      status: "approved",
      approvedAt: timestamp,
      approvedBy: user.uid,
      returnReason: undefined,
      updatedAt: timestamp,
    });
  }, { applyLocally: false });
}
export async function returnClosing(id: string, expected: ClosingRevision, reason: string, user: User) {
  await requireUser(user, ["accounting", "op"]);
  await assertMonthOpen(expected.businessDate.slice(0, 7));
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error("差戻し理由を入力してください。");
  if (normalizedReason.length > 500) throw new Error("差戻し理由は500文字以内で入力してください。");
  const returnedAt = now();
  await runTransaction(rootRef(`history/${id}`), (current) => {
    const existing = current as DailyClosing | null;
    if (!existing || !["submitted", "approved"].includes(existing.status)) throw new Error("経理確認待ちまたは承認済みのデータだけ差し戻せます。");
    assertClosingRevision(existing, expected);
    return clean({
      ...existing,
      businessMonth: existing.businessDate.slice(0, 7),
      status: "returned",
      returnedAt,
      returnedBy: user.uid,
      returnedFromStatus: existing.status,
      returnReason: normalizedReason,
      updatedAt: returnedAt,
    });
  }, { applyLocally: false });
}

export async function saveMonthlyAdjustments(value: MonthlyAdjustments, user: User) {
  await requireUser(user, ["accounting", "op"]);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)) throw new Error("対象月を正しく選択してください。");
  await assertMonthOpen(value.month);
  const numberMaps = [value.withholdingByCast, value.staffSalesAllowance, value.staffBottleAllowance, value.driverRemoteAllowance];
  if (numberMaps.some((map) => Object.values(map).some((amount) => !nonNegative(amount)))) throw new Error("経理入力には0以上の金額を入力してください。");
  if (Object.entries(value.legacyBottleClassifications || {}).some(([key, classification]) => !key || !["honShimei", "jonaiExtension", "excluded"].includes(classification))) {
    throw new Error("旧日次データのボトル区分が正しくありません。");
  }
  if (!nonNegative(value.cardFee) || (value.liquorDeliveryAmount !== undefined && !nonNegative(value.liquorDeliveryAmount))) throw new Error("経費金額が正しくありません。");
  if (value.fixedExpenses.some((row) => !row.account.trim() || !nonNegative(row.amount))) throw new Error("固定経費の科目と金額を確認してください。");
  const timestamp = now();
  await runTransaction(rootRef(`accountingAdjustments/${value.month}`), (current) => {
    const existing = current as Omit<MonthlyAdjustments, "month"> | null;
    const currentRevision = Number(existing?.revision || 0);
    const expectedRevision = Number(value.revision || 0);
    if (currentRevision !== expectedRevision) throw new Error("別の端末で月次入力が更新されています。入力内容を控え、最新データを読み込んでから反映し直してください。");
    const { month: _month, ...stored } = value;
    return clean({ ...stored, revision: currentRevision + 1, updatedAt: timestamp, updatedBy: user.uid });
  }, { applyLocally: false });
}

async function currentMonthlySources(month: string) {
  const [casts, staff, introducers, closings, adjustment, entryEvents] = await Promise.all([
    get(rootRef("casts")),
    get(rootRef("staff")),
    get(rootRef("introducers")),
    get(rootRef("history")),
    get(rootRef(`accountingAdjustments/${month}`)),
    get(rootRef(`introducerEntryEvents/${month}`)),
  ]);
  const data: DomainWorkspaceData = {
    casts: asArray<CastRecord>(casts.val()),
    staff: asArray<StaffRecord>(staff.val()),
    drivers: [],
    introducers: asArray<IntroducerRecord>(introducers.val()),
    liquor: [],
    closings: asArray<DailyClosing>(closings.val()).map(normalizeDailyClosing)
      .sort((left, right) => right.businessDate.localeCompare(left.businessDate)),
    adjustments: [],
    cashFloat: 0,
  };
  const adjustments = normalizeMonthlyAdjustments({
    month,
    withholdingByCast: {},
    staffSalesAllowance: {},
    staffBottleAllowance: {},
    driverRemoteAllowance: {},
    fixedExpenses: [],
    cardFee: 0,
    ...(adjustment.val() || {}),
  } as MonthlyAdjustments);
  const events = Object.entries((entryEvents.val() || {}) as Record<string, IntroducerEntryEvent>)
    .map(([id, row]) => ({ ...row, id, month }));
  return { data, adjustments, events };
}

function canonicalComparisonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalComparisonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalComparisonValue(child)]));
  }
  return value;
}

function comparableMonthlySnapshot(value: MonthlyAccountingSnapshot) {
  const { revision: _revision, createdAt: _createdAt, createdBy: _createdBy, ...content } = value;
  return JSON.stringify(canonicalComparisonValue(content));
}

function assertMonthlySnapshotMatchesCurrent(
  candidate: MonthlyAccountingSnapshot,
  expected: MonthlyAccountingSnapshot,
) {
  if (comparableMonthlySnapshot(candidate) !== comparableMonthlySnapshot(expected)) {
    throw new Error("月次計算結果が現在の元データと一致しません。最新データを読み込み、全項目を再確認してください。");
  }
}

async function assertMonthOpen(month: string) {
  const state = (await get(rootRef(`accountingMonthStates/${month}`))).val() as AccountingMonthState | null;
  if (state && state.status !== "open") throw new Error(`${month}は月次確定処理中または確定済みのため変更できません。先に月次確定を解除してください。`);
}

async function acquireAccountingFinalizeLock(month: string, operationId: string, user: User) {
  const acquiredAt = Date.now();
  const expiresAt = acquiredAt + ACCOUNTING_FINALIZE_LOCK_TTL_MS;
  await runTransaction(rootRef("accountingFinalizeLock"), (current) => {
    const lock = current as AccountingFinalizeLock | null;
    if (lock && Number(lock.expiresAt || 0) > Date.now() && lock.operationId !== operationId) {
      throw new Error(`${lock.month || "別の月"}の月次確定処理中です。完了後にやり直してください。`);
    }
    return { operationId, owner: user.uid, month, acquiredAt, expiresAt };
  }, { applyLocally: false });
}

async function renewAccountingFinalizeLock(month: string, operationId: string, user: User) {
  const renewedAt = Date.now();
  await runTransaction(rootRef("accountingFinalizeLock"), (current) => {
    const lock = current as AccountingFinalizeLock | null;
    if (!lock || lock.operationId !== operationId || lock.owner !== user.uid || lock.month !== month) {
      throw new Error("月次確定用の排他情報が失われました。最新データを読み込んでください。");
    }
    return { ...lock, expiresAt: renewedAt + ACCOUNTING_FINALIZE_LOCK_TTL_MS };
  }, { applyLocally: false });
}

async function releaseAccountingFinalizeLock(operationId: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await runTransaction(rootRef("accountingFinalizeLock"), (current) => {
        const lock = current as AccountingFinalizeLock | null;
        return lock?.operationId === operationId ? null : current;
      }, { applyLocally: false });
      return;
    } catch (error) {
      lastError = error;
      try {
        const current = (await get(rootRef("accountingFinalizeLock"))).val() as AccountingFinalizeLock | null;
        if (!current || current.operationId !== operationId) return;
      } catch {
        // 一時的な通信失敗はもう一度だけ同じoperationIdで安全に再試行する。
      }
    }
  }
  throw lastError;
}

export async function finalizeAccountingMonth(
  month: string,
  snapshot: MonthlyAccountingSnapshot,
  expectedStateRevision: number,
  user: User,
) {
  await requireUser(user, ["accounting", "op"]);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || snapshot.month !== month) throw new Error("対象月が正しくありません。");
  const storedRevisions = Object.keys((await get(rootRef(`accountingMonthSnapshots/${month}`))).val() || {})
    .map(Number)
    .filter((revision) => Number.isSafeInteger(revision) && revision > 0);
  const highestStoredRevision = storedRevisions.length ? Math.max(...storedRevisions) : 0;
  const operationId = crypto.randomUUID();
  const startedAt = now();
  let snapshotRevision = 0;
  let lockAcquired = false;
  try {
    await acquireAccountingFinalizeLock(month, operationId, user);
    lockAcquired = true;
    const started = await runTransaction(rootRef(`accountingMonthStates/${month}`), (current) => {
      const state = current as AccountingMonthState | null;
      const revision = Number(state?.revision || 0);
      if (revision !== expectedStateRevision) throw new Error("月次状態が別の端末で更新されています。最新データを読み込んでください。");
      if (state && state.status !== "open") throw new Error(state.status === "closed" ? "この月はすでに確定済みです。" : "別の端末で月次確定処理中です。");
      snapshotRevision = Math.max(Number(state?.currentSnapshotRevision || 0), highestStoredRevision) + 1;
      return clean({
        ...(state || {}), month, status: "closing", revision: revision + 1,
        operationId, updatedAt: startedAt, updatedBy: user.uid,
      });
    }, { applyLocally: false });
    if (!started.committed) throw new Error("月次確定を開始できませんでした。");

    const current = await currentMonthlySources(month);
    const latestFingerprint = await monthlySourceFingerprint(current.data, month, current.adjustments, current.events);
    if (latestFingerprint !== snapshot.sourceFingerprint) {
      throw new Error("月次データが更新されています。最新データを読み込み、全項目を再確認してください。");
    }
    const currentResults = calculateMonthlyAccounting(current.data, month, current.adjustments, current.events);
    const recomputedSnapshot = buildMonthlySnapshot(
      month,
      snapshotRevision,
      latestFingerprint,
      current.adjustments,
      currentResults,
      current.data.closings,
      user.uid,
      startedAt,
    );
    assertMonthlySnapshotMatchesCurrent(snapshot, recomputedSnapshot);
    await renewAccountingFinalizeLock(month, operationId, user);
    // 呼出元の計算結果ではなく、ロック取得後の現在ソースから再計算した値だけを保存する。
    const storedSnapshot: MonthlyAccountingSnapshot = clean(recomputedSnapshot);
    await runTransaction(rootRef(`accountingMonthSnapshots/${month}/${snapshotRevision}`), (existing) => {
      if (existing) throw new Error("同じ世代の月次スナップショットがすでに存在します。最新データを読み込んでください。");
      return storedSnapshot;
    }, { applyLocally: false });
    await renewAccountingFinalizeLock(month, operationId, user);
    const finalSources = await currentMonthlySources(month);
    const finalFingerprint = await monthlySourceFingerprint(finalSources.data, month, finalSources.adjustments, finalSources.events);
    if (finalFingerprint !== snapshot.sourceFingerprint) {
      throw new Error("月次確定中に元データが更新されました。最新データを読み込み、全項目を再確認してください。");
    }
    const finalResults = calculateMonthlyAccounting(finalSources.data, month, finalSources.adjustments, finalSources.events);
    const finalRecomputedSnapshot = buildMonthlySnapshot(
      month,
      snapshotRevision,
      finalFingerprint,
      finalSources.adjustments,
      finalResults,
      finalSources.data.closings,
      user.uid,
      startedAt,
    );
    assertMonthlySnapshotMatchesCurrent(storedSnapshot, finalRecomputedSnapshot);
    const closedAt = now();
    await runTransaction(rootRef(`accountingMonthStates/${month}`), (currentState) => {
      const state = currentState as AccountingMonthState | null;
      if (!state || state.status !== "closing" || state.operationId !== operationId) throw new Error("月次確定状態が変更されました。最新データを確認してください。");
      return clean({
        ...state,
        status: "closed",
        revision: Number(state.revision || 0) + 1,
        currentSnapshotRevision: snapshotRevision,
        operationId: undefined,
        closedAt,
        closedBy: user.uid,
        updatedAt: closedAt,
        updatedBy: user.uid,
      });
    }, { applyLocally: false });
    return snapshotRevision;
  } catch (error) {
    const reopenedAt = now();
    await runTransaction(rootRef(`accountingMonthStates/${month}`), (currentState) => {
      const state = currentState as AccountingMonthState | null;
      if (!state || state.status !== "closing" || state.operationId !== operationId) return state;
      return clean({
        ...state,
        status: "open",
        revision: Number(state.revision || 0) + 1,
        operationId: undefined,
        reopenedAt,
        reopenedBy: user.uid,
        updatedAt: reopenedAt,
        updatedBy: user.uid,
      });
    }, { applyLocally: false }).catch(() => undefined);
    throw error;
  } finally {
    if (lockAcquired) await releaseAccountingFinalizeLock(operationId).catch(() => undefined);
  }
}

export async function reopenAccountingMonth(month: string, expectedStateRevision: number, user: User) {
  await requireUser(user, ["accounting", "op"]);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月が正しくありません。");
  // 確定成功後にlock解除の応答だけ失われた場合に備え、openへ戻す前の残留lockだけを記録する。
  // open後に別処理が取得した新しいlockを誤って解放しないよう、operationIdを固定して扱う。
  const finalizeLock = (await get(rootRef("accountingFinalizeLock"))).val() as AccountingFinalizeLock | null;
  const staleOperationId = finalizeLock?.month === month ? finalizeLock.operationId : "";
  const reopenedAt = now();
  await runTransaction(rootRef(`accountingMonthStates/${month}`), (current) => {
    const state = current as AccountingMonthState | null;
    if (!state || state.status !== "closed") throw new Error("確定済みの月だけ確定解除できます。");
    if (Number(state.revision || 0) !== expectedStateRevision) throw new Error("月次状態が別の端末で更新されています。最新データを読み込んでください。");
    return clean({
      ...state,
      status: "open",
      revision: Number(state.revision || 0) + 1,
      operationId: undefined,
      reopenedAt,
      reopenedBy: user.uid,
      updatedAt: reopenedAt,
      updatedBy: user.uid,
    });
  }, { applyLocally: false });
  if (staleOperationId) await releaseAccountingFinalizeLock(staleOperationId);
}

export async function cancelAccountingMonthClosing(month: string, expectedStateRevision: number, user: User) {
  await requireUser(user, ["accounting", "op"]);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月が正しくありません。");
  const reopenedAt = now();
  let operationId = "";
  await runTransaction(rootRef(`accountingMonthStates/${month}`), (current) => {
    const state = current as AccountingMonthState | null;
    if (!state || state.status !== "closing") throw new Error("月次確定処理中の月だけ処理を中止できます。");
    if (Number(state.revision || 0) !== expectedStateRevision) throw new Error("月次状態が別の端末で更新されています。最新データを読み込んでください。");
    operationId = state.operationId || "";
    return clean({
      ...state,
      status: "open",
      revision: Number(state.revision || 0) + 1,
      operationId: undefined,
      reopenedAt,
      reopenedBy: user.uid,
      updatedAt: reopenedAt,
      updatedBy: user.uid,
    });
  }, { applyLocally: false });
  if (operationId) await releaseAccountingFinalizeLock(operationId);
}
