import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const domain = {};
const domainSource = await readFile(new URL("../src/domain/accounting-expenses.ts", import.meta.url), "utf8");
new Function("exports", ts.transpileModule(domainSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(domain);
const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules.$workspace;
class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  val() { return this.path.reduce((v, key) => v?.[key], this.tree) ?? null; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  exists() { return this.val() !== null; }
  isNumber() { return typeof this.val() === "number" && Number.isFinite(this.val()); }
  isString() { return typeof this.val() === "string"; }
  hasChildren(keys = []) { const v = this.val(); return v && typeof v === "object" && Object.keys(v).length > 0 && keys.every(key => this.child(key).exists()); }
}
const month = "2026-09";
const compiledRules = new Map();
function evaluate(rule, value, path = [], { workspace = "accounting-dev", inputId = "expense_1", field = "", old = value } = {}) {
  if (!compiledRules.has(rule)) compiledRules.set(rule, new Function("root", "data", "newData", "auth", "now", "$workspace", "$month", "$inputId", "$inputIndex", "$field",
    "return (" + rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(") + ");"));
  return Boolean(compiledRules.get(rule)(
    new Snapshot(old), new Snapshot(old, path), new Snapshot(value, path), { uid: "user" }, 1800000000000, workspace, month, inputId, "0", field));
}
const input = (extra = {}) => ({ id: "expense_1", category: "supplies", payee: "購入先", amount: 1234, ...extra });
const collection = rules.accountingAdjustments.$month.expenseInputs;
const validInput = (row, options = {}) => evaluate(collection.$inputId[".validate"], row, [], options)
  && Object.keys(row).every(field => evaluate(collection.$inputId.$field[".validate"], row, [field], { ...options, field }));
for (const workspace of ["accounting-dev", "accounting"]) {
  test(workspace + ": 日付あり・なしと全既存科目を保存可能", () => {
    for (const category of ["beautyTrial", "introduction", "advertising", "supplies", "entertainment", "liquor", "transportOther"]) {
      assert.equal(validInput(input({ category }), { workspace }), true);
      assert.equal(validInput(input({ category, businessDate: "2026-09-02" }), { workspace }), true);
    }
    assert.equal(evaluate(collection[".validate"], { expense_1: input() }, [], { workspace }), true);
  });
  test(workspace + ": 不正金額・科目・月・未知項目・IDを拒否", () => {
    for (const extra of [{ amount: -1 }, { amount: 0.1 }, { amount: "1000" }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { category: "other" },
      { id: "expense_2" }, { payee: " " }, { businessDate: "2026-10-02" }, { businessDate: "2026-09-00" }, { unknown: true }]) {
      assert.equal(validInput(input(extra), { workspace }), false, JSON.stringify(extra));
    }
  });
}
test("追加経費は既存の経理/OP、共通revision、確定月保護の対象", () => {
  const monthly = rules.accountingAdjustments.$month;
  const old = { users: { user: { role: "accounting" } }, "accounting-dev": { accountingAdjustments: { [month]: { revision: 1, updatedAt: "before", updatedBy: "user", cardFee: 0 } } } };
  const next = structuredClone(old); Object.assign(next["accounting-dev"].accountingAdjustments[month], { revision: 2, updatedAt: "after", consumptionTaxRate: 0, expenseInputs: { expense_1: input() } });
  const path = ["accounting-dev", "accountingAdjustments", month];
  assert.equal(evaluate(monthly[".write"], next, path, { old }), true);
  assert.equal(evaluate(monthly[".validate"], next, path, { old }), true);
  for (const role of ["shop", "unknown"]) { old.users.user.role = role; assert.equal(evaluate(monthly[".write"], next, path, { old }), false); }
  old.users.user.role = "accounting";
  for (const status of ["closing", "closed"]) { old["accounting-dev"].accountingMonthStates = { [month]: { status } }; assert.equal(evaluate(monthly[".write"], next, path, { old }), false); }
  delete old["accounting-dev"].accountingMonthStates;
  next["accounting-dev"].accountingAdjustments[month].revision = 1;
  assert.equal(evaluate(monthly[".validate"], next, path, { old }), false);
});
const expenseRule = rules.accountingMonthSnapshots.$month.$revision.expenses[".validate"];
const snapshot = () => ({ calculationVersion: "2.43.0", sales: { total: 100001 }, expenses: {
  dailyExpenseTotal: 1000, dispatchCast: 2000, dispatchStaff: 3000, dispatchFee: 400, dispatchTotal: 5400,
  liquorDelivery: 500, fixed: 600, cardFee: 70, accountingExpenseTotal: 1234, consumptionTax: 3000, total: 11804,
  accountingExpenseInputs: [input()] } });
test("2.43確定月は追加経費と月合計3%切捨てを経費合計へ1度加算", () => {
  const row = snapshot(); assert.equal(evaluate(expenseRule, row, ["expenses"]), true);
  for (const extra of [{ consumptionTax: 3001, total: 11805 }, { consumptionTax: 2999, total: 11803 }, { total: 10604 }, { accountingExpenseTotal: -1 }]) {
    const changed = snapshot(); Object.assign(changed.expenses, extra); assert.equal(evaluate(expenseRule, changed, ["expenses"]), false, JSON.stringify(extra));
  }
  for (const key of ["accountingExpenseTotal", "consumptionTax"]) { const changed = snapshot(); delete changed.expenses[key]; assert.equal(evaluate(expenseRule, changed, ["expenses"]), false); }
});
test("旧確定月の既存経費合計は許可し、3%の後付けは拒否", () => {
  const row = snapshot(); row.calculationVersion = "2.42.0";
  assert.equal(evaluate(expenseRule, row, ["expenses"]), false);
  delete row.expenses.accountingExpenseTotal; delete row.expenses.consumptionTax; delete row.expenses.accountingExpenseInputs;
  row.expenses.total = 7570;
  assert.equal(evaluate(expenseRule, row, ["expenses"]), true);
});

const rateRule = rules.accountingAdjustments.$month.consumptionTaxRate[".validate"];
function variableSnapshot(sales, rate, tax = domain.consumptionTaxForSales(sales, rate)) {
  return { calculationVersion: "2.44.0", sales: { total: sales }, expenses: {
    dailyExpenseTotal: 0, dispatchCast: 0, dispatchStaff: 0, dispatchFee: 0, dispatchTotal: 0,
    liquorDelivery: 0, fixed: 0, cardFee: 0, accountingExpenseTotal: 0,
    consumptionTaxRate: rate, consumptionTax: tax, total: tax,
  } };
}
function allowsTax(sales, rate, tax) {
  return evaluate(expenseRule, variableSnapshot(sales, rate, tax), ["expenses"]);
}

test("月別税率は0～100%の全10001通りの0.01刻みを許可し、不正な精度を拒否する", () => {
  for (let bp = 0; bp <= 10000; bp += 1) {
    const rate = bp / 100;
    assert.equal(evaluate(rateRule, rate), true, `${rate}%`);
    assert.equal(domain.validateConsumptionTaxRate(rate), rate);
  }
  for (const rate of [-1, 100.01, 0.001, 2.011, 99.999, 2.0100000000000002, "3", null, NaN, Infinity, -Infinity]) {
    assert.equal(evaluate(rateRule, rate), false, String(rate));
    assert.throws(() => domain.validateConsumptionTaxRate(rate));
  }
});

test("整数売上は全税率・代表境界でdomainの正答だけ許可し±1円の改変を拒否する", () => {
  for (let bp = 0; bp <= 10000; bp += 1) {
    const rate = bp / 100;
    for (const sales of [0, 1, 9999, 10000, 10001, Number.MAX_SAFE_INTEGER]) {
      const expected = Number(BigInt(sales) * BigInt(bp) / 10000n);
      assert.equal(domain.consumptionTaxForSales(sales, rate), expected);
      assert.equal(allowsTax(sales, rate, expected), true, `${sales}円 × ${rate}% = ${expected}円`);
      if (expected > 0) assert.equal(allowsTax(sales, rate, expected - 1), false);
      if (expected < Number.MAX_SAFE_INTEGER) assert.equal(allowsTax(sales, rate, expected + 1), false);
    }
  }
});

test("小数2桁までの通常売上も整数銭へ復元し、浮動小数点境界の±1円を拒否する", () => {
  for (const [sales, rate] of [[20001.6, 62.5], [312.5, 0.96], [1562.5, 0.96], [10000.01, 2.01],
    [0.29, 100], [9999.99, 0], [9999.99, 100], [1000000000000.01, 99.99]]) {
    const expected = domain.consumptionTaxForSales(sales, rate);
    assert.equal(allowsTax(sales, rate, expected), true, `${sales}円 × ${rate}%`);
    if (expected > 0) assert.equal(allowsTax(sales, rate, expected - 1), false);
    assert.equal(allowsTax(sales, rate, expected + 1), false);
  }
  assert.equal(allowsTax(20001.6, 62.5, 12501), true);
  assert.equal(allowsTax(312.5, 0.96, 3), true);
});

test("小数売上の3%はVer2.43当時のMath.floor計算を維持する", () => {
  for (const sales of [0.1, 33.33333333333333, 33.333333333333336, 9999.99, 20001.6, 1000000000000000.1]) {
    const expected = Math.floor(sales * 0.03);
    assert.equal(domain.consumptionTaxForSales(sales, 3), expected);
    assert.equal(allowsTax(sales, 3, expected), true);
    if (expected > 0) assert.equal(allowsTax(sales, 3, expected - 1), false);
    assert.equal(allowsTax(sales, 3, expected + 1), false);
  }
});

test("銭未満と超高額の旧小数売上へ新たな桁数制限を設けずdomainの正答を受け入れる", () => {
  // 旧数値の最短10進表記とRulesのIEEE計算には表現差がある。
  // この分岐は機械精度内で隣接額も受入可能。読込・確定・帳票はdomainで保存税額を厳密照合する。
  for (const sales of [0.001, 1.23456789, 4.3478260869565215, 10000.123456, 20001.6001,
    70368744177664.12, 1000000000000000.1, 1000000000001234.1, 2251799813685247.8]) {
    for (const rate of [0, 0.01, 0.29, 0.96, 2.01, 23, 62.5, 99.99, 100]) {
      const expected = domain.consumptionTaxForSales(sales, rate);
      assert.equal(allowsTax(sales, rate, expected), true, `${sales}円 × ${rate}% = ${expected}円`);
      assert.equal(allowsTax(sales, rate, expected + 2), false, '許容帯は2円改変を認めない');
    }
  }
});

test("2.44以降は保存税率を必須にし、不正税率・税額・経費合計を拒否する", () => {
  for (const version of ["2.44.0", "2.44.1", "2.99.0", "2.100.0", "3.0.0", "10.0.0"]) {
    const row = variableSnapshot(10000, 2.01);
    row.calculationVersion = version;
    assert.equal(evaluate(expenseRule, row, ["expenses"]), true, version);
    delete row.expenses.consumptionTaxRate;
    assert.equal(evaluate(expenseRule, row, ["expenses"]), false, version);
  }
  for (const rate of [-1, 101, 2.001, "2", null]) {
    const row = variableSnapshot(10000, 2);
    row.expenses.consumptionTaxRate = rate;
    assert.equal(evaluate(expenseRule, row, ["expenses"]), false, String(rate));
  }
  const inconsistent = variableSnapshot(10000, 2.01);
  inconsistent.expenses.total += 1;
  assert.equal(evaluate(expenseRule, inconsistent, ["expenses"]), false);
});

test("2.43以前の旧確定月へ税率を後付けできない", () => {
  for (const version of ["2.43.0", "2.43.1", "2.43.99"]) {
    const row = snapshot();
    row.calculationVersion = version;
    assert.equal(evaluate(expenseRule, row, ["expenses"]), true);
    row.expenses.consumptionTaxRate = 3;
    assert.equal(evaluate(expenseRule, row, ["expenses"]), false);
  }
  const row = snapshot();
  row.calculationVersion = "2.42.0";
  delete row.expenses.accountingExpenseTotal;
  delete row.expenses.consumptionTax;
  delete row.expenses.accountingExpenseInputs;
  row.expenses.total = 7570;
  assert.equal(evaluate(expenseRule, row, ["expenses"]), true);
  row.expenses.consumptionTaxRate = 0;
  assert.equal(evaluate(expenseRule, row, ["expenses"]), false);
});
