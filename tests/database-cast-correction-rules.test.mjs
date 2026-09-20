import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceRules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules.$workspace;

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
  const names = ["root", "data", "newData", "auth", "now", "$workspace", "$sourceClosingId", "$closingId", "$revision", "$index", "$itemIndex", "$targetIndex", "$other", "$id", "$field", "$handoffId"];
  const run = new Function(...names, `return Boolean(${expression});`);
  return run(new Snapshot(old), new Snapshot(old, path.split("/")), new Snapshot(newTree, path.split("/")), { uid: "user" }, 1800000000000,
    variables.workspace || "accounting-dev", variables.sourceClosingId || "source", variables.closingId || "target",
    variables.revision || "1", variables.index || "0", "0", "0", variables.other || "", variables.id || "target", variables.field || "status", variables.handoffId || "handoff");
}

function correctionTrees({ oldGlobal = 1, newGlobal = 2, documentRevision = 2, claimRevision = documentRevision, existingClaim } = {}) {
  const closing = { status: "approved", businessDate: "2026-10-01", businessMonth: "2026-10" };
  const old = { "accounting-dev": { history: { target: closing }, castDailyCorrectionRevision: oldGlobal,
    castDailyCorrections: { source: { sourceClosingId: "source", revision: documentRevision - 1, active: false } },
    castDailyCorrectionClaims: existingClaim ? { target: { source: existingClaim } } : {} } };
  const next = structuredClone(old);
  next["accounting-dev"].castDailyCorrectionRevision = newGlobal;
  next["accounting-dev"].castDailyCorrections.source = { sourceClosingId: "source", revision: documentRevision, active: true };
  next["accounting-dev"].castDailyCorrectionClaims.target = { source: { sourceClosingId: "source", revision: claimRevision } };
  return { old, next };
}

test("訂正Rulesは開発環境の経理・OPだけに限定し、履歴追記・全体CASを要求する", () => {
  assert.match(workspaceRules.castDailyCorrections[".read"], /\$workspace === 'accounting-dev'/);
  assert.doesNotMatch(workspaceRules.castDailyCorrections[".read"], /shop/);
  assert.match(workspaceRules.castDailyCorrectionRevision[".validate"], /data\.val\(\) \+ 1/);
  assert.match(workspaceRules.castDailyCorrections.$sourceClosingId.revision[".write"], /castDailyCorrectionRevision/);
  assert.match(workspaceRules.castDailyCorrections.$sourceClosingId.history.$revision[".write"], /!data\.exists\(\) && newData\.exists\(\)/);
  assert.match(workspaceRules.castDailyCorrections.$sourceClosingId[".validate"], /history'\)\.child\(newData\.child\('revision'\)\.val\(\) \+ ''\)\.exists\(\)/);
  const historyDraft = workspaceRules.castDailyCorrections.$sourceClosingId.history.$revision.draft;
  assert.match(historyDraft.entries.$index[".validate"], /honShimeiSales.*current.*honShimeiSales/);
  assert.match(historyDraft.products.$index.targets.$targetIndex[".validate"], /current.*targets/);
  assert.doesNotMatch(historyDraft[".validate"], /child\('entries'\)\.val\(\).*child\('current'\).*child\('entries'\)\.val\(\)/);
  assert.equal(workspaceRules.history.$id.casts.$index.accountingCorrection[".validate"], "$workspace !== 'accounting-dev' || !newData.exists()");
});

test("rev2の新しい移動先claimと、復元後rev3以降の再開claimを許可し、古い全体版は拒否する", () => {
  const rule = workspaceRules.castDailyCorrectionClaims.$closingId.$sourceClosingId[".write"];
  const rev2 = correctionTrees();
  assert.equal(evaluate(rule, rev2.old, rev2.next, "accounting-dev/castDailyCorrectionClaims/target/source"), true);
  const rev3 = correctionTrees({ oldGlobal: 2, newGlobal: 3, documentRevision: 3, claimRevision: 3 });
  assert.equal(evaluate(rule, rev3.old, rev3.next, "accounting-dev/castDailyCorrectionClaims/target/source"), true);
  const stale = correctionTrees({ oldGlobal: 2, newGlobal: 2, documentRevision: 3, claimRevision: 3 });
  assert.equal(evaluate(rule, stale.old, stale.next, "accounting-dev/castDailyCorrectionClaims/target/source"), false);
  assert.doesNotMatch(rule, /!data\.exists\(\) && newData\.child\('revision'\)\.val\(\) === 1/);
});

test("対象日claimが残る承認済み日次は差戻しできず、復元後は差戻しできる", () => {
  const rule = workspaceRules.history.$id.$field[".validate"];
  const before = { status: "approved", submittedAtMs: 1 };
  const after = { ...before, status: "returned" };
  const old = { "accounting-dev": { history: { target: before }, castDailyCorrectionClaims: { target: { source: { revision: 1 } } } } };
  const next = { "accounting-dev": { history: { target: after }, castDailyCorrectionClaims: old["accounting-dev"].castDailyCorrectionClaims } };
  assert.equal(evaluate(rule, old, next, "accounting-dev/history/target/status", { id: "target" }), false);
  delete old["accounting-dev"].castDailyCorrectionClaims.target;
  delete next["accounting-dev"].castDailyCorrectionClaims.target;
  assert.equal(evaluate(rule, old, next, "accounting-dev/history/target/status", { id: "target" }), true);
});

test("訂正draftは原本アンカー・承認済み変更先・金額型・固定紹介者条件を検証する", () => {
  const rules = workspaceRules.castDailyCorrections.$sourceClosingId.current;
  assert.match(rules[".validate"], /sourceUpdatedAt.*history/);
  assert.match(rules.entries.$index[".validate"], /status'\)\.val\(\) === 'approved'/);
  assert.match(rules.entries.$index[".validate"], /honShimeiSales.*% 10/);
  assert.match(rules.entries.$index.termsSnapshot[".validate"], /masterId.*businessDate.*source/);
  assert.match(rules.products.$index[".validate"], /champagneWine.*keepBottle.*castDrink/);
  assert.match(rules.products.$index[".validate"], /externalTargetCount/);
});

test("追加した全Rules式はJavaScript互換構文として括弧が閉じている", () => {
  const roots = [workspaceRules.castDailyCorrectionRevision, workspaceRules.castDailyCorrections,
    workspaceRules.castDailyCorrectionClaims, workspaceRules.castReturnHandoffs, workspaceRules.history.$id.castInputRevision,
    workspaceRules.history.$id.$field, workspaceRules.dailyClosingDeletionLock];
  const expressions = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === ".read" || key === ".write" || key === ".validate") && typeof child === "string") expressions.push(child);
      else visit(child);
    }
  };
  roots.forEach(visit);
  for (const expression of expressions) {
    assert.doesNotThrow(() => new Function("root", "data", "newData", "auth", "now", "$workspace", "$sourceClosingId", "$closingId",
      "$revision", "$index", "$itemIndex", "$targetIndex", "$other", "$id", "$field", `return (${expression});`));
  }
});

test("引継ぎ履歴はdevの個別IDだけ店舗から読め、店舗書込・履歴上書き・本番利用は禁止する", () => {
  const rule = workspaceRules.castReturnHandoffs.$id.$handoffId;
  assert.equal(workspaceRules.castReturnHandoffs[".read"], undefined);
  assert.equal(evaluate(rule[".read"], {}, {}, "accounting-dev/castReturnHandoffs/source/handoff", { role: "shop" }), true);
  assert.equal(evaluate(rule[".read"], {}, {}, "accounting/castReturnHandoffs/source/handoff", { role: "shop", workspace: "accounting" }), false);
  assert.equal(evaluate(rule[".write"], {}, {}, "accounting-dev/castReturnHandoffs/source/handoff", { role: "shop" }), false);
  assert.match(rule[".write"], /!data\.exists\(\) && newData\.exists\(\)/);
  assert.match(rule[".validate"], /castDailyCorrectionClaims/);
  assert.match(rule[".validate"], /castDailyCorrections.*active.*false/);
});

test("受入済み引継ぎの途中entry欠落は、残った前行の連続index検査でも拒否する", () => {
  const entry = { id: "pos0", targetClosingId: "source", businessDate: "2026-09-01", masterId: "cast0", name: "合成",
    kind: "regular", startTime: "20:00", endTime: "01:00", breakMinutes: 0, hourlyRate: 3000,
    honShimeiCount: 0, banaiShimeiCount: 0, honShimeiSales: 0, jonaiExtensionSales: 0, beautyAllowance: 0, deleted: false };
  const draft = { entries: [entry, { ...entry, id: "pos1" }, { ...entry, id: "pos2" }] };
  const handoff = { draft, draftShape: { entries: 3, products: 0, originalCasts: 0, indices: { 0: 0, 1: 1, 2: 2 }, dohan: { 0: 0, 1: 0, 2: 0 } } };
  const old = { "accounting-dev": { castReturnHandoffs: { source: { handoff } } } };
  const next = { "accounting-dev": { ...old["accounting-dev"], history: { source: { castInputRevision: { handoffId: "handoff", draft: structuredClone(draft) } } } } };
  const rule = workspaceRules.history.$id.castInputRevision.draft.entries.$index[".validate"];
  const path = "accounting-dev/history/source/castInputRevision/draft/entries/0";
  assert.equal(evaluate(rule, old, next, path, { id: "source" }), true);
  delete next["accounting-dev"].history.source.castInputRevision.draft.entries[1];
  assert.equal(evaluate(rule, old, next, path, { id: "source" }), false);
});

test("受入済み引継ぎは新POSへ持ち越せず、既存の本番検証は変えない", () => {
  const draft = { sourceClosingId: "source", sourceChecksum: "old", sourceSubmissionId: "submission-old" };
  const input = { schema: 1, handoffId: "handoff", sourceCorrectionRevision: 1, draft };
  const old = { "accounting-dev": { history: { source: { castReturnHandoffId: "handoff" } },
    castReturnHandoffs: { source: { handoff: { sourceCorrectionRevision: 1, draftShape: { originalCasts: 0 } } } } } };
  const next = { "accounting-dev": { ...old["accounting-dev"], history: { source: { status: "submitted", checksum: "old", submissionId: "submission-old", castInputRevision: input } } } };
  const rule = workspaceRules.history.$id.castInputRevision[".validate"];
  const path = "accounting-dev/history/source/castInputRevision";
  assert.equal(evaluate(rule, old, next, path, { id: "source" }), true);
  next["accounting-dev"].history.source.checksum = "new";
  assert.equal(evaluate(rule, old, next, path, { id: "source" }), false);
  assert.equal(evaluate(rule, {}, {}, "accounting/history/source/castInputRevision", { workspace: "accounting", id: "source" }), true);
});
