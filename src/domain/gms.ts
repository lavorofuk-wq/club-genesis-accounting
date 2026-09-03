export type Role = "shop" | "accounting" | "op";
export type PersonStatus = "active" | "trial" | "departed";
export type CastKind = "regular" | "trial" | "dispatch";
export type ClosingStatus = "submitted" | "returned" | "approved" | "withdrawn";

export type MonthlyRates = Record<string, number>;

export type CastRecord = {
  id: string;
  name: string;
  legalName: string;
  status: PersonStatus;
  hiredAt?: string;
  trialDate?: string;
  departedAt?: string;
  hourlyRates: MonthlyRates;
  trialHourlyRate?: number;
  introducerId?: string;
  attendanceAdvisoryFee?: number;
  entryAdvisoryFee?: number;
  convertedFromTrialId?: string;
  convertedToCastId?: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type StaffRecord = {
  id: string;
  name: string;
  status: PersonStatus;
  hiredAt?: string;
  trialDate?: string;
  departedAt?: string;
  hourlyRate?: number;
  trialHourlyRate?: number;
  convertedFromTrialId?: string;
  convertedToStaffId?: string;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type DriverRecord = {
  id: string;
  name: string;
  status: "active" | "departed";
  hiredAt: string;
  departedAt?: string;
  dailyRate: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type IntroducerFeeType =
  | "sales10"
  | "netSales10"
  | "gross10"
  | "higherSalesGross10"
  | "higherNetSalesGross10";

export type IntroducerRecord = {
  id: string;
  name: string;
  feeType: IntroducerFeeType;
  attendanceAdvisoryEnabled: boolean;
  entryAdvisoryEnabled: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type LiquorRecord = {
  id: string;
  kind: "champagneWine" | "keepBottle";
  name: string;
  salePrice: number;
  costPrice: number;
  createdAt: string;
  updatedAt: string;
};

export type PosItem = {
  itemId: string;
  label: string;
  category: string;
  price: number;
  quantity: number;
  castId?: string;
  castName?: string;
  backTargetCastIds: string[];
  backTargetCastNames: string[];
  backType?: string;
  backAllocation?: string;
  banaiExtCastIds: string[];
  isSet: boolean;
  isHonShimei: boolean;
  isBanaiShimei: boolean;
  isExtension: boolean;
  isBanaiExtension: boolean;
  isDiscount: boolean;
};

export type PosTransaction = {
  transactionId: string;
  tableId: string;
  tableLabel: string;
  startTime: number;
  endTime: number;
  payMethod: string;
  splits: { method: string; amount: number }[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  items: PosItem[];
};

export type PosCastWork = {
  castId: string;
  castName: string;
  castType: CastKind;
  isTrial: boolean;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  hours: number;
};

export type PosCastSales = {
  castId: string;
  castName: string;
  honShimeiSales: number;
  jonaiExtensionSales: number;
  drinkSales: number;
  totalAttributedSales: number;
};

export type PosClosingV3 = {
  schema: "club-genesis-pos-closing";
  schemaVersion: 3;
  businessDate: string;
  status: string;
  sales: { totalSales: number; cashSales: number; cardSales: number };
  customers: { groupCount: number; totalCustomers: number; customerUnitPrice?: number };
  nominations: { honShimeiCount: number; jonaiCount: number };
  transactions: PosTransaction[];
  castSales: PosCastSales[];
  castWork: PosCastWork[];
  rosterSnapshot?: { complete: boolean; capturedAt: string; casts: Record<string, unknown>[] };
  lifecycleEvents?: Record<string, unknown>[];
  source?: Record<string, unknown>;
  submissionId: string;
  generatedAt: string;
  checksumAlgorithm: "sha256";
  checksumCanonicalization: "recursive-key-sort-v1";
  checksum: string;
};

export type BottleAllocation = {
  itemId: string;
  name: string;
  kind: "champagneWine" | "keepBottle";
  quantity: number;
  salesAmount: number;
  costAmount: number;
  specialCost: boolean;
};

export type DailyCast = {
  masterId: string;
  posCastId: string;
  name: string;
  kind: CastKind;
  startTime: string;
  endTime: string;
  hours: number;
  hourlyRate: number;
  honShimeiCount: number;
  banaiShimeiCount: number;
  dohanCount: number;
  dohanBack: number;
  honShimeiSales: number;
  jonaiExtensionSales: number;
  drinkSales: number;
  bottles: BottleAllocation[];
  liquorCost: number;
  beautyAllowance: number;
  dailyPayment: number;
  advancePayment: number;
  transportFee: number;
  introducer?: {
    id: string;
    name: string;
    feeType: IntroducerFeeType;
    attendanceAdvisoryFee: number;
    entryAdvisoryFee: number;
  };
};

export type DailyStaffWork = {
  staffId: string;
  name: string;
  kind: "regular" | "trial";
  startTime: string;
  endTime: string;
  hours: number;
  hourlyRate: number;
  dailyPayment: number;
};

export type DailyDriverWork = {
  driverId: string;
  name: string;
  dailyRate: number;
};

export type ExpenseCategory =
  | "beautyTrial"
  | "introduction"
  | "advertising"
  | "supplies"
  | "entertainment"
  | "liquor"
  | "transportOther";

export type DailyExpense = {
  id: string;
  category: ExpenseCategory;
  payee: string;
  amount: number;
  personId?: string;
  personName?: string;
};

export type CashReconciliation = {
  cashSales: number;
  cardSales: number;
  totalSales: number;
  cashFloat: number;
  expenseAndPaymentTotal: number;
  expectedClosingCash: number;
  cashProfit: number;
  actualClosingCash: number;
  difference: number;
};

export type DailyClosing = {
  id: string;
  businessDate: string;
  status: ClosingStatus;
  submissionId: string;
  checksum: string;
  sales: PosClosingV3["sales"];
  customers: PosClosingV3["customers"];
  nominations: PosClosingV3["nominations"];
  casts: DailyCast[];
  staffWork: DailyStaffWork[];
  drivers: DailyDriverWork[];
  expenses: DailyExpense[];
  staffDailyPaymentTotal: number;
  dispatchStaffPayment: number;
  dispatchCastPayment: number;
  dispatchFee: number;
  liquorDeliveryAmount: number;
  cash: CashReconciliation;
  posSnapshot: PosClosingV3;
  submittedAt?: string;
  submittedBy?: string;
  withdrawnAt?: string;
  returnedAt?: string;
  returnReason?: string;
  approvedAt?: string;
  approvedBy?: string;
  updatedAt: string;
};

function storedList<T>(value: unknown): T[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, T>)
      : [];
  return rows.filter((row): row is T => row !== null && row !== undefined);
}

/** Realtime Databaseで保存時に消える空配列を、読込境界で復元する。 */
export function normalizeDailyClosing(value: DailyClosing): DailyClosing {
  return {
    ...value,
    casts: storedList<DailyCast>(value.casts).map((row) => ({
      ...row,
      bottles: storedList<BottleAllocation>(row.bottles),
    })),
    staffWork: storedList<DailyStaffWork>(value.staffWork),
    drivers: storedList<DailyDriverWork>(value.drivers),
    expenses: storedList<DailyExpense>(value.expenses),
  };
}

export type MonthlyAdjustments = {
  month: string;
  withholdingByCast: Record<string, number>;
  staffSalesAllowance: Record<string, number>;
  staffBottleAllowance: Record<string, number>;
  driverRemoteAllowance: Record<string, number>;
  fixedExpenses: { id: string; account: string; amount: number }[];
  liquorDeliveryAmount?: number;
  cardFee: number;
  updatedAt?: string;
  updatedBy?: string;
};

export type WorkspaceData = {
  casts: CastRecord[];
  staff: StaffRecord[];
  drivers: DriverRecord[];
  introducers: IntroducerRecord[];
  liquor: LiquorRecord[];
  closings: DailyClosing[];
  adjustments: MonthlyAdjustments[];
  cashFloat: number;
};

export type CastReward = {
  id: string;
  name: string;
  days: number;
  advisoryDays: number;
  hours: number;
  trialOnly: boolean;
  hourlyPay: number;
  honShimeiSales: number;
  jonaiExtensionSales: number;
  liquorCost: number;
  honShimeiBack: number;
  banaiShimeiBack: number;
  dohanBack: number;
  bottleBack: number;
  drinkBack: number;
  hourlyAndBack: number;
  rewardRate: number;
  salesRewardBase: number;
  salesReward: number;
  adoptedSystem: "hourlyAndBack" | "salesReward";
  adoptedReward: number;
  beautyAllowance: number;
  grossPay: number;
  dailyPayment: number;
  advancePayment: number;
  transportFee: number;
  withholding: number;
  netPay: number;
  introducer?: DailyCast["introducer"];
};

const asNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

export const floorHundred = (value: number) => Math.floor(Math.max(0, value) / 100) * 100;

export function hoursBetweenQuarter(startTime: string, endTime: string, breakMinutes = 0) {
  const parse = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match) return Number.NaN;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const start = parse(startTime);
  let end = parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  if (end < start) end += 1440;
  const minutes = Math.max(0, end - start - Math.max(0, breakMinutes));
  return Math.floor(minutes / 15) / 4;
}

export function rateForMonth(rates: MonthlyRates, month: string) {
  const applicable = Object.entries(rates || {})
    .filter(([key, value]) => key <= month && Number(value) > 0)
    .sort(([left], [right]) => right.localeCompare(left));
  return applicable.length ? Number(applicable[0][1]) : 0;
}

export function rewardRateForSales(amount: number) {
  if (amount >= 8_010_000) return 0.8;
  if (amount >= 6_010_000) return 0.75;
  if (amount >= 4_010_000) return 0.7;
  if (amount >= 2_510_000) return 0.65;
  if (amount >= 1_210_000) return 0.6;
  return 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export async function sha256Checksum(value: Record<string, unknown>) {
  const copy = { ...value };
  delete copy.checksum;
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(copy)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function parsePosClosingV3(input: unknown): Promise<PosClosingV3> {
  assert(input && typeof input === "object", "JSONのルート形式が正しくありません。");
  const value = input as Record<string, unknown>;
  assert(value.schema === "club-genesis-pos-closing", "GMS取込用のPOS JSONではありません。");
  assert(value.schemaVersion === 3, "schemaVersion 3のPOS JSONを使用してください。");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(String(value.businessDate || "")), "営業日の形式が正しくありません。");
  assert(String(value.submissionId || ""), "submissionIdがありません。");
  assert(typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt)), "generatedAtが正しくありません。");
  assert(value.checksumAlgorithm === "sha256", "checksumAlgorithmはsha256である必要があります。");
  assert(value.checksumCanonicalization === "recursive-key-sort-v1", "チェックサム正規化方式が一致しません。");
  assert(/^[0-9a-f]{64}$/.test(String(value.checksum || "")), "SHA-256チェックサムの形式が正しくありません。");
  assert(Array.isArray(value.transactions), "transactionsがありません。");
  assert(Array.isArray(value.castSales), "castSalesがありません。");
  assert(Array.isArray(value.castWork), "castWorkがありません。");
  const checksum = await sha256Checksum(value);
  assert(checksum === value.checksum, "チェックサムが一致しません。POSからJSONを再出力してください。");

  const closing = value as unknown as PosClosingV3;
  const transactionIds = closing.transactions.map((row) => String(row.transactionId || ""));
  assert(transactionIds.every(Boolean) && new Set(transactionIds).size === transactionIds.length, "会計IDの空欄または重複があります。");
  closing.transactions.forEach((transaction) => {
    const splitTotal = (transaction.splits || []).reduce((sum, row) => sum + asNumber(row.amount), 0);
    assert(splitTotal === asNumber(transaction.total), `テーブル${transaction.tableLabel}の決済内訳と会計金額が一致しません。`);
    (transaction.items || []).forEach((item) => {
      const paidBottle = ["champagneWine", "keepBottle"].includes(item.category) && asNumber(item.price) * asNumber(item.quantity) > 0;
      if (paidBottle) {
        assert(item.backTargetCastIds?.length, `「${item.label}」のボトルバック対象がありません。`);
        const expectedAllocation = item.backTargetCastIds.length > 1 ? "equal" : "single";
        assert(item.backAllocation === expectedAllocation, `「${item.label}」のバック配分は${expectedAllocation}である必要があります。`);
      }
      if (item.category === "dohan") {
        assert(item.backTargetCastIds?.length === 1, `テーブル${transaction.tableLabel}の同伴キャストは1名で指定してください。`);
      }
    });
  });
  assert(asNumber(closing.sales.cashSales) + asNumber(closing.sales.cardSales) === asNumber(closing.sales.totalSales), "現金売上とカード売上の合計が総売上と一致しません。");
  closing.castWork.forEach((work) => {
    assert(work.castType === "regular" || work.castType === "trial" || work.castType === "dispatch", `${work.castName}のキャスト区分が不正です。`);
    assert((work.castType === "trial") === Boolean(work.isTrial), `${work.castName}の体入区分が一致しません。`);
    const calculated = hoursBetweenQuarter(work.startTime, work.endTime, work.breakMinutes);
    assert(calculated === asNumber(work.hours), `${work.castName}の勤務時間が出退勤時刻と一致しません。`);
  });
  return closing;
}

export function posCastReferences(closing: PosClosingV3) {
  const rows = new Map<string, { id: string; name: string; kind: CastKind }>();
  const add = (id: unknown, name: unknown, kind: CastKind = "regular") => {
    const key = String(id || "");
    if (!key) return;
    const previous = rows.get(key);
    rows.set(key, {
      id: key,
      name: String(name || previous?.name || ""),
      // castSalesや商品明細から同じ人物が再登場しても、勤務データの体入・派遣区分を失わない。
      kind: previous && kind === "regular" ? previous.kind : kind
    });
  };
  closing.castWork.forEach((row) => add(row.castId, row.castName, row.castType));
  closing.castSales.forEach((row) => add(row.castId, row.castName));
  closing.transactions.forEach((transaction) => transaction.items.forEach((item) => {
    add(item.castId, item.castName);
    (item.backTargetCastIds || []).forEach((id, index) => add(id, item.backTargetCastNames?.[index]));
    item.banaiExtCastIds.forEach((id) => add(id, ""));
  }));
  return [...rows.values()];
}

export function canMapAsDispatch(kind: CastKind) {
  return kind === "trial" || kind === "dispatch";
}

export function isCastMappingComplete(
  references: ReturnType<typeof posCastReferences>,
  mapping: Record<string, string>
) {
  return references.every((source) => {
    const selected = mapping[source.id];
    if (selected === "dispatch") return canMapAsDispatch(source.kind);
    if (source.kind === "dispatch") return false;
    return Boolean(selected);
  });
}

export function requiresBottleCost(item: PosItem, mapping: Record<string, string>) {
  return ["champagneWine", "keepBottle"].includes(item.category)
    && asNumber(item.price) * asNumber(item.quantity) > 0
    && item.backTargetCastIds.some((id) => mapping[id] !== "dispatch");
}

function dohanBack(transaction: PosTransaction) {
  const time = new Date(transaction.startTime).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
  const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  if (minutes <= 20 * 60 + 30) return 3000 + (transaction.items.some((item) => item.isExtension) ? 2000 : 0);
  if (minutes <= 21 * 60) return 2000;
  return 0;
}

export function buildDailyCasts(
  closing: PosClosingV3,
  mapping: Record<string, { masterId: string; name: string; kind: CastKind; hourlyRate: number; introducer?: DailyCast["introducer"] }>,
  liquor: LiquorRecord[],
  specialCosts: Record<string, number>
) {
  const sales = new Map(closing.castSales.map((row) => [row.castId, row]));
  const work = new Map(closing.castWork.map((row) => [row.castId, row]));
  return posCastReferences(closing)
    .filter((source) => source.kind !== "dispatch" && mapping[source.id]?.kind !== "dispatch")
    .map((source): DailyCast => {
    const target = mapping[source.id];
    const shift = work.get(source.id);
    const sale = sales.get(source.id);
    let honCount = 0;
    let banaiCount = 0;
    let dohanCount = 0;
    let dohanAmount = 0;
    let drinkSales = 0;
    const bottles: BottleAllocation[] = [];
    closing.transactions.forEach((transaction) => transaction.items.forEach((item) => {
      const quantity = asNumber(item.quantity) || 1;
      if (item.isHonShimei && item.castId === source.id) honCount += quantity;
      if (item.isBanaiShimei && item.castId === source.id) banaiCount += quantity;
      const targets = item.backTargetCastIds || [];
      if (item.category === "dohan" && targets.includes(source.id)) {
        dohanCount += quantity;
        dohanAmount += dohanBack(transaction) * quantity;
      }
      if (item.category === "castDrink" && targets.includes(source.id)) {
        drinkSales += asNumber(item.price) * quantity / Math.max(1, targets.length);
      }
      if (["champagneWine", "keepBottle"].includes(item.category) && asNumber(item.price) * quantity > 0 && targets.includes(source.id)) {
        const master = liquor.find((row) => row.kind === item.category && row.name === item.label && row.salePrice === asNumber(item.price));
        const costPrice = master?.costPrice ?? specialCosts[item.itemId];
        const divisor = Math.max(1, targets.length);
        bottles.push({
          itemId: item.itemId,
          name: item.label,
          kind: item.category as BottleAllocation["kind"],
          quantity,
          salesAmount: asNumber(item.price) * quantity / divisor,
          costAmount: asNumber(costPrice) * quantity / divisor,
          specialCost: !master
        });
      }
    }));
    const liquorCost = bottles.reduce((sum, row) => sum + row.costAmount, 0);
    return {
      masterId: target?.masterId || "",
      posCastId: source.id,
      name: target?.name || source.name,
      kind: target?.kind || source.kind,
      startTime: shift?.startTime || "",
      endTime: shift?.endTime || "",
      hours: shift ? hoursBetweenQuarter(shift.startTime, shift.endTime, shift.breakMinutes) : 0,
      hourlyRate: target?.hourlyRate || 0,
      honShimeiCount: honCount,
      banaiShimeiCount: banaiCount,
      dohanCount,
      dohanBack: dohanAmount,
      honShimeiSales: floorHundred(asNumber(sale?.honShimeiSales)),
      jonaiExtensionSales: floorHundred(asNumber(sale?.jonaiExtensionSales)),
      drinkSales,
      bottles,
      liquorCost,
      beautyAllowance: 0,
      dailyPayment: source.kind === "trial" ? floorHundred((target?.hourlyRate || 0) * (shift?.hours || 0)) : 0,
      advancePayment: 0,
      transportFee: 0,
      introducer: target?.introducer
    };
    });
}

function bottleBack(rows: BottleAllocation[]) {
  return floorHundred(rows.reduce((sum, row) => {
    const rate = row.kind === "champagneWine" ? 0.25 : 0.15;
    return sum + Math.max(0, row.salesAmount - row.costAmount) * rate;
  }, 0));
}

export function calculateCastRewards(
  closings: DailyClosing[],
  casts: CastRecord[],
  month: string,
  adjustments?: MonthlyAdjustments
): CastReward[] {
  const approved = closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month));
  const castById = new Map(casts.map((row) => [row.id, row]));
  const identity = (row: DailyCast) => {
    const member = castById.get(row.masterId);
    if (member?.convertedToCastId) {
      const converted = castById.get(member.convertedToCastId);
      if (converted?.hiredAt?.startsWith(month)) return converted.id;
    }
    return row.masterId || row.posCastId;
  };
  const grouped = new Map<string, { businessDate: string; row: DailyCast }[]>();
  approved.forEach((closing) => (closing.casts ?? []).forEach((row) => {
    const key = identity(row);
    grouped.set(key, [...(grouped.get(key) || []), { businessDate: closing.businessDate, row }]);
  }));
  return [...grouped.entries()].map(([id, entries]): CastReward => {
    const member = castById.get(id);
    const rows = entries.map((entry) => entry.row);
    const sourceMember = castById.get(rows[0]?.masterId);
    const convertedMember = sourceMember?.convertedToCastId ? castById.get(sourceMember.convertedToCastId) : undefined;
    const trialOnly = rows.every((row) => row.kind === "trial") && !convertedMember?.hiredAt?.startsWith(month);
    const sum = (key: keyof DailyCast) => rows.reduce((total, row) => total + asNumber(row[key]), 0);
    const monthlyRate = rateForMonth(member?.hourlyRates || {}, month);
    const hourlyPay = floorHundred(rows.reduce((total, row) => total + (row.kind === "regular" && monthlyRate > 0 ? monthlyRate : row.hourlyRate) * row.hours, 0));
    const honShimeiSales = sum("honShimeiSales");
    const jonaiExtensionSales = sum("jonaiExtensionSales");
    const liquorCost = sum("liquorCost");
    const honShimeiBack = trialOnly ? 0 : floorHundred(sum("honShimeiCount") * 1000);
    const banaiShimeiBack = trialOnly ? 0 : floorHundred(sum("banaiShimeiCount") * 500);
    const totalDohanBack = trialOnly ? 0 : floorHundred(sum("dohanBack"));
    const totalBottleBack = trialOnly ? 0 : bottleBack(rows.flatMap((row) => row.bottles ?? []));
    const drinkBack = trialOnly ? 0 : floorHundred(sum("drinkSales") * 0.1);
    const hourlyAndBack = floorHundred(hourlyPay + honShimeiBack + banaiShimeiBack + totalDohanBack + totalBottleBack + drinkBack);
    const salesRewardBase = trialOnly ? 0 : floorHundred(Math.max(0, honShimeiSales + jonaiExtensionSales - liquorCost * 0.5));
    const rewardRate = trialOnly ? 0 : rewardRateForSales(salesRewardBase);
    const salesReward = floorHundred(salesRewardBase * rewardRate);
    const adoptedSystem = salesReward > hourlyAndBack ? "salesReward" as const : "hourlyAndBack" as const;
    const adoptedReward = Math.max(hourlyAndBack, salesReward);
    const beautyAllowance = sum("beautyAllowance");
    const grossPay = adoptedReward + beautyAllowance;
    const dailyPayment = sum("dailyPayment");
    const advancePayment = sum("advancePayment");
    const transportFee = sum("transportFee");
    const withholding = asNumber(adjustments?.withholdingByCast?.[id]);
    return {
      id,
      name: member?.name || rows[0]?.name || "名称未設定",
      days: new Set(entries.map((entry) => entry.businessDate)).size,
      advisoryDays: new Set(entries.filter((entry) => entry.row.kind === "regular").map((entry) => entry.businessDate)).size,
      hours: rows.reduce((total, row) => total + row.hours, 0),
      trialOnly,
      hourlyPay,
      honShimeiSales,
      jonaiExtensionSales,
      liquorCost,
      honShimeiBack,
      banaiShimeiBack,
      dohanBack: totalDohanBack,
      bottleBack: totalBottleBack,
      drinkBack,
      hourlyAndBack,
      rewardRate,
      salesRewardBase,
      salesReward,
      adoptedSystem,
      adoptedReward,
      beautyAllowance,
      grossPay,
      dailyPayment,
      advancePayment,
      transportFee,
      withholding,
      netPay: grossPay - dailyPayment - advancePayment - transportFee - withholding,
      introducer: trialOnly ? undefined : rows.find((row) => row.introducer)?.introducer
    };
  }).sort((left, right) => right.honShimeiSales + right.jonaiExtensionSales - (left.honShimeiSales + left.jonaiExtensionSales));
}

export function calculateCash(input: {
  sales: PosClosingV3["sales"];
  cashFloat: number;
  expenses: number;
  regularDailyPayments: number;
  trialDailyPayments: number;
  staffDailyPayments: number;
  dispatchCastPayment: number;
  dispatchStaffPayment: number;
  dispatchFee: number;
  actualClosingCash: number;
}): CashReconciliation {
  const expenseAndPaymentTotal = input.expenses + input.regularDailyPayments + input.trialDailyPayments
    + input.staffDailyPayments + input.dispatchCastPayment + input.dispatchStaffPayment + input.dispatchFee;
  const expectedClosingCash = input.sales.cashSales + input.cashFloat - expenseAndPaymentTotal;
  const cashProfit = expectedClosingCash - input.cashFloat;
  return {
    cashSales: input.sales.cashSales,
    cardSales: input.sales.cardSales,
    totalSales: input.sales.totalSales,
    cashFloat: input.cashFloat,
    expenseAndPaymentTotal,
    expectedClosingCash,
    cashProfit,
    actualClosingCash: input.actualClosingCash,
    difference: input.actualClosingCash - expectedClosingCash
  };
}
