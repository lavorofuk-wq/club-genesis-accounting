import {
  calculateCastRewards,
  calculateCastSalesReports,
  calculateDriverPayroll,
  findUnclassifiedLegacyBottles,
  floorHundred,
  introducerTermConflicts,
  introducerSalesBase,
} from "./gms";
import type {
  CastRecord,
  CastReward,
  CastSalesReport,
  DailyClosing,
  DriverPayrollRow,
  IntroducerFeeType,
  MonthlyAdjustments,
  StaffRecord,
  WorkspaceData,
} from "./gms";

export const MONTHLY_CALCULATION_VERSION = "2.8.1";

export type IntroducerEntryEvent = {
  id: string;
  month: string;
  hiredAt: string;
  castId: string;
  castName: string;
  introducerId: string;
  introducerName: string;
  feeType?: IntroducerFeeType;
  amount: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};

export type IntroducerPaymentRow = {
  id: string;
  introducer: string;
  cast: string;
  feeType: string;
  honShimeiLiquorCost: number;
  salesBase: number;
  salesFee: number;
  grossBase: number;
  grossFee: number;
  adopted: string;
  attendanceAdvisory: number;
  entryAdvisory: number;
  advisory: number;
  total: number;
};

export type StaffPayrollRow = {
  id: string;
  name: string;
  hours: number;
  hourly: number;
  sales: number;
  bottle: number;
  gross: number;
  daily: number;
  net: number;
};

export type MonthlyExpenseSummary = {
  byCategory: Record<string, number>;
  dailyExpenseTotal: number;
  dispatchCast: number;
  dispatchStaff: number;
  dispatchFee: number;
  dispatchTotal: number;
  liquorDelivery: number;
  fixed: number;
  cardFee: number;
  total: number;
};

export type MonthlySalesSummary = {
  cash: number;
  card: number;
  total: number;
};

export type MonthlyBalanceSummary = {
  cast: number;
  introducer: number;
  staff: number;
  driver: number;
  expenses: number;
  totalCosts: number;
  profit: number;
};

export type MonthlyAccountingResults = {
  approvedDays: number;
  castSalesReports: CastSalesReport[];
  castRewards: CastReward[];
  introducerPayments: IntroducerPaymentRow[];
  staffPayroll: StaffPayrollRow[];
  driverPayroll: DriverPayrollRow[];
  expenses: MonthlyExpenseSummary;
  sales: MonthlySalesSummary;
  balance: MonthlyBalanceSummary;
  warnings: string[];
};

export type AccountingMonthState = {
  month: string;
  status: "open" | "closing" | "closed";
  revision: number;
  currentSnapshotRevision?: number;
  operationId?: string;
  closedAt?: string;
  closedBy?: string;
  reopenedAt?: string;
  reopenedBy?: string;
  updatedAt: string;
  updatedBy: string;
};

export type MonthlyAccountingSnapshot = MonthlyAccountingResults & {
  schemaVersion: 1;
  calculationVersion: string;
  month: string;
  revision: number;
  sourceFingerprint: string;
  adjustmentsRevision: number;
  approvedClosings: Array<{ id: string; checksum: string; updatedAt: string }>;
  createdAt: string;
  createdBy: string;
};

export type AccountingWorkspaceData = WorkspaceData & {
  archivedCasts: CastRecord[];
  archivedStaff: StaffRecord[];
  introducerEntryEvents: IntroducerEntryEvent[];
  monthStates: AccountingMonthState[];
  monthSnapshots: MonthlyAccountingSnapshot[];
};

const snapshotList = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value.filter((row): row is T => row !== null && row !== undefined);
  if (value && typeof value === "object") return Object.values(value as Record<string, T>).filter((row): row is T => row !== null && row !== undefined);
  return [];
};

const snapshotObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const snapshotNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const snapshotNonNegative = (value: unknown): value is number => snapshotNumber(value) && value >= 0;
const snapshotInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const snapshotString = (value: unknown) => typeof value === "string" && value.length > 0;
const snapshotDateInMonth = (value: unknown, month: string) => typeof value === "string"
  && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
  && value.startsWith(`${month}-`);
const allSnapshotNumbers = (row: Record<string, unknown>, keys: string[], allowNegative = false) =>
  keys.every((key) => allowNegative ? snapshotNumber(row[key]) : snapshotNonNegative(row[key]));

const castSalesNumberKeys = [
  "hours", "honShimeiSales", "jonaiExtensionSales", "totalSales", "honShimeiLiquorCost",
  "jonaiExtensionLiquorCost", "totalLiquorCost", "honShimeiCount", "banaiShimeiCount",
  "nominationCount", "dohanCount", "backTotal", "beautyAllowance",
];

function normalizeSnapshotBacks(value: unknown) {
  const keys = new Set(["honShimei", "banaiShimei", "dohan", "bottle", "drink"]);
  const rows = snapshotList<unknown>(value);
  if (rows.some((item) => !snapshotObject(item) || !keys.has(String(item.key || ""))
    || !snapshotString(item.label) || !snapshotInteger(item.amount))) return undefined;
  return rows as CastSalesReport["days"][number]["backs"];
}

function normalizeSnapshotBottles(value: unknown) {
  const rows = snapshotList<unknown>(value);
  if (rows.some((item) => !snapshotObject(item) || !snapshotString(item.name)
    || !snapshotNonNegative(item.quantity) || Number(item.quantity) <= 0)) return undefined;
  return rows as CastSalesReport["days"][number]["bottles"];
}

function normalizeSnapshotCastSales(value: unknown, month: string): CastSalesReport[] | undefined {
  const reports = snapshotList<unknown>(value);
  const normalized: CastSalesReport[] = [];
  for (const item of reports) {
    if (!snapshotObject(item) || !snapshotString(item.id) || !snapshotString(item.name)
      || !snapshotInteger(item.attendanceDays) || Number(item.attendanceDays) <= 0 || !snapshotObject(item.totals)) return undefined;
    const days: CastSalesReport["days"] = [];
    for (const day of snapshotList<unknown>(item.days)) {
      if (!snapshotObject(day) || !snapshotDateInMonth(day.businessDate, month)
        || !snapshotString(day.startTime) || !snapshotString(day.endTime)
        || !allSnapshotNumbers(day, castSalesNumberKeys)) return undefined;
      const backs = normalizeSnapshotBacks(day.backs);
      const bottles = normalizeSnapshotBottles(day.bottles);
      if (!backs || !bottles || day.totalSales !== Number(day.honShimeiSales) + Number(day.jonaiExtensionSales)
        || day.totalLiquorCost !== Number(day.honShimeiLiquorCost) + Number(day.jonaiExtensionLiquorCost)
        || day.backTotal !== backs.reduce((sum, back) => sum + back.amount, 0)) return undefined;
      days.push({ ...(day as unknown as CastSalesReport["days"][number]), backs, bottles });
    }
    const totals = item.totals;
    const backs = normalizeSnapshotBacks(totals.backs);
    const bottles = normalizeSnapshotBottles(totals.bottles);
    if (!backs || !bottles || !snapshotInteger(totals.attendanceDays) || Number(totals.attendanceDays) <= 0 || days.length === 0
      || !allSnapshotNumbers(totals, castSalesNumberKeys)
      || totals.totalSales !== Number(totals.honShimeiSales) + Number(totals.jonaiExtensionSales)
      || totals.totalLiquorCost !== Number(totals.honShimeiLiquorCost) + Number(totals.jonaiExtensionLiquorCost)
      || totals.backTotal !== backs.reduce((sum, back) => sum + back.amount, 0)
      || item.attendanceDays !== totals.attendanceDays
      || item.attendanceDays !== new Set(days.map((day) => day.businessDate)).size) return undefined;
    normalized.push({
      ...(item as unknown as CastSalesReport),
      days,
      totals: { ...(totals as unknown as CastSalesReport["totals"]), backs, bottles },
    });
  }
  return normalized;
}

function validSnapshotRows(value: unknown, stringKeys: string[], numericKeys: string[], options?: {
  integerKeys?: string[];
  booleanKeys?: string[];
  allowNegativeKeys?: string[];
}) {
  const rows = snapshotList<unknown>(value);
  const valid = rows.every((item) => snapshotObject(item)
    && stringKeys.every((key) => snapshotString(item[key]))
    && numericKeys.every((key) => snapshotNonNegative(item[key]))
    && (options?.integerKeys || []).every((key) => snapshotInteger(item[key]))
    && (options?.booleanKeys || []).every((key) => typeof item[key] === "boolean")
    && (options?.allowNegativeKeys || []).every((key) => snapshotNumber(item[key])));
  return valid ? rows : undefined;
}

/** Firebase境界で月次スナップショットを検証し、空配列がオブジェクト化された場合も復元する。 */
export function normalizeMonthlyAccountingSnapshot(
  value: unknown,
  pathMonth: string,
  pathRevision: number,
): MonthlyAccountingSnapshot | undefined {
  if (!snapshotObject(value)) return undefined;
  const row = value as unknown as MonthlyAccountingSnapshot;
  if (row.schemaVersion !== 1 || row.month !== pathMonth || row.revision !== pathRevision
    || !Number.isSafeInteger(pathRevision) || pathRevision <= 0
    || typeof row.calculationVersion !== "string" || !row.calculationVersion
    || !/^[0-9a-f]{64}$/.test(String(row.sourceFingerprint || ""))
    || !Number.isSafeInteger(row.adjustmentsRevision) || row.adjustmentsRevision < 0
    || typeof row.createdAt !== "string" || typeof row.createdBy !== "string") return undefined;
  if (!snapshotObject(row.expenses) || !snapshotObject(row.sales) || !snapshotObject(row.balance)) return undefined;
  if (![row.approvedDays, row.expenses.dailyExpenseTotal, row.expenses.dispatchCast,
    row.expenses.dispatchStaff, row.expenses.dispatchFee, row.expenses.dispatchTotal,
    row.expenses.liquorDelivery, row.expenses.fixed, row.expenses.cardFee, row.expenses.total,
    row.sales.cash, row.sales.card, row.sales.total,
    row.balance.cast, row.balance.introducer, row.balance.staff, row.balance.driver,
    row.balance.expenses, row.balance.totalCosts, row.balance.profit].every(snapshotNumber)) return undefined;

  const castSalesReports = normalizeSnapshotCastSales(row.castSalesReports, pathMonth);
  const castRewards = validSnapshotRows(row.castRewards, ["id", "name", "adoptedSystem"], [
    "hours", "hourlyPay", "honShimeiSales", "jonaiExtensionSales", "liquorCost", "honShimeiLiquorCost",
    "honShimeiBack", "banaiShimeiBack", "dohanBack", "bottleBack", "drinkBack", "hourlyAndBack",
    "rewardRate", "salesRewardBase", "salesReward", "adoptedReward", "beautyAllowance", "grossPay",
    "dailyPayment", "advancePayment", "transportFee", "withholding",
  ], {
    integerKeys: ["days", "advisoryDays", "bottleBack", "drinkBack", "hourlyAndBack"],
    booleanKeys: ["trialOnly"],
    allowNegativeKeys: ["netPay"],
  });
  const introducerPayments = validSnapshotRows(row.introducerPayments,
    ["id", "introducer", "cast", "feeType", "adopted"],
    ["honShimeiLiquorCost", "salesBase", "salesFee", "grossBase", "grossFee", "attendanceAdvisory", "entryAdvisory", "advisory", "total"]);
  const staffPayroll = validSnapshotRows(row.staffPayroll, ["id", "name"], ["hours", "hourly", "sales", "bottle", "gross", "daily"], { allowNegativeKeys: ["net"] });
  const driverPayroll = validSnapshotRows(row.driverPayroll, ["id", "name"], ["basic", "remote", "gross", "dailyPayment"], { integerKeys: ["days"], allowNegativeKeys: ["net"] });
  const approvedClosings = validSnapshotRows(row.approvedClosings, ["id", "checksum", "updatedAt"], []);
  const warnings = snapshotList<unknown>(row.warnings);
  const categoryValues = snapshotObject(row.expenses.byCategory) ? Object.values(row.expenses.byCategory) : [];
  const castRewardsValid = Boolean(castRewards?.every((item) => {
    if (!snapshotObject(item)) return false;
    return (item.adoptedSystem === "hourlyAndBack" || item.adoptedSystem === "salesReward")
      && Number(item.rewardRate) <= 1
      && item.hourlyAndBack === Number(item.hourlyPay) + Number(item.honShimeiBack) + Number(item.banaiShimeiBack)
        + Number(item.dohanBack) + Number(item.bottleBack) + Number(item.drinkBack)
      && item.adoptedReward === Math.max(Number(item.hourlyAndBack), Number(item.salesReward))
      && item.grossPay === Number(item.adoptedReward) + Number(item.beautyAllowance)
      && item.netPay === Number(item.grossPay) - Number(item.dailyPayment) - Number(item.advancePayment)
        - Number(item.transportFee) - Number(item.withholding);
  }));
  const introducerPaymentsValid = Boolean(introducerPayments?.every((item) => snapshotObject(item)
    && item.advisory === Number(item.attendanceAdvisory) + Number(item.entryAdvisory)
    && Number(item.total) >= Number(item.advisory)));
  const staffPayrollValid = Boolean(staffPayroll?.every((item) => snapshotObject(item)
    && item.gross === Number(item.hourly) + Number(item.sales) + Number(item.bottle)
    && item.net === Number(item.gross) - Number(item.daily)));
  const driverPayrollValid = Boolean(driverPayroll?.every((item) => snapshotObject(item)
    && item.gross === Number(item.basic) + Number(item.remote)
    && item.net === Number(item.gross) - Number(item.dailyPayment)));
  if (!castSalesReports || !castRewards || !introducerPayments || !staffPayroll || !driverPayroll || !approvedClosings
    || !castRewardsValid || !introducerPaymentsValid || !staffPayrollValid || !driverPayrollValid
    || warnings.some((warning) => typeof warning !== "string")
    || categoryValues.some((amount) => !snapshotNonNegative(amount))
    || row.approvedDays !== approvedClosings.length
    || row.sales.total !== row.sales.cash + row.sales.card
    || row.expenses.dispatchTotal !== row.expenses.dispatchCast + row.expenses.dispatchStaff + row.expenses.dispatchFee
    || row.expenses.total !== row.expenses.dailyExpenseTotal + row.expenses.dispatchTotal + row.expenses.liquorDelivery + row.expenses.fixed + row.expenses.cardFee
    || row.balance.expenses !== row.expenses.total
    || row.balance.totalCosts !== row.balance.cast + row.balance.introducer + row.balance.staff + row.balance.driver + row.balance.expenses
    || row.balance.profit !== row.sales.total - row.balance.totalCosts) return undefined;

  return {
    ...row,
    revision: pathRevision,
    castSalesReports,
    castRewards: castRewards as CastReward[],
    introducerPayments: introducerPayments as IntroducerPaymentRow[],
    staffPayroll: staffPayroll as StaffPayrollRow[],
    driverPayroll: driverPayroll as DriverPayrollRow[],
    warnings: warnings as string[],
    approvedClosings: approvedClosings as MonthlyAccountingSnapshot["approvedClosings"],
    expenses: { ...row.expenses, byCategory: snapshotObject(row.expenses.byCategory) ? row.expenses.byCategory : {} },
  };
}

const validIntroducerFeeTypes = new Set<IntroducerFeeType>([
  "sales10",
  "netSales10",
  "gross10",
  "higherSalesGross10",
  "higherNetSalesGross10",
]);

export function calculateStaffPayroll(
  closings: DailyClosing[],
  adjustments: MonthlyAdjustments,
  staff: StaffRecord[] = [],
  month = "",
): StaffPayrollRow[] {
  const map = new Map<string, StaffPayrollRow>();
  closings.forEach((closing) => (closing.staffWork ?? []).forEach((work) => {
    const converted = work.kind === "trial"
      ? staff.find((member) => member.convertedFromTrialId === work.staffId && member.hiredAt?.startsWith(month))
      : undefined;
    const staffId = converted?.id || work.staffId;
    const row = map.get(staffId) || {
      id: staffId,
      name: converted?.name || work.name,
      hours: 0,
      hourly: 0,
      sales: adjustments.staffSalesAllowance[staffId] || 0,
      bottle: adjustments.staffBottleAllowance[staffId] || 0,
      gross: 0,
      daily: 0,
      net: 0,
    };
    row.hours += work.hours;
    row.hourly += work.hourlyRate * work.hours;
    row.daily += work.dailyPayment;
    map.set(staffId, row);
  }));
  return [...map.values()].map((row) => {
    const hourly = floorHundred(row.hourly);
    const gross = hourly + row.sales + row.bottle;
    return { ...row, hourly, gross, net: gross - row.daily };
  });
}

function paymentBasis(reward: CastReward | undefined, feeType: string) {
  if (!reward || !validIntroducerFeeTypes.has(feeType as IntroducerFeeType)) {
    return { salesBase: 0, salesFee: 0, grossBase: reward?.grossPay || 0, grossFee: 0, adopted: reward ? "報酬形態未設定" : "入店顧問料のみ", fee: 0 };
  }
  const typedFee = feeType as IntroducerFeeType;
  const salesBase = introducerSalesBase(reward, typedFee);
  const salesFee = Math.floor(salesBase / 10);
  const grossBase = reward.grossPay;
  const grossFee = Math.floor(grossBase / 10);
  const salesLabel = typedFee === "netSales10" || typedFee === "higherNetSalesGross10"
    ? "酒代原価引き売上10%"
    : "売上10%";
  if (typedFee === "gross10") return { salesBase, salesFee, grossBase, grossFee, adopted: "総支給額10%", fee: grossFee };
  if (typedFee === "higherSalesGross10" || typedFee === "higherNetSalesGross10") {
    const grossWins = grossFee > salesFee;
    return { salesBase, salesFee, grossBase, grossFee, adopted: grossWins ? "総支給額10%" : salesLabel, fee: Math.max(salesFee, grossFee) };
  }
  return { salesBase, salesFee, grossBase, grossFee, adopted: salesLabel, fee: salesFee };
}

function fallbackEntryEvents(data: WorkspaceData, month: string): IntroducerEntryEvent[] {
  return data.casts.flatMap((cast): IntroducerEntryEvent[] => {
    if (!cast.hiredAt?.startsWith(month) || !cast.introducerId || !(cast.entryAdvisoryFee && cast.entryAdvisoryFee > 0)) return [];
    const introducer = data.introducers.find((row) => row.id === cast.introducerId);
    if (!introducer) return [];
    return [{
      id: `fallback_${cast.id}`,
      month,
      hiredAt: cast.hiredAt,
      castId: cast.id,
      castName: cast.name,
      introducerId: introducer.id,
      introducerName: introducer.name,
      feeType: introducer.feeType,
      amount: cast.entryAdvisoryFee,
      createdAt: cast.createdAt,
      createdBy: "legacy-master",
      updatedAt: cast.updatedAt,
      updatedBy: "legacy-master",
    }];
  });
}

function withArchivedMasters(data: WorkspaceData & { archivedCasts?: CastRecord[]; archivedStaff?: StaffRecord[] }): WorkspaceData {
  const byId = new Map<string, CastRecord>();
  (data.archivedCasts || []).forEach((cast) => byId.set(cast.id, cast));
  data.casts.forEach((cast) => byId.set(cast.id, cast));
  const staffById = new Map<string, StaffRecord>();
  (data.archivedStaff || []).forEach((member) => staffById.set(member.id, member));
  data.staff.forEach((member) => staffById.set(member.id, member));
  return { ...data, casts: [...byId.values()], staff: [...staffById.values()] };
}

type EntryEventConflict = { castId: string; message: string };

/**
 * 入店時に保存した紹介者と、現在マスタ・承認済み日次の紹介者が食い違う人物を検出する。
 * 誰へ支払うかを推測せず、月次確定を止めるための安全確認として扱う。
 */
function entryEventConflictDetails(
  rewards: CastReward[],
  data: WorkspaceData,
  month: string,
  storedEvents: IntroducerEntryEvent[],
): EntryEventConflict[] {
  const castById = new Map(data.casts.map((cast) => [cast.id, cast]));
  const rewardByCast = new Map(rewards.map((reward) => [reward.id, reward]));
  const eventsByCast = new Map<string, IntroducerEntryEvent[]>();
  storedEvents.filter((event) => event.month === month && event.amount > 0).forEach((event) => {
    const cast = castById.get(event.castId);
    // 現在マスタで入店顧問料自体が取り消された場合は、既存仕様どおり古いイベントを無効とする。
    if (cast && (!cast.hiredAt?.startsWith(month) || !cast.introducerId || Number(cast.entryAdvisoryFee || 0) <= 0)) return;
    eventsByCast.set(event.castId, [...(eventsByCast.get(event.castId) || []), event]);
  });

  const fallbackByCast = new Map(fallbackEntryEvents(data, month).map((event) => [event.castId, event]));
  const castIds = new Set([...eventsByCast.keys(), ...fallbackByCast.keys()]);
  return [...castIds].flatMap((castId): EntryEventConflict[] => {
    const cast = castById.get(castId);
    const reward = rewardByCast.get(castId);
    const events = eventsByCast.get(castId) || [];
    const recipientIds = new Set(events.map((event) => event.introducerId).filter(Boolean));
    const fallback = fallbackByCast.get(castId);
    if (fallback) {
      recipientIds.add(fallback.introducerId);
    } else if (events.length && cast?.introducerId && cast.hiredAt?.startsWith(month) && Number(cast.entryAdvisoryFee || 0) > 0) {
      // 保存イベント後に支払先マスタだけが変わった場合も、同期漏れとして検出する。
      recipientIds.add(cast.introducerId);
    }
    if (reward) recipientIds.add(reward.introducer?.id || "__none__");
    const eventFeeTypes = new Set(events.map((event) => event.feeType).filter(Boolean));
    const feeTypeMismatch = Boolean(reward?.introducer && eventFeeTypes.size > 0
      && [...eventFeeTypes].some((feeType) => feeType !== reward.introducer?.feeType));
    if (recipientIds.size <= 1 && !feeTypeMismatch) return [];
    const castName = cast?.name || reward?.name || events[0]?.castName || castId;
    return [{
      castId,
      message: `${castName}の入店時紹介者条件と月内の日次紹介者条件が一致しません。支払先・計算方法を確認するまで月次確定できません。`,
    }];
  });
}

export function introducerEntryEventConflicts(
  rewards: CastReward[],
  data: WorkspaceData,
  month: string,
  storedEvents: IntroducerEntryEvent[] = [],
) {
  return entryEventConflictDetails(rewards, data, month, storedEvents).map((conflict) => conflict.message);
}

export function calculateIntroducerPayments(
  rewards: CastReward[],
  data: WorkspaceData,
  month: string,
  storedEvents: IntroducerEntryEvent[] = [],
): IntroducerPaymentRow[] {
  const conflictedCastIds = new Set(entryEventConflictDetails(rewards, data, month, storedEvents)
    .map((conflict) => conflict.castId));
  const entries = new Map<string, IntroducerEntryEvent>();
  fallbackEntryEvents(data, month).forEach((event) => entries.set(event.castId, event));
  const castById = new Map(data.casts.map((cast) => [cast.id, cast]));
  storedEvents.filter((event) => event.month === month).forEach((event) => {
    const cast = castById.get(event.castId);
    // 現在または論理削除済みのキャストマスタが残っている場合は、その値を正とする。
    // マスタ更新後にイベント側の同期だけ失敗しても、古い顧問料を過払いしない。
    if (cast) {
      const sameCurrentTerms = cast.hiredAt === event.hiredAt
        && cast.hiredAt?.startsWith(month)
        && cast.introducerId === event.introducerId
        && Number(cast.entryAdvisoryFee || 0) === event.amount;
      if (!sameCurrentTerms || event.amount <= 0) return;
    }
    // 保存イベントを当時スナップショットとして優先し、後日の名称・報酬形態変更や削除で書き換えない。
    entries.set(event.castId, event);
  });
  const rewardByCast = new Map(rewards.map((reward) => [reward.id, reward]));
  const castIds = new Set([...rewardByCast.keys(), ...entries.keys()]);
  return [...castIds].flatMap((castId): IntroducerPaymentRow[] => {
    if (conflictedCastIds.has(castId)) return [];
    const reward = rewardByCast.get(castId);
    const entry = entries.get(castId);
    const intro = reward?.introducer;
    if (!intro && !entry) return [];
    const feeType = typeof intro?.feeType === "string" ? intro.feeType : entry?.feeType || "";
    const basis = paymentBasis(reward, feeType);
    const attendanceEnabled = intro
      ? intro.attendanceAdvisoryEnabled !== false
      : false;
    const attendanceAdvisory = attendanceEnabled
      ? (reward?.advisoryDays || 0) * (intro?.attendanceAdvisoryFee || 0)
      : 0;
    const entryAdvisory = entry?.amount || 0;
    const advisory = attendanceAdvisory + entryAdvisory;
    return [{
      id: `${intro?.id || entry!.introducerId}_${castId}`,
      introducer: intro?.name || entry!.introducerName,
      cast: reward?.name || entry!.castName,
      feeType,
      honShimeiLiquorCost: reward?.honShimeiLiquorCost || 0,
      salesBase: basis.salesBase,
      salesFee: basis.salesFee,
      grossBase: basis.grossBase,
      grossFee: basis.grossFee,
      adopted: basis.adopted,
      attendanceAdvisory,
      entryAdvisory,
      advisory,
      total: basis.fee + advisory,
    }];
  }).sort((left, right) => left.introducer.localeCompare(right.introducer, "ja") || left.cast.localeCompare(right.cast, "ja"));
}

export function monthlyAccountingWarnings(rows: DailyClosing[], casts: CastRecord[] = [], month = "") {
  const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
  const warnings: string[] = [];
  rows.forEach((closing) => {
    (closing.integrityIssues ?? []).forEach((issue) => warnings.push(`${closing.businessDate || closing.id}: ${issue}`));
    if (closing.cash.difference !== 0) warnings.push(`${closing.businessDate}の現金照合に${yen.format(closing.cash.difference)}の差額があります。`);
    (closing.casts ?? []).filter((row) => row.kind === "regular" && row.hourlyRate <= 0)
      .forEach((row) => warnings.push(`${closing.businessDate}・${row.name}の時給が未設定です。`));
    (closing.casts ?? []).filter((row) => row.introducer && !validIntroducerFeeTypes.has(String(row.introducer.feeType || "") as IntroducerFeeType))
      .forEach((row) => warnings.push(`${closing.businessDate}・${row.name}の紹介者報酬形態が未設定です。`));
  });
  if (month) warnings.push(...introducerTermConflicts(rows, casts, month));
  return [...new Set(warnings)];
}

export function calculateMonthlyAccounting(
  data: WorkspaceData & { archivedCasts?: CastRecord[]; archivedStaff?: StaffRecord[] },
  month: string,
  adjustments: MonthlyAdjustments,
  entryEvents: IntroducerEntryEvent[] = [],
): MonthlyAccountingResults {
  const calculationData = withArchivedMasters(data);
  const approved = calculationData.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month));
  const castSalesReports = calculateCastSalesReports(calculationData.closings, calculationData.casts, month, adjustments);
  const castRewards = calculateCastRewards(calculationData.closings, calculationData.casts, month, adjustments);
  const staffPayroll = calculateStaffPayroll(approved, adjustments, calculationData.staff, month);
  const driverPayroll = calculateDriverPayroll(approved, adjustments.driverRemoteAllowance);
  const entryEventConflicts = introducerEntryEventConflicts(castRewards, calculationData, month, entryEvents);
  const introducerPayments = calculateIntroducerPayments(castRewards, calculationData, month, entryEvents);
  const byCategory: Record<string, number> = {};
  approved.forEach((closing) => (closing.expenses ?? []).forEach((row) => {
    byCategory[row.category] = (byCategory[row.category] || 0) + row.amount;
  }));
  const dailyExpenseTotal = Object.values(byCategory).reduce((sum, value) => sum + value, 0);
  const dispatchCast = approved.reduce((sum, row) => sum + row.dispatchCastPayment, 0);
  const dispatchStaff = approved.reduce((sum, row) => sum + row.dispatchStaffPayment, 0);
  const dispatchFee = approved.reduce((sum, row) => sum + row.dispatchFee, 0);
  const dispatchTotal = dispatchCast + dispatchStaff + dispatchFee;
  const liquorDelivery = adjustments.liquorDeliveryAmount
    ?? approved.reduce((sum, row) => sum + row.liquorDeliveryAmount, 0);
  const fixed = adjustments.fixedExpenses.reduce((sum, row) => sum + row.amount, 0);
  const expenses: MonthlyExpenseSummary = {
    byCategory,
    dailyExpenseTotal,
    dispatchCast,
    dispatchStaff,
    dispatchFee,
    dispatchTotal,
    liquorDelivery,
    fixed,
    cardFee: adjustments.cardFee,
    total: dailyExpenseTotal + dispatchTotal + liquorDelivery + fixed + adjustments.cardFee,
  };
  const sales: MonthlySalesSummary = {
    cash: approved.reduce((sum, row) => sum + row.sales.cashSales, 0),
    card: approved.reduce((sum, row) => sum + row.sales.cardSales, 0),
    total: approved.reduce((sum, row) => sum + row.sales.totalSales, 0),
  };
  const balanceWithoutProfit = {
    cast: castRewards.reduce((sum, row) => sum + row.grossPay, 0),
    introducer: introducerPayments.reduce((sum, row) => sum + row.total, 0),
    staff: staffPayroll.reduce((sum, row) => sum + row.gross, 0),
    driver: driverPayroll.reduce((sum, row) => sum + row.gross, 0),
    expenses: expenses.total,
  };
  const totalCosts = Object.values(balanceWithoutProfit).reduce((sum, value) => sum + value, 0);
  return {
    approvedDays: new Set(approved.map((row) => row.businessDate)).size,
    castSalesReports,
    castRewards,
    introducerPayments,
    staffPayroll,
    driverPayroll,
    expenses,
    sales,
    balance: { ...balanceWithoutProfit, totalCosts, profit: sales.total - totalCosts },
    warnings: [...new Set([
      ...monthlyAccountingWarnings(approved, calculationData.casts, month),
      ...entryEventConflicts,
    ])],
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export async function monthlySourceFingerprint(
  data: WorkspaceData & { archivedCasts?: CastRecord[]; archivedStaff?: StaffRecord[] },
  month: string,
  adjustments: MonthlyAdjustments,
  entryEvents: IntroducerEntryEvent[] = [],
) {
  const calculationData = withArchivedMasters(data);
  const source = canonicalize({
    month,
    // updatedAtだけでなく計算へ入力される実値を含め、同一ミリ秒の更新や直接書込みも検出する。
    closings: calculationData.closings.filter((row) => row.businessDate.startsWith(month))
      .sort((left, right) => left.id.localeCompare(right.id)),
    casts: [...calculationData.casts].sort((left, right) => left.id.localeCompare(right.id)),
    introducers: [...calculationData.introducers].sort((left, right) => left.id.localeCompare(right.id)),
    staff: [...calculationData.staff].sort((left, right) => left.id.localeCompare(right.id)),
    adjustments,
    entryEvents: entryEvents.filter((row) => row.month === month)
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canFinalizeMonthlyAccounting(
  data: WorkspaceData & {
    archivedCasts?: CastRecord[];
    archivedStaff?: StaffRecord[];
    introducerEntryEvents?: IntroducerEntryEvent[];
  },
  month: string,
  adjustments: MonthlyAdjustments,
  blockUnresolvedDaily: boolean,
  entryEvents?: IntroducerEntryEvent[],
) {
  const calculationData = withArchivedMasters(data);
  const resolvedEntryEvents = entryEvents ?? data.introducerEntryEvents ?? [];
  const unclassified = findUnclassifiedLegacyBottles(data.closings, month, adjustments);
  const unresolvedDaily = data.closings.filter((row) => row.businessDate.startsWith(month)
    && (row.status === "submitted" || row.status === "returned" || row.status === "withdrawn"));
  const approved = data.closings.filter((row) => row.businessDate.startsWith(month) && row.status === "approved");
  const businessDateCounts = new Map<string, number>();
  approved.forEach((row) => businessDateCounts.set(row.businessDate, (businessDateCounts.get(row.businessDate) || 0) + 1));
  const duplicateBusinessDates = [...businessDateCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([businessDate]) => `${businessDate}の承認済み日次データが複数あります。重複データを差し戻してから確定してください。`);
  const integrityIssues = [
    ...approved.flatMap((row) => row.integrityIssues || []),
    ...duplicateBusinessDates,
    ...introducerTermConflicts(approved, calculationData.casts, month),
    ...introducerEntryEventConflicts(
      calculateCastRewards(calculationData.closings, calculationData.casts, month, adjustments),
      calculationData,
      month,
      resolvedEntryEvents,
    ),
  ];
  return {
    allowed: unclassified.length === 0 && integrityIssues.length === 0 && (!blockUnresolvedDaily || unresolvedDaily.length === 0),
    unclassified,
    unresolvedDaily,
    integrityIssues,
  };
}

export function buildMonthlySnapshot(
  month: string,
  revision: number,
  fingerprint: string,
  adjustments: MonthlyAdjustments,
  results: MonthlyAccountingResults,
  closings: DailyClosing[],
  userId: string,
  createdAt: string,
): MonthlyAccountingSnapshot {
  return {
    ...results,
    schemaVersion: 1,
    calculationVersion: MONTHLY_CALCULATION_VERSION,
    month,
    revision,
    sourceFingerprint: fingerprint,
    adjustmentsRevision: adjustments.revision || 0,
    approvedClosings: closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month))
      .map((row) => ({ id: row.id, checksum: row.checksum, updatedAt: row.updatedAt })),
    createdAt,
    createdBy: userId,
  };
}

export function castForEntryEvent(cast: CastRecord) {
  return Boolean(cast.status === "active" && cast.hiredAt && cast.introducerId && cast.entryAdvisoryFee && cast.entryAdvisoryFee > 0);
}
