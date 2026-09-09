import type { CashReconciliation, DailyClosing } from "./gms";

/** 補充・返済は損益ではなく現金移動。未記録の開始残高を0円へ補完しない。 */
export type CashFundingContext = {
  previousClosingId: string;
  previousBusinessDate: string;
  previousClosingCash: number;
  openingShortfall: number;
  openingPersonalDebt: number;
};

export type CashFundingInputs = {
  companyReplenishment: number;
  personalReplenishment: number;
  companyTransfer: number;
};

export type CashFunding = CashFundingContext & CashFundingInputs & {
  /** 1は従来の自動返済記録、2は確認した実際の返済を記録する。 */
  schema: 1 | 2;
  personalRepayment: number;
  closingPersonalDebt: number;
  confirmed: boolean;
};

export type CashFundingDraftContext = Omit<CashFundingContext, "openingPersonalDebt"> & {
  /** 未記録は0円ではない。利用者が当時の残高を確認して入力する。 */
  openingPersonalDebt: number | null;
};

export type CashChangeImpact = Pick<DailyClosing, "id" | "businessDate" | "status"> & { issues: string[] };
type CashMonthState = { month: string; status: string };

export type CashFundingSummary = {
  managedDays: number;
  openingPersonalDebt: number;
  companyReplenishment: number;
  personalReplenishment: number;
  companyTransfer: number;
  personalRepayment: number;
  closingPersonalDebt: number;
  netCashMovement: number;
};

const money = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const signedMoney = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const validDate = (value: string) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** 承認は経理の状態。補充・返済の実績は差戻し・取下げでも消えない。 */
function orderedClosings(closings: DailyClosing[]) {
  const ordered = [...closings].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const dates = new Set<string>();
  const ids = new Set<string>();
  for (const row of ordered) {
    assert(validDate(row.businessDate) && row.id && !dates.has(row.businessDate) && !ids.has(row.id), "現金繰越の営業日・日次IDが不正または重複しています。");
    assert(["submitted", "approved", "returned", "withdrawn"].includes(row.status), `${row.businessDate}の現金繰越に不明な状態があります。`);
    dates.add(row.businessDate); ids.add(row.id);
  }
  return ordered;
}

function contextFromPrevious(previous: DailyClosing | undefined, cashFloat: number): CashFundingContext {
  assert(money(cashFloat), "設定つり銭は0円以上の整数で指定してください。");
  if (!previous) return { previousClosingId: "", previousBusinessDate: "", previousClosingCash: cashFloat, openingShortfall: 0, openingPersonalDebt: 0 };
  assert(money(previous.cash?.expectedClosingCash), `${previous.businessDate}の計算上現金残額を確認できません。過去データを確認してください。`);
  const funding = previous.cash.funding;
  if (funding) {
    const issues = cashFundingIssues(previous.cash);
    assert(issues.length === 0, `${previous.businessDate}：${issues[0]}`);
  }
  return {
    previousClosingId: previous.id,
    previousBusinessDate: previous.businessDate,
    previousClosingCash: previous.cash.expectedClosingCash,
    openingShortfall: Math.max(0, cashFloat - previous.cash.expectedClosingCash),
    openingPersonalDebt: funding?.closingPersonalDebt ?? 0,
  };
}

export function cashFundingContext(closings: DailyClosing[], businessDate: string, cashFloat: number, excludeId?: string): CashFundingContext {
  assert(validDate(businessDate), "現金管理の営業日を指定してください。");
  const earlier = orderedClosings(closings.filter((row) => row.id !== excludeId && row.businessDate < businessDate));
  // schema 1の読込互換用。新しい入力画面は不明な開始残高を0円にしないdraft APIを使う。
  const issues = earlier.filter((row) => row.cash?.funding).flatMap((row) => cashDayIssues(row, earlier));
  assert(issues.length === 0, issues[0]);
  return contextFromPrevious(earlier.at(-1), cashFloat);
}

/** 修正画面を開くための最新前提。後続の不整合があっても入力画面を閉ざさない。 */
export function cashFundingDraftContext(closings: DailyClosing[], businessDate: string, cashFloat: number, excludeId?: string): CashFundingDraftContext {
  assert(validDate(businessDate), "現金管理の営業日を指定してください。");
  const earlier = orderedClosings(closings.filter((row) => row.id !== excludeId && row.businessDate < businessDate));
  const previous = earlier.at(-1);
  const context = contextFromPrevious(previous, cashFloat);
  return { ...context, openingPersonalDebt: previous?.cash.funding ? context.openingPersonalDebt : null };
}

/** 推奨値を表示するだけで、記録済みの実返済額へは代入しない。 */
export function recommendedPersonalRepayment(context: CashFundingContext, inputs: CashFundingInputs, cashProfit: number): number {
  return calculateCashFunding(context, inputs, cashProfit).personalRepayment;
}

/** 入力・確認された実績。推奨額との差があっても実返済を自動変更しない。 */
export function calculateConfirmedCashFunding(context: CashFundingContext, inputs: CashFundingInputs, personalRepayment: number, cashProfit: number, confirmed = false): CashFunding {
  const recommended = calculateCashFunding(context, inputs, cashProfit, confirmed);
  assert(money(personalRepayment), "実際の個人返済額を0円以上の1円単位で入力してください。");
  return { ...recommended, schema: 2, personalRepayment,
    closingPersonalDebt: context.openingPersonalDebt + inputs.personalReplenishment - personalRepayment, confirmed };
}

/** 利益は不変。返済できるのは会社入金を含めて設定つり銭を超える部分だけ。 */
export function calculateCashFunding(context: CashFundingContext, inputs: CashFundingInputs, cashProfit: number, confirmed = false): CashFunding {
  assert([inputs.companyReplenishment, inputs.personalReplenishment, inputs.companyTransfer].every(money) && signedMoney(cashProfit), "補充・会社入金・現金収支は1円単位で指定してください。");
  assert(money(context.openingShortfall) && money(context.openingPersonalDebt), "現金繰越の不足額・未返済額が不正です。");
  const debt = context.openingPersonalDebt + inputs.personalReplenishment;
  const available = Math.max(0, cashProfit + inputs.companyTransfer);
  assert(money(debt) && money(available), "現金管理の金額が計算可能な範囲を超えています。");
  const personalRepayment = Math.min(debt, available);
  return { schema: 1, ...context, companyReplenishment: inputs.companyReplenishment, personalReplenishment: inputs.personalReplenishment,
    companyTransfer: inputs.companyTransfer, personalRepayment, closingPersonalDebt: debt - personalRepayment, confirmed };
}

/** ローカル・Firebase境界の双方で同じ式を検証。旧日次は補完しない。 */
export function cashFundingIssues(cash: CashReconciliation): string[] {
  if (cash.funding === undefined) return [];
  const funding = cash.funding;
  const fail = (message: string) => [message];
  if (!funding || ![1, 2].includes(funding.schema) || typeof funding.confirmed !== "boolean") return fail("補充・返済の保存形式が不正です。");
  if (![
    funding.previousClosingCash, funding.openingShortfall, funding.openingPersonalDebt,
    funding.companyReplenishment, funding.personalReplenishment, funding.companyTransfer,
    funding.personalRepayment, funding.closingPersonalDebt, cash.cashFloat,
  ].every(money) || !signedMoney(cash.cashProfit)) return fail("補充・返済の金額は0円以上の整数で指定してください。");
  if (typeof funding.previousClosingId !== "string" || /[.#$\/[\]]/.test(funding.previousClosingId)
    || typeof funding.previousBusinessDate !== "string"
    || (funding.previousClosingId ? !validDate(funding.previousBusinessDate) : funding.previousBusinessDate !== "")) return fail("現金繰越元の営業日・日次IDが不正です。");
  if (!funding.previousClosingId && ((funding.schema === 1 && funding.openingPersonalDebt !== 0) || funding.previousClosingCash !== cash.cashFloat)) return fail("初回の個人立替未返済額・開始現金が一致しません。");
  if (funding.openingShortfall !== Math.max(0, cash.cashFloat - funding.previousClosingCash)) return fail("開店前のつり銭不足額が前営業日の残額と一致しません。");
  if (funding.companyReplenishment + funding.personalReplenishment !== funding.openingShortfall) return fail("会社補充と個人立替の合計を、開店前のつり銭不足額に合わせてください。");
  if (cash.cashProfit !== cash.cashSales - cash.expenseAndPaymentTotal) return fail("補充・返済を除く当日の現金収支が一致しません。");
  if (!money(funding.openingPersonalDebt + funding.personalReplenishment)
    || !money(Math.max(0, cash.cashProfit + funding.companyTransfer))) return fail("補充・返済の合計が計算可能な範囲を超えています。");
  const expected = calculateCashFunding(funding, funding, cash.cashProfit, funding.confirmed);
  if (funding.schema === 1) {
    if (funding.personalRepayment !== expected.personalRepayment || funding.closingPersonalDebt !== expected.closingPersonalDebt) return fail("個人立替の返済額・未返済残高が一致しません。");
  } else {
    if (funding.personalRepayment > expected.personalRepayment) return fail("実際の返済額が未返済額または設定つり銭を除く返済可能額を超えています。補充・支払実績を確認してください。");
    if (funding.closingPersonalDebt !== funding.openingPersonalDebt + funding.personalReplenishment - funding.personalRepayment) return fail("実際の返済額と未返済残高が一致しません。");
  }
  if (cash.expectedClosingCash !== cash.cashFloat + cash.cashProfit + funding.companyTransfer - funding.personalRepayment) return fail("補充・返済後の計算上現金残額が一致しません。");
  if (!money(cash.expectedClosingCash)) return fail("計算上の現金残額が0円未満または整数ではありません。入力や会社入金を確認してください。");
  if (cash.actualClosingCash !== cash.expectedClosingCash || cash.difference !== 0) return fail("計算上の現金残額との一致確認が必要です。");
  if (!funding.confirmed) return fail("実際の現金と計算上の残額が一致していることを確認してください。");
  return [];
}

/** その日の実績と最新の前営業日を照合する。保存済み金額は変更しない。 */
export function cashDayIssues(row: DailyClosing, closings: DailyClosing[]): string[] {
  try {
    if (!row.cash?.funding) return [`${row.businessDate}の補充・返済の確認記録がありません。開始未返済額と当日の補充・返済実績を確認・入力してください。`];
    const issues = cashFundingIssues(row.cash);
    if (issues.length) return issues.map((message) => `${row.businessDate}：${message}`);
    const expected = cashFundingDraftContext(closings, row.businessDate, row.cash.cashFloat, row.id);
    const funding = row.cash.funding;
    const changed = (Object.keys(expected) as Array<keyof CashFundingDraftContext>).some((key) =>
      // schema 2の明示確認残高は、前日の記録が無ければ数値を推定して置き換えない。
      key === "openingPersonalDebt" && expected[key] === null
        ? funding.schema === 1 && funding.openingPersonalDebt !== 0
        : funding[key] !== expected[key]);
    return changed ? [`${row.businessDate}の現金繰越が前営業日の記録と一致しません。保存済みの補充・返済額を保持し、最新の前提との差を確認して再送してください。`] : [];
  } catch (error) {
    return [`${row.businessDate}：${error instanceof Error ? error.message : "現金繰越を確認できません。"}`];
  }
}

/** 対象月の未入力と、それ以前の記録済み実績の不整合を診断する。 */
export function cashLedgerIssues(closings: DailyClosing[], month?: string): string[] {
  try {
    const relevant = month ? closings.filter((row) => row.businessDate.slice(0, 7) <= month) : closings;
    const ordered = orderedClosings(relevant);
    return [...new Set(ordered.flatMap((row) =>
      (!month || row.businessDate.startsWith(`${month}-`) || row.cash?.funding) ? cashDayIssues(row, ordered) : []))];
  } catch (error) {
    return [error instanceof Error ? error.message : "現金繰越を確認できません。"];
  }
}

function sameCashValue(before: unknown, candidate: unknown): boolean {
  if (Object.is(before, candidate)) return true;
  if (!before || !candidate || typeof before !== "object" || typeof candidate !== "object") return false;
  if (Array.isArray(before) !== Array.isArray(candidate)) return false;
  if (Array.isArray(before) && Array.isArray(candidate) && before.length !== candidate.length) return false;
  const original = before as Record<string, unknown>;
  const next = candidate as Record<string, unknown>;
  const keys = Object.keys(original);
  return keys.length === Object.keys(next).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(next, key) && sameCashValue(original[key], next[key]));
}

export function sameCashReconciliation(before: CashReconciliation, candidate: CashReconciliation): boolean {
  return sameCashValue(before, candidate);
}

/** 未確定の後続には再確認を要求できる。確定済みの繰越と実績の削除は保護する。 */
export function assertCashLedgerChange(before: DailyClosing | null, candidate: DailyClosing | null, closings: DailyClosing[], monthStates: CashMonthState[] = []) {
  const id = candidate?.id || before?.id;
  assert(id, "現金管理の対象日次がありません。");
  const others = orderedClosings(closings.filter((row) => row.id !== id));
  const day = candidate?.businessDate || before!.businessDate;
  const successors = others.filter((row) => row.businessDate > day && row.cash?.funding !== undefined);
  if (!candidate && successors.length) throw new Error(`${successors[0].businessDate}以降の補充・返済がこの日以前の現金残額を参照しています。実績を保護するため削除はできません。`);
  const changesCarry = !before || !candidate || before.businessDate !== candidate.businessDate
    || before.cash.expectedClosingCash !== candidate.cash.expectedClosingCash
    || before.cash.funding?.closingPersonalDebt !== candidate.cash.funding?.closingPersonalDebt;
  const protectedMonth = monthStates.find((row) => row.month >= day.slice(0, 7) && (row.status === "closed" || row.status === "closing"));
  assert(!protectedMonth || !changesCarry, `${protectedMonth?.month}の確定済みまたは確定処理中の月へ現金繰越が影響します。該当月の確定解除後に修正してください。`);
  if (candidate) {
    assert(!before || before.businessDate === candidate.businessDate, "再送時に営業日は変更できません。");
    assert(candidate.cash.funding, "現金残額の一致確認と補充・返済の入力が必要です。");
    const issues = cashDayIssues(candidate, others);
    assert(issues.length === 0, issues[0]);
  }
}

/** 変更後の後続要確認日。対象日を直せない循環待ちを作らず、実績をそのまま提示する。 */
export function cashChangeImpacts(before: DailyClosing | null, candidate: DailyClosing, closings: DailyClosing[]): CashChangeImpact[] {
  const next = [...closings.filter((row) => row.id !== candidate.id), candidate];
  const start = before && before.businessDate < candidate.businessDate ? before.businessDate : candidate.businessDate;
  return next.filter((row) => row.id !== candidate.id && row.businessDate > start)
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate))
    .map((row) => ({ id: row.id, businessDate: row.businessDate, status: row.status, issues: cashDayIssues(row, next) }))
    .filter((row) => row.issues.length > 0);
}

export function summarizeCashFunding(closings: DailyClosing[], month: string): CashFundingSummary {
  const issues = cashLedgerIssues(closings, month);
  assert(issues.length === 0, issues[0]);
  const all = orderedClosings(closings.filter((row) => row.businessDate.startsWith(`${month}-`) && row.cash?.funding));
  assert(all.every((row) => row.status === "approved"), "補充・返済を含む日次に未承認・差戻し・取下げがあるため、月間の現金移動を集計できません。経理承認後に確認してください。");
  const sum = (key: keyof CashFundingInputs | "personalRepayment") => all.reduce((total, row) => total + row.cash.funding![key], 0);
  const companyReplenishment = sum("companyReplenishment");
  const personalReplenishment = sum("personalReplenishment");
  const companyTransfer = sum("companyTransfer");
  const personalRepayment = sum("personalRepayment");
  const previous = closings.filter((row) => row.businessDate < `${month}-01`)
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate)).at(-1);
  assert(all.length > 0 || !previous || previous.cash.funding,
    `${previous?.businessDate}の未返済残高が未確認のため、営業日のない月へ残高を繰り越せません。直前営業日の実績を確認してください。`);
  const openingPersonalDebt = all[0]?.cash.funding!.openingPersonalDebt ?? previous?.cash.funding!.closingPersonalDebt ?? 0;
  assert([companyReplenishment, personalReplenishment, companyTransfer, personalRepayment, openingPersonalDebt].every(money),
    "月間の補充・返済合計が計算可能な範囲を超えています。");
  const inflows = companyReplenishment + personalReplenishment + companyTransfer;
  const netCashMovement = inflows - personalRepayment;
  assert(money(inflows) && signedMoney(netCashMovement), "月間の現金移動合計が計算可能な範囲を超えています。");
  return {
    managedDays: all.length,
    openingPersonalDebt,
    companyReplenishment, personalReplenishment, companyTransfer, personalRepayment,
    closingPersonalDebt: all.at(-1)?.cash.funding!.closingPersonalDebt ?? openingPersonalDebt,
    netCashMovement,
  };
}
