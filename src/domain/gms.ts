export type Role = "shop" | "accounting" | "op";
export type PersonStatus = "active" | "trial" | "departed";
export type CastKind = "regular" | "trial" | "dispatch";
export type ClosingStatus = "submitted" | "returned" | "approved" | "withdrawn";

export function isUnapprovedClosingStatus(
  status: ClosingStatus,
): status is Exclude<ClosingStatus, "approved"> {
  return status === "submitted" || status === "returned" || status === "withdrawn";
}

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
  /** 直前版との原子的な更新競合検査に使う保存済みCAS値。 */
  previousUpdatedAt?: string;
  /** 完全削除後も過去集計の同一人物対応を保持する論理削除情報。 */
  deletedAt?: string;
  deletedBy?: string;
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
  /** 完全削除後も体入→在籍の変換関係を保持する論理削除情報。 */
  deletedAt?: string;
  deletedBy?: string;
};

/** 体入スタッフの採用日は、体入日と同日ではなく翌日以降に限る。 */
export function isStaffHireDateAfterTrial(trialDate: string | undefined, hiredAt: string | undefined) {
  return realBusinessDate(trialDate) && realBusinessDate(hiredAt) && hiredAt > trialDate;
}

/** 日付入力のmin属性に使用する、体入日の翌日。 */
export function dayAfterIsoDate(value: string | undefined) {
  if (!realBusinessDate(value)) return "";
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * 営業日に勤務登録できるスタッフを返す。
 * 旧版で体入日と採用日が同日になっている変換データも、体入当日は体入側だけを候補にする。
 */
export function staffCandidatesForBusinessDate(
  staff: StaffRecord[],
  archivedStaff: StaffRecord[],
  businessDate: string,
) {
  if (!realBusinessDate(businessDate)) return [];
  const staffById = new Map([...archivedStaff, ...staff].map((row) => [row.id, row]));
  return staff.filter((row) => {
    if (row.deletedAt) return false;
    if (row.status === "trial") return row.trialDate === businessDate;
    if (!row.hiredAt || row.hiredAt > businessDate || (row.departedAt && row.departedAt < businessDate)) return false;
    if (row.convertedFromTrialId && row.trialDate === businessDate) return false;
    const sourceTrial = row.convertedFromTrialId ? staffById.get(row.convertedFromTrialId) : undefined;
    return sourceTrial?.trialDate !== businessDate;
  });
}

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
  sales: {
    totalSales: number;
    cashSales: number;
    cardSales: number;
    discountTotal?: number;
    taxServiceTotal?: number;
  };
  customers: { groupCount: number; totalCustomers: number; customerUnitPrice?: number };
  nominations: { honShimeiCount: number; jonaiCount: number };
  transactions: PosTransaction[];
  castSales: PosCastSales[];
  castWork: PosCastWork[];
  enteredCasts: Record<string, unknown>[];
  exitedCasts: Record<string, unknown>[];
  trialCasts: Record<string, unknown>[];
  rosterSnapshot: { complete: boolean; capturedAt: string; casts: Record<string, unknown>[] };
  lifecycleEvents: Record<string, unknown>[];
  source?: Record<string, unknown>;
  submissionId: string;
  generatedAt: string;
  checksumAlgorithm: "sha256";
  checksumCanonicalization: "recursive-key-sort-v1";
  checksum: string;
};

export type BottleAllocation = {
  itemId: string;
  /** POS会計内の商品出現位置。商品IDが別会計で再利用されても一意になる。 */
  sourceKey?: string;
  name: string;
  kind: "champagneWine" | "keepBottle";
  quantity: number;
  salesAmount: number;
  costAmount: number;
  /** 商品1行全体の％バックを100円未満切捨て後、対象人数で均等割りした1人分（1円未満切捨て）。 */
  backAmount?: number;
  specialCost: boolean;
};

/** POSの商品明細1行を、バック対象キャストへ配賦したドリンク売上。 */
export type DrinkAllocation = {
  itemId: string;
  /** POS会計内の商品出現位置。商品IDが別会計で再利用されても一意になる。 */
  sourceKey?: string;
  name: string;
  quantity: number;
  salesAmount: number;
  /** 商品1行全体の10%を100円未満切捨て後、対象人数で均等割りした1人分（1円未満切捨て）。 */
  backAmount?: number;
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
  /** 旧保存データには存在しないため、集約済みdrinkSalesへフォールバックする。 */
  drinkAllocations?: DrinkAllocation[];
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
    attendanceAdvisoryEnabled?: boolean;
    entryAdvisoryEnabled?: boolean;
    attendanceAdvisoryFee: number;
    entryAdvisoryFee: number;
  };
};

/**
 * 紹介者マスタを削除した月だけに適用する、キャスト単位の月次制御履歴。
 * `deleted` は当月の紹介者支払を全額停止し、`reassigned` は削除後に
 * キャストへ設定し直した紹介者条件を当月全体へ遡及適用する。
 */
export type IntroducerMonthEvent = {
  id: string;
  month: string;
  castId: string;
  castName: string;
  state: "deleted" | "reassigned";
  deletedIntroducerId: string;
  deletedIntroducerName: string;
  deletedAt: string;
  deletedBy: string;
  introducer?: NonNullable<DailyCast["introducer"]>;
  reassignedAt?: string;
  /** Firebaseサーバーが確定した再設定時刻（ミリ秒）。旧データでは未設定。 */
  reassignedAtMs?: number;
  reassignedBy?: string;
  /** 体入から在籍化した際に、削除履歴を引き継いだ元キャストID。 */
  sourceCastId?: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  /** Firebaseサーバーが確定した最終イベント保存時刻（ミリ秒）。旧データでは未設定。 */
  updatedAtMs?: number;
  updatedBy: string;
};

/** 紹介者マスタ削除を原子的に証明する月次tombstone。 */
export type IntroducerDeletionCommit = {
  id: string;
  introducerId: string;
  introducerName: string;
  month: string;
  token: string;
  owner: string;
  /** 削除ロックをFirebaseが確定した時刻。削除月の正本。 */
  deletedAtMs: number;
  completedAt: string;
  completedAtMs: number;
  linkedCastIds: string[];
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
  dailyPayment: number;
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
  /** Firebaseサーバーが確定した店舗送信時刻（ミリ秒）。旧データでは未設定。 */
  submittedAtMs?: number;
  submittedBy?: string;
  withdrawnAt?: string;
  returnedAt?: string;
  returnedBy?: string;
  returnedFromStatus?: "submitted" | "approved";
  returnReason?: string;
  approvedAt?: string;
  approvedBy?: string;
  integrityIssues?: string[];
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

function parsedStoredNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .replace(/^[¥￥]\s*/, "")
    .replace(/\s*(?:円|時間|本|杯)$/, "")
    .replace(/[,_\s]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function storedNumber(value: unknown): number {
  return parsedStoredNumber(value) ?? 0;
}

function storedBoolean(value: unknown): boolean {
  if (typeof value === "string") return value.trim().toLowerCase() === "true" || value.trim() === "1";
  return value === true || value === 1;
}

function hasFiniteNumbers(value: unknown, keys: string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return keys.every(
    (key) => typeof record[key] === "number" && Number.isFinite(record[key]),
  );
}

function normalizePosSnapshot(value: PosClosingV3): PosClosingV3 {
  const storedRoster = value.rosterSnapshot && typeof value.rosterSnapshot === "object"
    ? value.rosterSnapshot
    : { complete: false, capturedAt: "", casts: [] };
  return {
    ...value,
    businessDate: String(value.businessDate || ""),
    sales: {
      totalSales: storedNumber(value.sales?.totalSales),
      cashSales: storedNumber(value.sales?.cashSales),
      cardSales: storedNumber(value.sales?.cardSales),
      ...(value.sales?.discountTotal === undefined
        ? {}
        : { discountTotal: storedNumber(value.sales.discountTotal) }),
      ...(value.sales?.taxServiceTotal === undefined
        ? {}
        : { taxServiceTotal: storedNumber(value.sales.taxServiceTotal) }),
    },
    customers: {
      groupCount: storedNumber(value.customers?.groupCount),
      totalCustomers: storedNumber(value.customers?.totalCustomers),
      ...(value.customers?.customerUnitPrice === undefined
        ? {}
        : { customerUnitPrice: storedNumber(value.customers.customerUnitPrice) }),
    },
    nominations: {
      honShimeiCount: storedNumber(value.nominations?.honShimeiCount),
      jonaiCount: storedNumber(value.nominations?.jonaiCount),
    },
    transactions: storedList<PosTransaction>(value.transactions).map((transaction) => ({
      ...transaction,
      splits: storedList<PosTransaction["splits"][number]>(transaction.splits),
      items: storedList<PosItem>(transaction.items).map((item) => ({
        ...item,
        backTargetCastIds: storedList<string>(item.backTargetCastIds),
        backTargetCastNames: storedList<string>(item.backTargetCastNames),
        banaiExtCastIds: storedList<string>(item.banaiExtCastIds),
      })),
    })),
    castSales: storedList<PosCastSales>(value.castSales),
    castWork: storedList<PosCastWork>(value.castWork),
    enteredCasts: storedList<Record<string, unknown>>(value.enteredCasts),
    exitedCasts: storedList<Record<string, unknown>>(value.exitedCasts),
    trialCasts: storedList<Record<string, unknown>>(value.trialCasts),
    rosterSnapshot: {
      ...storedRoster,
      casts: storedList<Record<string, unknown>>(storedRoster.casts),
    },
    lifecycleEvents: storedList<Record<string, unknown>>(value.lifecycleEvents),
  };
}

/** Realtime Databaseで保存時に消える空配列を、読込境界で復元する。 */
export function normalizeDailyClosing(value: DailyClosing): DailyClosing {
  const integrityIssues = storedList<unknown>(value.integrityIssues).map((issue) => String(issue));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.businessDate || ""))) {
    integrityIssues.push("営業日が未設定または不正です。");
  }
  if (!String(value.submissionId || "").trim()) {
    integrityIssues.push("送信IDがありません。店舗から再送してください。");
  }
  if (!/^[0-9a-f]{64}$/.test(String(value.checksum || ""))) {
    integrityIssues.push("POSチェックサムがないか形式が不正です。店舗から再送してください。");
  }
  if (value.submittedAtMs !== undefined
    && (!Number.isSafeInteger(value.submittedAtMs) || value.submittedAtMs < 0)) {
    integrityIssues.push("店舗送信のサーバー保存時刻が不正です。店舗から再送してください。");
  }
  if (!hasFiniteNumbers(value.sales, ["totalSales", "cashSales", "cardSales"])) {
    integrityIssues.push("売上データが不完全です。店舗送信データを確認してください。");
  }
  if (!hasFiniteNumbers(value.cash, ["cashSales", "cardSales", "totalSales", "cashFloat", "expenseAndPaymentTotal", "expectedClosingCash", "cashProfit", "actualClosingCash", "difference"])) {
    integrityIssues.push("現金照合データが不完全です。店舗送信データを確認してください。");
  }
  const normalizeNumericFields = (
    source: Record<string, unknown>,
    keys: string[],
    issueLabel: string,
  ) => {
    const corrected = keys.filter((key) => {
      const parsed = parsedStoredNumber(source[key]);
      return typeof source[key] !== "number" || !Number.isFinite(source[key] as number)
        || parsed === undefined || parsed < 0;
    });
    if (corrected.length) {
      integrityIssues.push(`${issueLabel}の数値データを補正しました（${corrected.join("、")}）。`);
    }
    return Object.fromEntries(keys.map((key) => [key, Math.max(0, storedNumber(source[key]))])) as Record<string, number>;
  };
  const castNumericKeys = [
    "hours", "hourlyRate", "honShimeiCount", "banaiShimeiCount", "dohanCount",
    "dohanBack", "honShimeiSales", "jonaiExtensionSales", "drinkSales", "liquorCost",
    "beautyAllowance", "dailyPayment", "advancePayment", "transportFee",
  ];
  const casts = storedList<unknown>(value.casts).flatMap((candidate, index): DailyCast[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      integrityIssues.push(`キャスト明細${index + 1}件目の形式が不正なため除外しました。`);
      return [];
    }
    const row = candidate as unknown as DailyCast & Record<string, unknown>;
    const label = `キャスト明細「${String(row.name || index + 1)}」`;
    const numeric = normalizeNumericFields(row, castNumericKeys, label);
    const bottles = storedList<unknown>(row.bottles).flatMap((bottleCandidate, bottleIndex): BottleAllocation[] => {
      if (!bottleCandidate || typeof bottleCandidate !== "object" || Array.isArray(bottleCandidate)) {
        integrityIssues.push(`${label}のボトル明細${bottleIndex + 1}件目を除外しました。`);
        return [];
      }
      const bottle = bottleCandidate as BottleAllocation & Record<string, unknown>;
      const bottleNumeric = normalizeNumericFields(
        bottle,
        ["quantity", "salesAmount", "costAmount"],
        `${label}のボトル「${String(bottle.name || bottleIndex + 1)}」`,
      );
      const parsedBackAmount = bottle.backAmount === undefined ? undefined : parsedStoredNumber(bottle.backAmount);
      if (bottle.backAmount !== undefined && (parsedBackAmount === undefined || parsedBackAmount < 0 || !Number.isSafeInteger(parsedBackAmount))) {
        integrityIssues.push(`${label}のボトル「${String(bottle.name || bottleIndex + 1)}」のバック額を1円単位へ補正しました。`);
      }
      return [{
        ...bottle,
        itemId: String(bottle.itemId || ""),
        ...(bottle.sourceKey === undefined ? {} : { sourceKey: String(bottle.sourceKey || "") }),
        name: String(bottle.name || ""),
        quantity: bottleNumeric.quantity,
        salesAmount: bottleNumeric.salesAmount,
        costAmount: bottleNumeric.costAmount,
        ...(bottle.backAmount === undefined ? {} : { backAmount: Math.max(0, Math.floor(parsedBackAmount || 0)) }),
        specialCost: Boolean(bottle.specialCost),
      }];
    });
    const rawDrinkAllocations = row.drinkAllocations;
    const drinkAllocations = rawDrinkAllocations === undefined
      ? undefined
      : storedList<unknown>(rawDrinkAllocations).flatMap((drinkCandidate, drinkIndex): DrinkAllocation[] => {
        if (!drinkCandidate || typeof drinkCandidate !== "object" || Array.isArray(drinkCandidate)) {
          integrityIssues.push(`${label}のドリンク明細${drinkIndex + 1}件目を除外しました。`);
          return [];
        }
        const drink = drinkCandidate as DrinkAllocation & Record<string, unknown>;
        const drinkNumeric = normalizeNumericFields(
          drink,
          ["quantity", "salesAmount"],
          `${label}のドリンク「${String(drink.name || drinkIndex + 1)}」`,
        );
        const parsedBackAmount = drink.backAmount === undefined ? undefined : parsedStoredNumber(drink.backAmount);
        if (drink.backAmount !== undefined && (parsedBackAmount === undefined || parsedBackAmount < 0 || !Number.isSafeInteger(parsedBackAmount))) {
          integrityIssues.push(`${label}のドリンク「${String(drink.name || drinkIndex + 1)}」のバック額を1円単位へ補正しました。`);
        }
        return [{
          itemId: String(drink.itemId || ""),
          ...(drink.sourceKey === undefined ? {} : { sourceKey: String(drink.sourceKey || "") }),
          name: String(drink.name || ""),
          quantity: drinkNumeric.quantity,
          salesAmount: drinkNumeric.salesAmount,
          ...(drink.backAmount === undefined ? {} : { backAmount: Math.max(0, Math.floor(parsedBackAmount || 0)) }),
        }];
      });
    const introducer = row.introducer && typeof row.introducer === "object"
      ? (() => {
          const fees = normalizeNumericFields(
            row.introducer as unknown as Record<string, unknown>,
            ["attendanceAdvisoryFee", "entryAdvisoryFee"],
            `${label}の紹介者情報`,
          );
          return {
            ...row.introducer,
            id: String(row.introducer.id || ""),
            name: String(row.introducer.name || ""),
            ...(row.introducer.attendanceAdvisoryEnabled === undefined
              ? {}
              : { attendanceAdvisoryEnabled: storedBoolean(row.introducer.attendanceAdvisoryEnabled) }),
            ...(row.introducer.entryAdvisoryEnabled === undefined
              ? {}
              : { entryAdvisoryEnabled: storedBoolean(row.introducer.entryAdvisoryEnabled) }),
            attendanceAdvisoryFee: fees.attendanceAdvisoryFee,
            entryAdvisoryFee: fees.entryAdvisoryFee,
          };
        })()
      : undefined;
    return [{
      ...row,
      masterId: String(row.masterId || ""),
      posCastId: String(row.posCastId || ""),
      name: String(row.name || ""),
      startTime: String(row.startTime || ""),
      endTime: String(row.endTime || ""),
      ...numeric,
      bottles,
      ...(drinkAllocations === undefined ? {} : { drinkAllocations }),
      introducer,
    } as DailyCast];
  });
  const staffWork = storedList<unknown>(value.staffWork).flatMap((candidate, index): DailyStaffWork[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      integrityIssues.push(`スタッフ勤務${index + 1}件目の形式が不正なため除外しました。`);
      return [];
    }
    const row = candidate as DailyStaffWork & Record<string, unknown>;
    const numeric = normalizeNumericFields(
      row,
      ["hours", "hourlyRate", "dailyPayment"],
      `スタッフ勤務「${String(row.name || index + 1)}」`,
    );
    return [{
      ...row,
      staffId: String(row.staffId || ""),
      name: String(row.name || ""),
      startTime: String(row.startTime || ""),
      endTime: String(row.endTime || ""),
      ...numeric,
    }];
  });
  const drivers = storedList<unknown>(value.drivers).flatMap((candidate, index): DailyDriverWork[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      integrityIssues.push(`送迎ドライバー勤務${index + 1}件目の形式が不正なため除外しました。`);
      return [];
    }
    const row = candidate as DailyDriverWork & Record<string, unknown>;
    const numeric = normalizeNumericFields(
      row,
      ["dailyRate", "dailyPayment"],
      `送迎ドライバー勤務「${String(row.name || index + 1)}」`,
    );
    return [{
      ...row,
      driverId: String(row.driverId || ""),
      name: String(row.name || ""),
      ...numeric,
    }];
  });
  const expenses = storedList<unknown>(value.expenses).flatMap((candidate, index): DailyExpense[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      integrityIssues.push(`経費明細${index + 1}件目の形式が不正なため除外しました。`);
      return [];
    }
    const row = candidate as DailyExpense & Record<string, unknown>;
    const numeric = normalizeNumericFields(row, ["amount"], `経費明細「${String(row.payee || index + 1)}」`);
    return [{
      ...row,
      id: String(row.id || ""),
      payee: String(row.payee || ""),
      amount: numeric.amount,
      ...(row.personId === undefined ? {} : { personId: String(row.personId || "") }),
      ...(row.personName === undefined ? {} : { personName: String(row.personName || "") }),
    }];
  });
  const reportDuplicateIds = (label: string, ids: string[]) => {
    const duplicates = [...new Set(ids.filter((id, index) => id && ids.indexOf(id) !== index))];
    if (duplicates.length) integrityIssues.push(`${label}が重複しています（${duplicates.join("、")}）。`);
  };
  casts.forEach((row, index) => {
    const label = row.name || `${index + 1}件目`;
    if (row.kind !== "regular" && row.kind !== "trial" && row.kind !== "dispatch") {
      integrityIssues.push(`キャスト明細「${label}」のキャスト区分が不正です。`);
    }
    if (!row.posCastId.trim()) integrityIssues.push(`キャスト明細「${label}」のPOSキャストIDがありません。`);
    if ((row.kind === "regular" || row.kind === "trial") && !row.masterId.trim()) {
      integrityIssues.push(`キャスト明細「${label}」のマスターIDがありません。`);
    }
    if (!row.name.trim()) integrityIssues.push(`キャスト明細${index + 1}件目の名前がありません。`);
  });
  reportDuplicateIds("キャスト明細のPOSキャストID", casts.map((row) => row.posCastId));
  reportDuplicateIds(
    "キャスト明細のマスターID",
    casts.filter((row) => row.kind === "regular" || row.kind === "trial").map((row) => row.masterId),
  );
  staffWork.forEach((row, index) => {
    if (row.kind !== "regular" && row.kind !== "trial") {
      integrityIssues.push(`スタッフ勤務「${row.name || index + 1}件目」のスタッフ区分が不正です。`);
    }
    if (!row.staffId.trim()) integrityIssues.push(`スタッフ勤務「${row.name || index + 1}件目」のスタッフIDがありません。`);
    if (!row.name.trim()) integrityIssues.push(`スタッフ勤務${index + 1}件目の名前がありません。`);
  });
  reportDuplicateIds("スタッフ勤務のスタッフID", staffWork.map((row) => row.staffId));
  drivers.forEach((row, index) => {
    if (!row.driverId.trim()) integrityIssues.push(`送迎ドライバー勤務「${row.name || index + 1}件目」のドライバーIDがありません。`);
    if (!row.name.trim()) integrityIssues.push(`送迎ドライバー勤務${index + 1}件目の名前がありません。`);
  });
  reportDuplicateIds("送迎ドライバー勤務のドライバーID", drivers.map((row) => row.driverId));
  return {
    ...value,
    businessDate: String(value.businessDate || ""),
    sales: {
      totalSales: storedNumber(value.sales?.totalSales),
      cashSales: storedNumber(value.sales?.cashSales),
      cardSales: storedNumber(value.sales?.cardSales),
    },
    customers: {
      groupCount: storedNumber(value.customers?.groupCount),
      totalCustomers: storedNumber(value.customers?.totalCustomers),
      ...(value.customers?.customerUnitPrice === undefined
        ? {}
        : { customerUnitPrice: storedNumber(value.customers.customerUnitPrice) }),
    },
    nominations: {
      honShimeiCount: storedNumber(value.nominations?.honShimeiCount),
      jonaiCount: storedNumber(value.nominations?.jonaiCount),
    },
    cash: {
      cashSales: storedNumber(value.cash?.cashSales),
      cardSales: storedNumber(value.cash?.cardSales),
      totalSales: storedNumber(value.cash?.totalSales),
      cashFloat: storedNumber(value.cash?.cashFloat),
      expenseAndPaymentTotal: storedNumber(value.cash?.expenseAndPaymentTotal),
      expectedClosingCash: storedNumber(value.cash?.expectedClosingCash),
      cashProfit: storedNumber(value.cash?.cashProfit),
      actualClosingCash: storedNumber(value.cash?.actualClosingCash),
      difference: storedNumber(value.cash?.difference),
    },
    casts,
    staffWork,
    drivers,
    expenses,
    staffDailyPaymentTotal: storedNumber(value.staffDailyPaymentTotal),
    dispatchStaffPayment: storedNumber(value.dispatchStaffPayment),
    dispatchCastPayment: storedNumber(value.dispatchCastPayment),
    dispatchFee: storedNumber(value.dispatchFee),
    liquorDeliveryAmount: storedNumber(value.liquorDeliveryAmount),
    integrityIssues: [...new Set(integrityIssues)],
    ...(value.posSnapshot ? { posSnapshot: normalizePosSnapshot(value.posSnapshot) } : {}),
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
  /** posSnapshotがない旧日次データのボトル区分。キーはlegacyBottleSourceKeyで生成する。 */
  legacyBottleClassifications?: Record<string, LegacyBottleClassification>;
  /** 複数端末保存時の競合検知に使用する世代番号。 */
  revision?: number;
  updatedAt?: string;
  updatedBy?: string;
};

export type LegacyBottleClassification = "honShimei" | "jonaiExtension" | "excluded";

function storedNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, amount]) => [
      key,
      storedNumber(amount),
    ]),
  );
}

/** Realtime Databaseの配列・空オブジェクト表現を月次入力の型へ揃える。 */
export function normalizeMonthlyAdjustments(
  value: MonthlyAdjustments,
): MonthlyAdjustments {
  const classifications = value.legacyBottleClassifications;
  const legacyBottleClassifications = classifications && typeof classifications === "object" && !Array.isArray(classifications)
    ? Object.fromEntries(Object.entries(classifications).filter((entry): entry is [string, LegacyBottleClassification] =>
        entry[1] === "honShimei" || entry[1] === "jonaiExtension" || entry[1] === "excluded"))
    : {};
  return {
    ...value,
    month: String(value.month || ""),
    withholdingByCast: storedNumberMap(value.withholdingByCast),
    staffSalesAllowance: storedNumberMap(value.staffSalesAllowance),
    staffBottleAllowance: storedNumberMap(value.staffBottleAllowance),
    driverRemoteAllowance: storedNumberMap(value.driverRemoteAllowance),
    fixedExpenses: storedList<MonthlyAdjustments["fixedExpenses"][number]>(
      value.fixedExpenses,
    ).map((row) => ({
      id: String(row.id || ""),
      account: String(row.account || ""),
      amount: storedNumber(row.amount),
    })),
    cardFee: storedNumber(value.cardFee),
    legacyBottleClassifications,
    revision: Math.max(0, Math.floor(storedNumber(value.revision))),
    ...(value.liquorDeliveryAmount === undefined
      ? {}
      : { liquorDeliveryAmount: storedNumber(value.liquorDeliveryAmount) }),
  };
}

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
  honShimeiLiquorCost: number;
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

export type CastSalesBackBreakdown = {
  key: "honShimei" | "banaiShimei" | "dohan" | "bottle" | "drink";
  label: string;
  amount: number;
};

export type CastSalesBottleSummary = {
  name: string;
  quantity: number;
};

export type CastSalesDay = {
  businessDate: string;
  startTime: string;
  endTime: string;
  hours: number;
  honShimeiSales: number;
  jonaiExtensionSales: number;
  totalSales: number;
  honShimeiLiquorCost: number;
  jonaiExtensionLiquorCost: number;
  totalLiquorCost: number;
  honShimeiCount: number;
  banaiShimeiCount: number;
  nominationCount: number;
  dohanCount: number;
  backs: CastSalesBackBreakdown[];
  backTotal: number;
  bottles: CastSalesBottleSummary[];
  beautyAllowance: number;
};

export type CastSalesTotals = Omit<CastSalesDay, "businessDate" | "startTime" | "endTime"> & {
  attendanceDays: number;
};

export type CastSalesReport = {
  id: string;
  name: string;
  attendanceDays: number;
  days: CastSalesDay[];
  totals: CastSalesTotals;
};

const asNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};
const instantOrderValue = (value: string | undefined) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};
const validServerOrder = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** 店舗保存順。新規データはFirebaseサーバー時刻、旧データだけsubmittedAtへフォールバックする。 */
export function dailyClosingSubmissionOrderValue(closing: Pick<DailyClosing, "submittedAt" | "submittedAtMs">) {
  return validServerOrder(closing.submittedAtMs)
    ? closing.submittedAtMs
    : instantOrderValue(closing.submittedAt);
}

export function hasDailyClosingSubmissionOrder(closing: Pick<DailyClosing, "submittedAt" | "submittedAtMs">) {
  return Number.isFinite(dailyClosingSubmissionOrderValue(closing));
}

export function compareDailyClosingSubmissionOrder(
  left: Pick<DailyClosing, "submittedAt" | "submittedAtMs">,
  right: Pick<DailyClosing, "submittedAt" | "submittedAtMs">,
) {
  const leftValue = dailyClosingSubmissionOrderValue(left);
  const rightValue = dailyClosingSubmissionOrderValue(right);
  return leftValue === rightValue ? 0 : leftValue - rightValue;
}

/** 異なる体入・在籍IDに残ったイベントも、Firebaseで最後に保存されたものを選ぶ。 */
export function compareIntroducerMonthEventSaveOrder(left: IntroducerMonthEvent, right: IntroducerMonthEvent) {
  const leftValue = validServerOrder(left.updatedAtMs) ? left.updatedAtMs : instantOrderValue(left.updatedAt);
  const rightValue = validServerOrder(right.updatedAtMs) ? right.updatedAtMs : instantOrderValue(right.updatedAt);
  return leftValue === rightValue
    ? left.updatedAt.localeCompare(right.updatedAt)
      || left.castId.localeCompare(right.castId)
      || left.revision - right.revision
    : leftValue - rightValue;
}

export function introducerMonthEventEffectiveOrderValue(event: IntroducerMonthEvent) {
  if (event.state === "reassigned" && validServerOrder(event.reassignedAtMs)) return event.reassignedAtMs;
  if (event.state === "deleted" && validServerOrder(event.updatedAtMs)) return event.updatedAtMs;
  return instantOrderValue(event.reassignedAt || event.updatedAt);
}

export function compareIntroducerMonthEventEffectiveOrder(left: IntroducerMonthEvent, right: IntroducerMonthEvent) {
  const leftValue = introducerMonthEventEffectiveOrderValue(left);
  const rightValue = introducerMonthEventEffectiveOrderValue(right);
  return leftValue === rightValue
    ? compareIntroducerMonthEventSaveOrder(left, right)
    : leftValue - rightValue;
}

/**
 * 100円未満を切り捨てる。
 *
 * 0.7 や 0.15 を掛けた結果は、数学上ちょうど100円単位でも
 * 99.99999999999999 のようになることがある。計算機誤差だけを最寄りの整数へ
 * 戻してから切り捨て、実額の端数はそのまま切り捨てる。
 */
export const floorHundred = (value: number) => {
  const hundredUnits = Math.max(0, value) / 100;
  const nearestInteger = Math.round(hundredUnits);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(hundredUnits)) * 8;
  const stableUnits = Math.abs(hundredUnits - nearestInteger) <= floatingPointTolerance
    ? nearestInteger
    : hundredUnits;
  return Math.floor(stableUnits) * 100;
};

/**
 * 商品1行全体の％バックを先に100円単位へ切り捨ててから均等割りする。
 * 割り切れない1円未満は各人で切り捨て、余りは誰にも上乗せしない。
 */
export function splitItemBackPerTarget(totalEligibleAmount: number, rate: number, targetCount: number) {
  if (!Number.isSafeInteger(targetCount) || targetCount <= 0) return 0;
  return Math.floor(floorHundred(Math.max(0, totalEligibleAmount) * rate) / targetCount);
}

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

/** ISO日時を営業拠点（Asia/Tokyo）のYYYY-MMへ変換する。月初のUTC/JST差を残さない。 */
export function japanMonthFromTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("日時が正しくありません。");
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("日時を対象月へ変換できません。");
  return `${year}-${month.padStart(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  assert(isRecord(value), `${label}の形式が正しくありません。`);
  return value;
}

function requiredArray(record: Record<string, unknown>, key: string, label = key): unknown[] {
  assert(Array.isArray(record[key]), `${label}が配列ではないか、存在しません。`);
  return record[key];
}

function finiteNonNegative(
  record: Record<string, unknown>,
  key: string,
  label: string,
  options: { optional?: boolean; positive?: boolean } = {},
) {
  if (options.optional && record[key] === undefined) return undefined;
  const value = record[key];
  assert(typeof value === "number" && Number.isFinite(value), `${label}は有限の数値で指定してください。`);
  assert(options.positive ? value > 0 : value >= 0, `${label}は${options.positive ? "0より大きい" : "0以上の"}数値で指定してください。`);
  return value;
}

function realBusinessDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validClockTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
}

function validInstant(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function assertUniqueRequiredIds(values: unknown[], label: string) {
  assert(values.every((value) => typeof value === "string" && value.length > 0), `${label}に空または文字列以外のIDがあります。`);
  assert(new Set(values).size === values.length, `${label}に重複したIDがあります。`);
}

export async function parsePosClosingV3(input: unknown): Promise<PosClosingV3> {
  const value = requiredRecord(input, "JSONのルート");
  assert(value.schema === "club-genesis-pos-closing", "GMS取込用のPOS JSONではありません。");
  assert(value.schemaVersion === 3, "schemaVersion 3のPOS JSONを使用してください。");
  assert(realBusinessDate(value.businessDate), "営業日が実在しないか、YYYY-MM-DD形式ではありません。");
  assert(typeof value.submissionId === "string" && value.submissionId.trim().length > 0, "submissionIdがありません。");
  assert(validInstant(value.generatedAt), "generatedAtが正しくありません。");
  assert(value.checksumAlgorithm === "sha256", "checksumAlgorithmはsha256である必要があります。");
  assert(value.checksumCanonicalization === "recursive-key-sort-v1", "チェックサム正規化方式が一致しません。");
  assert(/^[0-9a-f]{64}$/.test(String(value.checksum || "")), "SHA-256チェックサムの形式が正しくありません。");
  const transactionValues = requiredArray(value, "transactions");
  const castSalesValues = requiredArray(value, "castSales");
  const castWorkValues = requiredArray(value, "castWork");
  const enteredCastValues = requiredArray(value, "enteredCasts");
  const exitedCastValues = requiredArray(value, "exitedCasts");
  const trialCastValues = requiredArray(value, "trialCasts");
  const lifecycleEventValues = requiredArray(value, "lifecycleEvents");
  const rosterSnapshot = requiredRecord(value.rosterSnapshot, "rosterSnapshot");
  const rosterCastValues = requiredArray(rosterSnapshot, "casts", "rosterSnapshot.casts");

  // ネスト配列を先に検証し、不完全なJSONを後続処理で参照してクラッシュさせない。
  transactionValues.forEach((candidate, transactionIndex) => {
    const transaction = requiredRecord(candidate, `transactions[${transactionIndex}]`);
    requiredArray(transaction, "splits", `transactions[${transactionIndex}].splits`)
      .forEach((split, splitIndex) => requiredRecord(split, `transactions[${transactionIndex}].splits[${splitIndex}]`));
    requiredArray(transaction, "items", `transactions[${transactionIndex}].items`)
      .forEach((candidateItem, itemIndex) => {
        const item = requiredRecord(candidateItem, `transactions[${transactionIndex}].items[${itemIndex}]`);
        requiredArray(item, "backTargetCastIds", `transactions[${transactionIndex}].items[${itemIndex}].backTargetCastIds`);
        requiredArray(item, "backTargetCastNames", `transactions[${transactionIndex}].items[${itemIndex}].backTargetCastNames`);
        requiredArray(item, "banaiExtCastIds", `transactions[${transactionIndex}].items[${itemIndex}].banaiExtCastIds`);
      });
  });
  castSalesValues.forEach((row, index) => requiredRecord(row, `castSales[${index}]`));
  castWorkValues.forEach((row, index) => requiredRecord(row, `castWork[${index}]`));
  enteredCastValues.forEach((row, index) => requiredRecord(row, `enteredCasts[${index}]`));
  exitedCastValues.forEach((row, index) => requiredRecord(row, `exitedCasts[${index}]`));
  trialCastValues.forEach((row, index) => requiredRecord(row, `trialCasts[${index}]`));
  lifecycleEventValues.forEach((row, index) => requiredRecord(row, `lifecycleEvents[${index}]`));
  rosterCastValues.forEach((row, index) => requiredRecord(row, `rosterSnapshot.casts[${index}]`));

  const checksum = await sha256Checksum(value);
  assert(checksum === value.checksum, "チェックサムが一致しません。POSからJSONを再出力してください。");

  const closing = value as unknown as PosClosingV3;
  assert(validInstant(rosterSnapshot.capturedAt), "rosterSnapshot.capturedAtが正しくありません。");
  enteredCastValues.forEach((candidate, index) => {
    const row = candidate as Record<string, unknown>;
    finiteNonNegative(row, "enteredAt", `enteredCasts[${index}]の入店時刻`);
  });
  exitedCastValues.forEach((candidate, index) => {
    const row = candidate as Record<string, unknown>;
    finiteNonNegative(row, "exitedAt", `exitedCasts[${index}]の退店時刻`);
  });
  trialCastValues.forEach((candidate, index) => {
    const row = candidate as Record<string, unknown>;
    finiteNonNegative(row, "trialRegisteredAt", `trialCasts[${index}]の体入登録時刻`);
    finiteNonNegative(row, "trialEndedAt", `trialCasts[${index}]の体入終了時刻`);
    assert(realBusinessDate(row.trialBizDay), `trialCasts[${index}]の体入営業日が不正です。`);
  });
  lifecycleEventValues.forEach((candidate, index) => {
    const row = candidate as Record<string, unknown>;
    assert(validInstant(row.eventAt), `lifecycleEvents[${index}]の発生時刻が不正です。`);
    assert(realBusinessDate(row.entryDate), `lifecycleEvents[${index}]の営業日が不正です。`);
  });
  const sales = requiredRecord(value.sales, "sales");
  finiteNonNegative(sales, "totalSales", "総売上");
  finiteNonNegative(sales, "cashSales", "現金売上");
  finiteNonNegative(sales, "cardSales", "カード売上");
  finiteNonNegative(sales, "discountTotal", "値引合計", { optional: true });
  finiteNonNegative(sales, "taxServiceTotal", "税・サービス料合計", { optional: true });
  const customers = requiredRecord(value.customers, "customers");
  finiteNonNegative(customers, "groupCount", "組数");
  finiteNonNegative(customers, "totalCustomers", "来店人数");
  finiteNonNegative(customers, "customerUnitPrice", "客単価", { optional: true });
  const nominations = requiredRecord(value.nominations, "nominations");
  finiteNonNegative(nominations, "honShimeiCount", "本指名本数");
  finiteNonNegative(nominations, "jonaiCount", "場内指名本数");

  if (value.source !== undefined) {
    const source = requiredRecord(value.source, "source");
    const businessStartedAt = finiteNonNegative(source, "businessStartedAt", "営業開始時刻", { optional: true });
    const businessEndedAt = finiteNonNegative(source, "businessEndedAt", "営業終了時刻", { optional: true });
    if (businessStartedAt !== undefined && businessEndedAt !== undefined) {
      assert(businessEndedAt >= businessStartedAt, "営業終了時刻が営業開始時刻より前です。");
    }
  }

  const transactionIds = closing.transactions.map((row) => String(row.transactionId || ""));
  assert(closing.transactions.every((row) => typeof row.transactionId === "string" && row.transactionId.length > 0)
    && new Set(transactionIds).size === transactionIds.length, "会計IDの空欄、型不正または重複があります。");
  let transactionTotal = 0;
  let cashSplitTotal = 0;
  let cardSplitTotal = 0;
  closing.transactions.forEach((transaction) => {
    const transactionRecord = transaction as unknown as Record<string, unknown>;
    finiteNonNegative(transactionRecord, "startTime", `テーブル${transaction.tableLabel}の開始時刻`);
    finiteNonNegative(transactionRecord, "endTime", `テーブル${transaction.tableLabel}の終了時刻`);
    assert(transaction.endTime >= transaction.startTime, `テーブル${transaction.tableLabel}の終了時刻が開始時刻より前です。`);
    finiteNonNegative(transactionRecord, "subtotal", `テーブル${transaction.tableLabel}の小計`);
    finiteNonNegative(transactionRecord, "discount", `テーブル${transaction.tableLabel}の値引額`);
    finiteNonNegative(transactionRecord, "tax", `テーブル${transaction.tableLabel}の税・サービス料`);
    finiteNonNegative(transactionRecord, "total", `テーブル${transaction.tableLabel}の会計金額`);
    finiteNonNegative(transactionRecord, "guests", `テーブル${transaction.tableLabel}の人数`, { optional: true });
    // 金額分類はPOS実データのsplits.method（cash/card）を正とし、表示用payMethodは空欄だけを拒否する。
    assert(typeof transaction.payMethod === "string" && transaction.payMethod.trim().length > 0, `テーブル${transaction.tableLabel}の決済方法が不正です。`);
    const splitTotal = transaction.splits.reduce((sum, row, splitIndex) => {
      const split = row as unknown as Record<string, unknown>;
      const amount = finiteNonNegative(split, "amount", `テーブル${transaction.tableLabel}の決済内訳${splitIndex + 1}件目`) ?? 0;
      assert(row.method === "cash" || row.method === "card", `テーブル${transaction.tableLabel}の決済内訳に未対応の方法があります。`);
      if (row.method === "cash") cashSplitTotal += amount;
      if (row.method === "card") cardSplitTotal += amount;
      return sum + amount;
    }, 0);
    assert(splitTotal === transaction.total, `テーブル${transaction.tableLabel}の決済内訳と会計金額が一致しません。`);
    transactionTotal += transaction.total;
    const itemIds = transaction.items.map((item) => String(item.itemId || ""));
    assert(transaction.items.every((item) => typeof item.itemId === "string" && item.itemId.length > 0)
      && new Set(itemIds).size === itemIds.length, `テーブル${transaction.tableLabel}の商品IDに空欄、型不正または重複があります。`);
    transaction.items.forEach((item) => {
      const itemRecord = item as unknown as Record<string, unknown>;
      finiteNonNegative(itemRecord, "price", `「${item.label}」の商品金額`);
      const bottle = ["champagneWine", "keepBottle"].includes(item.category);
      finiteNonNegative(itemRecord, "quantity", `「${item.label}」の商品数量`, { positive: bottle });
      finiteNonNegative(itemRecord, "roomMinutes", `「${item.label}」のルーム時間`, { optional: true });
      finiteNonNegative(itemRecord, "freeDrinkMinutes", `「${item.label}」のフリードリンク時間`, { optional: true });
      const bottleTargets = item.backTargetCastIds;
      assertUniqueRequiredIds(bottleTargets, `「${item.label}」のバック対象ID`);
      assertUniqueRequiredIds(item.banaiExtCastIds, `「${item.label}」の場内延長対象ID`);
      assert(item.backTargetCastNames.length === bottleTargets.length, `「${item.label}」のバック対象IDと対象名の件数が一致しません。`);
      assert(item.backTargetCastNames.every((name) => typeof name === "string"), `「${item.label}」のバック対象名に文字列以外の値があります。`);
      const paidBottle = bottle && item.price * item.quantity > 0;
      if (paidBottle && bottleTargets.length) {
        const eligibleTargets = new Set(bottleBackContextCastIds(transaction, item));
        assert(
          bottleTargets.every((id) => eligibleTargets.has(id)),
          `「${item.label}」のボトルバック対象に本指名・場内延長対象外のキャストが含まれています。`
        );
        const expectedAllocation = bottleTargets.length > 1 ? "equal" : "single";
        assert(item.backAllocation === expectedAllocation, `「${item.label}」のバック配分は${expectedAllocation}である必要があります。`);
      }
      if (item.category === "dohan") {
        assert(item.backTargetCastIds.length === 1, `テーブル${transaction.tableLabel}の同伴キャストは1名で指定してください。`);
      }
    });
  });
  assert(transactionTotal === closing.sales.totalSales, "会計データの合計と総売上が一致しません。");
  assert(cashSplitTotal === closing.sales.cashSales, "現金の決済内訳合計と現金売上が一致しません。");
  assert(cardSplitTotal === closing.sales.cardSales, "カードの決済内訳合計とカード売上が一致しません。");
  assert(closing.sales.cashSales + closing.sales.cardSales === closing.sales.totalSales, "現金売上とカード売上の合計が総売上と一致しません。");

  const workIds = closing.castWork.map((work) => String(work.castId || ""));
  assert(closing.castWork.every((work) => typeof work.castId === "string" && work.castId.length > 0)
    && new Set(workIds).size === workIds.length, "キャスト勤務IDの空欄、型不正または重複があります。");
  assert(closing.castWork.every((work) => typeof work.castName === "string" && work.castName.trim().length > 0), "キャスト勤務に名前の空欄または型不正があります。");
  const castSalesIds = closing.castSales.map((sale) => String(sale.castId || ""));
  assert(closing.castSales.every((sale) => typeof sale.castId === "string" && sale.castId.length > 0)
    && new Set(castSalesIds).size === castSalesIds.length, "キャスト売上IDの空欄、型不正または重複があります。");
  const workIdSet = new Set(workIds);
  const workNameById = new Map(closing.castWork.map((work) => [work.castId, work.castName]));
  assert(castSalesIds.every((id) => workIdSet.has(id)), "キャスト売上に勤務記録のないキャストが含まれています。");
  assert(closing.castSales.every((sale) => typeof sale.castName === "string" && workNameById.get(sale.castId) === sale.castName), "キャスト売上のIDと名前が勤務記録に一致しません。");
  closing.castSales.forEach((sale) => {
    const saleRecord = sale as unknown as Record<string, unknown>;
    finiteNonNegative(saleRecord, "honShimeiSales", `${sale.castName}の本指名売上`);
    finiteNonNegative(saleRecord, "jonaiExtensionSales", `${sale.castName}の場内延長売上`);
    finiteNonNegative(saleRecord, "jonaiExtensionBackSales", `${sale.castName}の場内延長バック売上`, { optional: true });
    finiteNonNegative(saleRecord, "drinkSales", `${sale.castName}のドリンク売上`);
    finiteNonNegative(saleRecord, "totalAttributedSales", `${sale.castName}の売上帰属合計`);
  });
  closing.castWork.forEach((work) => {
    const workRecord = work as unknown as Record<string, unknown>;
    assert(work.castType === "regular" || work.castType === "trial" || work.castType === "dispatch", `${work.castName}のキャスト区分が不正です。`);
    assert((work.castType === "trial") === Boolean(work.isTrial), `${work.castName}の体入区分が一致しません。`);
    assert(validClockTime(work.startTime) && validClockTime(work.endTime), `${work.castName}の出退勤時刻がHH:mm形式ではありません。`);
    finiteNonNegative(workRecord, "breakMinutes", `${work.castName}の休憩時間`);
    finiteNonNegative(workRecord, "hours", `${work.castName}の勤務時間`);
    const calculated = hoursBetweenQuarter(work.startTime, work.endTime, work.breakMinutes);
    assert(calculated === work.hours, `${work.castName}の勤務時間が出退勤時刻と一致しません。`);
  });
  closing.transactions.forEach((transaction) => transaction.items.forEach((item) => {
    const ids = [...item.backTargetCastIds, ...item.banaiExtCastIds, ...(item.castId ? [item.castId] : [])];
    assert(ids.every((id) => workIdSet.has(id)), `「${item.label}」に勤務記録のないキャストIDが含まれています。`);
    if (item.castId) {
      assert(typeof item.castName === "string" && workNameById.get(item.castId) === item.castName, `「${item.label}」のキャストIDと名前が勤務記録に一致しません。`);
    }
    item.backTargetCastIds.forEach((id, index) => {
      assert(workNameById.get(id) === item.backTargetCastNames[index], `「${item.label}」のバック対象IDと名前が勤務記録に一致しません。`);
    });
  }));
  return closing;
}

function uniqueCastIds(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
}

/**
 * ボトルバック対象になれるキャストを、POSの売上帰属と同じ卓内ルールで求める。
 * 本指名卓は本指名キャスト、フリー卓は当該ボトルより前に開始した場内延長キャストだけが対象。
 */
function bottleBackContextCastIds(transaction: PosTransaction, bottle: PosItem) {
  const items = transaction.items || [];
  const honShimeiCastIds = uniqueCastIds(items
    .filter((item) => item.isHonShimei)
    .map((item) => item.castId));
  if (honShimeiCastIds.length) return honShimeiCastIds;

  let banaiExtensionCastIds: string[] = [];
  for (const item of items) {
    if (item.isBanaiExtension) {
      banaiExtensionCastIds = uniqueCastIds([...(item.banaiExtCastIds || []), item.castId]);
    }
    if (item === bottle) return banaiExtensionCastIds;
  }
  return [];
}

function effectiveBottleBackTargets(transaction: PosTransaction, item: PosItem) {
  const eligibleTargets = new Set(bottleBackContextCastIds(transaction, item));
  return (item.backTargetCastIds || []).filter((id) => eligibleTargets.has(id));
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
    const targetIds = ["champagneWine", "keepBottle"].includes(item.category)
      ? effectiveBottleBackTargets(transaction, item)
      : (item.backTargetCastIds || []);
    targetIds.forEach((id) => {
      const nameIndex = (item.backTargetCastIds || []).indexOf(id);
      add(id, item.backTargetCastNames?.[nameIndex]);
    });
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

export function requiresBottleCost(transaction: PosTransaction, item: PosItem, mapping: Record<string, string>) {
  return ["champagneWine", "keepBottle"].includes(item.category)
    && asNumber(item.price) * asNumber(item.quantity) > 0
    && effectiveBottleBackTargets(transaction, item).some((id) => mapping[id] !== "dispatch");
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
    .filter((source) => work.has(source.id) && source.kind !== "dispatch" && mapping[source.id]?.kind !== "dispatch")
    .map((source): DailyCast => {
    const target = mapping[source.id];
    const shift = work.get(source.id);
    const sale = sales.get(source.id);
    let honCount = 0;
    let banaiCount = 0;
    let dohanCount = 0;
    let dohanAmount = 0;
    let drinkSales = 0;
    const drinkAllocations: DrinkAllocation[] = [];
    const bottles: BottleAllocation[] = [];
    closing.transactions.forEach((transaction) => transaction.items.forEach((item, itemIndex) => {
      const quantity = asNumber(item.quantity);
      if (item.isHonShimei && item.castId === source.id) honCount += quantity;
      if (item.isBanaiShimei && item.castId === source.id) banaiCount += quantity;
      const targets = ["champagneWine", "keepBottle"].includes(item.category)
        ? effectiveBottleBackTargets(transaction, item)
        : (item.backTargetCastIds || []);
      if (item.category === "dohan" && targets.includes(source.id)) {
        dohanCount += quantity;
        dohanAmount += dohanBack(transaction) * quantity;
      }
      if (item.category === "castDrink" && targets.includes(source.id)) {
        const divisor = Math.max(1, targets.length);
        const salesAmount = asNumber(item.price) * quantity / divisor;
        drinkSales += salesAmount;
        drinkAllocations.push({
          itemId: item.itemId,
          sourceKey: posItemOccurrenceKey(transaction, itemIndex),
          name: item.label,
          quantity,
          salesAmount,
          backAmount: splitItemBackPerTarget(asNumber(item.price) * quantity, 0.1, divisor),
        });
      }
      if (["champagneWine", "keepBottle"].includes(item.category) && asNumber(item.price) * quantity > 0 && targets.includes(source.id)) {
        const master = liquor.find((row) => row.kind === item.category && row.name === item.label && row.salePrice === asNumber(item.price));
        const sourceKey = posItemOccurrenceKey(transaction, itemIndex);
        const costPrice = master?.costPrice ?? specialCosts[sourceKey];
        const divisor = Math.max(1, targets.length);
        const totalSalesAmount = asNumber(item.price) * quantity;
        const totalCostAmount = asNumber(costPrice) * quantity;
        const rate = item.category === "champagneWine" ? 0.25 : 0.15;
        bottles.push({
          itemId: item.itemId,
          sourceKey,
          name: item.label,
          kind: item.category as BottleAllocation["kind"],
          quantity,
          salesAmount: totalSalesAmount / divisor,
          costAmount: totalCostAmount / divisor,
          backAmount: splitItemBackPerTarget(totalSalesAmount - totalCostAmount, rate, divisor),
          specialCost: !master
        });
      }
    }));
    const liquorCost = bottles.reduce((sum, row) => sum + row.costAmount, 0);
    const roundedHours = shift ? hoursBetweenQuarter(shift.startTime, shift.endTime, shift.breakMinutes) : 0;
    return {
      masterId: target?.masterId || "",
      posCastId: source.id,
      name: target?.name || source.name,
      kind: target?.kind || source.kind,
      startTime: shift?.startTime || "",
      endTime: shift?.endTime || "",
      hours: roundedHours,
      hourlyRate: target?.hourlyRate || 0,
      honShimeiCount: honCount,
      banaiShimeiCount: banaiCount,
      dohanCount,
      dohanBack: dohanAmount,
      honShimeiSales: floorHundred(asNumber(sale?.honShimeiSales)),
      jonaiExtensionSales: floorHundred(asNumber(sale?.jonaiExtensionSales)),
      drinkSales,
      drinkAllocations,
      bottles,
      liquorCost,
      beautyAllowance: 0,
      dailyPayment: source.kind === "trial" ? floorHundred((target?.hourlyRate || 0) * roundedHours) : 0,
      advancePayment: 0,
      transportFee: 0,
      introducer: target?.introducer
    };
    });
}

function bottleBack(rows: BottleAllocation[]) {
  return rows.reduce((sum, row) => {
    if (row.backAmount !== undefined) return sum + Math.max(0, Math.floor(asNumber(row.backAmount)));
    const rate = row.kind === "champagneWine" ? 0.25 : 0.15;
    return sum + floorHundred(Math.max(0, row.salesAmount - row.costAmount) * rate);
  }, 0);
}

/**
 * 新データはPOS商品1行ごと、明細を持たない旧データは従来どおり集約売上へ10%を掛ける。
 * 新旧データが同月に混在しても、旧集約値を二重計上しない。
 */
function drinkBack(rows: DailyCast[]) {
  let itemizedBack = 0;
  let legacyDrinkSales = 0;
  rows.forEach((row) => {
    if (Array.isArray(row.drinkAllocations) && row.drinkAllocations.length > 0) {
      itemizedBack += row.drinkAllocations.reduce(
        (sum, allocation) => sum + (allocation.backAmount === undefined
          ? floorHundred(asNumber(allocation.salesAmount) * 0.1)
          : Math.max(0, Math.floor(asNumber(allocation.backAmount)))),
        0,
      );
    } else {
      legacyDrinkSales += asNumber(row.drinkSales);
    }
  });
  return itemizedBack + floorHundred(legacyDrinkSales * 0.1);
}

export type UnclassifiedLegacyBottle = {
  sourceKey: string;
  closingId: string;
  businessDate: string;
  castId: string;
  castName: string;
  bottleIndex: number;
  bottle: BottleAllocation;
};

/**
 * Firebaseキーとして利用できる形で、旧ボトルの保存元リビジョンと明細位置を一意化する。
 * 各要素を個別にencodeURIComponentするため、ID等に区切り文字が含まれても衝突しない。
 */
export function legacyBottleSourceKey(
  closing: Pick<DailyClosing, "id" | "updatedAt" | "checksum">,
  row: Pick<DailyCast, "posCastId">,
  bottleIndex: number,
) {
  return [closing.id, closing.updatedAt || "", closing.checksum || "", row.posCastId, bottleIndex]
    .map(firebaseKeyPart)
    .join("|");
}

function firebaseKeyPart(value: unknown) {
  return encodeURIComponent(String(value)).replace(/\./g, "%2E");
}

/** POSの商品IDではなく、会計と配列位置を含めた商品出現単位の一意キー。 */
export function posItemOccurrenceKey(transaction: Pick<PosTransaction, "transactionId" | "items">, itemIndex: number) {
  const itemId = transaction.items[itemIndex]?.itemId || "";
  return [transaction.transactionId, itemIndex, itemId].map(firebaseKeyPart).join("|");
}

/** 保存済みの1人分原価から商品単価を復元し、POS商品行の正しい1人分バックを返す。 */
export function bottleBackAmountFromPosItem(
  item: Pick<PosItem, "category" | "price" | "quantity">,
  allocation: Pick<BottleAllocation, "quantity" | "costAmount">,
  targetCount: number,
) {
  const allocationQuantity = asNumber(allocation.quantity);
  const unitCost = allocationQuantity > 0
    ? Math.round(asNumber(allocation.costAmount) * targetCount / allocationQuantity)
    : 0;
  const totalCostAmount = unitCost * asNumber(item.quantity);
  const rate = item.category === "champagneWine" ? 0.25 : 0.15;
  return splitItemBackPerTarget(
    asNumber(item.price) * asNumber(item.quantity) - totalCostAmount,
    rate,
    targetCount,
  );
}

/**
 * 旧保存形式の再編集時に、保存済みの手当・控除等は維持したまま、
 * POS原本から商品出現キーと新しい1人分バック額だけを復元する。
 */
export function restoreDailyCastBackMetadata(closing: PosClosingV3, rows: DailyCast[]) {
  return rows.map((row): DailyCast => {
    const bottleOccurrences = closing.transactions.flatMap((transaction) =>
      transaction.items.flatMap((item, itemIndex) => {
        if (!["champagneWine", "keepBottle"].includes(item.category)
          || asNumber(item.price) * asNumber(item.quantity) <= 0) return [];
        const targets = effectiveBottleBackTargets(transaction, item);
        if (!targets.includes(row.posCastId)) return [];
        return [{ item, sourceKey: posItemOccurrenceKey(transaction, itemIndex), targetCount: targets.length }];
      }));
    const claimed = new Set<string>();
    const bottles = (row.bottles || []).map((bottle) => {
      const occurrence = (bottle.sourceKey
        ? bottleOccurrences.find((candidate) => candidate.sourceKey === bottle.sourceKey)
        : undefined)
        || bottleOccurrences.find((candidate) => !claimed.has(candidate.sourceKey)
          && candidate.item.itemId === bottle.itemId
          && candidate.item.label === bottle.name
          && candidate.item.category === bottle.kind);
      if (!occurrence) return bottle;
      claimed.add(occurrence.sourceKey);
      return {
        ...bottle,
        sourceKey: occurrence.sourceKey,
        backAmount: bottleBackAmountFromPosItem(occurrence.item, bottle, occurrence.targetCount),
      };
    });
    const drinkAllocations = closing.transactions.flatMap((transaction) =>
      transaction.items.flatMap((item, itemIndex): DrinkAllocation[] => {
        const targets = item.backTargetCastIds || [];
        if (item.category !== "castDrink" || !targets.includes(row.posCastId)) return [];
        const divisor = Math.max(1, targets.length);
        const salesAmount = asNumber(item.price) * asNumber(item.quantity) / divisor;
        return [{
          itemId: item.itemId,
          sourceKey: posItemOccurrenceKey(transaction, itemIndex),
          name: item.label,
          quantity: asNumber(item.quantity),
          salesAmount,
          backAmount: splitItemBackPerTarget(asNumber(item.price) * asNumber(item.quantity), 0.1, divisor),
        }];
      }));
    return {
      ...row,
      bottles,
      drinkSales: drinkAllocations.reduce((sum, drink) => sum + drink.salesAmount, 0),
      drinkAllocations,
    };
  });
}

function hasAttributablePosSnapshot(closing: DailyClosing) {
  return Array.isArray(closing.posSnapshot?.transactions) && closing.posSnapshot.transactions.length > 0;
}

/** 承認済み旧データのうち、経理による手動区分がまだないボトル明細を返す。 */
export function findUnclassifiedLegacyBottles(
  closings: DailyClosing[],
  month: string,
  adjustments?: MonthlyAdjustments,
): UnclassifiedLegacyBottle[] {
  const classifications = adjustments?.legacyBottleClassifications || {};
  return closings
    .filter((closing) => closing.status === "approved"
      && closing.businessDate.startsWith(month)
      && !hasAttributablePosSnapshot(closing))
    .flatMap((closing) => (closing.casts || []).flatMap((row) =>
      (row.bottles || []).flatMap((bottle, bottleIndex) => {
        const sourceKey = legacyBottleSourceKey(closing, row, bottleIndex);
        return classifications[sourceKey] ? [] : [{
          sourceKey,
          closingId: closing.id,
          businessDate: closing.businessDate,
          castId: row.masterId || row.posCastId,
          castName: row.name,
          bottleIndex,
          bottle,
        }];
      })));
}

function bottleAllocationsBySalesType(
  closing: DailyClosing,
  row: DailyCast,
  adjustments?: MonthlyAdjustments,
) {
  const transactions = closing.posSnapshot?.transactions || [];
  if (!transactions.length) {
    // 旧データは売上額から推測しない。未分類・対象外は報酬計算へ一切含めない。
    return (row.bottles || []).reduce((result, bottle, bottleIndex) => {
      const sourceKey = legacyBottleSourceKey(closing, row, bottleIndex);
      const classification = adjustments?.legacyBottleClassifications?.[sourceKey];
      if (classification === "honShimei" || classification === "jonaiExtension") {
        result[classification].push(bottle);
      }
      return result;
    }, { honShimei: [] as BottleAllocation[], jonaiExtension: [] as BottleAllocation[] });
  }
  type BottleAttribution = {
    sourceKey: string;
    attribution: "honShimei" | "jonaiExtension" | undefined;
    item: PosItem;
    targetCount: number;
    claimed: boolean;
  };
  const attributionBySourceKey = new Map<string, BottleAttribution>();
  const attributionByItemId = new Map<string, BottleAttribution[]>();
  transactions.forEach((transaction) => {
    const honShimei = (transaction.items || []).some((item) => item.isHonShimei);
    (transaction.items || []).forEach((item, itemIndex) => {
      if (!["champagneWine", "keepBottle"].includes(item.category)) return;
      // 同じ銘柄が複数卓で注文されても、保存済みのボトル明細と注文順に対応させる。
      if (!(item.backTargetCastIds || []).includes(row.posCastId)) return;
      const eligible = bottleBackContextCastIds(transaction, item).includes(row.posCastId);
      const attribution: BottleAttribution["attribution"] = eligible
        ? (honShimei ? "honShimei" : "jonaiExtension")
        : undefined;
      const sourceKey = posItemOccurrenceKey(transaction, itemIndex);
      const record: BottleAttribution = {
        sourceKey,
        attribution,
        item,
        targetCount: effectiveBottleBackTargets(transaction, item).length,
        claimed: false,
      };
      attributionBySourceKey.set(sourceKey, record);
      attributionByItemId.set(item.itemId, [...(attributionByItemId.get(item.itemId) || []), record]);
    });
  });
  return (row.bottles || []).reduce((result, bottle) => {
    const record = bottle.sourceKey
      ? attributionBySourceKey.get(bottle.sourceKey)
      : attributionByItemId.get(bottle.itemId)?.find((candidate) => !candidate.claimed);
    if (record) record.claimed = true;
    const attribution = record?.attribution;
    if (attribution && record) {
      result[attribution].push({
        ...bottle,
        // posSnapshot付きの既存データは、保存当時の配賦売上ではなく
        // POSの商品1行全体と対象人数から新しい分配規則で再計算する。
        backAmount: bottleBackAmountFromPosItem(record.item, bottle, record.targetCount),
      });
    }
    return result;
  }, { honShimei: [] as BottleAllocation[], jonaiExtension: [] as BottleAllocation[] });
}

function drinkBackFromPosSnapshot(closing: DailyClosing, row: DailyCast) {
  if (!hasAttributablePosSnapshot(closing)) return undefined;
  return closing.posSnapshot.transactions.reduce((transactionTotal, transaction) =>
    transactionTotal + (transaction.items || []).reduce((itemTotal, item) => {
      if (item.category !== "castDrink" || !(item.backTargetCastIds || []).includes(row.posCastId)) return itemTotal;
      const targetCount = (item.backTargetCastIds || []).length;
      return itemTotal + splitItemBackPerTarget(asNumber(item.price) * asNumber(item.quantity), 0.1, targetCount);
    }, 0), 0);
}

/**
 * posSnapshot付きの日次はPOSの商品行と対象人数を正とする。
 * POS原本のない旧日次だけは、保存済み明細／集約値による従来計算を維持する。
 */
function drinkBackForEntries(entries: Array<{ closing: DailyClosing; row: DailyCast }>) {
  let posItemBack = 0;
  const legacyRows: DailyCast[] = [];
  entries.forEach(({ closing, row }) => {
    const back = drinkBackFromPosSnapshot(closing, row);
    if (back === undefined) legacyRows.push(row);
    else posItemBack += back;
  });
  return posItemBack + drinkBack(legacyRows);
}

function liquorCostBySalesType(closing: DailyClosing, row: DailyCast, adjustments?: MonthlyAdjustments) {
  const bottles = bottleAllocationsBySalesType(closing, row, adjustments);
  const total = (rows: BottleAllocation[]) => rows.reduce((sum, bottle) => sum + asNumber(bottle.costAmount), 0);
  return { honShimei: total(bottles.honShimei), jonaiExtension: total(bottles.jonaiExtension) };
}

function honShimeiLiquorCostForClosing(closing: DailyClosing, row: DailyCast, adjustments?: MonthlyAdjustments) {
  return liquorCostBySalesType(closing, row, adjustments).honShimei;
}

export function introducerSalesBase(
  reward: Pick<CastReward, "honShimeiSales" | "honShimeiLiquorCost">,
  feeType: IntroducerFeeType
) {
  const netOfLiquorCost = feeType === "netSales10" || feeType === "higherNetSalesGross10";
  return Math.max(0, asNumber(reward.honShimeiSales)
    - (netOfLiquorCost ? asNumber(reward.honShimeiLiquorCost) : 0));
}

const castSalesBackLabels: Record<CastSalesBackBreakdown["key"], string> = {
  honShimei: "本指名バック",
  banaiShimei: "場内指名バック",
  dohan: "同伴バック",
  bottle: "ボトルバック",
  drink: "ドリンクバック",
};

function castSalesBacks(closing: DailyClosing, row: DailyCast, disabled: boolean, bottles: BottleAllocation[]): CastSalesBackBreakdown[] {
  const amounts: Record<CastSalesBackBreakdown["key"], number> = disabled ? {
    honShimei: 0, banaiShimei: 0, dohan: 0, bottle: 0, drink: 0,
  } : {
    honShimei: floorHundred(asNumber(row.honShimeiCount) * 1000),
    banaiShimei: floorHundred(asNumber(row.banaiShimeiCount) * 500),
    dohan: floorHundred(asNumber(row.dohanBack)),
    bottle: bottleBack(bottles),
    drink: drinkBackForEntries([{ closing, row }]),
  };
  return (Object.keys(castSalesBackLabels) as CastSalesBackBreakdown["key"][])
    .map((key) => ({ key, label: castSalesBackLabels[key], amount: amounts[key] }));
}

function summarizeBottles(rows: Array<Pick<BottleAllocation, "name" | "quantity">>): CastSalesBottleSummary[] {
  const bottles = new Map<string, number>();
  rows.forEach((row) => bottles.set(row.name, (bottles.get(row.name) || 0) + asNumber(row.quantity)));
  return [...bottles.entries()].map(([name, quantity]) => ({ name, quantity }));
}

function convertedCastForMonth(
  masterId: string,
  castById: Map<string, CastRecord>,
  casts: CastRecord[],
  month: string,
) {
  const source = castById.get(masterId);
  const direct = source?.convertedToCastId ? castById.get(source.convertedToCastId) : undefined;
  if (direct?.hiredAt?.startsWith(month)) return direct;
  // 体入マスタが完全削除済みでも、在籍側に保存した逆参照で同月の履歴を統合する。
  if (!source) {
    return casts.find((candidate) =>
      candidate.convertedFromTrialId === masterId && candidate.hiredAt?.startsWith(month));
  }
  return undefined;
}

export function castMasterIdentityForMonth(
  masterId: string,
  castById: Map<string, CastRecord>,
  casts: CastRecord[],
  month: string,
  monthDailyMasterIds?: ReadonlySet<string>,
) {
  const source = castById.get(masterId);
  // 旧版の物理削除で在籍側マスタだけが消えていても、残存する体入側の変換先IDと
  // 同月regular日次のIDが一致する場合に限り、同一人物として復元する。
  const missingConvertedTargetId = source?.convertedToCastId
    && monthDailyMasterIds?.has(source.convertedToCastId)
    ? source.convertedToCastId
    : undefined;
  return convertedCastForMonth(masterId, castById, casts, month)?.id
    || missingConvertedTargetId
    || masterId;
}

export function castIdentityForMonth(
  row: DailyCast,
  castById: Map<string, CastRecord>,
  casts: CastRecord[],
  month: string,
  monthDailyMasterIds?: ReadonlySet<string>,
) {
  return castMasterIdentityForMonth(row.masterId, castById, casts, month, monthDailyMasterIds)
    || row.posCastId;
}

export function calculateCastSalesReports(
  closings: DailyClosing[],
  casts: CastRecord[],
  month: string,
  adjustments?: MonthlyAdjustments,
): CastSalesReport[] {
  const castById = new Map(casts.map((row) => [row.id, row]));
  const grouped = new Map<string, { closing: DailyClosing; row: DailyCast }[]>();
  const approved = closings.filter((closing) => closing.status === "approved" && closing.businessDate.startsWith(month));
  const monthDailyMasterIds = new Set(approved.flatMap((closing) => (closing.casts || [])
    .filter((row) => row.kind === "regular")
    .map((row) => row.masterId)));
  approved.forEach((closing) => (closing.casts || []).forEach((row) => {
      const id = castIdentityForMonth(row, castById, casts, month, monthDailyMasterIds);
      grouped.set(id, [...(grouped.get(id) || []), { closing, row }]);
    }));

  return [...grouped.entries()].map(([id, entries]): CastSalesReport => {
    const rows = entries.map((entry) => entry.row);
    const convertedMember = rows.map((row) => convertedCastForMonth(row.masterId, castById, casts, month)).find(Boolean);
    const trialOnly = rows.every((row) => row.kind === "trial") && !convertedMember;
    const days = entries.map(({ closing, row }): CastSalesDay => {
      const bottleAllocations = bottleAllocationsBySalesType(closing, row, adjustments);
      const eligibleBottles = [...bottleAllocations.honShimei, ...bottleAllocations.jonaiExtension];
      const allocationCost = (bottles: BottleAllocation[]) => bottles.reduce((sum, bottle) => sum + asNumber(bottle.costAmount), 0);
      const liquorCosts = {
        honShimei: allocationCost(bottleAllocations.honShimei),
        jonaiExtension: allocationCost(bottleAllocations.jonaiExtension),
      };
      const totalLiquorCost = liquorCosts.honShimei + liquorCosts.jonaiExtension;
      const backs = castSalesBacks(closing, row, trialOnly, eligibleBottles);
      return {
        businessDate: closing.businessDate,
        startTime: row.startTime,
        endTime: row.endTime,
        hours: asNumber(row.hours),
        honShimeiSales: asNumber(row.honShimeiSales),
        jonaiExtensionSales: asNumber(row.jonaiExtensionSales),
        totalSales: asNumber(row.honShimeiSales) + asNumber(row.jonaiExtensionSales),
        honShimeiLiquorCost: liquorCosts.honShimei,
        jonaiExtensionLiquorCost: liquorCosts.jonaiExtension,
        totalLiquorCost,
        honShimeiCount: asNumber(row.honShimeiCount),
        banaiShimeiCount: asNumber(row.banaiShimeiCount),
        nominationCount: asNumber(row.honShimeiCount) + asNumber(row.banaiShimeiCount),
        dohanCount: asNumber(row.dohanCount),
        backs,
        backTotal: backs.reduce((sum, back) => sum + back.amount, 0),
        bottles: summarizeBottles(eligibleBottles),
        beautyAllowance: asNumber(row.beautyAllowance) + (closing.expenses || [])
          .filter((expense) => expense.category === "beautyTrial" && expense.personId === row.masterId)
          .reduce((sum, expense) => sum + asNumber(expense.amount), 0),
      };
    }).sort((left, right) => left.businessDate.localeCompare(right.businessDate));
    const total = (key: keyof CastSalesDay) => days.reduce((sum, day) => sum + asNumber(day[key]), 0);
    const backs = (Object.keys(castSalesBackLabels) as CastSalesBackBreakdown["key"][]).map((key) => ({
      key,
      label: castSalesBackLabels[key],
      amount: days.reduce((sum, day) => sum + (day.backs.find((back) => back.key === key)?.amount || 0), 0),
    }));
    return {
      id,
      name: castById.get(id)?.name || rows[0]?.name || "名称未設定",
      attendanceDays: new Set(days.map((day) => day.businessDate)).size,
      days,
      totals: {
        attendanceDays: new Set(days.map((day) => day.businessDate)).size,
        hours: total("hours"),
        honShimeiSales: total("honShimeiSales"),
        jonaiExtensionSales: total("jonaiExtensionSales"),
        totalSales: total("totalSales"),
        honShimeiLiquorCost: total("honShimeiLiquorCost"),
        jonaiExtensionLiquorCost: total("jonaiExtensionLiquorCost"),
        totalLiquorCost: total("totalLiquorCost"),
        honShimeiCount: total("honShimeiCount"),
        banaiShimeiCount: total("banaiShimeiCount"),
        nominationCount: total("nominationCount"),
        dohanCount: total("dohanCount"),
        backs,
        backTotal: backs.reduce((sum, back) => sum + back.amount, 0),
        bottles: summarizeBottles(days.flatMap((day) => day.bottles)),
        beautyAllowance: total("beautyAllowance"),
      },
    };
  }).sort((left, right) => right.totals.totalSales - left.totals.totalSales || left.name.localeCompare(right.name, "ja"));
}

export function calculateCastRewards(
  closings: DailyClosing[],
  casts: CastRecord[],
  month: string,
  adjustments?: MonthlyAdjustments,
  introducerMonthEvents: IntroducerMonthEvent[] = [],
  introducerDeletionCommits: IntroducerDeletionCommit[] = [],
): CastReward[] {
  const approved = closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month));
  const castById = new Map(casts.map((row) => [row.id, row]));
  const grouped = new Map<string, { businessDate: string; row: DailyCast; closing: DailyClosing }[]>();
  const monthDailyMasterIds = new Set(approved.flatMap((closing) => (closing.casts || [])
    .filter((row) => row.kind === "regular")
    .map((row) => row.masterId)));
  approved.forEach((closing) => (closing.casts ?? []).forEach((row) => {
    const key = castIdentityForMonth(row, castById, casts, month, monthDailyMasterIds);
    grouped.set(key, [...(grouped.get(key) || []), { businessDate: closing.businessDate, row, closing }]);
  }));
  return [...grouped.entries()].map(([id, entries]): CastReward => {
    const member = castById.get(id);
    const rows = entries.map((entry) => entry.row);
    const convertedMember = rows.map((row) => convertedCastForMonth(row.masterId, castById, casts, month)).find(Boolean);
    const trialOnly = rows.every((row) => row.kind === "trial") && !convertedMember;
    const sum = (key: keyof DailyCast) => rows.reduce((total, row) => total + asNumber(row[key]), 0);
    const monthlyRate = rateForMonth(member?.hourlyRates || {}, month);
    const hourlyPay = floorHundred(rows.reduce((total, row) => total + (row.kind === "regular" && monthlyRate > 0 ? monthlyRate : row.hourlyRate) * row.hours, 0));
    const honShimeiSales = sum("honShimeiSales");
    const jonaiExtensionSales = sum("jonaiExtensionSales");
    const eligibleBottles = entries.flatMap((entry) => {
      const allocations = bottleAllocationsBySalesType(entry.closing, entry.row, adjustments);
      return [...allocations.honShimei, ...allocations.jonaiExtension];
    });
    const liquorCost = eligibleBottles.reduce((total, bottle) => total + asNumber(bottle.costAmount), 0);
    const honShimeiLiquorCost = entries.reduce((total, entry) =>
      total + honShimeiLiquorCostForClosing(entry.closing, entry.row, adjustments), 0);
    const honShimeiBack = trialOnly ? 0 : floorHundred(sum("honShimeiCount") * 1000);
    const banaiShimeiBack = trialOnly ? 0 : floorHundred(sum("banaiShimeiCount") * 500);
    const totalDohanBack = trialOnly ? 0 : floorHundred(sum("dohanBack"));
    const totalBottleBack = trialOnly ? 0 : bottleBack(eligibleBottles);
    const totalDrinkBack = trialOnly ? 0 : drinkBackForEntries(entries);
    // 各商品バックは商品全体で100円単位へ切捨て後、1円単位で人数割り済み。
    // ここで再び100円単位へ落とすと333円等の正しい個人配分が失われるため、単純合計する。
    const hourlyAndBack = hourlyPay + honShimeiBack + banaiShimeiBack + totalDohanBack + totalBottleBack + totalDrinkBack;
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
    // 月途中で条件が変わった場合は営業日・在籍区分ではなく、体入日も含めて
    // 「最後に店舗保存された日次」に実際に入っている条件を正とする。
    const latestIntroducerEntry = [...entries].sort((left, right) => {
      return compareDailyClosingSubmissionOrder(left.closing, right.closing)
        || left.businessDate.localeCompare(right.businessDate)
        || left.closing.id.localeCompare(right.closing.id)
        || left.row.posCastId.localeCompare(right.row.posCastId);
    }).at(-1);
    const latestIntroducer = latestIntroducerEntry?.row.introducer;
    const latestDailySavedOrder = latestIntroducerEntry
      ? dailyClosingSubmissionOrderValue(latestIntroducerEntry.closing)
      : Number.NEGATIVE_INFINITY;
    // 体入・在籍IDのどちらに履歴が残っていても、人物全体で最後に保存された
    // イベントを採る。異なるパスのrevisionは大小比較できないため順序には使わない。
    const aliasIds = new Set([
      id,
      member?.convertedFromTrialId,
      ...rows.map((row) => row.masterId),
    ].filter((value): value is string => Boolean(value)));
    const monthEvent = introducerMonthEvents
      .filter((event) => event.month === month && aliasIds.has(event.castId))
      .sort(compareIntroducerMonthEventEffectiveOrder)
      .at(-1);
    const deletionCommit = introducerDeletionCommits
      // linkedCastIdsは削除時に警告表示し、削除ロック下で固定した対象者の正本。
      // 旧・破損commitで一覧が欠けても、現存キャストの当月最新日次が削除紹介者を
      // 指している場合だけ安全側で0にする。archived/物理削除済み履歴は巻き込まない。
      .filter((commit) => commit.month === month && (
        commit.linkedCastIds.some((castId) => aliasIds.has(castId))
        || (member !== undefined && !member.deletedAt && (
          member.introducerId === commit.introducerId
          || latestIntroducer?.id === commit.introducerId
        ))
      ))
      .sort((left, right) => left.completedAtMs - right.completedAtMs || left.id.localeCompare(right.id))
      .at(-1);
    const latestSpecial = [
      ...(monthEvent ? [{ kind: "event" as const, order: introducerMonthEventEffectiveOrderValue(monthEvent), event: monthEvent }] : []),
      ...(deletionCommit ? [{ kind: "commit" as const, order: deletionCommit.completedAtMs, commit: deletionCommit }] : []),
    ].sort((left, right) => left.order - right.order || (left.kind === "commit" ? 1 : -1)).at(-1);
    const effectiveIntroducer = latestSpecial?.kind === "commit"
      ? undefined
      : latestSpecial?.event.state === "deleted"
        ? undefined
        : latestSpecial?.event.state === "reassigned"
        // 再設定より後に日次が保存された場合は、その保存内容（紹介者なしを含む）を
        // 新しい月内条件とする。同一時刻なら明示操作である再設定イベントを優先する。
        ? latestDailySavedOrder > introducerMonthEventEffectiveOrderValue(latestSpecial.event)
          ? latestIntroducer
          : latestSpecial.event.introducer
        : latestIntroducer;
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
      honShimeiLiquorCost,
      honShimeiBack,
      banaiShimeiBack,
      dohanBack: totalDohanBack,
      bottleBack: totalBottleBack,
      drinkBack: totalDrinkBack,
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
      introducer: trialOnly ? undefined : effectiveIntroducer
    };
  }).sort((left, right) => right.honShimeiSales + right.jonaiExtensionSales - (left.honShimeiSales + left.jonaiExtensionSales));
}

/**
 * 旧版互換の公開関数。現在は最後に保存された日次条件を月全体へ適用する仕様のため、
 * 月途中の条件差は確定阻害要因ではない。
 */
export function introducerTermConflicts(closings: DailyClosing[], casts: CastRecord[], month: string) {
  void closings;
  void casts;
  void month;
  return [] as string[];
}

export type DriverPayrollRow = {
  id: string;
  name: string;
  days: number;
  basic: number;
  remote: number;
  gross: number;
  dailyPayment: number;
  net: number;
};

export function calculateDriverPayroll(
  closings: DailyClosing[],
  remoteAllowance: Record<string, number>
): DriverPayrollRow[] {
  const rows = new Map<string, DriverPayrollRow>();
  closings.forEach((closing) => (closing.drivers || []).forEach((driver) => {
    const row = rows.get(driver.driverId) || {
      id: driver.driverId,
      name: driver.name,
      days: 0,
      basic: 0,
      remote: asNumber(remoteAllowance[driver.driverId]),
      gross: 0,
      dailyPayment: 0,
      net: 0,
    };
    row.days += 1;
    row.basic += asNumber(driver.dailyRate);
    row.dailyPayment += asNumber(driver.dailyPayment);
    rows.set(driver.driverId, row);
  }));
  return [...rows.values()].map((row) => ({
    ...row,
    gross: row.basic + row.remote,
    net: row.basic + row.remote - row.dailyPayment,
  }));
}

export function calculateCash(input: {
  sales: PosClosingV3["sales"];
  cashFloat: number;
  expenses: number;
  regularDailyPayments: number;
  trialDailyPayments: number;
  staffDailyPayments: number;
  driverDailyPayments: number;
  dispatchCastPayment: number;
  dispatchStaffPayment: number;
  dispatchFee: number;
  actualClosingCash: number;
}): CashReconciliation {
  const expenseAndPaymentTotal = input.expenses + input.regularDailyPayments + input.trialDailyPayments
    + input.staffDailyPayments + input.driverDailyPayments
    + input.dispatchCastPayment + input.dispatchStaffPayment + input.dispatchFee;
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
