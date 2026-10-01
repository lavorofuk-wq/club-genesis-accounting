import type { AccountingExpenseInput, DailyClosing, ExpenseCategory } from "./gms";

export const EXPENSE_LABELS: Record<ExpenseCategory, string> = {
  beautyTrial: "美容室手当", introduction: "紹介料", advertising: "広告等", supplies: "備品・消耗品他",
  entertainment: "交際費・プレゼント等", liquor: "酒代", transportOther: "交通費・その他",
};
/** 固定経費の新規入力で選択する科目。酒代・カード手数料は専用欄で入力する。 */
export const FIXED_EXPENSE_ACCOUNTS: readonly string[] = ["賃料", "カラオケ", "おしぼり", "リースキン", "固定電話", "西部ガス", "USEN"];
/** 経費表XLSXに常設する固定費の行。 */
export const EXPENSE_WORKBOOK_FIXED_ACCOUNTS: readonly string[] = [...FIXED_EXPENSE_ACCOUNTS, "酒代", "カード決済手数料"];

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Firebase表現だけを復元する。不正行や端数を黙って削除・丸めない。 */
export function normalizeAccountingExpenseInputs(value: unknown): AccountingExpenseInput[] {
  if (value === undefined || value === null) return [];
  requireValue(Array.isArray(value) || object(value), "経費入力の保存形式が不正です。");
  if (!Array.isArray(value)) requireValue(Object.entries(value).every(([key, row]) => object(row) && row.id === key),
    "経費入力の保存キーと入力IDが一致しません。");
  const rows: unknown[] = Array.isArray(value) ? value.filter((row) => row != null) : Object.values(value);
  const seen = new Set<string>();
  const inputs = rows.map((row, index): AccountingExpenseInput => {
    const label = `経費入力${index + 1}件目`;
    requireValue(object(row) && typeof row.id === "string" && /^[A-Za-z0-9_-]+$/.test(row.id), `${label}のIDが不正です。`);
    requireValue(!seen.has(row.id), `${label}の入力IDが重複しています。`);
    seen.add(row.id);
    requireValue(typeof row.category === "string" && Object.hasOwn(EXPENSE_LABELS, row.category), `${label}の勘定科目が不正です。`);
    requireValue(text(row.payee), `${label}の支払先を入力してください。`);
    requireValue(typeof row.amount === "number" && Number.isSafeInteger(row.amount) && row.amount >= 0,
      `${label}の金額は0円以上の安全な整数で入力してください。`);
    requireValue(row.businessDate === undefined || date(row.businessDate), `${label}の営業日が不正です。`);
    return { id: row.id, category: row.category as ExpenseCategory, payee: row.payee, amount: row.amount,
      ...(row.businessDate === undefined ? {} : { businessDate: row.businessDate as string }) };
  });
  requireValue(Number.isSafeInteger(inputs.reduce((sum, row) => sum + row.amount, 0)), "経費入力の合計金額が処理可能な範囲を超えています。");
  return inputs;
}

export function validateAccountingExpenseInputs(value: unknown, month: string, closings?: DailyClosing[]): AccountingExpenseInput[] {
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "経費入力の対象月が不正です。");
  const inputs = normalizeAccountingExpenseInputs(value);
  const dates = closings && new Set(closings.filter((row) => row.status === "approved").map((row) => row.businessDate));
  inputs.forEach((row) => {
    if (row.businessDate === undefined) return;
    requireValue(row.businessDate.startsWith(`${month}-`), `経費入力「${row.payee}」の営業日が対象月と一致しません。`);
    requireValue(!dates || dates.has(row.businessDate), `経費入力「${row.payee}」の指定日に承認済み営業日がありません。`);
  });
  return inputs;
}

export const DEFAULT_CONSUMPTION_TAX_RATE = 3;

/** 百分率。入力された精度を保ち、小数第3位以下や不正値を黙って丸めない。 */
export function validateConsumptionTaxRate(value: unknown): number {
  if (value === undefined) return DEFAULT_CONSUMPTION_TAX_RATE;
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    && Math.round(value * 100) / 100 === value, "預かり消費税率は0～100%の範囲で小数2桁まで入力してください。");
  return value;
}

/** 月額売上へ選択月の税率を一度掛け、1円未満を切り捨てる。 */
export function consumptionTaxForSales(totalSales: number, rate: number = DEFAULT_CONSUMPTION_TAX_RATE): number {
  requireValue(Number.isFinite(totalSales) && totalSales >= 0 && totalSales <= Number.MAX_SAFE_INTEGER,
    "預かり消費税の計算対象売上が不正です。");
  const checkedRate = validateConsumptionTaxRate(rate);
  const basisPoints = BigInt(Math.round(checkedRate * 100));
  // 0.29等の二進表現誤差を除いた整数bpsで、中間積の桁あふれを避ける。
  if (Number.isSafeInteger(totalSales)) return Number(BigInt(totalSales) * basisPoints / BigInt(10000));
  // Ver2.43までの小数売上の固定3%は、当時の保存税額を変更しない。
  if (checkedRate === DEFAULT_CONSUMPTION_TAX_RATE) return Math.floor(totalSales * 0.03);
  const [coefficient, exponent = "0"] = String(totalSales).split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction) * basisPoints * (scale < 0 ? BigInt(10) ** BigInt(-scale) : BigInt(1));
  const denominator = BigInt(10000) * (scale > 0 ? BigInt(10) ** BigInt(scale) : BigInt(1));
  return Number(numerator / denominator);
}
