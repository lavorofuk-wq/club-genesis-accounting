import {
  calculateCastRewards,
  calculateCastSalesReports,
  calculateDriverPayroll,
  castIdentityForMonth,
  castMasterIdentityForMonth,
  compareDailyClosingSubmissionOrder,
  compareIntroducerMonthEventEffectiveOrder,
  dailyClosingSubmissionOrderValue,
  findUnclassifiedLegacyBottles,
  floorHundred,
  hasDailyClosingSubmissionOrder,
  introducerMonthEventEffectiveOrderValue,
  introducerSalesBase,
  japanMonthFromTimestamp,
} from "./gms";
import type {
  CastRecord,
  CastReward,
  CastSalesReport,
  DailyClosing,
  DriverPayrollRow,
  IntroducerDeletionCommit,
  IntroducerFeeType,
  IntroducerMonthEvent,
  MonthlyAdjustments,
  StaffRecord,
  WorkspaceData,
} from "./gms";

export const MONTHLY_CALCULATION_VERSION = "2.11.2";

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
  introducerDeletionCommits: IntroducerDeletionCommit[];
  introducerMonthEvents: IntroducerMonthEvent[];
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
const snapshotMillisecondsInstant = (value: unknown) => {
  if (!snapshotInteger(value)) return undefined;
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const snapshotString = (value: unknown) => typeof value === "string" && value.length > 0;
const snapshotIsoInstant = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value)
  && !Number.isNaN(Date.parse(value))
  && new Date(value).toISOString() === value;
const instantValue = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};
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

/** Firebaseのパス値を月次紹介者制御イベントとして安全に復元する。 */
export function normalizeIntroducerMonthEvent(
  value: unknown,
  month: string,
  castId: string,
): IntroducerMonthEvent | undefined {
  if (!snapshotObject(value) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !castId) return undefined;
  const row = value as Record<string, unknown>;
  if (row.id !== castId || row.castId !== castId || row.month !== month
    || (row.state !== "deleted" && row.state !== "reassigned")
    || !snapshotString(row.castName)
    || !snapshotString(row.deletedIntroducerId)
    || !snapshotString(row.deletedIntroducerName)
    || !snapshotIsoInstant(row.deletedAt)
    || !snapshotString(row.deletedBy)
    || !snapshotInteger(row.revision) || Number(row.revision) < 1
    || !snapshotIsoInstant(row.createdAt)
    || !snapshotString(row.createdBy)
    || !snapshotIsoInstant(row.updatedAt)
    || !snapshotString(row.updatedBy)) return undefined;
  const updatedAtMsInstant = row.updatedAtMs === undefined ? undefined : snapshotMillisecondsInstant(row.updatedAtMs);
  // updatedAtMsは実Firebase保存順専用。長い通信遅延で月を跨いでも、原子的に
  // 保存済みのeventを破損扱いにしない。適用月は操作開始時のupdatedAtで固定する。
  if ((row.updatedAtMs !== undefined && !updatedAtMsInstant)
    || japanMonthFromTimestamp(row.updatedAt) !== month) return undefined;
  if (row.createdAt > row.updatedAt || row.deletedAt > row.updatedAt) return undefined;
  if (row.sourceCastId !== undefined && !snapshotString(row.sourceCastId)) return undefined;
  if (row.state === "deleted") {
    if (row.introducer !== undefined || row.reassignedAt !== undefined
      || row.reassignedAtMs !== undefined || row.reassignedBy !== undefined) return undefined;
  } else {
    if (!snapshotIsoInstant(row.reassignedAt) || !snapshotString(row.reassignedBy) || !snapshotObject(row.introducer)
      || row.deletedAt > row.reassignedAt || row.reassignedAt > row.updatedAt) return undefined;
    const reassignedAtMsInstant = row.reassignedAtMs === undefined ? undefined : snapshotMillisecondsInstant(row.reassignedAtMs);
    if ((row.reassignedAtMs !== undefined && !reassignedAtMsInstant)
      || japanMonthFromTimestamp(row.reassignedAt) !== month) return undefined;
    const introducer = row.introducer as Record<string, unknown>;
    if (!snapshotString(introducer.id) || !snapshotString(introducer.name)
      || !validIntroducerFeeTypes.has(introducer.feeType as IntroducerFeeType)
      || typeof introducer.attendanceAdvisoryEnabled !== "boolean"
      || typeof introducer.entryAdvisoryEnabled !== "boolean"
      || !snapshotNonNegative(introducer.attendanceAdvisoryFee)
      || !snapshotNonNegative(introducer.entryAdvisoryFee)) return undefined;
  }
  return row as IntroducerMonthEvent;
}

export function normalizeIntroducerDeletionCommit(
  value: unknown,
  introducerId: string,
): IntroducerDeletionCommit | undefined {
  if (!snapshotObject(value) || !introducerId) return undefined;
  const row = value as Record<string, unknown>;
  if (row.id !== introducerId || row.introducerId !== introducerId
    || !snapshotString(row.introducerName)
    || typeof row.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)
    || !snapshotString(row.token) || !snapshotString(row.owner)
    || !snapshotInteger(row.deletedAtMs)
    || !snapshotIsoInstant(row.completedAt)
    || !snapshotInteger(row.completedAtMs)) return undefined;
  const deletedAtMsInstant = snapshotMillisecondsInstant(row.deletedAtMs);
  const completedAtMsInstant = snapshotMillisecondsInstant(row.completedAtMs);
  if (!deletedAtMsInstant || !completedAtMsInstant
    || Date.parse(row.completedAt) !== row.deletedAtMs
    || Number(row.completedAtMs) < Number(row.deletedAtMs)
    || japanMonthFromTimestamp(deletedAtMsInstant) !== row.month) return undefined;
  const linked = row.linkedCastIds;
  if (linked !== undefined && (!snapshotObject(linked)
    || Object.values(linked).some((selected) => selected !== true))) return undefined;
  return {
    id: introducerId,
    introducerId,
    introducerName: row.introducerName,
    month: row.month,
    token: row.token,
    owner: row.owner,
    deletedAtMs: row.deletedAtMs,
    completedAt: row.completedAt,
    completedAtMs: row.completedAtMs,
    linkedCastIds: linked ? Object.keys(linked).sort() : [],
  } as IntroducerDeletionCommit;
}

export function calculateStaffPayroll(
  closings: DailyClosing[],
  adjustments: MonthlyAdjustments,
  staff: StaffRecord[] = [],
  month = "",
): StaffPayrollRow[] {
  const map = new Map<string, StaffPayrollRow>();
  const staffById = new Map(staff.map((member) => [member.id, member]));
  const monthWorkIds = new Set(closings.flatMap((closing) => (closing.staffWork ?? [])
    .filter((work) => work.kind === "regular")
    .map((work) => work.staffId)));
  closings.forEach((closing) => (closing.staffWork ?? []).forEach((work) => {
    const converted = work.kind === "trial"
      ? staff.find((member) => member.convertedFromTrialId === work.staffId && member.hiredAt?.startsWith(month))
      : undefined;
    const source = work.kind === "trial" ? staffById.get(work.staffId) : undefined;
    // 旧版の物理削除で在籍側だけ消えた場合も、体入側に残る変換先IDが
    // 同月regular勤務に実在するときだけ同一人物として給与を統合する。
    const missingConvertedTargetId = source?.convertedToStaffId
      && monthWorkIds.has(source.convertedToStaffId)
      ? source.convertedToStaffId
      : undefined;
    const staffId = converted?.id || missingConvertedTargetId || work.staffId;
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

export function introducerEntryEventConflicts(
  rewards: CastReward[],
  data: WorkspaceData,
  month: string,
  storedEvents: IntroducerEntryEvent[] = [],
  introducerMonthEvents: IntroducerMonthEvent[] = [],
  introducerDeletionCommits: IntroducerDeletionCommit[] = [],
) {
  return rewards.flatMap((reward): string[] => {
    const cast = data.casts.find((row) => row.id === reward.id);
    if (!cast?.convertedFromTrialId || reward.advisoryDays !== 0 || !cast.hiredAt?.startsWith(month)) return [];
    const entry = storedEvents.find((event) => event.month === month && event.castId === cast.id);
    if (!entry || reward.introducer?.id === entry.introducerId) return [];
    const aliases = new Set([cast.id, cast.convertedFromTrialId]);
    const event = introducerMonthEvents.filter((candidate) => candidate.month === month && aliases.has(candidate.castId))
      .sort(compareIntroducerMonthEventEffectiveOrder)
      .at(-1);
    const commit = deletionCommitForAliases(aliases, month, introducerDeletionCommits);
    const latestSpecial = [
      ...(event ? [{ state: event.state, order: introducerMonthEventEffectiveOrderValue(event) }] : []),
      ...(commit ? [{ state: "deleted" as const, order: commit.completedAtMs }] : []),
    ].sort((left, right) => left.order - right.order).at(-1);
    // 削除が最後の明示操作なら当月0円が確定仕様なので、紹介者差は曖昧さにならない。
    if (latestSpecial?.state === "deleted") return [];
    const dailyIntroducer = reward.introducer?.name || "紹介者なし";
    return [`${reward.name}は体入日の紹介者（${dailyIntroducer}）と入店時の紹介者（${entry.introducerName}）が異なるため、入店顧問料を確定できません。適用する紹介者を確認してください。`];
  });
}

function monthEventForCast(
  castId: string,
  data: WorkspaceData,
  month: string,
  events: IntroducerMonthEvent[],
) {
  const cast = data.casts.find((row) => row.id === castId);
  const aliases = new Set([
    castId,
    cast?.convertedFromTrialId,
    ...data.casts.filter((row) => row.convertedToCastId === castId).map((row) => row.id),
  ].filter((value): value is string => Boolean(value)));
  const candidates = events.filter((event) => event.month === month && aliases.has(event.castId));
  return [...candidates].sort(compareIntroducerMonthEventEffectiveOrder).at(-1);
}

function deletionCommitForAliases(
  aliases: Set<string>,
  month: string,
  commits: IntroducerDeletionCommit[],
) {
  return commits.filter((commit) => commit.month === month
    && commit.linkedCastIds.some((linkedId) => aliases.has(linkedId)))
    .sort((left, right) => left.completedAtMs - right.completedAtMs || left.id.localeCompare(right.id))
    .at(-1);
}

export function calculateIntroducerPayments(
  rewards: CastReward[],
  data: WorkspaceData,
  month: string,
  storedEvents: IntroducerEntryEvent[] = [],
  introducerMonthEvents: IntroducerMonthEvent[] = [],
  introducerDeletionCommits: IntroducerDeletionCommit[] = [],
): IntroducerPaymentRow[] {
  const entries = new Map<string, IntroducerEntryEvent>();
  fallbackEntryEvents(data, month).forEach((event) => entries.set(event.castId, event));
  const castById = new Map(data.casts.map((cast) => [cast.id, cast]));
  storedEvents.filter((event) => event.month === month).forEach((event) => {
    const cast = castById.get(event.castId);
    // 現在または論理削除済みのキャストマスタが残っている場合は、その値を正とする。
    // マスタ更新後にイベント側の同期だけ失敗しても、古い顧問料を過払いしない。
    const castUpdatedInTargetMonth = Boolean(cast && Number.isFinite(Date.parse(cast.updatedAt))
      && japanMonthFromTimestamp(cast.updatedAt) === month);
    if (cast && castUpdatedInTargetMonth) {
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
  const castIds = new Set([
    ...rewardByCast.keys(),
    ...entries.keys(),
    ...introducerMonthEvents.filter((event) => event.month === month && event.state === "reassigned").map((event) => event.castId),
  ]);
  return [...castIds].flatMap((castId): IntroducerPaymentRow[] => {
    const reward = rewardByCast.get(castId);
    const entry = entries.get(castId);
    const monthEvent = monthEventForCast(castId, data, month, introducerMonthEvents);
    const cast = data.casts.find((row) => row.id === castId);
    const aliases = new Set([
      castId,
      cast?.convertedFromTrialId,
      ...data.casts.filter((row) => row.convertedToCastId === castId).map((row) => row.id),
    ].filter((value): value is string => Boolean(value)));
    const deletionCommit = [
      ...introducerDeletionCommits.filter((commit) => commit.month === month
        && commit.linkedCastIds.some((linkedId) => aliases.has(linkedId))),
      ...introducerDeletionCommits.filter((commit) => commit.month === month
        && cast !== undefined && !cast.deletedAt && cast.introducerId === commit.introducerId),
    ].filter((commit, index, rows) => rows.findIndex((candidate) => candidate.id === commit.id) === index)
      .sort((left, right) => left.completedAtMs - right.completedAtMs || left.id.localeCompare(right.id))
      .at(-1);
    const latestSpecial = [
      ...(monthEvent ? [{ kind: "event" as const, order: introducerMonthEventEffectiveOrderValue(monthEvent), event: monthEvent }] : []),
      ...(deletionCommit ? [{ kind: "commit" as const, order: deletionCommit.completedAtMs }] : []),
    ].sort((left, right) => left.order - right.order || (left.kind === "commit" ? 1 : -1)).at(-1);
    if (latestSpecial?.kind === "commit" || latestSpecial?.event.state === "deleted") return [];
    const effectiveMonthEvent = latestSpecial?.kind === "event" ? latestSpecial.event : undefined;
    const intro = reward
      ? reward.introducer
      : effectiveMonthEvent?.state === "reassigned"
        ? effectiveMonthEvent.introducer
        : undefined;
    // 出勤済みで最後の日次が「紹介者なし」なら、入店時イベントだけを旧紹介者へ支払わない。
    if (reward && !intro) return [];
    if (!intro && !entry) return [];
    const feeType = typeof intro?.feeType === "string" ? intro.feeType : entry?.feeType || "";
    const basis = paymentBasis(reward, feeType);
    const attendanceEnabled = intro
      ? intro.attendanceAdvisoryEnabled !== false
      : false;
    const attendanceAdvisory = attendanceEnabled
      ? (reward?.advisoryDays || 0) * (intro?.attendanceAdvisoryFee || 0)
      : 0;
    // 旧版の物理削除でキャストマスタが残っていなくても、保存済み入店イベントの
    // 採用日を使って当時発生した一回分を維持する。
    const hiredThisMonth = Boolean(cast?.hiredAt?.startsWith(month) || entry?.hiredAt?.startsWith(month));
    // 体入後に同月在籍化し、在籍後は一度も出勤していない場合、最後の日次は
    // 体入日のため入店顧問料が0のままになる。入店時に保存したイベントと紹介者が
    // 同一なら、その一回分だけは採用日基準で計上する（異なる紹介者は推測しない）。
    const sameIntroducerEntryWithoutRegularAttendance = Boolean(
      reward
        && reward.advisoryDays === 0
        && cast?.convertedFromTrialId
        && intro
        && entry
        && entry.introducerId === intro.id
        && entry.amount > 0,
    );
    // 日次がある人物は、入店顧問料も含めて最後に保存された日次（または再設定イベント）の
    // snapshotを月全体へ適用する。保存イベントは月内に日次が一度もない入店キャスト専用。
    const entryAdvisory = intro
      ? (hiredThisMonth && sameIntroducerEntryWithoutRegularAttendance
        ? entry!.amount
        : hiredThisMonth && intro.entryAdvisoryEnabled !== false ? intro.entryAdvisoryFee || 0 : 0)
      : entry?.amount || 0;
    if (!reward && entryAdvisory <= 0) return [];
    const advisory = attendanceAdvisory + entryAdvisory;
    return [{
      id: `${intro?.id || entry!.introducerId}_${castId}`,
      introducer: intro?.name || entry!.introducerName,
      cast: reward?.name || entry?.castName || cast?.name || effectiveMonthEvent?.castName || "名称未設定",
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
  });
  // 紹介者条件の月途中変更は、最後に保存された日次条件へ統一して算出する。
  void casts;
  void month;
  return [...new Set(warnings)];
}

function effectiveIntroducerIssues(rewards: CastReward[]) {
  return rewards
    .filter((reward) => reward.introducer && !validIntroducerFeeTypes.has(String(reward.introducer.feeType || "") as IntroducerFeeType))
    .map((reward) => `${reward.name}の当月適用対象となる紹介者報酬形態が未設定です。`);
}

function introducerConditionKey(value: DailyClosing["casts"][number]["introducer"] | undefined) {
  return JSON.stringify(canonicalize(value || null));
}

/**
 * 保存順が復元できない旧日次、またはFirebaseサーバー時刻が同一の競合を検出する。
 * 表示計算は決定的に継続するが、条件を推測した月次確定は許可しない。
 */
function introducerSaveOrderIssues(
  data: WorkspaceData,
  month: string,
  events: IntroducerMonthEvent[],
  commits: IntroducerDeletionCommit[],
) {
  const approved = data.closings.filter((closing) => closing.status === "approved"
    && closing.businessDate.startsWith(month));
  const castById = new Map(data.casts.map((cast) => [cast.id, cast]));
  const groups = new Map<string, Array<{ closing: DailyClosing; row: DailyClosing["casts"][number] }>>();
  const monthDailyMasterIds = new Set(approved.flatMap((closing) => (closing.casts || [])
    .filter((row) => row.kind === "regular")
    .map((row) => row.masterId)));
  // 出勤がなくても入店顧問料は発生し得るため、イベントだけを持つ人物も検査する。
  data.casts.forEach((cast) => {
    const id = castMasterIdentityForMonth(cast.id, castById, data.casts, month, monthDailyMasterIds);
    if (!groups.has(id)) groups.set(id, []);
  });
  events.filter((event) => event.month === month).forEach((event) => {
    const id = castMasterIdentityForMonth(event.castId, castById, data.casts, month, monthDailyMasterIds);
    if (!groups.has(id)) groups.set(id, []);
  });
  commits.filter((commit) => commit.month === month).forEach((commit) => {
    commit.linkedCastIds.forEach((linkedId) => {
      const id = castMasterIdentityForMonth(linkedId, castById, data.casts, month, monthDailyMasterIds);
      if (!groups.has(id)) groups.set(id, []);
    });
  });
  approved.forEach((closing) => (closing.casts || []).forEach((row) => {
    if (row.kind === "dispatch") return;
    const id = castIdentityForMonth(row, castById, data.casts, month, monthDailyMasterIds);
    groups.set(id, [...(groups.get(id) || []), { closing, row }]);
  }));

  return [...groups.entries()].flatMap(([castId, entries]): string[] => {
    const name = castById.get(castId)?.name || entries[0]?.row.name
      || events.find((event) => event.month === month && event.castId === castId)?.castName
      || castId;
    const distinctDailyTerms = new Set(entries.map(({ row }) => introducerConditionKey(row.introducer)));
    const issues: string[] = [];
    if (distinctDailyTerms.size > 1 && entries.some(({ closing }) => !hasDailyClosingSubmissionOrder(closing))) {
      issues.push(`${name}の旧日次に店舗保存順がないため、当月の紹介者条件を確定できません。該当日次を差し戻して再送してください。`);
    }
    const dailyByOrder = new Map<number, Set<string>>();
    entries.filter(({ closing }) => hasDailyClosingSubmissionOrder(closing)).forEach(({ closing, row }) => {
      const order = dailyClosingSubmissionOrderValue(closing);
      dailyByOrder.set(order, new Set([...(dailyByOrder.get(order) || []), introducerConditionKey(row.introducer)]));
    });
    if ([...dailyByOrder.values()].some((terms) => terms.size > 1)) {
      issues.push(`${name}の紹介者条件が同じ店舗保存時刻で競合しています。該当日次を差し戻して再送してください。`);
    }

    const cast = castById.get(castId);
    const aliases = new Set([
      castId,
      cast?.convertedFromTrialId,
      ...data.casts.filter((candidate) => candidate.convertedToCastId === castId).map((candidate) => candidate.id),
      ...entries.map(({ row }) => row.masterId),
    ].filter((value): value is string => Boolean(value)));
    const candidateEvents = events.filter((event) => event.month === month && aliases.has(event.castId));
    const candidateCommits = commits.filter((commit) => commit.month === month
      && commit.linkedCastIds.some((linkedId) => aliases.has(linkedId)));
    const eventResolution = (event: IntroducerMonthEvent) => JSON.stringify(canonicalize({
      state: event.state,
      terms: event.state === "deleted" ? undefined : event.introducer,
      // deletedは月全体0で保存順に影響しない。reassignedは日次との前後判定に
      // 再設定時刻を使うため、条件が同じでもこの値の差を曖昧なままにしない。
      effectiveOrder: event.state === "reassigned"
        ? introducerMonthEventEffectiveOrderValue(event)
        : undefined,
    }));
    const distinctEventResolutions = new Set(candidateEvents.map(eventResolution));
    if (distinctEventResolutions.size > 1
      && candidateEvents.some((event) => !Number.isSafeInteger(event.updatedAtMs))) {
      issues.push(`${name}の旧紹介者変更履歴にサーバー保存順がないため、当月の条件を確定できません。キャストデータを保存し直してください。`);
    }
    const eventByServerOrder = new Map<number, Set<string>>();
    candidateEvents.filter((event) => Number.isSafeInteger(event.updatedAtMs) && Number(event.updatedAtMs) >= 0)
      .forEach((event) => {
        const resolution = eventResolution(event);
        eventByServerOrder.set(event.updatedAtMs!, new Set([...(eventByServerOrder.get(event.updatedAtMs!) || []), resolution]));
      });
    if ([...eventByServerOrder.values()].some((terms) => terms.size > 1)) {
      issues.push(`${name}の紹介者変更履歴が同じサーバー保存時刻で競合しています。キャストデータを保存し直してください。`);
    }

    const specialByServerOrder = new Map<number, Set<string>>();
    candidateEvents.forEach((event) => {
      const order = event.state === "reassigned" ? event.reassignedAtMs : event.updatedAtMs;
      if (!Number.isSafeInteger(order)) return;
      const resolution = introducerConditionKey(event.state === "reassigned" ? event.introducer : undefined);
      specialByServerOrder.set(order!, new Set([...(specialByServerOrder.get(order!) || []), resolution]));
    });
    candidateCommits.forEach((commit) => {
      const resolution = introducerConditionKey(undefined);
      specialByServerOrder.set(commit.completedAtMs, new Set([...(specialByServerOrder.get(commit.completedAtMs) || []), resolution]));
    });
    if ([...specialByServerOrder.values()].some((terms) => terms.size > 1)) {
      issues.push(`${name}の紹介者削除・再設定が同じサーバー時刻で競合しています。キャストデータを保存し直してください。`);
    }

    const latestDaily = [...entries].sort((left, right) =>
      compareDailyClosingSubmissionOrder(left.closing, right.closing)
      || left.closing.businessDate.localeCompare(right.closing.businessDate)
      || left.closing.id.localeCompare(right.closing.id)
      || left.row.posCastId.localeCompare(right.row.posCastId)).at(-1);
    const latestEvent = [...candidateEvents].sort(compareIntroducerMonthEventEffectiveOrder).at(-1);
    const latestCommit = deletionCommitForAliases(aliases, month, candidateCommits);
    const latestSpecial = [
      ...(latestEvent ? [{ kind: "event" as const, order: introducerMonthEventEffectiveOrderValue(latestEvent), event: latestEvent }] : []),
      ...(latestCommit ? [{ kind: "commit" as const, order: latestCommit.completedAtMs }] : []),
    ].sort((left, right) => left.order - right.order || (left.kind === "commit" ? 1 : -1)).at(-1);
    if (latestEvent?.state === "reassigned") {
      const eventTerms = introducerConditionKey(latestEvent.introducer);
      if (entries.some(({ closing, row }) =>
        !hasDailyClosingSubmissionOrder(closing) && introducerConditionKey(row.introducer) !== eventTerms)) {
        issues.push(`${name}の旧日次と紹介者再設定の前後関係を復元できません。該当日次を差し戻して再送してください。`);
      }
      if (latestDaily
        && Number.isSafeInteger(latestDaily.closing.submittedAtMs)
        && !Number.isSafeInteger(latestEvent.reassignedAtMs)
        && introducerConditionKey(latestDaily.row.introducer) !== eventTerms) {
        issues.push(`${name}の日次保存と旧紹介者再設定の前後関係を復元できません。キャストデータまたは日次を保存し直してください。`);
      }
    }
    const eventEffectiveServerOrder = latestEvent?.state === "reassigned"
      ? latestEvent.reassignedAtMs
      : latestEvent?.updatedAtMs;
    if (latestDaily && latestEvent
      && Number.isSafeInteger(latestDaily.closing.submittedAtMs)
      && Number.isSafeInteger(eventEffectiveServerOrder)
      && latestDaily.closing.submittedAtMs === eventEffectiveServerOrder) {
      const dailyTerms = introducerConditionKey(latestDaily.row.introducer);
      const eventTerms = latestEvent.state === "deleted"
        ? introducerConditionKey(undefined)
        : introducerConditionKey(latestEvent.introducer);
      if (dailyTerms !== eventTerms) {
        issues.push(`${name}の日次保存と紹介者変更が同じサーバー時刻で競合しています。キャストデータまたは日次を保存し直してください。`);
      }
    }
    if (latestDaily && latestSpecial
      && Number.isSafeInteger(latestDaily.closing.submittedAtMs)
      && Number.isSafeInteger(latestSpecial.order)
      && latestDaily.closing.submittedAtMs === latestSpecial.order) {
      const dailyTerms = introducerConditionKey(latestDaily.row.introducer);
      const specialTerms = latestSpecial.kind === "event" && latestSpecial.event.state === "reassigned"
        ? introducerConditionKey(latestSpecial.event.introducer)
        : introducerConditionKey(undefined);
      if (dailyTerms !== specialTerms) {
        issues.push(`${name}の日次保存と紹介者削除・再設定が同じサーバー時刻で競合しています。キャストデータまたは日次を保存し直してください。`);
      }
    }
    return [...new Set(issues)];
  });
}

/**
 * キャスト保存と月次イベント同期の間に通信断・月次確定ロックが入った場合も、
 * 不整合な状態のまま確定スナップショットを作らないための検査。
 */
function introducerMonthEventConsistencyIssues(
  data: WorkspaceData,
  month: string,
  events: IntroducerMonthEvent[],
  commits: IntroducerDeletionCommit[],
) {
  const currentCasts = data.casts.filter((cast) => !(cast as CastRecord & { deletedAt?: string }).deletedAt);
  const castById = new Map(currentCasts.map((cast) => [cast.id, cast]));
  const canonicalCasts = new Map<string, CastRecord>();
  currentCasts.forEach((cast) => {
    const converted = cast.convertedToCastId ? castById.get(cast.convertedToCastId) : undefined;
    const canonical = converted || cast;
    canonicalCasts.set(canonical.id, canonical);
  });
  const scopedData = { ...data, casts: currentCasts };
  return [...canonicalCasts.values()].flatMap((cast): string[] => {
    const event = monthEventForCast(cast.id, scopedData, month, events);
    if (!event) return [];
    const aliasIds = new Set([
      cast.id,
      cast.convertedFromTrialId,
      ...currentCasts.filter((candidate) => candidate.convertedToCastId === cast.id).map((candidate) => candidate.id),
    ].filter((value): value is string => Boolean(value)));
    const deletionCommit = deletionCommitForAliases(aliasIds, month, commits);
    if (deletionCommit && deletionCommit.completedAtMs >= introducerMonthEventEffectiveOrderValue(event)) return [];
    const laterDailyExists = event.state === "reassigned" && data.closings.some((closing) => closing.status === "approved"
      && closing.businessDate.startsWith(month)
      && dailyClosingSubmissionOrderValue(closing) > introducerMonthEventEffectiveOrderValue(event)
      && (closing.casts || []).some((dailyCast) => aliasIds.has(dailyCast.masterId)));
    // 再設定イベントより後の店舗保存があれば、その日次snapshotが正となる。
    // 現在マスタとの差は、古いイベント同期不良として扱わない。
    if (laterDailyExists) return [];
    // 現在マスタは後月にも正当に変更される。対象月内に保存された変更だけを
    // event同期検査の対象とし、過去月snapshotを現在値で上書きしない。
    if (!Number.isFinite(Date.parse(cast.updatedAt)) || japanMonthFromTimestamp(cast.updatedAt) !== month) return [];
    const selectedIntroducer = cast.introducerId
      ? data.introducers.find((introducer) => introducer.id === cast.introducerId)
      : undefined;
    if (event.state === "deleted") {
      if (selectedIntroducer && selectedIntroducer.id !== event.deletedIntroducerId) {
        return [`${cast.name}は紹介者を再設定済みですが、当月の再設定履歴が同期されていません。キャストデータをもう一度保存してください。`];
      }
      return [];
    }
    if (!event.introducer || cast.introducerId !== event.introducer.id || !selectedIntroducer) {
      return [`${cast.name}の紹介者再設定履歴と現在のキャストデータが一致しません。キャストデータをもう一度保存してください。`];
    }
    if (instantValue(cast.updatedAt) > instantValue(event.updatedAt)) {
      const expectedSnapshot: NonNullable<IntroducerMonthEvent["introducer"]> = {
        id: selectedIntroducer.id,
        name: selectedIntroducer.name,
        feeType: selectedIntroducer.feeType,
        attendanceAdvisoryEnabled: Boolean(selectedIntroducer.attendanceAdvisoryEnabled),
        entryAdvisoryEnabled: Boolean(selectedIntroducer.entryAdvisoryEnabled),
        attendanceAdvisoryFee: selectedIntroducer.attendanceAdvisoryEnabled
          ? Number(cast.attendanceAdvisoryFee || 0)
          : 0,
        entryAdvisoryFee: selectedIntroducer.entryAdvisoryEnabled
          ? Number(cast.entryAdvisoryFee || 0)
          : 0,
      };
      if (event.castName !== cast.name
        || JSON.stringify(canonicalize(event.introducer)) !== JSON.stringify(canonicalize(expectedSnapshot))) {
        return [`${cast.name}の紹介者条件変更が当月の再設定履歴へ同期されていません。キャストデータをもう一度保存してください。`];
      }
    }
    return [];
  });
}

function introducerDeletionCommitConsistencyIssues(
  data: WorkspaceData,
  month: string,
  events: IntroducerMonthEvent[],
  commits: IntroducerDeletionCommit[],
) {
  const currentCasts = data.casts.filter((cast) => !(cast as CastRecord & { deletedAt?: string }).deletedAt);
  const monthCommits = commits.filter((commit) => commit.month === month);
  const omittedIssues = monthCommits.flatMap((commit) => currentCasts
    .filter((cast) => cast.introducerId === commit.introducerId && !commit.linkedCastIds.includes(cast.id))
    .map((cast) => `${cast.name}が紹介者削除確定履歴の対象者一覧から欠落しています。紹介者削除履歴を確認してください。`));
  const synchronizationIssues = currentCasts.flatMap((cast): string[] => {
    const aliases = new Set([
      cast.id,
      cast.convertedFromTrialId,
      ...currentCasts.filter((candidate) => candidate.convertedToCastId === cast.id).map((candidate) => candidate.id),
    ].filter((value): value is string => Boolean(value)));
    const linkedCommits = monthCommits.filter((commit) =>
      commit.linkedCastIds.some((linkedId) => aliases.has(linkedId)));
    if (!linkedCommits.length) return [];
    // 後月に別紹介者へ変更した現在値で、削除月の確定履歴を再設定漏れと誤判定しない。
    if (!Number.isFinite(Date.parse(cast.updatedAt)) || japanMonthFromTimestamp(cast.updatedAt) !== month) return [];
    const latestCommit = deletionCommitForAliases(aliases, month, linkedCommits)!;
    const event = monthEventForCast(cast.id, data, month, events);
    const latestSpecial = [
      { kind: "commit" as const, order: latestCommit.completedAtMs, introducerId: latestCommit.introducerId },
      ...(event ? [{
        kind: "event" as const,
        order: introducerMonthEventEffectiveOrderValue(event),
        introducerId: event.state === "reassigned" ? event.introducer!.id : event.deletedIntroducerId,
        event,
      }] : []),
    ].sort((left, right) => left.order - right.order || (left.kind === "commit" ? 1 : -1)).at(-1)!;
    if (!cast.introducerId || cast.introducerId === latestSpecial.introducerId) return [];
    if (latestSpecial.kind === "event" && latestSpecial.event.state === "reassigned"
      && latestSpecial.event.introducer?.id === cast.introducerId) return [];
    return [`${cast.name}は削除済み紹介者から変更されていますが、当月の再設定履歴が同期されていません。キャストデータをもう一度保存してください。`];
  });
  return [...new Set([...omittedIssues, ...synchronizationIssues])];
}

export function calculateMonthlyAccounting(
  data: WorkspaceData & { archivedCasts?: CastRecord[]; archivedStaff?: StaffRecord[]; introducerMonthEvents?: IntroducerMonthEvent[]; introducerDeletionCommits?: IntroducerDeletionCommit[] },
  month: string,
  adjustments: MonthlyAdjustments,
  entryEvents: IntroducerEntryEvent[] = [],
  monthEvents: IntroducerMonthEvent[] = data.introducerMonthEvents ?? [],
  deletionCommits: IntroducerDeletionCommit[] = data.introducerDeletionCommits ?? [],
): MonthlyAccountingResults {
  const calculationData = withArchivedMasters(data);
  const approved = calculationData.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month));
  const castSalesReports = calculateCastSalesReports(calculationData.closings, calculationData.casts, month, adjustments);
  const castRewards = calculateCastRewards(calculationData.closings, calculationData.casts, month, adjustments, monthEvents, deletionCommits);
  const staffPayroll = calculateStaffPayroll(approved, adjustments, calculationData.staff, month);
  const driverPayroll = calculateDriverPayroll(approved, adjustments.driverRemoteAllowance);
  const introducerPayments = calculateIntroducerPayments(castRewards, calculationData, month, entryEvents, monthEvents, deletionCommits);
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
      ...effectiveIntroducerIssues(castRewards),
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
  data: WorkspaceData & { archivedCasts?: CastRecord[]; archivedStaff?: StaffRecord[]; introducerMonthEvents?: IntroducerMonthEvent[]; introducerDeletionCommits?: IntroducerDeletionCommit[] },
  month: string,
  adjustments: MonthlyAdjustments,
  entryEvents: IntroducerEntryEvent[] = [],
  monthEvents: IntroducerMonthEvent[] = data.introducerMonthEvents ?? [],
  deletionCommits: IntroducerDeletionCommit[] = data.introducerDeletionCommits ?? [],
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
    introducerMonthEvents: monthEvents.filter((row) => row.month === month)
      .sort((left, right) => left.id.localeCompare(right.id)),
    introducerDeletionCommits: deletionCommits.filter((row) => row.month === month)
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
    introducerMonthEvents?: IntroducerMonthEvent[];
    introducerDeletionCommits?: IntroducerDeletionCommit[];
  },
  month: string,
  adjustments: MonthlyAdjustments,
  blockUnresolvedDaily: boolean,
  entryEvents?: IntroducerEntryEvent[],
  monthEvents?: IntroducerMonthEvent[],
  deletionCommits?: IntroducerDeletionCommit[],
) {
  const calculationData = withArchivedMasters(data);
  const resolvedEntryEvents = entryEvents ?? data.introducerEntryEvents ?? [];
  const resolvedMonthEvents = monthEvents ?? data.introducerMonthEvents ?? [];
  const resolvedDeletionCommits = deletionCommits ?? data.introducerDeletionCommits ?? [];
  const unclassified = findUnclassifiedLegacyBottles(data.closings, month, adjustments);
  const unresolvedDaily = data.closings.filter((row) => row.businessDate.startsWith(month)
    && (row.status === "submitted" || row.status === "returned" || row.status === "withdrawn"));
  const approved = data.closings.filter((row) => row.businessDate.startsWith(month) && row.status === "approved");
  const castRewards = calculateCastRewards(
    calculationData.closings,
    calculationData.casts,
    month,
    adjustments,
    resolvedMonthEvents,
    resolvedDeletionCommits,
  );
  const businessDateCounts = new Map<string, number>();
  approved.forEach((row) => businessDateCounts.set(row.businessDate, (businessDateCounts.get(row.businessDate) || 0) + 1));
  const duplicateBusinessDates = [...businessDateCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([businessDate]) => `${businessDate}の承認済み日次データが複数あります。重複データを差し戻してから確定してください。`);
  const integrityIssues = [
    ...approved.flatMap((row) => row.integrityIssues || []),
    ...duplicateBusinessDates,
    ...effectiveIntroducerIssues(castRewards),
    ...introducerSaveOrderIssues(calculationData, month, resolvedMonthEvents, resolvedDeletionCommits),
    ...introducerMonthEventConsistencyIssues(calculationData, month, resolvedMonthEvents, resolvedDeletionCommits),
    ...introducerDeletionCommitConsistencyIssues(calculationData, month, resolvedMonthEvents, resolvedDeletionCommits),
    ...introducerEntryEventConflicts(
      castRewards,
      calculationData,
      month,
      resolvedEntryEvents,
      resolvedMonthEvents,
      resolvedDeletionCommits,
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
