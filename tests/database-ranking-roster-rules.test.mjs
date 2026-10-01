import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withoutCastSalesRankingRosterRules } from "./ranking-roster-rules-baseline-helper.mjs";

const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules.$workspace;
const rosterRules = rules.accountingMonthSnapshots.$month.$revision.castSalesRankingRoster;
test("過去指紋の比較前に名簿ルールの全内容を厳密検証し、改変を隠さない", () => {
  const original = { $workspace: structuredClone(rules) };
  const baseline = withoutCastSalesRankingRosterRules(original);
  assert.equal(Object.hasOwn(baseline.$workspace.accountingMonthSnapshots.$month.$revision, "castSalesRankingRoster"), false);
  assert.deepEqual(original.$workspace.accountingMonthSnapshots.$month.$revision.castSalesRankingRoster, rosterRules);
  for (const modify of [
    (node) => { node[".validate"] = "true"; },
    (node) => { node[".write"] = "true"; },
    (node) => { delete node.entries.$index.$field; },
    (node) => { node.entries.$index[".validate"] = "$workspace !== 'accounting-dev' || (" + node.entries.$index[".validate"] + ")"; },
  ]) {
    const changed = structuredClone(original);
    modify(changed.$workspace.accountingMonthSnapshots.$month.$revision.castSalesRankingRoster);
    assert.throws(() => withoutCastSalesRankingRosterRules(changed));
  }
});
class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  val() { return this.path.reduce((v, key) => v?.[key], this.tree) ?? null; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  exists() { return this.val() !== null; }
  isString() { return typeof this.val() === "string"; }
  hasChildren(keys = []) { const v = this.val(); return v && typeof v === "object" && Object.keys(v).length > 0 && keys.every(key => this.child(key).exists()); }
}
function evaluate(rule, snapshot, workspace, vars) {
  return Boolean(new Function("newData", "$workspace", "$index", "$field",
    "return (" + rule.replaceAll(".matches(", ".match(") + ");")(snapshot, workspace, vars.$index ?? "", vars.$field ?? ""));
}
function allows(value, workspace = "accounting-dev") {
  function walk(node, path = [], vars = {}) {
    const snap = new Snapshot(value, path);
    // Firebaseは存在しない値（空配列を含む）へ.validateを適用しない。
    if (!snap.exists() || typeof snap.val() === "object" && Object.keys(snap.val()).length === 0) return true;
    if (node[".validate"] && !evaluate(node[".validate"], snap, workspace, vars)) return false;
    if (typeof snap.val() !== "object") return true;
    return Object.keys(snap.val()).every(key => {
      const name = Object.hasOwn(node, key) ? key : Object.keys(node).find(candidate => candidate.startsWith("$"));
      return !name || walk(node[name], [...path, key], name.startsWith("$") ? { ...vars, [name]: key } : vars);
    });
  }
  return walk(rosterRules);
}
const roster = (extra = {}) => ({ schemaVersion: 1, entries: [{ id: "cast:旧ID", name: "在籍" }], ...extra });

for (const workspace of ["accounting-dev", "accounting"]) {
test(`${workspace}: 名簿未保存・保存済み空名簿・正常名簿・数値キー配列を許可する`, () => {
  for (const value of [undefined, { schemaVersion: 1 }, { schemaVersion: 1, entries: [] }, roster(),
    roster({ entries: { 0: { id: "cast_1", name: "在籍" } } })]) assert.equal(allows(value, workspace), true);
});
test(`${workspace}: 不正schema・型・ID・名前・未知項目を拒否する`, () => {
  for (const value of [1, "invalid", { schemaVersion: 2 }, { entries: [] }, roster({ entries: "invalid" }),
    roster({ unknown: true }), roster({ entries: [{ id: "", name: "名前" }] }),
    roster({ entries: [{ id: 12, name: "名前" }] }), roster({ entries: [{ id: "a", name: "" }] }),
    roster({ entries: [{ id: "a", name: " " }] }), roster({ entries: [{ id: "a", name: 12 }] }),
    roster({ entries: [{ id: "a", name: "名前", extra: true }] }),
    roster({ entries: { "bad-index": { id: "a", name: "名前" } } })]) {
    assert.equal(allows(value, workspace), false, JSON.stringify(value));
  }
});
}
test("名簿の全階層で本番・devを同じ条件で検証し、書込・読取権限を追加しない", () => {
  function check(node) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ".validate") assert.doesNotMatch(value, /\$workspace/);
      else if (typeof value === "object") check(value);
    }
    assert.equal(Object.hasOwn(node, ".write"), false);
    assert.equal(Object.hasOwn(node, ".read"), false);
  }
  check(rosterRules);
});
test("保存権限は従来の経理・OPと確定ロックを継承し、名簿専用の書込許可を設けない", () => {
  const rule = rules.accountingMonthSnapshots.$month.$revision[".write"];
  assert.match(rule, /role'\)\.val\(\) === 'accounting'/);
  assert.match(rule, /role'\)\.val\(\) === 'op'/);
  assert.doesNotMatch(rule, /role'\)\.val\(\) === 'shop'/);
  assert.match(rule, /!data.exists\(\)/);
  assert.match(rule, /accountingFinalizeLock/);
  assert.match(rule, /status'\)\.val\(\) === 'closing'/);
});
