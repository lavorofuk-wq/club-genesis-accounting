import type { DailyClosing, StaffRecord } from "./gms";
import { validateExpenseExport, type ExpenseExportInput } from "./expense-export";
import { allocateBalancePayroll } from "./balance-allocation";

export type BalanceExportInput = ExpenseExportInput & {
  staff?: StaffRecord[];
  archivedStaff?: StaffRecord[];
};

export type BalanceExportDay = {
  businessDate: string;
  cashSales: number;
  cardSales: number;
  totalSales: number;
  groups: number;
  customers: number;
  honShimeiCount: number;
  jonaiCount: number;
  dohanCount: number;
  castCount: number;
  castHourly: number;
  castSalesReward: number;
  dispatchCastCount: number;
  dispatchCastPayment: number;
  /** 派遣スタッフ支払を含む。 */
  employeeGross: number;
  introducerPayment: number;
  /** 日次経費・派遣手数料・固定費・納品酒代・カード手数料。 */
  expenses: number;
};

export type BalanceExportReport = {
  month: string;
  days: BalanceExportDay[];
  approvedDays: number;
  castDailyAndAdvance: number;
  castTransport: number;
  castWithholding: number;
  castNet: number;
  employeeDaily: number;
  honShimeiSales: number;
  jonaiExtensionSales: number;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function count(value: unknown, label: string): number {
  requireValue(Number.isSafeInteger(value) && Number(value) >= 0, `${label}が正しい整数ではありません。`);
  return Number(value);
}

function amount(value: unknown, label: string): number {
  requireValue(typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER, `${label}の金額が不正です。`);
  return value;
}

const sum = <T,>(rows: T[], value: (row: T) => number) => rows.reduce((total, row) => total + value(row), 0);

function same(actual: number, expected: number, label: string) {
  amount(actual, label);
  amount(expected, label);
  requireValue(Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)) * 16,
    `${label}が月次データと一致しません。出力元データを確認してください。`);
}

/** 人数・本数は店舗全体の保存POSから取得し、派遣の欠落を0人として隠さない。 */
export function balanceDailyCounts(closing: DailyClosing) {
  const label = closing.businessDate;
  const pos = closing.posSnapshot;
  requireValue(pos && pos.businessDate === label && Array.isArray(pos.castWork)
    && Array.isArray(pos.transactions), `${label}の保存POSが不足しているため、派遣人数・同伴本数を確認できません。`);
  requireValue(Array.isArray(closing.casts), `${label}のキャスト出勤を読み込めません。`);
  const saved = new Map<string, DailyClosing["casts"][number]>();
  const masterIds = new Set<string>();
  for (const cast of closing.casts) {
    requireValue(cast && typeof cast.posCastId === "string" && cast.posCastId.length > 0
      && typeof cast.masterId === "string" && cast.masterId.length > 0
      && (cast.kind === "regular" || cast.kind === "trial"), `${label}のキャスト出勤の照合情報が不正です。`);
    requireValue(!saved.has(cast.posCastId) && !masterIds.has(cast.masterId), `${label}のキャスト出勤が重複しています。`);
    saved.set(cast.posCastId, cast);
    masterIds.add(cast.masterId);
  }
  const workIds = new Set<string>();
  let dispatchCastCount = 0;
  for (const work of pos.castWork) {
    requireValue(work && typeof work.castId === "string" && work.castId.length > 0
      && !workIds.has(work.castId), `${label}の保存POSの勤務IDが欠落または重複しています。`);
    requireValue(["regular", "trial", "dispatch"].includes(work.castType), `${label}の保存POSの勤務区分が不正です。`);
    workIds.add(work.castId);
    const cast = saved.get(work.castId);
    if (cast) {
      requireValue(cast.kind === work.castType && cast.name === work.castName,
        `${label}の保存POSとキャスト出勤の名前・区分が一致しません。`);
    } else {
      // 既存の再編集復元仕様と同じく、勤務済み体入で保存キャストがない場合は派遣指定。
      requireValue(work.castType === "trial" || work.castType === "dispatch",
        `${label}の在籍キャスト勤務に対応する店舗データがありません。派遣と推定せず出力を停止します。`);
      dispatchCastCount += 1;
    }
  }
  requireValue([...saved.keys()].every((id) => workIds.has(id)), `${label}のキャスト出勤に対応するPOS勤務がありません。`);
  let honShimeiCount = 0;
  let jonaiCount = 0;
  let dohanCount = 0;
  const transactionIds = new Set<string>();
  for (const transaction of pos.transactions) {
    requireValue(transaction && typeof transaction.transactionId === "string" && transaction.transactionId.length > 0
      && !transactionIds.has(transaction.transactionId) && Array.isArray(transaction.items),
    `${label}の保存POSの会計明細が欠落または重複しています。`);
    transactionIds.add(transaction.transactionId);
    const itemIds = new Set<string>();
    for (const item of transaction.items) {
      requireValue(item && typeof item.itemId === "string" && item.itemId.length > 0 && !itemIds.has(item.itemId)
        && typeof item.isHonShimei === "boolean" && typeof item.isBanaiShimei === "boolean"
        && typeof item.category === "string", `${label}の保存POSの商品区分が欠落または重複しています。`);
      itemIds.add(item.itemId);
      if (item.isHonShimei) honShimeiCount += count(item.quantity, `${label}の本指名本数`);
      if (item.isBanaiShimei) jonaiCount += count(item.quantity, `${label}の場内本数`);
      // 同伴料はキャストごとの商品数量。組数・対象ID数で重ねて数えない。
      if (item.category === "dohan") dohanCount += count(item.quantity, `${label}の同伴本数`);
    }
  }
  requireValue(closing.nominations && pos.nominations, `${label}の指名本数を読み込めません。`);
  same(count(closing.nominations.honShimeiCount, `${label}の本指名本数`), honShimeiCount, `${label}の本指名本数`);
  same(count(closing.nominations.jonaiCount, `${label}の場内本数`), jonaiCount, `${label}の場内本数`);
  same(count(pos.nominations.honShimeiCount, `${label}のPOS本指名本数`), honShimeiCount, `${label}のPOS本指名本数`);
  same(count(pos.nominations.jonaiCount, `${label}のPOS場内本数`), jonaiCount, `${label}のPOS場内本数`);
  requireValue(closing.customers, `${label}の組数・客数を読み込めません。`);
  return {
    groups: count(closing.customers.groupCount, `${label}の組数`),
    customers: count(closing.customers.totalCustomers, `${label}の客数`),
    honShimeiCount, jonaiCount, dohanCount, castCount: saved.size, dispatchCastCount,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** 月次結果を保持した日別帳票。給与・日払い・経費はそれぞれ一度だけ計上する。 */
export function buildBalanceExportReport(input: BalanceExportInput): BalanceExportReport {
  validateExpenseExport(input);
  const { results, snapshot, month } = input;
  if (snapshot) {
    requireValue(JSON.stringify(canonical(results.castSalesReports)) === JSON.stringify(canonical(snapshot.castSalesReports)),
      "キャストの日別売上・勤務データが月次確定時と一致しません。");
  }
  const approved = input.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(`${month}-`))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const payroll = new Map(allocateBalancePayroll(input).byDate.map((day) => [day.businessDate, day]));
  const monthlyExpenses = results.expenses.fixed + results.expenses.liquorDelivery + results.expenses.cardFee;
  // 月額費用は営業日順で最後の承認済み日へまとめる。承認操作の順番や暦の月末ではない。
  const monthlyChargeDate = approved.at(-1)?.businessDate;
  if (monthlyExpenses !== 0 || results.balance.introducer !== 0) {
    requireValue(monthlyChargeDate,
      "対象月の承認済み営業日がないため、月額の紹介料・固定費・納品酒代・カード手数料を日別に計上できません。");
  }
  const days = approved.map((closing): BalanceExportDay => {
    const dailyPayroll = payroll.get(closing.businessDate);
    requireValue(dailyPayroll, `${closing.businessDate}の給与配分結果がありません。`);
    const monthlyDate = closing.businessDate === monthlyChargeDate;
    return {
      businessDate: closing.businessDate,
      cashSales: closing.sales.cashSales,
      cardSales: closing.sales.cardSales,
      totalSales: closing.sales.totalSales,
      ...balanceDailyCounts(closing),
      castHourly: dailyPayroll.castHourly,
      castSalesReward: dailyPayroll.castSalesReward,
      dispatchCastPayment: closing.dispatchCastPayment,
      employeeGross: dailyPayroll.employeeGross + closing.dispatchStaffPayment,
      introducerPayment: monthlyDate ? results.balance.introducer : 0,
      expenses: sum(closing.expenses, (row) => row.amount) + closing.dispatchFee + (monthlyDate ? monthlyExpenses : 0),
    };
  });
  same(sum(days, (row) => row.castHourly + row.castSalesReward), results.balance.cast, "日別キャスト報酬の合計");
  same(sum(days, (row) => row.employeeGross), results.balance.staff + results.balance.driver + results.expenses.dispatchStaff,
    "日別従業員給与の合計");
  same(sum(days, (row) => row.introducerPayment), results.balance.introducer, "日別紹介者支払の合計");
  same(sum(days, (row) => row.expenses), results.expenses.total - results.expenses.dispatchCast - results.expenses.dispatchStaff,
    "日別経費の合計");
  const totalCosts = sum(days, (row) => row.castHourly + row.castSalesReward + row.dispatchCastPayment
    + row.employeeGross + row.introducerPayment + row.expenses);
  same(totalCosts, results.balance.totalCosts, "帳票の総支出");
  same(sum(days, (row) => row.totalSales) - totalCosts, results.balance.profit, "帳票の収支");
  const castDailyAndAdvance = sum(results.castRewards, (row) => row.dailyPayment + row.advancePayment);
  const castTransport = sum(results.castRewards, (row) => row.transportFee);
  const castWithholding = sum(results.castRewards, (row) => row.withholding);
  const castNet = sum(results.castRewards, (row) => row.netPay);
  const employeeDaily = sum(results.staffPayroll, (row) => row.daily) + sum(results.driverPayroll, (row) => row.dailyPayment);
  const employeeNet = sum(results.staffPayroll, (row) => row.net) + sum(results.driverPayroll, (row) => row.net);
  same(castDailyAndAdvance, sum(approved, (closing) => sum(closing.casts,
    (cast) => amount(cast.dailyPayment, "キャスト日払い") + amount(cast.advancePayment, "キャスト立替"))),
  "キャスト日払い・立替合計");
  same(castTransport, sum(approved, (closing) => sum(closing.casts, (cast) => amount(cast.transportFee, "キャスト送迎控除"))),
    "キャスト送迎控除合計");
  // スタッフ/ドライバーの日払い控除後給与と日払いを別々に引き、派遣支払も各1回だけ引く。
  const expandedCash = results.sales.cash - castNet - castWithholding - results.balance.introducer
    - employeeNet - castDailyAndAdvance - employeeDaily - results.expenses.dispatchCast
    - results.expenses.dispatchStaff - results.expenses.dispatchFee - results.expenses.dailyExpenseTotal
    - monthlyExpenses;
  same(expandedCash, results.sales.cash - totalCosts + castTransport, "現状現金残高の控除内訳");
  return {
    month, days, approvedDays: results.approvedDays,
    castDailyAndAdvance, castTransport, castWithholding, castNet, employeeDaily,
    honShimeiSales: sum(results.castRewards, (row) => amount(row.honShimeiSales, "キャスト本指名売上")),
    jonaiExtensionSales: sum(results.castRewards, (row) => amount(row.jonaiExtensionSales, "キャスト場内延長売上")),
  };
}
