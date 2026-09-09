import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules.$workspace;
const now = 1800000000000;
const id = "daily_20260909";

// 実際のrules式を、同一APIを持つ読み取り専用snapshotで評価する。
class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  val() { return this.path.reduce((value, key) => value?.[key], this.tree) ?? null; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  exists() { return this.val() !== null; }
  isNumber() { return typeof this.val() === "number" && Number.isFinite(this.val()); }
  isString() { return typeof this.val() === "string"; }
  hasChildren(keys = []) { const value = this.val(); return value !== null && typeof value === "object" && Object.keys(value).length > 0 && keys.every((key) => this.child(key).exists()); }
}
function check(rule, oldTree, newTree, path, role = "op", field = "") {
  const old = structuredClone(oldTree); old.users = { user: { role } };
  const expression = rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(");
  const evaluate = new Function("root", "data", "newData", "auth", "now", "$workspace", "$id", "$field", `return Boolean(${expression});`);
  return evaluate(new Snapshot(old), new Snapshot(old, path.split("/")), new Snapshot(newTree, path.split("/")), { uid: "user" }, now, "accounting-dev", id, field);
}
function closing() {
  const cash = { cashSales: 10000, cardSales: 0, totalSales: 10000, cashFloat: 200000,
    expenseAndPaymentTotal: 0, expectedClosingCash: 210000, cashProfit: 10000, actualClosingCash: 210000, difference: 0,
    funding: { schema: 1, previousClosingId: "", previousBusinessDate: "", previousClosingCash: 200000,
      openingShortfall: 0, openingPersonalDebt: 0, companyReplenishment: 0, personalReplenishment: 0,
      companyTransfer: 0, personalRepayment: 0, closingPersonalDebt: 0, confirmed: true } };
  return { businessDate: "2026-09-09", businessMonth: "2026-09", status: "submitted", submittedBy: "user", updatedAt: "new",
    submissionId: "submission", checksum: "a".repeat(64), cashManagementToken: "current-token", cash };
}
function activeLock(overrides = {}) {
  return { id, operation: "submit", token: "current-token", owner: "user", acquiredAtMs: now, expiresAt: now + 120000, ...overrides };
}
function trees(value = closing(), before = null) {
  return {
    old: { "accounting-dev": { history: before ? { [id]: before } : {}, cashManagementLock: activeLock() } },
    next: { "accounting-dev": { history: { [id]: value }, cashManagementLock: activeLock() } },
  };
}
const cashPath = `accounting-dev/history/${id}/cash`;
const historyPath = `accounting-dev/history/${id}`;
const cashAllowed = ({ old, next }) => check(rules.history.$id.cash[".validate"], old, next, cashPath);

test("確認済み初回1円現金は許可し、未確認・旧形式の新送信は拒否する", () => {
  assert.equal(cashAllowed(trees()), true);
  for (const change of [value => { delete value.cash.funding; }, value => { value.cash.funding.confirmed = false; }]) {
    const value = closing(); change(value); assert.equal(cashAllowed(trees(value)), false);
  }
});

test("補充・返済の各数値は非負の安全な整数を要求する", () => {
  for (const field of ["previousClosingCash", "openingShortfall", "openingPersonalDebt", "companyReplenishment", "personalReplenishment", "companyTransfer", "personalRepayment", "closingPersonalDebt"]) {
    for (const amount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
      const value = closing(); value.cash.funding[field] = amount; assert.equal(cashAllowed(trees(value)), false, `${field}: ${amount}`);
    }
  }
});

test("実在高・計算上残額・差額・純粋な現金収支の改ざんを拒否する", () => {
  for (const field of ["actualClosingCash", "expectedClosingCash", "difference", "cashProfit"]) {
    const value = closing(); value.cash[field] += 1; assert.equal(cashAllowed(trees(value)), false, field);
  }
  const negative = closing(); negative.cash.actualClosingCash = negative.cash.expectedClosingCash = -1;
  assert.equal(cashAllowed(trees(negative)), false);
});

function carried() {
  const value = closing(); const funding = value.cash.funding;
  Object.assign(funding, { previousClosingId: "daily_20260831", previousBusinessDate: "2026-08-31", previousClosingCash: 180000,
    openingShortfall: 20000, openingPersonalDebt: 5000, companyReplenishment: 5000, personalReplenishment: 15000,
    companyTransfer: 3000, personalRepayment: 13000, closingPersonalDebt: 7000 });
  value.cash.actualClosingCash = value.cash.expectedClosingCash = 200000;
  const result = trees(value);
  result.old["accounting-dev"].history.daily_20260831 = { businessDate: "2026-08-31", status: "returned",
    cash: { expectedClosingCash: 180000, actualClosingCash: 170000, funding: { closingPersonalDebt: 5000 } } };
  return result;
}

test("月をまたぐ繰越は承認状態に依存せず、計算上残額・未返済額に一致する", () => {
  assert.equal(cashAllowed(carried()), true);
  const result = carried(); result.old["accounting-dev"].history.daily_20260831.cash.actualClosingCash = 0;
  assert.equal(cashAllowed(result), true);
});

test("開店補充の二重加算・不足額との不一致・返済超過・前日残高偽装を拒否する", () => {
  for (const field of ["openingShortfall", "companyReplenishment", "personalReplenishment", "personalRepayment", "closingPersonalDebt", "previousClosingCash", "openingPersonalDebt"]) {
    const result = carried(); result.next["accounting-dev"].history[id].cash.funding[field] += 1;
    assert.equal(cashAllowed(result), false, field);
  }
  const duplicate = carried(); duplicate.next["accounting-dev"].history[id].cash.expectedClosingCash += 20000;
  duplicate.next["accounting-dev"].history[id].cash.actualClosingCash += 20000;
  assert.equal(cashAllowed(duplicate), false);
});

test("将来日・自分自身・存在しない前日への参照を拒否する", () => {
  for (const previousId of [id, "missing"]) {
    const result = carried(); result.next["accounting-dev"].history[id].cash.funding.previousClosingId = previousId;
    assert.equal(cashAllowed(result), false);
  }
  const result = carried(); result.old["accounting-dev"].history.daily_20260831.businessDate = "2026-10-01";
  result.next["accounting-dev"].history[id].cash.funding.previousBusinessDate = "2026-10-01";
  assert.equal(cashAllowed(result), false);
});

test("旧funding無しの承認・差戻しは不変の現金を保持でき、同時変更は拒否する", () => {
  for (const status of ["approved", "returned", "withdrawn"]) {
    const before = closing(); delete before.cash.funding; delete before.cashManagementToken;
    before.cash.actualClosingCash -= 1000; before.cash.difference = -1000;
    const value = structuredClone(before); value.status = status;
    const result = trees(value, before); assert.equal(cashAllowed(result), true);
    value.cash.actualClosingCash += 1; assert.equal(cashAllowed(trees(value, before)), false);
  }
});

test("新fundingの承認・差戻しでは補充返済の各値を変更できない", () => {
  const before = closing();
  for (const field of Object.keys(before.cash.funding)) {
    const value = structuredClone(before); value.status = "approved";
    value.cash.funding[field] = typeof value.cash.funding[field] === "number" ? value.cash.funding[field] + 1 : "changed";
    assert.equal(cashAllowed(trees(value, before)), false, field);
  }
});

test("保存済み旧cashの確認済み再送はtokenの有無と再送回数に依存しない", () => {
  for (const existingToken of [undefined, "previous-submission-token"]) {
    const before = closing(); delete before.cash.funding; before.status = "returned";
    before.cashManagementToken = existingToken; before.legacyCashConfirmed = true; before.updatedAt = "before";
    const value = structuredClone(before); value.status = "submitted"; value.cashManagementToken = "current-token";
    value.legacyCashConfirmed = true; value.updatedAt = "new"; value.submittedAt = "new";
    assert.equal(cashAllowed(trees(value, before)), true);
    const allowed = trees(value, before);
    assert.equal(check(rules.history.$id[".write"], allowed.old, allowed.next, historyPath), true);
    delete allowed.old["accounting-dev"].cashManagementLock;
    assert.equal(check(rules.history.$id[".write"], allowed.old, allowed.next, historyPath), false);
    delete value.legacyCashConfirmed; assert.equal(cashAllowed(trees(value, before)), false);
  }
});

test("旧互換では営業日と全9現金プリミティブが不変でなければ再送できない", () => {
  const before = closing(); delete before.cash.funding; before.status = "returned";
  for (const field of Object.keys(before.cash)) {
    const value = structuredClone(before); value.status = "submitted"; value.legacyCashConfirmed = true;
    value.cash[field] += 1; assert.equal(cashAllowed(trees(value, before)), false, field);
  }
  const value = structuredClone(before); value.status = "submitted"; value.legacyCashConfirmed = true;
  value.businessDate = "2026-09-10"; assert.equal(cashAllowed(trees(value, before)), false);
});

test("旧差額の非0は旧現金と同値の場合だけ確認済み再送で保持する", () => {
  const before = closing(); delete before.cash.funding; before.status = "returned";
  before.cash.actualClosingCash -= 1000; before.cash.difference = -1000;
  const value = structuredClone(before); value.status = "submitted"; value.legacyCashConfirmed = true;
  assert.equal(cashAllowed(trees(value, before)), true);
  value.cash.difference = 0; assert.equal(cashAllowed(trees(value, before)), false);
});

test("確認フラグを偽装しても新規missingとmanagedからのfunding削除は拒否する", () => {
  const value = closing(); delete value.cash.funding; value.legacyCashConfirmed = true;
  assert.equal(cashAllowed(trees(value)), false);
  const before = closing(); before.status = "returned";
  assert.equal(cashAllowed(trees(value, before)), false);
});

test("旧記録確認フラグはtrueかつfunding無しの保存だけ許可する", () => {
  const path = `${historyPath}/legacyCashConfirmed`;
  for (const [confirmed, managed, allowed] of [[true, false, true], [false, false, false], ["true", false, false], [true, true, false]]) {
    const value = closing(); value.legacyCashConfirmed = confirmed; if (!managed) delete value.cash.funding;
    const result = trees(value);
    assert.equal(check(rules.history.$id.legacyCashConfirmed[".validate"], result.old, result.next, path), allowed);
  }
});

test("新送信は有効な対象id・owner・token一致のcash lockを要求する", () => {
  const original = trees(); assert.equal(check(rules.history.$id[".write"], original.old, original.next, historyPath), true);
  for (const change of [state => { delete state.cashManagementLock; },
    state => { state.cashManagementLock.expiresAt = now; }, state => { state.cashManagementLock.owner = "other"; },
    state => { state.cashManagementLock.token = "stale-token"; }, state => { state.cashManagementLock.id = "other-day"; },
    state => { state.cashManagementLock.operation = "delete"; }]) {
    const result = trees(); change(result.old["accounting-dev"]);
    assert.equal(check(rules.history.$id[".write"], result.old, result.next, historyPath), false);
  }
});

test("cash lockは店舗・OPだけ取得でき、有効ロックの上書きやTTL延長を拒否する", () => {
  const path = "accounting-dev/cashManagementLock";
  const next = { "accounting-dev": { cashManagementLock: activeLock() } };
  const old = { "accounting-dev": {} };
  for (const role of ["shop", "op"]) assert.equal(check(rules.cashManagementLock[".write"], old, next, path, role), true);
  assert.equal(check(rules.cashManagementLock[".write"], old, next, path, "accounting"), false);
  assert.equal(check(rules.cashManagementLock[".write"], next, next, path), false);
  assert.equal(check(rules.cashManagementLock[".validate"], old, next, path), true);
  next["accounting-dev"].cashManagementLock.expiresAt = now + 180001;
  assert.equal(check(rules.cashManagementLock[".validate"], old, next, path), false);
});

test("cash lock取得と月次確定開始は相互排他、つり銭設定はcash lock中に変更不可", () => {
  const old = { "accounting-dev": { accountingFinalizeLock: { expiresAt: now + 1 } } };
  const next = { "accounting-dev": { cashManagementLock: activeLock() } };
  assert.equal(check(rules.cashManagementLock[".write"], old, next, "accounting-dev/cashManagementLock"), false);
  const cashActive = { "accounting-dev": { cashManagementLock: activeLock() } };
  const finalizeNext = { "accounting-dev": { accountingFinalizeLock: { operationId: "final", month: "2026-09", owner: "user" } } };
  assert.equal(check(rules.accountingFinalizeLock[".write"], cashActive, finalizeNext, "accounting-dev/accountingFinalizeLock"), false);
  assert.equal(check(rules.config.cashFloat[".write"], cashActive, { "accounting-dev": { config: { cashFloat: 250000 } } }, "accounting-dev/config/cashFloat"), false);
});

test("日次削除はcash lockと既存削除lockの同一tokenを要求し、一括削除条件も維持する", () => {
  const value = closing();
  const cashLock = activeLock({ operation: "delete" });
  const deletionLock = { ...value, id, month: value.businessMonth, claimKey: value.checksum,
    owner: "user", expiresAt: now + 120000, cashManagementToken: "current-token" };
  const old = { "accounting-dev": { history: { [id]: value }, cashManagementLock: cashLock,
    dailyClosingDeletionLock: deletionLock, posSubmissionClaims: { [value.checksum]: id } } };
  const next = { "accounting-dev": { history: {}, cashManagementLock: cashLock } };
  assert.equal(check(rules.history.$id[".write"], old, next, historyPath), true);
  for (const mutation of [state => { state.cashManagementLock.expiresAt = now; },
    state => { state.cashManagementLock.token = "new-owner-token"; }, state => { delete state.cashManagementLock; }]) {
    const wrong = structuredClone(old); mutation(wrong["accounting-dev"]);
    assert.equal(check(rules.history.$id[".write"], wrong, next, historyPath), false);
  }
  const retainedClaim = structuredClone(next); retainedClaim["accounting-dev"].posSubmissionClaims = { [value.checksum]: id };
  assert.equal(check(rules.history.$id[".write"], old, retainedClaim, historyPath), false);
});

test("既存の削除・確定月・権限のガードを保持しcash token条件を追加する", () => {
  for (const field of ["accountingMonthStates", "accountingFinalizeLock", "dailyClosingDeletionLock", "cashManagementLock", "posSubmissionClaims"]) {
    assert.match(rules.history.$id[".write"], new RegExp(field));
  }
  assert.match(rules.dailyClosingDeletionLock[".write"], /cashManagementToken/);
  assert.match(rules.dailyClosingDeletionLock[".write"], /operation'\)\.val\(\) === 'delete'/);
  assert.match(rules.dailyClosingDeletionLock[".validate"], /cashManagementToken'\)\.isString/);
});

test("2.21以降の月次snapshotは現金移動summaryが必須で旧2.20は互換を維持する", () => {
  const rule = rules.accountingMonthSnapshots.$month.$revision[".validate"];
  const start = rule.lastIndexOf(" && (!newData.child('calculationVersion')");
  assert.ok(start > 0);
  const required = rule.slice(start + 4);
  for (const [version, hasSummary, allowed] of [["2.20.0", false, true], ["2.21.0", false, false],
    ["2.21.1", false, false], ["2.30.0", false, false], ["3.0.0", false, false], ["2.21.0", true, true]]) {
    const next = { snapshot: { calculationVersion: version, ...(hasSummary ? { cashFunding: { managedDays: 0 } } : {}) } };
    assert.equal(check(required, {}, next, "snapshot"), allowed, version);
  }
});

test("現金移動summaryは1円整数・承認日数上限・移動純額と未返済額の恒等式を検証する", () => {
  const rule = rules.accountingMonthSnapshots.$month.$revision.cashFunding[".validate"];
  const summary = { managedDays: 2, openingPersonalDebt: 5000, companyReplenishment: 5000, personalReplenishment: 15000,
    companyTransfer: 3000, personalRepayment: 13000, closingPersonalDebt: 7000, netCashMovement: 10000 };
  const permitted = (value) => check(rule, {}, { snapshot: { approvedDays: 2, cashFunding: value } }, "snapshot/cashFunding");
  assert.equal(permitted(summary), true);
  for (const field of Object.keys(summary)) assert.equal(permitted({ ...summary, [field]: summary[field] + 0.5 }), false, field);
  assert.equal(permitted({ ...summary, managedDays: 3 }), false);
  assert.equal(permitted({ ...summary, closingPersonalDebt: 7001 }), false);
  assert.equal(permitted({ ...summary, netCashMovement: 10001 }), false);
  assert.equal(permitted({ managedDays: 1, openingPersonalDebt: 10000, companyReplenishment: 0, personalReplenishment: 0,
    companyTransfer: 0, personalRepayment: 5000, closingPersonalDebt: 5000, netCashMovement: -5000 }), true);
});
