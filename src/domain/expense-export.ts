import type { DailyClosing, ExpenseCategory, MonthlyAdjustments } from "./gms";
import type { MonthlyAccountingResults, MonthlyAccountingSnapshot } from "./month-accounting";

export type ExpenseExportInput = {
  results: MonthlyAccountingResults;
  closings: DailyClosing[];
  adjustments: MonthlyAdjustments;
  month: string;
  snapshot?: MonthlyAccountingSnapshot;
};

const expenseCategories: ExpenseCategory[] = [
  "beautyTrial", "introduction", "advertising", "supplies", "entertainment", "liquor", "transportOther",
];

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function amount(value: unknown, label: string, allowNegative = false): number {
  requireValue(typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (allowNegative || value >= 0), `${label}の金額が不正です。`);
  return value;
}

function sameAmount(actual: unknown, expected: number, label: string, allowNegative = false) {
  const checked = amount(actual, label, allowNegative);
  amount(expected, `${label}の合計`, allowNegative);
  // 既存データに小数がある場合も丸めず、加算順序による浮動小数点の誤差だけを許容する。
  requireValue(Math.abs(checked - expected) <= Number.EPSILON * Math.max(1, Math.abs(checked), Math.abs(expected)) * 8,
    `${label}が元データの合計と一致しません。最新データを読み込んでください。`);
}

function text(value: unknown, label: string): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label}がありません。`);
}

function array<T>(value: T[] | undefined, label: string): T[] {
  requireValue(Array.isArray(value), `${label}を読み込めません。`);
  return value;
}

function uniqueId(id: unknown, ids: Set<string>, label: string) {
  text(id, `${label}のID`);
  requireValue(!ids.has(id), `${label}のIDが重複しています。`);
  ids.add(id);
}

function validBusinessDate(value: string, month: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !value.startsWith(`${month}-`)) return false;
  const day = Number(value.slice(8));
  const [year, monthNumber] = month.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthNumber - 1];
  return day >= 1 && day <= days;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** 保存済み支払額を紹介者ID別に集約する。現在マスタや名前から人物を推測しない。 */
export function summarizeExpenseIntroducers(
  results: Pick<MonthlyAccountingResults, "castRewards" | "introducerPayments">,
): Array<{ id: string; name: string; total: number }> {
  const rewards = array(results.castRewards, "キャスト報酬");
  const payments = array(results.introducerPayments, "紹介者支払");
  const paymentIds = new Set<string>();
  const groups = new Map<string, { names: Set<string>; total: number }>();
  for (const payment of payments) {
    requireValue(payment, "紹介者支払を読み込めません。");
    uniqueId(payment.id, paymentIds, "紹介者支払");
    text(payment.introducer, "紹介者名");
    const candidates = new Map<string, string>();
    if (payment.introducerId !== undefined || payment.castId !== undefined) {
      text(payment.introducerId, "紹介者支払の紹介者ID");
      text(payment.castId, "紹介者支払のキャストID");
      requireValue(payment.id === `${payment.introducerId}_${payment.castId}`,
        "紹介者支払の人物IDが保存済み支払IDと一致しません。");
      candidates.set(JSON.stringify([payment.introducerId, payment.castId]), payment.introducerId);
    } else {
      // 旧確定データは保存済みのキャスト報酬内の紹介者IDと完全一致する組だけを採用する。
      for (const reward of rewards) {
        if (typeof reward?.id !== "string" || !reward.id
          || typeof reward.introducer?.id !== "string" || !reward.introducer.id) continue;
        if (payment.id === `${reward.introducer.id}_${reward.id}`) {
          candidates.set(JSON.stringify([reward.introducer.id, reward.id]), reward.introducer.id);
        }
      }
      // 出勤なしの入店顧問料にはキャスト報酬がない。GMSの生成形式に完全一致するIDのみ復元する。
      const generatedId = /^(introducer_[0-9a-f]{32})_(cast_[0-9a-f]{32})$/.exec(payment.id);
      if (generatedId) candidates.set(JSON.stringify(generatedId.slice(1)), generatedId[1]);
    }
    requireValue(candidates.size === 1,
      `${payment.introducer}の紹介者IDを一意に確認できません。保存済み紹介者支払データの確認が必要です。`);
    const introducerId = candidates.values().next().value!;
    const group = groups.get(introducerId) || { names: new Set<string>(), total: 0 };
    group.names.add(payment.introducer.trim());
    group.total = amount(group.total + amount(payment.total, "紹介者支払計"), "紹介者別支払合計");
    groups.set(introducerId, group);
  }
  return [...groups.entries()].map(([id, group]) => ({
    id,
    name: [...group.names].sort((left, right) => left.localeCompare(right, "ja") || (left < right ? -1 : left > right ? 1 : 0)).join("／"),
    total: group.total,
  })).sort((left, right) => left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id));
}

/** 経費帳票を生成する前に、明細・月計・確定時の保存世代が一致することを検査する。 */
export function validateExpenseExport({ results, closings, adjustments, month, snapshot }: ExpenseExportInput): void {
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "対象月が正しくありません。");
  requireValue(adjustments && adjustments.month === month, "対象月の経理入力を読み込めません。");
  requireValue(results && results.expenses && results.sales && results.balance, "出力する月次データを読み込めません。");
  requireValue(array(results.warnings, "月次データの警告").length === 0, "月次データの警告を解消してから出力してください。");
  const approved = array(closings, "日次データ").filter((closing) => {
    if (closing?.status !== "approved") return false;
    requireValue(closing && typeof closing.businessDate === "string", "営業日を読み込めない日次データがあります。");
    return closing.businessDate.startsWith(month);
  });
  const byCategory: Record<string, number> = Object.fromEntries(expenseCategories.map((category) => [category, 0]));
  const closingIds = new Set<string>();
  const dates = new Set<string>();
  let dispatchCast = 0;
  let dispatchStaff = 0;
  let dispatchFee = 0;
  let dailyLiquorDelivery = 0;
  let cashSales = 0;
  let cardSales = 0;
  approved.forEach((closing) => {
    requireValue(validBusinessDate(closing.businessDate, month), `${closing.businessDate}の営業日が正しくありません。`);
    uniqueId(closing.id, closingIds, "承認済み日次データ");
    requireValue(!dates.has(closing.businessDate), `${closing.businessDate}の承認済み日次データが重複しています。`);
    dates.add(closing.businessDate);
    requireValue(!closing.integrityIssues?.length, `${closing.businessDate}の日次データに未解決の不整合があります。`);
    const expenseIds = new Set<string>();
    array(closing.expenses, `${closing.businessDate}の経費明細`).forEach((expense) => {
      requireValue(expense && expenseCategories.includes(expense.category), `${closing.businessDate}の経費に未対応の勘定科目があります。`);
      uniqueId(expense.id, expenseIds, `${closing.businessDate}の経費明細`);
      text(expense.payee, `${closing.businessDate}の経費の支払先`);
      byCategory[expense.category] += amount(expense.amount, `${closing.businessDate}の経費`);
    });
    dispatchCast += amount(closing.dispatchCastPayment, `${closing.businessDate}の派遣キャスト支払`);
    dispatchStaff += amount(closing.dispatchStaffPayment, `${closing.businessDate}の派遣スタッフ支払`);
    dispatchFee += amount(closing.dispatchFee, `${closing.businessDate}の派遣手数料`);
    dailyLiquorDelivery += amount(closing.liquorDeliveryAmount, `${closing.businessDate}の酒代納品書分`);
    requireValue(closing.sales, `${closing.businessDate}の売上を読み込めません。`);
    const cash = amount(closing.sales.cashSales, `${closing.businessDate}の現金売上`);
    const card = amount(closing.sales.cardSales, `${closing.businessDate}のカード売上`);
    sameAmount(closing.sales.totalSales, cash + card, `${closing.businessDate}の合計売上`);
    cashSales += cash;
    cardSales += card;
  });
  requireValue(Number.isSafeInteger(results.approvedDays) && results.approvedDays === approved.length, "承認済み営業日数が出力元データと一致しません。");
  const summary = results.expenses;
  requireValue(summary.byCategory && typeof summary.byCategory === "object" && !Array.isArray(summary.byCategory), "経費の科目別合計を読み込めません。");
  Object.entries(summary.byCategory).forEach(([category, value]) => {
    requireValue(expenseCategories.includes(category as ExpenseCategory), "経費の科目別合計に未対応の勘定科目があります。");
    amount(value, "経費の科目別合計");
  });
  expenseCategories.forEach((category) => sameAmount(summary.byCategory[category] ?? 0, byCategory[category], `経費「${category}」`));
  const dailyExpenseTotal = Object.values(byCategory).reduce((sum, value) => sum + value, 0);
  sameAmount(summary.dailyExpenseTotal, dailyExpenseTotal, "日次経費計");
  sameAmount(summary.dispatchCast, dispatchCast, "派遣キャスト支払");
  sameAmount(summary.dispatchStaff, dispatchStaff, "派遣スタッフ支払");
  sameAmount(summary.dispatchFee, dispatchFee, "派遣手数料");
  sameAmount(summary.dispatchTotal, dispatchCast + dispatchStaff + dispatchFee, "派遣支払計");
  const fixedIds = new Set<string>();
  const fixed = array(adjustments.fixedExpenses, "固定経費").reduce((sum, expense) => {
    requireValue(expense, "固定経費を読み込めません。");
    uniqueId(expense.id, fixedIds, "固定経費");
    text(expense.account, "固定経費の科目");
    return sum + amount(expense.amount, "固定経費");
  }, 0);
  const liquorDelivery = adjustments.liquorDeliveryAmount === undefined
    ? dailyLiquorDelivery : amount(adjustments.liquorDeliveryAmount, "酒代納品書分の月締め調整");
  const cardFee = amount(adjustments.cardFee, "カード決済手数料");
  sameAmount(summary.fixed, fixed, "固定経費計");
  sameAmount(summary.liquorDelivery, liquorDelivery, "酒代納品書分");
  sameAmount(summary.cardFee, cardFee, "カード決済手数料");
  sameAmount(summary.total, dailyExpenseTotal + dispatchCast + dispatchStaff + dispatchFee + liquorDelivery + fixed + cardFee, "経費総合計");
  sameAmount(results.sales.cash, cashSales, "月次現金売上");
  sameAmount(results.sales.card, cardSales, "月次カード売上");
  sameAmount(results.sales.total, cashSales + cardSales, "月次合計売上");

  const castIds = new Set<string>();
  const castTotal = array(results.castRewards, "キャスト報酬").reduce((sum, row) => {
    requireValue(row, "キャスト報酬を読み込めません。");
    uniqueId(row.id, castIds, "キャスト報酬");
    text(row.name, "キャスト報酬の氏名");
    requireValue(row.adoptedSystem === "hourlyAndBack" || row.adoptedSystem === "salesReward", `${row.name}の採用報酬方式が正しくありません。`);
    const hourlyAndBack = [row.hourlyPay, row.honShimeiBack, row.banaiShimeiBack, row.dohanBack, row.bottleBack, row.drinkBack]
      .reduce((total, value) => total + amount(value, `${row.name}の時給・バック`), 0);
    sameAmount(row.hourlyAndBack, hourlyAndBack, `${row.name}の時給・バック合計`);
    const salesReward = amount(row.salesReward, `${row.name}の売上報酬`);
    sameAmount(row.adoptedReward, Math.max(hourlyAndBack, salesReward), `${row.name}の採用報酬額`);
    sameAmount(row.adoptedReward, row.adoptedSystem === "salesReward" ? salesReward : hourlyAndBack, `${row.name}の採用報酬方式`);
    sameAmount(row.grossPay, row.adoptedReward + amount(row.beautyAllowance, `${row.name}の美容室手当`), `${row.name}の総支給額`);
    const deductions = [row.dailyPayment, row.advancePayment, row.transportFee, row.withholding]
      .reduce((total, value) => total + amount(value, `${row.name}の控除`), 0);
    sameAmount(row.netPay, row.grossPay - deductions, `${row.name}の差引支給額`, true);
    return sum + row.grossPay;
  }, 0);
  const staffIds = new Set<string>();
  const staffTotal = array(results.staffPayroll, "スタッフ給与").reduce((sum, row) => {
    requireValue(row, "スタッフ給与を読み込めません。");
    uniqueId(row.id, staffIds, "スタッフ給与");
    text(row.name, "スタッフ給与の氏名");
    sameAmount(row.gross, amount(row.hourly, "スタッフ基本給与") + amount(row.sales, "スタッフ売上手当") + amount(row.bottle, "スタッフボトル手当"), `${row.name}のスタッフ総支給額`);
    sameAmount(row.net, row.gross - amount(row.daily, "スタッフ日払い"), `${row.name}のスタッフ差引支給額`, true);
    return sum + row.gross;
  }, 0);
  const driverIds = new Set<string>();
  const driverTotal = array(results.driverPayroll, "ドライバー給与").reduce((sum, row) => {
    requireValue(row, "ドライバー給与を読み込めません。");
    uniqueId(row.id, driverIds, "ドライバー給与");
    text(row.name, "ドライバー給与の氏名");
    sameAmount(row.gross, amount(row.basic, "ドライバー基本給与") + amount(row.remote, "ドライバー遠方手当"), `${row.name}のドライバー総支給額`);
    sameAmount(row.net, row.gross - amount(row.dailyPayment, "ドライバー日払い"), `${row.name}のドライバー差引支給額`, true);
    return sum + row.gross;
  }, 0);
  const introducerIds = new Set<string>();
  const introducerTotal = array(results.introducerPayments, "紹介者支払").reduce((sum, row) => {
    requireValue(row, "紹介者支払を読み込めません。");
    uniqueId(row.id, introducerIds, "紹介者支払");
    text(row.introducer, "紹介者名");
    sameAmount(row.advisory, amount(row.attendanceAdvisory, "出勤顧問料") + amount(row.entryAdvisory, "入店顧問料"), "紹介者顧問料計");
    const salesFee = amount(row.salesFee, "紹介者の売上報酬");
    const grossFee = amount(row.grossFee, "紹介者の総支給額報酬");
    const adoptedFee = row.adopted === "総支給額10%" ? grossFee
      : row.adopted === "売上10%" || row.adopted === "酒代原価引き売上10%" ? salesFee
        : row.adopted === "入店顧問料のみ" ? 0 : undefined;
    requireValue(adoptedFee !== undefined, "紹介者支払の採用報酬方式が正しくありません。");
    sameAmount(row.total, adoptedFee + row.advisory, "紹介者支払計");
    return sum + row.total;
  }, 0);
  sameAmount(results.balance.cast, castTotal, "収支のキャスト報酬");
  sameAmount(results.balance.staff, staffTotal, "収支のスタッフ給与");
  sameAmount(results.balance.driver, driverTotal, "収支のドライバー給与");
  sameAmount(results.balance.introducer, introducerTotal, "収支の紹介者支払");
  sameAmount(results.balance.expenses, summary.total, "収支の経費");
  const totalCosts = castTotal + staffTotal + driverTotal + introducerTotal + summary.total;
  sameAmount(results.balance.totalCosts, totalCosts, "総支出");
  sameAmount(results.balance.profit, results.sales.total - totalCosts, "収支", true);

  if (snapshot) {
    requireValue(snapshot.month === month && Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0, "対象月の確定データが正しくありません。");
    requireValue(Number.isSafeInteger(snapshot.adjustmentsRevision) && snapshot.adjustmentsRevision >= 0
      && snapshot.adjustmentsRevision === (adjustments.revision ?? 0), "経理入力の保存世代が月次確定時と一致しません。");
    const references = array(snapshot.approvedClosings, "確定時の承認済み日次一覧");
    requireValue(references.length === approved.length, "月次確定時の日次データが不足しているか、別の日次データが含まれています。");
    const referenceIds = new Set<string>();
    references.forEach((reference) => {
      requireValue(reference, "確定時の日次参照データを読み込めません。");
      uniqueId(reference.id, referenceIds, "確定時の日次参照データ");
      text(reference.checksum, "確定時の日次チェックサム");
      text(reference.updatedAt, "確定時の日次更新日時");
      const source = approved.find((closing) => closing.id === reference.id);
      requireValue(source && source.checksum === reference.checksum && source.updatedAt === reference.updatedAt,
        "日次データの保存世代が月次確定時と一致しません。");
    });
    const snapshotFields = ["approvedDays", "expenses", "sales", "balance", "castRewards", "staffPayroll", "driverPayroll", "introducerPayments"] as const;
    snapshotFields.forEach((key) => requireValue(JSON.stringify(canonical(results[key])) === JSON.stringify(canonical(snapshot[key])),
      "出力する月次データが確定時の金額と一致しません。"));
  }
  summarizeExpenseIntroducers(results);
}
