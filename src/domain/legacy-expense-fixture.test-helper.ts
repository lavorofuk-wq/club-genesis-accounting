import type { MonthlyAccountingResults } from "./month-accounting";

/** 旧計算版fixtureを当時の経費構成に戻す。新規計算の税を旧確定に後付けしない。 */
export function removeNewExpensesForLegacy<T extends Pick<MonthlyAccountingResults, "expenses" | "balance">>(result: T): T {
  const difference = (result.expenses.accountingExpenseTotal ?? 0) + (result.expenses.consumptionTax ?? 0);
  delete result.expenses.accountingExpenseInputs;
  delete result.expenses.accountingExpenseTotal;
  delete result.expenses.consumptionTax;
  delete result.expenses.consumptionTaxRate;
  result.expenses.total -= difference;
  result.balance.expenses -= difference;
  result.balance.totalCosts -= difference;
  result.balance.profit += difference;
  return result;
}
