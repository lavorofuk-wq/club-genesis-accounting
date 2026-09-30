import assert from 'node:assert/strict';

const number = (field) => "newData.child('" + field + "').isNumber() && newData.child('" + field + "').val() >= 0 && newData.child('" + field + "').val() <= 9007199254740991 && newData.child('" + field + "').val() % 1 === 0";
const expenseVersion = "newData.parent().child('calculationVersion').val().matches(/^(2[.](4[3-9]|[5-9][0-9]|[1-9][0-9]{2,})[.][0-9]+|([3-9]|[1-9][0-9]+)[.][0-9]+[.][0-9]+)$/)";
const rateVersion = "newData.parent().child('calculationVersion').val().matches(/^(2[.](4[4-9]|[5-9][0-9]|[1-9][0-9]{2,})[.][0-9]+|([3-9]|[1-9][0-9]+)[.][0-9]+[.][0-9]+)$/)";
const totalSuffix = " + (newData.child('accountingExpenseTotal').exists() ? newData.child('accountingExpenseTotal').val() : 0) + (newData.child('consumptionTax').exists() ? newData.child('consumptionTax').val() : 0)";
const savedAmounts = "newData.hasChildren(['accountingExpenseTotal', 'consumptionTax']) && " + number('accountingExpenseTotal') + " && " + number('consumptionTax');
const legacyTax = "newData.child('consumptionTax').val() * 100 <= newData.parent().child('sales/total').val() * 3 && (newData.child('consumptionTax').val() + 1) * 100 > newData.parent().child('sales/total').val() * 3";
const noAccountingExpenses = "!newData.child('accountingExpenseTotal').exists() && !newData.child('consumptionTax').exists() && !newData.child('accountingExpenseInputs').exists()";

const roundNonNegative = (value) => `(${value} - (${value} % 1) + ((${value} % 1) >= 0.5 ? 1 : 0))`;
export function consumptionTaxRateValidation(path) {
  const rate = `${path}.val()`;
  return `${path}.isNumber() && ${rate} >= 0 && ${rate} <= 100 && ${rate} === ${roundNonNegative(`(${rate} * 100)`)} / 100`;
}

function variableTaxValidation() {
  const sales = "newData.parent().child('sales/total').val()";
  const tax = "newData.child('consumptionTax').val()";
  const ratePath = "newData.child('consumptionTaxRate')";
  const rate = `${ratePath}.val()`;
  const bp = roundNonNegative(`(${rate} * 100)`);
  const integer = `(${sales} - (${sales} % 1))`;
  const residue = `(${integer} % 10000)`;
  const base = `(((${integer} - ${residue}) / 10000) * ${bp})`;
  const taxResidue = `(${tax} - ${base})`;
  const fraction = `(${sales} % 1)`;
  const cents = roundNonNegative(`(${fraction} * 100)`);
  const integerProduct = `(${residue} * ${bp})`;
  const centsProduct = `((${residue} * 100 + ${cents}) * ${bp})`;
  const fractionalProduct = `(${integerProduct} + ${fraction} * ${bp})`;
  const integerBounds = `${taxResidue} * 10000 <= ${integerProduct} && (${taxResidue} + 1) * 10000 > ${integerProduct}`;
  const centsBounds = `${taxResidue} * 1000000 <= ${centsProduct} && (${taxResidue} + 1) * 1000000 > ${centsProduct}`;
  // 銭未満や超高額の旧売上では最短10進表記とIEEE演算が異なる。
  // 積の1e-6（税額で1e-10円）と入力売上の機械精度分だけ許容し、正答を拒否しない。
  // この境界内の隣接税額はdomain/snapshotの厳密照合でも検査する。
  const tolerance = `(0.000001 + ${sales} * 0.0000000000000002220446049250313 * ${bp})`;
  const fractionalBounds = `${taxResidue} * 10000 <= ${fractionalProduct} + ${tolerance} && (${taxResidue} + 1) * 10000 > ${fractionalProduct} - ${tolerance}`;
  const centsExact = `${sales} < 70368744177664 && ${integer} + ${cents} / 100 === ${sales}`;
  const legacyFractionBounds = `${tax} <= ${sales} * 0.03 && (${tax} + 1) > ${sales} * 0.03`;
  return `${consumptionTaxRateValidation(ratePath)} && newData.parent().child('sales/total').isNumber() && ${sales} >= 0 && ${sales} <= 9007199254740991 && (${sales} % 1 === 0 ? (${integerBounds}) : (${rate} === 3 ? (${legacyFractionBounds}) : ((${centsExact}) ? (${centsBounds}) : (${fractionalBounds}))))`;
}

export function accountingExpenseRuleSuffix(variableRate = true) {
  const taxValidation = variableRate
    ? `(${rateVersion} ? (${variableTaxValidation()}) : (!newData.child('consumptionTaxRate').exists() && ${legacyTax}))`
    : legacyTax;
  const absentRate = variableRate ? " && !newData.child('consumptionTaxRate').exists()" : "";
  return totalSuffix + ` && (${expenseVersion} ? (${savedAmounts} && ${taxValidation}) : (${noAccountingExpenses}${absentRate}))`;
}

// 承認済みVer2.43/2.44追加分だけを除去し、既存保護式の過去指紋を維持する。
export function withoutAccountingExpenseRules(value) {
  const copy = structuredClone(value);
  const workspace = copy.$workspace;
  assert.ok(workspace.accountingAdjustments.$month.expenseInputs);
  delete workspace.accountingAdjustments.$month.expenseInputs;
  assert.deepEqual(workspace.accountingAdjustments.$month.consumptionTaxRate,
    { '.validate': consumptionTaxRateValidation('newData') }, '月別税率の範囲・小数2桁検証式');
  delete workspace.accountingAdjustments.$month.consumptionTaxRate;
  const expenses = workspace.accountingMonthSnapshots.$month.$revision.expenses;
  assert.ok(expenses.accountingExpenseInputs);
  delete expenses.accountingExpenseInputs;
  const suffix = accountingExpenseRuleSuffix();
  assert.ok(expenses['.validate'].endsWith(suffix), '承認された新経費の合計・税率・世代・端数検証式');
  expenses['.validate'] = expenses['.validate'].slice(0, -suffix.length);
  return copy;
}
