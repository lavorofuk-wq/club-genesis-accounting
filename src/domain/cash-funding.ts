import type { CashReconciliation, DailyClosing } from "./gms";

/** 補充・返済は損益ではなく現金移動。初回の個人未返済残高は利用者確認済みの0円。 */
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
  schema: 1;
  personalRepayment: number;
  closingPersonalDebt: number;
  confirmed: boolean;
};

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
  const issues = cashLedgerIssues(earlier);
  assert(issues.length === 0, issues[0]);
  return contextFromPrevious(earlier.at(-1), cashFloat);
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
  if (!funding || funding.schema !== 1 || typeof funding.confirmed !== "boolean") return fail("補充・返済の保存形式が不正です。");
  if (![
    funding.previousClosingCash, funding.openingShortfall, funding.openingPersonalDebt,
    funding.companyReplenishment, funding.personalReplenishment, funding.companyTransfer,
    funding.personalRepayment, funding.closingPersonalDebt, cash.cashFloat,
  ].every(money) || !signedMoney(cash.cashProfit)) return fail("補充・返済の金額は0円以上の整数で指定してください。");
  if (typeof funding.previousClosingId !== "string" || /[.#$\/[\]]/.test(funding.previousClosingId)
    || typeof funding.previousBusinessDate !== "string"
    || (funding.previousClosingId ? !validDate(funding.previousBusinessDate) : funding.previousBusinessDate !== "")) return fail("現金繰越元の営業日・日次IDが不正です。");
  if (!funding.previousClosingId && (funding.openingPersonalDebt !== 0 || funding.previousClosingCash !== cash.cashFloat)) return fail("初回の個人立替未返済額・開始現金が一致しません。");
  if (funding.openingShortfall !== Math.max(0, cash.cashFloat - funding.previousClosingCash)) return fail("開店前のつり銭不足額が前営業日の残額と一致しません。");
  if (funding.companyReplenishment + funding.personalReplenishment !== funding.openingShortfall) return fail("会社補充と個人立替の合計を、開店前のつり銭不足額に合わせてください。");
  if (cash.cashProfit !== cash.cashSales - cash.expenseAndPaymentTotal) return fail("補充・返済を除く当日の現金収支が一致しません。");
  if (!money(funding.openingPersonalDebt + funding.personalReplenishment)
    || !money(Math.max(0, cash.cashProfit + funding.companyTransfer))) return fail("補充・返済の合計が計算可能な範囲を超えています。");
  const expected = calculateCashFunding(funding, funding, cash.cashProfit, funding.confirmed);
  if (funding.personalRepayment !== expected.personalRepayment || funding.closingPersonalDebt !== expected.closingPersonalDebt) return fail("個人立替の返済額・未返済残高が一致しません。");
  if (cash.expectedClosingCash !== cash.cashFloat + cash.cashProfit + funding.companyTransfer - funding.personalRepayment) return fail("補充・返済後の計算上現金残額が一致しません。");
  if (!money(cash.expectedClosingCash)) return fail("計算上の現金残額が0円未満または整数ではありません。入力や会社入金を確認してください。");
  if (cash.actualClosingCash !== cash.expectedClosingCash || cash.difference !== 0) return fail("計算上の現金残額との一致確認が必要です。");
  if (!funding.confirmed) return fail("実際の現金と計算上の残額が一致していることを確認してください。");
  return [];
}

/** 過去の照合・実際の補充返済を再計算して保存しない。違いは必ず警告する。 */
export function cashLedgerIssues(closings: DailyClosing[], month?: string): string[] {
  try {
    const relevant = month ? closings.filter((row) => row.businessDate.slice(0, 7) <= month) : closings;
    if (!relevant.some((row) => row.cash?.funding !== undefined)) return [];
    const ordered = orderedClosings(relevant);
    const issues: string[] = [];
    let managed = false;
    let previous: DailyClosing | undefined;
    for (const row of ordered) {
      // 対象月より後の問題では過去確定月の閲覧を止めない。
      if (month && row.businessDate.slice(0, 7) > month) break;
      if (row.cash?.funding !== undefined) {
        managed = true;
        const localIssues = cashFundingIssues(row.cash);
        if (localIssues.length) issues.push(...localIssues.map((message) => `${row.businessDate}：${message}`));
        else {
          const expected = contextFromPrevious(previous, row.cash.cashFloat);
          const funding = row.cash.funding;
          if ((Object.keys(expected) as Array<keyof CashFundingContext>).some((key) => funding[key] !== expected[key])) {
            issues.push(`${row.businessDate}の現金繰越が前営業日の記録と一致しません。補充・返済実績は変更せず、元の営業日を確認してください。`);
          }
        }
      } else if (managed) {
        issues.push(`${row.businessDate}に補充・返済の確認記録がありません。現金管理を開始した後の日次は再確認してください。`);
      }
      previous = row;
    }
    return issues;
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

/** 保存済みの旧現金だけを保持する例外。ロックtokenや保存日時を新旧判定には使わない。 */
export function preservesLegacyCash(before: DailyClosing | null | undefined, candidate: DailyClosing): boolean {
  return Boolean(before?.cash && candidate?.cash
    && before.businessDate === candidate.businessDate
    && before.cash.funding === undefined && candidate.cash.funding === undefined
    && sameCashValue(before.cash, candidate.cash));
}

/** 後続の実績がある現金記録は、自動連鎖更新も削除も許可しない。 */
export function assertCashLedgerChange(before: DailyClosing | null, candidate: DailyClosing | null, closings: DailyClosing[]) {
  const id = candidate?.id || before?.id;
  assert(id, "現金管理の対象日次がありません。");
  const others = orderedClosings(closings.filter((row) => row.id !== id));
  const day = candidate?.businessDate || before!.businessDate;
  const successors = others.filter((row) => row.businessDate > day && row.cash?.funding !== undefined);
  if (successors.length) {
    const sameFunding = before && candidate && (Object.keys(before.cash.funding || {}).length === Object.keys(candidate.cash.funding || {}).length)
      && Object.entries(before.cash.funding || {}).every(([key, value]) => candidate.cash.funding?.[key as keyof CashFunding] === value);
    assert(before && candidate && before.businessDate === candidate.businessDate
      && before.cash.expectedClosingCash === candidate.cash.expectedClosingCash && sameFunding,
    `${successors[0].businessDate}以降の補充・返済がこの日以前の現金残額を参照しています。実績を保護するため現金額の変更・過去日次の追加・削除はできません。`);
  }
  if (candidate) {
    const preservedLegacy = preservesLegacyCash(before, candidate);
    assert(candidate.cash.funding || preservedLegacy, "現金残額の一致確認と補充・返済の入力が必要です。旧方式の日次は保存済みの現金記録を変更せずに再送してください。");
    if (preservedLegacy) assert(candidate.legacyCashConfirmed === true, "保存済みの旧現金記録を変更していないことを確認してください。");
    const issues = cashLedgerIssues([...others, candidate]);
    assert(issues.length === 0, issues[0]);
  }
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
  const previous = closings.filter((row) => row.businessDate < `${month}-01` && row.cash?.funding)
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate)).at(-1);
  const openingPersonalDebt = all[0]?.cash.funding!.openingPersonalDebt ?? previous?.cash.funding!.closingPersonalDebt ?? 0;
  return {
    managedDays: all.length,
    openingPersonalDebt,
    companyReplenishment, personalReplenishment, companyTransfer, personalRepayment,
    closingPersonalDebt: all.at(-1)?.cash.funding!.closingPersonalDebt ?? openingPersonalDebt,
    netCashMovement: companyReplenishment + personalReplenishment + companyTransfer - personalRepayment,
  };
}
