import type { CastMember, FinalizedClosing } from "./types";

export type CastRewardRow = {
  key: string;
  name: string;
  days: number;
  hours: number;
  hourlyRate: number;
  hourlyPay: number;
  honShimeiSales: number;
  jonaiExtensionSales: number;
  attributedSales: number;
  allowances: number;
  payable: number;
};

const number = (value: unknown) => Number(value || 0);
export const monthOf = (date: string) => date.slice(0, 7);
export const rowsForMonth = (rows: FinalizedClosing[], month: string) =>
  rows.filter((row) => monthOf(row.businessDate) === month);

const castId = (row: Record<string, unknown>) =>
  String(row.castId || row.posCastId || row.id || row.castName || row.name || "");
const castName = (row: Record<string, unknown>) =>
  String(row.castName || row.name || row.castId || row.posCastId || row.id || "名称未設定");

export function calculateCastRewards(
  closings: FinalizedClosing[],
  members: CastMember[]
): CastRewardRow[] {
  const rows = new Map<string, CastRewardRow>();
  const memberBySource = new Map(members.map((member) => [member.posCastId, member]));
  const ensure = (id: string, name: string) => {
    const member = memberBySource.get(id);
    const key = member?.personKey || member?.id || id || name;
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        name: member?.name || name,
        days: 0,
        hours: 0,
        hourlyRate: number(member?.guaranteedHourlyRate),
        hourlyPay: 0,
        honShimeiSales: 0,
        jonaiExtensionSales: 0,
        attributedSales: 0,
        allowances: 0,
        payable: 0
      });
    }
    return rows.get(key)!;
  };

  closings.forEach((closing) => {
    const worked = new Set<string>();
    closing.castWork.forEach((work) => {
      const raw = work as Record<string, unknown>;
      const id = castId(raw);
      const target = ensure(id, castName(raw));
      target.hours += number(work.hours);
      if (!worked.has(target.key)) {
        target.days += 1;
        worked.add(target.key);
      }
    });
    closing.castSales.forEach((sales) => {
      const raw = sales as Record<string, unknown>;
      const target = ensure(castId(raw), castName(raw));
      target.honShimeiSales += number(sales.honShimeiSales);
      target.jonaiExtensionSales += number(sales.jonaiExtensionSales);
      target.attributedSales += number(sales.totalAttributedSales)
        || number(sales.honShimeiSales) + number(sales.jonaiExtensionSales);
    });
    closing.allowances.forEach((allowance) => {
      const raw = allowance as Record<string, unknown>;
      const id = castId(raw);
      if (id) ensure(id, castName(raw)).allowances += number(allowance.amount);
    });
  });
  return [...rows.values()].map((row) => ({
    ...row,
    hourlyPay: Math.round(row.hourlyRate * row.hours),
    payable: Math.round(row.hourlyRate * row.hours) + row.allowances
  })).sort((a, b) => a.name.localeCompare(b.name, "ja"));
}

export function closingTotals(closing: FinalizedClosing) {
  const expense = closing.expenses.reduce((sum, row) => sum + number(row.amount), 0);
  const allowance = closing.allowances.reduce((sum, row) => sum + number(row.amount), 0);
  return {
    sales: number(closing.sales.totalSales),
    cash: number(closing.sales.cashSales),
    card: number(closing.sales.cardSales),
    groups: number(closing.customers.groupCount),
    customers: number(closing.customers.totalCustomers),
    expense,
    allowance,
    profit: number(closing.sales.totalSales) - expense - allowance
  };
}
