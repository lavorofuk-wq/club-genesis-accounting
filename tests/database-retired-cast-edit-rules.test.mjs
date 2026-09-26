import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules;
const workspaceRules = rules.$workspace;
const retiredRoots = ["castDailyCorrectionRevision", "castDailyCorrections", "castDailyCorrectionClaims", "castReturnHandoffs"];
const retiredFields = ["castInputRevision", "castReturnHandoffId", "castReturnProductAllocation"];
const retiredGuard = "$workspace !== 'accounting-dev' || !newData.exists()";

class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  val() { return this.path.reduce((value, key) => value?.[key], this.tree) ?? null; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  exists() { return this.val() !== null; }
  isNumber() { return typeof this.val() === "number" && Number.isFinite(this.val()); }
  isString() { return typeof this.val() === "string"; }
  isBoolean() { return typeof this.val() === "boolean"; }
  hasChildren(keys = []) { const value = this.val(); return value && typeof value === "object" && Object.keys(value).length > 0
    && keys.every((key) => this.child(key).exists()); }
}

function evaluate(rule, oldTree, newTree, path, variables = {}) {
  const old = structuredClone(oldTree);
  old.users = { user: { role: variables.role || "op" } };
  const expression = rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(");
  return Boolean(new Function("root", "data", "newData", "auth", "now", "$workspace", "$id", "$field",
    `return (${expression});`)(new Snapshot(old), new Snapshot(old, path.split("/")),
    new Snapshot(newTree, path.split("/")), { uid: "user" }, 1800000000000,
    variables.workspace || "accounting-dev", variables.id || "target", variables.field || "status"));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

function outsideRetiredRules(value) {
  const copy = structuredClone(value);
  const workspace = copy.$workspace;
  // Ver2.37の新規追加項目だけを除き、それ以外は撤去前の指紋を維持する。
  delete workspace.accountingAdjustments.$month.castInputs;
  const snapshots = workspace.accountingMonthSnapshots.$month.$revision;
  for (const node of [snapshots.castRewards.$index, snapshots.castSalesReports.$index.days.$dayIndex, snapshots.castSalesReports.$index.totals]) {
    for (const key of ["additionalSales", "additionalAllowance", "additionalTransportFee", "accountingInputs"]) delete node[key];
  }
  // 追加売上を持つdevの分岐だけを除去し、本番/既存データの元式を指紋に含める。
  const originalSales = "newData.child('totalSales').val() === newData.child('honShimeiSales').val() + newData.child('jonaiExtensionSales').val()";
  const additionalSales = "(($workspace === 'accounting-dev' && newData.child('additionalSales').exists()) ? "
    + originalSales + " + newData.child('additionalSales').val() : " + originalSales + ")";
  for (const node of [snapshots.castSalesReports.$index.days.$dayIndex, snapshots.castSalesReports.$index.totals]) {
    assert.ok(node[".validate"].includes(additionalSales));
    node[".validate"] = node[".validate"].replace(additionalSales, originalSales);
  }
  delete workspace.dailyClosingDeletionLock[".validate"];
  delete workspace.history.$id.$field[".validate"];
  delete workspace.history.$id.casts;
  for (const key of retiredRoots) delete workspace[key];
  for (const key of retiredFields) delete workspace.history.$id[key];
  return copy;
}

// 条件式の本番分岐だけを定数化する。未知のFirebase式は評価せず構文として保持する。
function productionExpression(expression) {
  const source = ts.createSourceFile("rule.ts", `(${expression.replaceAll("$workspace", "'accounting'")});`,
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(source.parseDiagnostics.length, 0);
  const simplify = (node) => {
    if (ts.isParenthesizedExpression(node)) return simplify(node.expression);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isBinaryExpression(node)) {
      const left = simplify(node.left), right = simplify(node.right), operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (left === false || right === false) return false;
        if (left === true) return right;
        if (right === true) return left;
      }
      if (operator === ts.SyntaxKind.BarBarToken) {
        if (left === true || right === true) return true;
        if (left === false) return right;
        if (right === false) return left;
      }
      if (ts.isStringLiteral(node.left) && ts.isStringLiteral(node.right)) {
        if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken) return node.left.text === node.right.text;
        if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) return node.left.text !== node.right.text;
      }
      return [ts.tokenToString(operator), left, right];
    }
    return node.getText(source).replace(/\s+/g, " ");
  };
  return simplify(source.statements[0].expression);
}

test("日次編集以外の保護ルールは撤去前から一切変更しない", () => {
  // 撤去前 Ver2.35.0 のJSONから、明示した対象だけを除外した指紋。
  assert.equal(fingerprint(outsideRetiredRules(rules)), "19580d9e6520beb8bbdf064997ca7fae8b8909adec28511f6041c32d2479ad27");
});

test("削除ロックと通常日次の本番条件は撤去前と同一", () => {
  assert.equal(fingerprint(productionExpression(workspaceRules.dailyClosingDeletionLock[".validate"])), "ddb30dcc2e44c1c8cd440fdff9fb81c434bfb574ab812c1ade09c774a8fea160");
  assert.equal(fingerprint(productionExpression(workspaceRules.history.$id.$field[".validate"])), "0cbd17e694033191d84de8ffd2e12faf27a3ff086a9c636b0f82e3358c45881f");
});

test("廃止した四つの根ノードは旧端末にも既定denyで読書きを許可しない", () => {
  assert.equal(rules[".read"], false);
  assert.equal(rules[".write"], false);
  assert.equal(workspaceRules[".read"], undefined);
  assert.equal(workspaceRules[".write"], undefined);
  assert.equal(workspaceRules.$other, undefined);
  for (const key of retiredRoots) assert.equal(workspaceRules[key], undefined);
});

test("旧日次編集の付帯フィールドはdevへの混入を拒否し、本番の既存条件は変えない", () => {
  const guards = [
    ...retiredFields.map((key) => [key, workspaceRules.history.$id[key][".validate"]]),
    ["casts/0/accountingCorrection", workspaceRules.history.$id.casts.$index.accountingCorrection[".validate"]],
  ];
  for (const [key, guard] of guards) {
    assert.equal(guard, retiredGuard);
    assert.equal(productionExpression(guard), true);
    const path = `accounting-dev/history/target/${key}`;
    const tree = { "accounting-dev": { history: { target: {} } } };
    const parts = key.split("/"); let node = tree["accounting-dev"].history.target;
    for (const part of parts.slice(0, -1)) node = node[part] = {};
    node[parts.at(-1)] = { unexpected: true };
    assert.equal(evaluate(guard, {}, tree, path), false);
    assert.equal(evaluate(guard, tree, {}, path), true);
    assert.equal(evaluate(guard, {}, tree, path, { workspace: "accounting" }), true);
  }
});

test("未移行の旧参照情報があっても確認待ち・承認済みの日次を通常差戻しできる", () => {
  const rule = workspaceRules.history.$id.$field[".validate"];
  for (const workspace of ["accounting-dev", "accounting"]) for (const status of ["submitted", "approved"]) {
    const before = { status, submittedAtMs: 1000 };
    const old = { [workspace]: { history: { target: before }, castDailyCorrectionClaims: { target: { source: { revision: 1 } } } } };
    const next = structuredClone(old);
    next[workspace].history.target.status = "returned";
    assert.equal(evaluate(rule, old, next, `${workspace}/history/target/status`, { workspace }), true);
    next[workspace].history.target.submittedAtMs = 2000;
    assert.equal(evaluate(rule, old, next, `${workspace}/history/target/status`, { workspace }), false);
  }
});

test("通常の店舗再送にはサーバー送信時刻を要求し、編集引継ぎを要求しない", () => {
  const rule = workspaceRules.history.$id.$field[".validate"];
  for (const status of ["returned", "withdrawn"]) {
    const old = { "accounting-dev": { history: { target: { status, submittedAtMs: 1000 } } } };
    const next = structuredClone(old);
    Object.assign(next["accounting-dev"].history.target, { status: "submitted", submittedAtMs: 1800000000000 });
    assert.equal(evaluate(rule, old, next, "accounting-dev/history/target/status"), true);
    next["accounting-dev"].history.target.submittedAtMs = 1000;
    assert.equal(evaluate(rule, old, next, "accounting-dev/history/target/status"), false);
  }
});

test("日次更新・月次・現金の既存保護は残り、廃止処理の呼出しは残らない", () => {
  assert.match(workspaceRules.history.$id[".write"], /accountingFinalizeLock/);
  assert.match(workspaceRules.history.$id[".write"], /accountingMonthStates/);
  assert.match(workspaceRules.history.$id[".write"], /cashManagementLock/);
  assert.doesNotMatch(workspaceRules.history.$id.$field[".validate"], /castDailyCorrection|castReturnHandoff|castInputRevision/);
  assert.doesNotMatch(workspaceRules.dailyClosingDeletionLock[".validate"], /castDailyCorrection/);
});

test("変更した全保護式は有効な構文である", () => {
  const expressions = [workspaceRules.history.$id.$field[".validate"], workspaceRules.dailyClosingDeletionLock[".validate"],
    ...retiredFields.map((key) => workspaceRules.history.$id[key][".validate"]), retiredGuard];
  for (const expression of expressions) assert.doesNotThrow(() => productionExpression(expression));
});
