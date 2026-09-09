import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules.$workspace;
const now = 1800000000000;
const id = "daily_20260909";
const operationId = "12345678-1234-1234-1234-123456789abc";

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
  const evaluate = new Function("root", "data", "newData", "auth", "now", "$workspace", "$id", "$field", "$operationId", `return Boolean(${expression});`);
  return evaluate(new Snapshot(old), new Snapshot(old, path.split("/")), new Snapshot(newTree, path.split("/")), { uid: "user" }, now, "accounting-dev", id, field, operationId);
}
function closing() {
  const cash = { cashSales: 10000, cardSales: 0, totalSales: 10000, cashFloat: 200000,
    expenseAndPaymentTotal: 0, expectedClosingCash: 210000, cashProfit: 10000, actualClosingCash: 210000, difference: 0,
    funding: { schema: 2, previousClosingId: "", previousBusinessDate: "", previousClosingCash: 200000,
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

test("旧funding無しは承認を止め、差戻し・取下げでは不変の現金を保持する", () => {
  for (const status of ["approved", "returned", "withdrawn"]) {
    const before = closing(); delete before.cash.funding; delete before.cashManagementToken;
    before.cash.actualClosingCash -= 1000; before.cash.difference = -1000;
    const value = structuredClone(before); value.status = status;
    const result = trees(value, before); assert.equal(cashAllowed(result), status !== "approved");
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

test("旧記録確認flagを付けても新規missing・旧再送・managed降格を許可しない", () => {
  const value = closing(); delete value.cash.funding; value.legacyCashConfirmed = true;
  assert.equal(cashAllowed(trees(value)), false);
  const legacy = structuredClone(value); legacy.status = "returned";
  assert.equal(cashAllowed(trees(value, legacy)), false);
  const managed = closing(); managed.status = "returned";
  assert.equal(cashAllowed(trees(value, managed)), false);
});

test("新規schema1は拒否し、保存済みschema1の全値不変再送だけ許可する", () => {
  const value = closing(); value.cash.funding.schema = 1;
  assert.equal(cashAllowed(trees(value)), false);
  const before = structuredClone(value); before.status = "returned";
  assert.equal(cashAllowed(trees(value, before)), true);
  value.cash.funding.confirmed = false; assert.equal(cashAllowed(trees(value, before)), false);
});

test("schema2では初回・直前未記録の開始債務を明示し、推奨額以下の実返済を保存できる", () => {
  const value = closing(); value.cash.funding.openingPersonalDebt = 12000; value.cash.funding.closingPersonalDebt = 12000;
  assert.equal(cashAllowed(trees(value)), true);
  value.cash.funding.personalRepayment = 3000; value.cash.funding.closingPersonalDebt = 9000;
  value.cash.expectedClosingCash = value.cash.actualClosingCash = 207000;
  assert.equal(cashAllowed(trees(value)), true);
  value.cash.funding.personalRepayment = 11000; value.cash.funding.closingPersonalDebt = 1000;
  value.cash.expectedClosingCash = value.cash.actualClosingCash = 199000;
  assert.equal(cashAllowed(trees(value)), false);
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
  const start = rule.indexOf(" && (!newData.child('calculationVersion')");
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

test("2.22以降の月次は承認日全件の現金確認を要求し旧2.21確定は維持する", () => {
  const rule = rules.accountingMonthSnapshots.$month.$revision[".validate"];
  const start = rule.lastIndexOf(" && (!newData.child('calculationVersion')");
  const required = rule.slice(start + 4);
  for (const [version, managedDays, allowed] of [["2.21.0", 0, true], ["2.21.1", 0, true], ["2.22.0", 0, false],
    ["2.22.1", 1, false], ["2.22.0", 2, true], ["3.0.0", 0, false]]) {
    const next = { snapshot: { calculationVersion: version, approvedDays: 2, cashFunding: { managedDays } } };
    assert.equal(check(required, {}, next, "snapshot"), allowed, version);
  }
});

function audited() {
  const before = closing(); before.status = "returned"; before.updatedAt = "before";
  const value = structuredClone(before); value.status = "submitted"; value.updatedAt = "new"; value.submittedAt = "new";
  value.cashRevisionId = operationId; value.previousUpdatedAt = "before"; value.cashRevisionReason = "店舗データ再送";
  const revision = { schema: 1, dailyId: id, businessDate: before.businessDate, operationId,
    cashManagementToken: "current-token", beforeCash: structuredClone(before.cash), beforeRecordJson: JSON.stringify(before),
    beforeUpdatedAt: "before", beforeStatus: "returned", actor: "user", createdAtMs: now, reason: value.cashRevisionReason };
  const result = trees(value, before);
  result.next["accounting-dev"].cashRevisions = { [id]: { [operationId]: revision } };
  return result;
}
const auditPath = `accounting-dev/cashRevisions/${id}/${operationId}`;
const auditRules = rules.cashRevisions.$id.$operationId;

test("再送の本体と監査の同時保存だけを許可する双方向リンク", () => {
  const result = audited();
  assert.equal(check(rules.history.$id[".write"], result.old, result.next, historyPath), true);
  assert.equal(check(auditRules[".write"], result.old, result.next, auditPath), true);
  assert.equal(check(auditRules[".validate"], result.old, result.next, auditPath), true);
  const historyOnly = structuredClone(result); delete historyOnly.next["accounting-dev"].cashRevisions;
  assert.equal(check(rules.history.$id[".write"], historyOnly.old, historyOnly.next, historyPath), false);
  const auditOnly = structuredClone(result); auditOnly.next["accounting-dev"].history = structuredClone(result.old["accounting-dev"].history);
  assert.equal(check(auditRules[".write"], auditOnly.old, auditOnly.next, auditPath), false);
});

test("先読み後の旧updatedAt変更・別UUID・別token・監査既存は原子的再送を拒否する", () => {
  for (const mutate of [result => { result.old["accounting-dev"].history[id].updatedAt = "concurrent"; },
    result => { result.next["accounting-dev"].history[id].previousUpdatedAt = "wrong"; },
    result => { result.next["accounting-dev"].cashRevisions[id][operationId].operationId = "wrong"; },
    result => { result.next["accounting-dev"].cashRevisions[id][operationId].cashManagementToken = "wrong"; },
    result => { result.old["accounting-dev"].cashRevisions = structuredClone(result.next["accounting-dev"].cashRevisions); }]) {
    const result = audited(); mutate(result);
    assert.equal(check(rules.history.$id[".write"], result.old, result.next, historyPath), false);
  }
});

test("監査の旧現金全値・旧状態・旧版・actor・理由・時刻の改ざんを拒否する", () => {
  const keys = ["beforeUpdatedAt", "beforeStatus", "actor", "reason", "createdAtMs", "businessDate", "dailyId", "operationId"];
  for (const key of keys) {
    const result = audited(); result.next["accounting-dev"].cashRevisions[id][operationId][key] = key === "createdAtMs" ? now - 1 : "wrong";
    assert.equal(check(auditRules[".validate"], result.old, result.next, auditPath), false, key);
  }
  for (const field of Object.keys(closing().cash).filter(key => key !== "funding")) {
    const result = audited(); result.next["accounting-dev"].cashRevisions[id][operationId].beforeCash[field] += 1;
    assert.equal(check(auditRules[".validate"], result.old, result.next, auditPath), false, field);
  }
  for (const field of Object.keys(closing().cash.funding)) {
    const result = audited(); const funding = result.next["accounting-dev"].cashRevisions[id][operationId].beforeCash.funding;
    funding[field] = typeof funding[field] === "number" ? funding[field] + 1 : "wrong";
    assert.equal(check(auditRules[".validate"], result.old, result.next, auditPath), false, field);
  }
});

test("監査は作成専用で更新・削除はOPでも拒否し、日次削除後も削除できない", () => {
  const result = audited(); result.old["accounting-dev"].cashRevisions = structuredClone(result.next["accounting-dev"].cashRevisions);
  assert.equal(check(auditRules[".write"], result.old, result.next, auditPath), false);
  delete result.next["accounting-dev"].cashRevisions;
  assert.equal(check(auditRules[".write"], result.old, result.next, auditPath), false);
  delete result.old["accounting-dev"].history[id];
  assert.equal(check(auditRules[".write"], result.old, result.next, auditPath), false);
});

test("承認用cash lockは経理・OPのみ取得でき、本体承認にもそのtokenを要求する", () => {
  const lockPath = "accounting-dev/cashManagementLock";
  const pending = { "accounting-dev": { cashManagementLock: activeLock({ operation: "approve" }) } };
  for (const role of ["accounting", "op"]) assert.equal(check(rules.cashManagementLock[".write"], { "accounting-dev": {} }, pending, lockPath, role), true);
  assert.equal(check(rules.cashManagementLock[".write"], { "accounting-dev": {} }, pending, lockPath, "shop"), false);
  const before = closing(); before.updatedAt = "before"; before.cashManagementToken = "old-token";
  const value = { ...structuredClone(before), status: "approved", updatedAt: "new", approvedAt: "new", approvedBy: "user", cashManagementToken: "current-token" };
  const result = trees(value, before); result.old["accounting-dev"].cashManagementLock.operation = "approve";
  assert.equal(check(rules.history.$id[".write"], result.old, result.next, historyPath, "accounting"), true);
  delete result.old["accounting-dev"].cashManagementLock;
  assert.equal(check(rules.history.$id[".write"], result.old, result.next, historyPath, "accounting"), false);
});
