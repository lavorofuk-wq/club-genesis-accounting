import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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
function evaluate(rule, value, path = [], { workspace = "accounting-dev", inputId = "expense_1", field = "", old = value } = {}) {
  return Boolean(new Function("root", "data", "newData", "auth", "now", "$workspace", "$month", "$inputId", "$inputIndex", "$field",
    "return (" + rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(") + ");")(
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
  const next = structuredClone(old); Object.assign(next["accounting-dev"].accountingAdjustments[month], { revision: 2, updatedAt: "after", expenseInputs: { expense_1: input() } });
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
test("新確定月は追加経費と月合計3%切捨てを経費合計へ1度加算", () => {
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
