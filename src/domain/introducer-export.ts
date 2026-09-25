import type { CastReward, CastSalesReport, IntroducerFeeType } from "./gms";
import { groupIntroducerPayments } from "./expense-export";
import type { IntroducerPaymentRow, MonthlyAccountingResults } from "./month-accounting";

export type IntroducerExportResults = Pick<MonthlyAccountingResults,
  "castRewards" | "castSalesReports" | "introducerPayments" | "warnings" | "balance"> & { month?: string };

export type IntroducerExportRemuneration = {
  baseLabel: "基本給 計" | "売上報酬";
  basePay: number;
  backs: number | null;
  allowance: number;
  grossPay: number;
  deductions: number;
  withholding: number;
  netPay: number;
};

type SalesDetail = {
  days: Array<{ businessDate: string; honShimeiCount: number; sales: number }>;
  salesTotal: number;
  honShimeiCount: number;
  salesFee: number;
};

type CastDetail = {
  name: string;
  attendanceDays: number;
  adopted: "売上10%" | "総支給額10%" | "入店顧問料のみ";
  advisory: number;
  total: number;
};

export type IntroducerExportCast = CastDetail & (
  | { layout: "gross"; remuneration: IntroducerExportRemuneration; grossFee: number }
  | ({ layout: "sales" } & SalesDetail)
  | ({ layout: "comparison"; remuneration: IntroducerExportRemuneration; grossFee: number } & SalesDetail)
);

/** 外部へ渡す帳票用データには、人物ID・原価・内部の契約種別を含めない。 */
export type IntroducerExport = {
  month: string;
  sheets: Array<{ name: string; total: number; casts: IntroducerExportCast[] }>;
};

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function amount(value: unknown, label: string, signed = false): number {
  requireValue(typeof value === "number" && Number.isFinite(value)
    && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (signed || value >= 0), `${label}の金額を確認できません。`);
  return value;
}

function same(actual: unknown, expected: number, label: string, signed = false) {
  const value = amount(actual, label, signed);
  amount(expected, label, signed);
  requireValue(Math.abs(value - expected) <= Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(expected)) * 16,
    `${label}が保存済み内訳と一致しません。月次データを確認してください。`);
}

function count(value: unknown, label: string): number {
  requireValue(Number.isSafeInteger(value) && Number(value) >= 0, `${label}を確認できません。`);
  return Number(value);
}

function named(value: unknown, label: string): asserts value is string {
  requireValue(typeof value === "string" && value.trim().length > 0, `${label}が保存されていません。`);
}

function rows<T>(value: T[], label: string): T[] {
  requireValue(Array.isArray(value), `${label}が保存されていません。推測せず出力を中止しました。`);
  return value;
}

function index<T extends { id: string }>(source: T[], label: string): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const row of rows(source, label)) {
    named(row?.id, `${label}のID`);
    requireValue(!indexed.has(row.id), `${label}のIDが重複しています。`);
    indexed.set(row.id, row);
  }
  return indexed;
}

const feeTypes = new Set<IntroducerFeeType>(["sales10", "netSales10", "gross10", "higherSalesGross10", "higherNetSalesGross10"]);
const isNet = (feeType: IntroducerFeeType) => feeType === "netSales10" || feeType === "higherNetSalesGross10";

function remuneration(reward: CastReward | undefined, label: string): IntroducerExportRemuneration {
  if (!reward) return { baseLabel: "基本給 計", basePay: 0, backs: 0, allowance: 0, grossPay: 0, deductions: 0, withholding: 0, netPay: 0 };
  requireValue(reward.adoptedSystem === "hourlyAndBack" || reward.adoptedSystem === "salesReward", `${label}の採用報酬方式が保存されていません。`);
  const hourly = amount(reward.hourlyPay, `${label}の基本給`);
  const backs = [reward.honShimeiBack, reward.banaiShimeiBack, reward.dohanBack, reward.bottleBack, reward.drinkBack]
    .reduce((sum, value) => sum + amount(value, `${label}のバック`), 0);
  const allowance = amount(reward.beautyAllowance, `${label}の手当て等`);
  const deductions = [reward.dailyPayment, reward.advancePayment, reward.transportFee]
    .reduce((sum, value) => sum + amount(value, `${label}の日払い・その他`), 0);
  const withholding = amount(reward.withholding, `${label}の源泉所得税`);
  const sales = reward.adoptedSystem === "salesReward";
  same(reward.hourlyAndBack, hourly + backs, `${label}の時給・バック合計`);
  same(reward.adoptedReward, sales ? amount(reward.salesReward, `${label}の売上報酬`) : reward.hourlyAndBack, `${label}の採用報酬`);
  same(reward.grossPay, reward.adoptedReward + allowance, `${label}の総支給額`);
  same(reward.netPay, reward.grossPay - deductions - withholding, `${label}の差引支給額`, true);
  return { baseLabel: sales ? "売上報酬" : "基本給 計", basePay: sales ? reward.adoptedReward : hourly,
    backs: sales ? null : backs, allowance, grossPay: reward.grossPay, deductions, withholding, netPay: reward.netPay };
}

function dailySales(report: CastSalesReport | undefined, reward: CastReward | undefined, payment: IntroducerPaymentRow,
  feeType: IntroducerFeeType, month: string): SalesDetail {
  if (!reward) {
    requireValue(!report, `${payment.cast}の報酬と日別明細が一致しません。`);
    return { days: [], salesTotal: 0, honShimeiCount: 0, salesFee: payment.salesFee };
  }
  requireValue(report, `${payment.cast}の日別売上明細が保存されていません。推測せず出力を中止しました。`);
  requireValue(report.totals, `${payment.cast}の日別売上明細の月合計が保存されていません。`);
  const grouped = new Map<string, { businessDate: string; honShimeiCount: number; sales: number }>();
  let originalSales = 0;
  let originalCost = 0;
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  for (const day of rows(report.days, `${payment.cast}の日別売上明細`)) {
    requireValue(day && typeof day.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.businessDate)
      && day.businessDate.startsWith(`${month}-`) && Number(day.businessDate.slice(8)) >= 1 && Number(day.businessDate.slice(8)) <= lastDay,
    `${payment.cast}の日別売上明細の営業日が対象月と一致しません。`);
    const label = `${payment.cast} ${day.businessDate}`;
    const sales = amount(day.honShimeiSales, `${label}の本指名売上`);
    const cost = isNet(feeType) ? amount(day.honShimeiLiquorCost, `${label}の本指名売上の計算内訳`) : 0;
    const nominations = count(day.honShimeiCount, `${label}の本指名本数`);
    originalSales += sales;
    originalCost += cost;
    const output = grouped.get(day.businessDate) || { businessDate: day.businessDate, honShimeiCount: 0, sales: 0 };
    output.honShimeiCount += nominations;
    output.sales += sales - cost;
    grouped.set(day.businessDate, output);
  }
  const days = [...grouped.values()].sort((left, right) => left.businessDate.localeCompare(right.businessDate));
  same(reward.days, days.length, `${payment.cast}の出勤日数`);
  same(report.attendanceDays, days.length, `${payment.cast}の日別明細の出勤日数`);
  same(report.totals.attendanceDays, days.length, `${payment.cast}の月合計の出勤日数`);
  same(reward.honShimeiSales, originalSales, `${payment.cast}の本指名売上合計`);
  same(report.totals.honShimeiSales, originalSales, `${payment.cast}の日別明細の売上合計`);
  if (isNet(feeType)) {
    same(reward.honShimeiLiquorCost, originalCost, `${payment.cast}の売上計算内訳`);
    same(payment.honShimeiLiquorCost, originalCost, `${payment.cast}の支払計算内訳`);
    same(report.totals.honShimeiLiquorCost, originalCost, `${payment.cast}の日別明細の計算内訳合計`);
  }
  const salesTotal = amount(days.reduce((sum, day) => sum + day.sales, 0), `${payment.cast}の売上合計`, true);
  const honShimeiCount = count(days.reduce((sum, day) => sum + day.honShimeiCount, 0), `${payment.cast}の本指名本数合計`);
  same(report.totals.honShimeiCount, honShimeiCount, `${payment.cast}の日別明細の本指名本数合計`);
  // 日別の符号は保持する。支払計算だけの月間下限0円は保存済み基礎額との照合に使う。
  same(payment.salesBase, Math.max(0, salesTotal), `${payment.cast}の紹介料計算基礎額`);
  return { days, salesTotal, honShimeiCount, salesFee: payment.salesFee };
}

/** 承認済み月次結果／確定snapshotから転記する。現在マスタや報酬計算を参照しない。 */
export function buildIntroducerExport(results: IntroducerExportResults, month: string): IntroducerExport {
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "対象月が正しくありません。");
  requireValue(results && (results.month === undefined || results.month === month), "保存済み月次データの対象月が一致しません。");
  requireValue(rows(results.warnings, "月次データの警告").length === 0, "月次データの警告を解消してから出力してください。");
  const rewards = index(results.castRewards, "キャスト報酬");
  const reports = index(results.castSalesReports, "キャスト日別売上明細");
  const groups = groupIntroducerPayments(results);
  requireValue(groups.length > 0, "対象月の紹介者支払データがありません。");
  const sheets = groups.map((group) => ({ name: group.name, total: group.total, casts: group.rows.map((payment): IntroducerExportCast => {
    named(payment.cast, "紹介者支払のキャスト名");
    requireValue(feeTypes.has(payment.feeType as IntroducerFeeType), `${payment.cast}の紹介者報酬形態が保存されていません。推測せず出力を中止しました。`);
    const feeType = payment.feeType as IntroducerFeeType;
    const candidates = payment.castId ? [payment.castId] : [...rewards.keys()].filter((id) => payment.id === `${group.id}_${id}`);
    if (!candidates.length) {
      const generated = /^(introducer_[0-9a-f]{32})_(cast_[0-9a-f]{32})$/.exec(payment.id);
      if (generated?.[1] === group.id) candidates.push(generated[2]);
    }
    requireValue(candidates.length === 1, `${payment.cast}の保存済みキャストIDを一意に確認できません。`);
    const reward = rewards.get(candidates[0]);
    const report = reports.get(candidates[0]);
    for (const key of ["salesBase", "salesFee", "grossBase", "grossFee", "attendanceAdvisory", "entryAdvisory", "advisory", "total"] as const) {
      amount(payment[key], `${payment.cast}の紹介者支払内訳`);
    }
    same(payment.advisory, payment.attendanceAdvisory + payment.entryAdvisory, `${payment.cast}の顧問料合計`);
    const attendanceDays = reward ? count(reward.days, `${payment.cast}の出勤日数`) : 0;
    const salesLabel = isNet(feeType) ? "酒代原価引き売上10%" : "売上10%";
    let adopted: IntroducerExportCast["adopted"];
    if (!reward) {
      requireValue(payment.adopted === "入店顧問料のみ" && payment.entryAdvisory > 0
        && [payment.salesBase, payment.salesFee, payment.grossBase, payment.grossFee, payment.attendanceAdvisory].every((value) => value === 0)
        && !report, `${payment.cast}のキャスト報酬が保存されていません。推測せず出力を中止しました。`);
      adopted = "入店顧問料のみ";
    } else {
      same(payment.grossBase, amount(reward.grossPay, `${payment.cast}の総支給額`), `${payment.cast}の紹介料対象総支給額`);
      const allowed = feeType === "gross10" ? ["総支給額10%"]
        : feeType === "sales10" || feeType === "netSales10" ? [salesLabel] : ["総支給額10%", salesLabel];
      requireValue(allowed.includes(payment.adopted), `${payment.cast}の紹介者報酬の採用方式を確認できません。`);
      adopted = payment.adopted === "総支給額10%" ? "総支給額10%" : "売上10%";
      if (feeType === "higherSalesGross10" || feeType === "higherNetSalesGross10") {
        requireValue((adopted === "売上10%" ? payment.salesFee : payment.grossFee) === Math.max(payment.salesFee, payment.grossFee),
        `${payment.cast}の紹介者報酬の採用額が保存済み比較額と一致しません。`);
      }
    }
    const selectedFee = adopted === "入店顧問料のみ" ? 0 : adopted === "売上10%" ? payment.salesFee : payment.grossFee;
    same(payment.total, selectedFee + payment.advisory, `${payment.cast}の紹介者支払合計`);
    const common: CastDetail = { name: payment.cast, attendanceDays, adopted, advisory: payment.advisory, total: payment.total };
    if (feeType === "gross10") return { ...common, layout: "gross", remuneration: remuneration(reward, payment.cast), grossFee: payment.grossFee };
    const sales = dailySales(report, reward, payment, feeType, month);
    if (feeType === "sales10" || feeType === "netSales10") return { ...common, layout: "sales", ...sales };
    return { ...common, layout: "comparison", remuneration: remuneration(reward, payment.cast), grossFee: payment.grossFee, ...sales };
  }) }));
  requireValue(results.balance, "月次の紹介者支払総額が保存されていません。");
  same(results.balance.introducer, sheets.reduce((sum, sheet) => sum + sheet.total, 0), "月次の紹介者支払総額");
  return { month, sheets };
}
