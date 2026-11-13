import type { DailyClosing } from "./gms";
import type { MonthlyAccountingResults, MonthlyAccountingSnapshot } from "./month-accounting";
import { normalizeEmployeePaymentsSummary, supportsEmployeePaymentsSnapshot, type EmployeePaymentsSummary } from "./employee-payments";

type Input = { month: string; closings: DailyClosing[]; results: Pick<MonthlyAccountingResults, "employeePayments">; snapshot?: MonthlyAccountingSnapshot };
const requireValue = (condition: unknown, message: string): void => { if (!condition) throw new Error(message); };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
const same = (a: number, b: number) => Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8;

/** 社員給与を作らず、確定時の社員日払い・月額手当を帳票へ渡す。 */
export function employeePaymentsForExport({ month, closings, results, snapshot }: Input): EmployeePaymentsSummary {
  requireValue(/^\d{4}-(0[1-9]|1[0-2])$/.test(month), "社員支払の対象月が不正です。");
  if (snapshot) {
    requireValue(snapshot.month === month, "社員支払の確定月が一致しません。");
    requireValue(Array.isArray(snapshot.approvedClosings), "社員支払の確定時の日次参照が不正です。");
    requireValue(supportsEmployeePaymentsSnapshot(snapshot.calculationVersion)
      ? snapshot.employeePayments !== undefined : snapshot.employeePayments === undefined,
    "社員支払の保存内容が確定時の計算版と一致しません。");
    requireValue(JSON.stringify(canonical(results.employeePayments)) === JSON.stringify(canonical(snapshot.employeePayments)),
      "社員支払が確定時の保存データと一致しません。");
  }
  const summary = results.employeePayments === undefined ? { rows: [], dailyTotal: 0, allowanceTotal: 0 }
    : normalizeEmployeePaymentsSummary(results.employeePayments, month);
  const references = new Map(snapshot?.approvedClosings.map((row) => [row.id, row]));
  const originals = closings.filter((closing) => closing.status === "approved" && closing.businessDate.startsWith(`${month}-`)
    && (!snapshot || references.get(closing.id)?.checksum === closing.checksum && references.get(closing.id)?.updatedAt === closing.updatedAt));
  const verifiedDates = new Set<string>();
  const seen = new Map<string, number>();
  const byId = new Map(summary.rows.map((row) => [row.id, row]));
  for (const closing of originals) {
    requireValue(!verifiedDates.has(closing.businessDate), "社員支払の承認済み営業日が重複しています。");
    verifiedDates.add(closing.businessDate);
    requireValue(closing.employeePayments === undefined || Array.isArray(closing.employeePayments), "社員日払いの明細が不正です。");
    for (const payment of closing.employeePayments ?? []) {
      requireValue(payment && typeof payment.staffId === "string" && payment.staffId.length > 0
        && typeof payment.name === "string" && payment.name.trim().length > 0
        && Number.isFinite(payment.dailyPayment) && payment.dailyPayment >= 0 && payment.dailyPayment <= Number.MAX_SAFE_INTEGER,
      "社員日払いの氏名・金額が不正です。");
      const key = `${closing.businessDate}/${payment.staffId}`;
      requireValue(!seen.has(key), `${closing.businessDate}の社員日払いが重複しています。`);
      requireValue(!closing.staffWork.some((work) => work.staffId === payment.staffId), "同じ社員が時給勤務にも含まれています。");
      seen.set(key, payment.dailyPayment);
      const day = byId.get(payment.staffId)?.days.find((entry) => entry.businessDate === closing.businessDate);
      requireValue(day && same(day.dailyPayment, payment.dailyPayment), `${payment.name} ${closing.businessDate}の社員日払いが月次内訳と一致しません。`);
    }
  }
  const complete = !snapshot || originals.length === snapshot.approvedClosings.length;
  for (const row of summary.rows) for (const day of row.days) {
    if (!complete && !verifiedDates.has(day.businessDate)) continue;
    const original = seen.get(`${day.businessDate}/${row.id}`);
    requireValue(original !== undefined && same(original, day.dailyPayment), `${row.name} ${day.businessDate}の社員日払い原本が月次内訳と一致しません。`);
  }
  if (complete) requireValue(same([...seen.values()].reduce((sum, value) => sum + value, 0), summary.dailyTotal),
    "社員日払い合計が日次データと一致しません。");
  return summary;
}
