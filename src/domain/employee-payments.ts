import type { DailyClosing, DailyEmployeePayment, MonthlyAdjustments, StaffRecord } from "./gms";

export type EmployeePaymentRow = {
  id: string;
  name: string;
  sales: number;
  bottle: number;
  allowanceTotal: number;
  daily: number;
  days: Array<{ businessDate: string; dailyPayment: number }>;
};
export type EmployeePaymentsSummary = {
  rows: EmployeePaymentRow[];
  dailyTotal: number;
  allowanceTotal: number;
};

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
const validName = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
function money(value: unknown, label: string): number {
  requireValue(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER,
    `${label}は0円以上の処理可能な金額で入力してください。`);
  return value;
}
function same(actual: number, expected: number, label: string) {
  money(expected, label);
  requireValue(Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected)) * 8,
    `${label}が明細の合計と一致しません。`);
}
function list(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  requireValue(Array.isArray(value) || object(value), `${label}の保存形式が不正です。`);
  return (Array.isArray(value) ? value : Object.values(value)).filter((row) => row !== undefined && row !== null);
}

/** 保存用JSONと下書きの配列を復元し、支払金額や氏名は変更しない。 */
export function normalizeDailyEmployeePayments(value: unknown): DailyEmployeePayment[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); }
    catch { throw new Error("社員日払いの保存JSONが破損しています。"); }
    requireValue(Array.isArray(value), "社員日払いの保存JSONは明細配列である必要があります。");
    requireValue(value.every((row) => row !== null && row !== undefined), "社員日払いの保存JSONに空の明細があります。");
  }
  const seen = new Set<string>();
  const rows = list(value, "社員日払い").map((row, index) => {
    const label = `社員日払い${index + 1}件目`;
    requireValue(object(row) && validId(row.staffId) && validName(row.name), `${label}の社員IDまたは氏名が不正です。`);
    requireValue(Object.keys(row).every((key) => ["staffId", "name", "dailyPayment"].includes(key)),
      `${label}に社員日払い以外の項目が含まれています。`);
    requireValue(!seen.has(row.staffId), `社員「${row.name}」の日払いが同じ営業日に重複しています。`);
    seen.add(row.staffId);
    return { staffId: row.staffId, name: row.name, dailyPayment: money(row.dailyPayment, `${row.name}の日払い`) };
  });
  money(rows.reduce((sum, row) => sum + row.dailyPayment, 0), "社員日払い合計");
  return rows;
}

export function supportsEmployeePaymentsSnapshot(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  return Boolean(match && (Number(match[1]) > 2 || Number(match[1]) === 2 && Number(match[2]) >= 59));
}

/** 確定済みは保存時の社員明細のみ検証し、現在マスタから補完しない。 */
export function normalizeEmployeePaymentsSummary(value: unknown, month: string): EmployeePaymentsSummary {
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "社員支払の対象月が不正です。");
  requireValue(object(value), "社員支払の月次集計が保存されていません。");
  const seen = new Set<string>();
  const rows = list(value.rows, "社員支払一覧").map((row): EmployeePaymentRow => {
    requireValue(object(row) && validId(row.id) && validName(row.name), "社員支払の社員IDまたは氏名が不正です。");
    requireValue(!seen.has(row.id), `社員「${row.name}」の月次集計が重複しています。`);
    seen.add(row.id);
    const sales = money(row.sales, `${row.name}の売上手当`);
    const bottle = money(row.bottle, `${row.name}のボトル手当`);
    const allowanceTotal = money(row.allowanceTotal, `${row.name}の手当合計`);
    const daily = money(row.daily, `${row.name}の日払い合計`);
    const dates = new Set<string>();
    const days = list(row.days, `${row.name}の日払い内訳`).map((day) => {
      requireValue(object(day) && validDate(day.businessDate) && day.businessDate.startsWith(`${month}-`), `${row.name}の社員日払いの営業日が不正です。`);
      requireValue(!dates.has(day.businessDate), `${row.name}の社員日払いに重複した営業日があります。`);
      dates.add(day.businessDate);
      return { businessDate: day.businessDate, dailyPayment: money(day.dailyPayment, `${row.name}の日払い`) };
    });
    same(allowanceTotal, sales + bottle, `${row.name}の手当合計`);
    same(daily, days.reduce((sum, day) => sum + day.dailyPayment, 0), `${row.name}の日払い合計`);
    return { id: row.id, name: row.name, sales, bottle, allowanceTotal, daily, days };
  });
  const dailyTotal = money(value.dailyTotal, "社員日払い総額");
  const allowanceTotal = money(value.allowanceTotal, "社員手当総額");
  same(dailyTotal, rows.reduce((sum, row) => sum + row.daily, 0), "社員日払い総額");
  same(allowanceTotal, rows.reduce((sum, row) => sum + row.allowanceTotal, 0), "社員手当総額");
  return { rows, dailyTotal, allowanceTotal };
}

export function calculateEmployeePayments(
  closings: DailyClosing[], staff: StaffRecord[], month: string, adjustments: MonthlyAdjustments,
): { summary: EmployeePaymentsSummary; issues: string[] } {
  const rows = new Map<string, EmployeePaymentRow>();
  const issues: string[] = [];
  const masters = new Map(staff.map((row) => [row.id, row]));
  const employeeMasters = staff.filter((row) => row.employmentType === "employee");
  const ensure = (id: string, name: string) => {
    let row = rows.get(id);
    if (!row) {
      let sales = 0, bottle = 0;
      try {
        sales = money(adjustments.staffSalesAllowance[id] ?? 0, `${name}の売上手当`);
        bottle = money(adjustments.staffBottleAllowance[id] ?? 0, `${name}のボトル手当`);
        money(sales + bottle, `${name}の手当合計`);
      } catch (error) { issues.push(error instanceof Error ? error.message : "社員手当の金額が不正です。"); }
      row = { id, name, sales, bottle, allowanceTotal: sales + bottle, daily: 0, days: [] };
      rows.set(id, row);
    }
    return row;
  };
  for (const master of employeeMasters) {
    const present = validDate(master.hiredAt) && master.hiredAt.slice(0, 7) <= month
      && (!master.departedAt || validDate(master.departedAt) && master.departedAt.slice(0, 7) >= month);
    if (master.status === "trial") issues.push(`${master.name}の社員区分と体入区分が一致しません。`);
    if (present || adjustments.staffSalesAllowance[master.id] || adjustments.staffBottleAllowance[master.id]) ensure(master.id, master.name);
  }
  const approved = closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(`${month}-`))
    .sort((left, right) => left.businessDate.localeCompare(right.businessDate) || left.id.localeCompare(right.id));
  for (const closing of approved) {
    try {
      for (const payment of normalizeDailyEmployeePayments(closing.employeePayments)) {
        const master = masters.get(payment.staffId);
        if (master && master.employmentType !== "employee") {
          issues.push(`${closing.businessDate}・${payment.name}の社員日払いIDがアルバイトに紐づいています。`);
        }
        const row = ensure(payment.staffId, master?.name || payment.name);
        if (row.days.some((day) => day.businessDate === closing.businessDate)) {
          issues.push(`${closing.businessDate}・${payment.name}の社員日払いが重複しています。`);
          continue;
        }
        row.days.push({ businessDate: closing.businessDate, dailyPayment: payment.dailyPayment });
        row.daily += payment.dailyPayment;
        if (!master) row.name = payment.name;
      }
    } catch (error) { issues.push(`${closing.businessDate}：${error instanceof Error ? error.message : "社員日払いが不正です。"}`); }
  }
  const summary = { rows: [...rows.values()], dailyTotal: [...rows.values()].reduce((sum, row) => sum + row.daily, 0),
    allowanceTotal: [...rows.values()].reduce((sum, row) => sum + row.allowanceTotal, 0) };
  summary.rows.sort((left, right) => left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id));
  try { normalizeEmployeePaymentsSummary(summary, month); }
  catch (error) { issues.push(error instanceof Error ? error.message : "社員支払の月次集計が不正です。"); }
  return { summary, issues: [...new Set(issues)] };
}
