import assert from 'node:assert/strict';

// 承認済みVer2.43追加分だけを除去し、既存保護式の過去指紋を維持する。
export function withoutAccountingExpenseRules(value) {
  const copy = structuredClone(value);
  const workspace = copy.$workspace;
  assert.ok(workspace.accountingAdjustments.$month.expenseInputs);
  delete workspace.accountingAdjustments.$month.expenseInputs;
  const expenses = workspace.accountingMonthSnapshots.$month.$revision.expenses;
  assert.ok(expenses.accountingExpenseInputs);
  delete expenses.accountingExpenseInputs;
  const version = "newData.parent().child('calculationVersion').val().matches(/^(2[.](4[3-9]|[5-9][0-9]|[1-9][0-9]{2,})[.][0-9]+|([3-9]|[1-9][0-9]+)[.][0-9]+[.][0-9]+)$/)";
  const number = (field) => "newData.child('" + field + "').isNumber() && newData.child('" + field + "').val() >= 0 && newData.child('" + field + "').val() <= 9007199254740991 && newData.child('" + field + "').val() % 1 === 0";
  const fields = "newData.hasChildren(['accountingExpenseTotal', 'consumptionTax']) && " + number('accountingExpenseTotal') + " && " + number('consumptionTax')
    + " && newData.child('consumptionTax').val() * 100 <= newData.parent().child('sales/total').val() * 3 && (newData.child('consumptionTax').val() + 1) * 100 > newData.parent().child('sales/total').val() * 3";
  const suffix = " + (newData.child('accountingExpenseTotal').exists() ? newData.child('accountingExpenseTotal').val() : 0) + (newData.child('consumptionTax').exists() ? newData.child('consumptionTax').val() : 0)"
    + " && (" + version + " ? (" + fields + ") : (!newData.child('accountingExpenseTotal').exists() && !newData.child('consumptionTax').exists() && !newData.child('accountingExpenseInputs').exists()))";
  assert.ok(expenses['.validate'].endsWith(suffix), '承認された新経費の合計・必須項目・端数検証式');
  expenses['.validate'] = expenses['.validate'].slice(0, -suffix.length);
  return copy;
}
