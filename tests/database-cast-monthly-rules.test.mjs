import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules.$workspace;
const now = 1800000000000;
const id = "daily_20261102";
const castId = "cast_member";
const month = "2026-11";
const children = Symbol("RTDB child nodes");

class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  raw() { return this.path.reduce((value, key) => value?.[key], this.tree) ?? null; }
  val() { const value = this.raw(); return value && typeof value === "object" ? children : value; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  exists() { return this.val() !== null; }
  hasChildren(keys = []) {
    return this.val() === children && Object.keys(this.raw()).length > 0 && keys.every((key) => this.child(key).exists());
  }
  isBoolean() { return typeof this.val() === "boolean"; }
  isNumber() { return Number.isFinite(this.val()); }
  isString() { return typeof this.val() === "string"; }
}

function evaluate(rule, before, after, path, { role = "op", uid = "user", key = month, workspace = "accounting-dev" } = {}) {
  if (typeof rule === "boolean") return rule;
  const root = { [workspace]: before, users: { [uid]: { role } } };
  const expression = rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(");
  const run = new Function("root", "data", "newData", "auth", "now", "$workspace", "$id", "$month", `return Boolean(${expression});`);
  const keys = [workspace, ...path];
  return run(new Snapshot(root), new Snapshot(root, keys), new Snapshot({ [workspace]: after }, keys),
    { uid }, now, workspace, path[1], key);
}

const lock = { owner: "user", token: "departure-token", month, expiresAt: now + 60000 };
const lockPath = ["castDepartureLock"];

test("退店ロックは業務権限・操作者・有効期間を検証し、使用中に上書きできない", () => {
  const after = { castDepartureLock: lock };
  const lockRules = rules.castDepartureLock;
  for (const role of ["shop", "accounting", "op"]) {
    assert.equal(evaluate(lockRules[".write"], {}, after, lockPath, { role }), true);
  }
  assert.equal(evaluate(lockRules[".write"], {}, after, lockPath, { role: "visitor" }), false);
  assert.equal(evaluate(lockRules[".write"], after, after, lockPath), false);
  assert.equal(evaluate(lockRules[".write"], after, {}, lockPath), true);
  assert.equal(evaluate(lockRules[".write"], after, {}, lockPath, { uid: "other" }), false);
  assert.equal(evaluate(lockRules[".validate"], {}, after, lockPath), true);
  for (const change of [{ owner: "other" }, { token: "" }, { month: "2026-13" }, { expiresAt: now }, { expiresAt: now + 120001 }]) {
    assert.equal(evaluate(lockRules[".validate"], {}, { castDepartureLock: { ...lock, ...change } }, lockPath), false);
  }
});

const active = {
  name: "キャスト", legalName: "本名", status: "active", hiredAt: "2026-10-12",
  hourlyRates: { "2026-10": 2000 }, createdAt: "created", updatedAt: "before",
};
const departed = { ...active, status: "departed", departedAt: "2026-11-03", departureLockToken: lock.token, updatedAt: "after" };
const castPath = ["casts", castId];
const castTree = (cast, extra = {}) => ({ casts: { [castId]: cast }, ...extra });

test("退店への変更には同じ月・本人・同じトークンの有効ロックが必要", () => {
  const write = rules.casts.$id[".write"];
  const after = castTree(departed);
  assert.equal(evaluate(write, castTree(active), after, castPath), false);
  assert.equal(evaluate(write, castTree(active, { castDepartureLock: lock }), after, castPath), true);
  for (const change of [{ owner: "other" }, { month: "2026-10" }, { token: "new-token" }, { expiresAt: now }]) {
    assert.equal(evaluate(write, castTree(active, { castDepartureLock: { ...lock, ...change } }), after, castPath), false);
  }
  const legacy = { ...departed, departureLockToken: undefined };
  assert.equal(evaluate(write, castTree(legacy), castTree({ ...legacy, note: "訂正", updatedAt: "later" }), castPath), true);
  assert.equal(evaluate(write, castTree(legacy), castTree({ ...legacy, departedAt: "2026-11-04", updatedAt: "later" }), castPath), false);
  assert.equal(evaluate(write, castTree(legacy), castTree({ ...active, updatedAt: "later" }), castPath), true);
});

test("退店ロックは対象営業月の承認だけを一時停止する", () => {
  const write = rules.history.$id[".write"];
  const day = {
    businessDate: "2026-11-02", businessMonth: month, status: "submitted", submittedBy: "user", updatedAt: "before",
    submissionId: "submission", checksum: "a".repeat(64), cashManagementToken: "old-cash-token",
  };
  const approved = { ...day, status: "approved", updatedAt: "after", approvedAt: "after", approvedBy: "user", cashManagementToken: "cash-token" };
  const cashManagementLock = { id, operation: "approve", token: "cash-token", owner: "user", acquiredAtMs: now, expiresAt: now + 120000 };
  const before = { history: { [id]: day }, cashManagementLock };
  const after = { history: { [id]: approved }, cashManagementLock };
  const path = ["history", id];
  assert.equal(evaluate(write, before, after, path), true);
  assert.equal(evaluate(write, { ...before, castDepartureLock: lock }, after, path), false);
  for (const change of [{ expiresAt: now }, { month: "2026-10" }]) {
    assert.equal(evaluate(write, { ...before, castDepartureLock: { ...lock, ...change } }, after, path), true);
  }
  const returned = { ...day, status: "returned", updatedAt: "after", returnedAt: "after", returnedBy: "user",
    returnedFromStatus: "submitted", returnReason: "確認" };
  assert.equal(evaluate(write, { history: { [id]: day }, castDepartureLock: lock }, { history: { [id]: returned } }, path), true);
});

const trial = { ...active, status: "trial", trialDate: "2026-11-02", trialHourlyRate: 1500, hourlyRates: undefined };
const conversionLock = { owner: "user", token: "conversion-token", operationId: "conversion", expiresAt: now + 1000 };

test("月度体入時給は有効月と正の整数を要求し、入店変換中は変更しない", () => {
  const rates = rules.casts.$id.trialHourlyRates;
  const previous = castTree({ ...trial, trialHourlyRates: { [month]: 1500 } });
  const path = [...castPath, "trialHourlyRates"];
  assert.equal(evaluate(rates[".validate"], {}, previous, path), true);
  assert.equal(evaluate(rates[".validate"], {}, castTree({ ...active, trialHourlyRates: { [month]: 1500 } }), path), false);
  for (const [key, value, allowed] of [[month, 1800, true], ["2026-00", 1800, false], [month, 0, false],
    [month, 1800.5, false], [month, Number.MAX_SAFE_INTEGER + 1, false]]) {
    const after = castTree({ ...trial, trialHourlyRates: { [key]: value } });
    assert.equal(evaluate(rates.$month[".validate"], previous, after, [...path, key], { key }), allowed);
  }
  const lockTree = castTree({ ...previous.casts[castId], conversionLock });
  const changed = castTree({ ...trial, trialHourlyRates: { [month]: 1800 } });
  assert.equal(evaluate(rates.$month[".validate"], lockTree, previous, [...path, month]), true);
  assert.equal(evaluate(rates.$month[".validate"], lockTree, changed, [...path, month]), false);
  assert.equal(evaluate(rules.casts.$id[".validate"], previous, castTree({ ...trial, updatedAt: "after", previousUpdatedAt: trial.updatedAt }), castPath), false);
});

test("月度紹介者は履歴か明示なしを保存でき、変換中・削除処理中は条件を変更しない", () => {
  const introduction = { id: "intro", name: "紹介者", feeType: "sales10", attendanceAdvisoryFee: 100, entryAdvisoryFee: 0 };
  const monthRules = rules.casts.$id.monthlyIntroducers.$month;
  const introducers = { [introduction.id]: { name: introduction.name } };
  const setIntroduction = (value, cast = active) => castTree({ ...cast, monthlyIntroducers: { [month]: value } }, { introducers });
  const path = [...castPath, "monthlyIntroducers", month];
  const existing = setIntroduction(introduction);
  for (const [value, allowed] of [[introduction, true], [false, true], [true, false], [{ id: "missing-fields" }, false]]) {
    assert.equal(evaluate(monthRules[".validate"], castTree(active), setIntroduction(value), path), allowed);
  }
  const locked = setIntroduction(introduction, { ...trial, conversionLock });
  assert.equal(evaluate(monthRules[".validate"], locked, setIntroduction(introduction, trial), path), true);
  assert.equal(evaluate(monthRules[".validate"], locked, setIntroduction(false, trial), path), false);
  const deleting = { ...existing, introducerDeletionLocks: { intro: { expiresAt: now + 100 } } };
  assert.equal(evaluate(monthRules[".validate"], deleting, existing, path), true);
  assert.equal(evaluate(monthRules[".validate"], deleting, setIntroduction({ ...introduction, attendanceAdvisoryFee: 200 }), path), false);
  assert.equal(evaluate(monthRules.feeType[".validate"], existing, setIntroduction({ ...introduction, feeType: "wrong" }), [...path, "feeType"]), false);
  assert.equal(evaluate(monthRules.attendanceAdvisoryFee[".validate"], existing, setIntroduction({ ...introduction, attendanceAdvisoryFee: -1 }),
    [...path, "attendanceAdvisoryFee"]), false);
});

test("月度紹介者は保存時点で実在する紹介者だけを新規・変更でき、削除済み履歴は維持できる", () => {
  const introduction = { id: "intro", name: "紹介者", feeType: "sales10", attendanceAdvisoryFee: 100, entryAdvisoryFee: 0 };
  const rule = rules.casts.$id.monthlyIntroducers.$month[".validate"];
  const path = [...castPath, "monthlyIntroducers", month];
  const introducers = { [introduction.id]: { name: introduction.name } };
  const previous = { ...active, monthlyIntroducers: { [month]: introduction } };
  const next = { ...active, monthlyIntroducers: { [month]: { ...introduction, attendanceAdvisoryFee: 200 } } };
  const cleared = { ...active, monthlyIntroducers: { [month]: false } };
  for (const workspace of ["accounting-dev", "accounting"]) {
    const options = { workspace };
    const live = castTree(previous, { introducers });
    assert.equal(evaluate(rule, castTree(active, { introducers }), live, path, options), true);
    assert.equal(evaluate(rule, live, castTree(next, { introducers }), path, options), true);
    assert.equal(evaluate(rule, castTree(active), castTree(previous), path, options), false);
    assert.equal(evaluate(rule, live, castTree(next), path, options), false);
    assert.equal(evaluate(rule, castTree(previous), castTree(next), path, options), false);
    assert.equal(evaluate(rule, castTree(previous), castTree({ ...previous, note: "備考だけ編集" }), path, options), true);
    assert.equal(evaluate(rule, castTree(previous), castTree(cleared), path, options), true);
    for (const [expiresAt, allowed] of [[now + 100, false], [now, true]]) {
      const deleting = { ...live, introducerDeletionLocks: { [introduction.id]: { expiresAt } } };
      assert.equal(evaluate(rule, deleting, castTree(next, { introducers }), path, options), allowed);
      assert.equal(evaluate(rule, deleting, castTree(cleared, { introducers }), path, options), true);
    }
  }
});
