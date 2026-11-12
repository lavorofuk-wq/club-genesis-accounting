import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withoutWorkAllowanceHistoryIndex } from "./history-index-rules-baseline-helper.mjs";

const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules;

test("送迎・美容室の月検索用索引はbusinessDateだけを両環境共通の日次に設定する", () => {
  assert.deepEqual(rules.$workspace.history[".indexOn"], ["businessDate"]);
  assert.equal(rules[".read"], false);
  assert.equal(rules[".write"], false);
  assert.equal(rules.$workspace.history[".write"], undefined);
});

test("指紋比較の除外は承認された索引だけで、権限・検証・他の項目を変更しない", () => {
  const before = structuredClone(rules);
  const expected = structuredClone(rules);
  delete expected.$workspace.history[".indexOn"];
  const restored = withoutWorkAllowanceHistoryIndex(rules);
  assert.deepEqual(restored, expected);
  assert.deepEqual(rules, before, "入力ルールを破壊しない");
  assert.equal(restored.$workspace.history[".read"], rules.$workspace.history[".read"]);
  assert.deepEqual(restored.$workspace.history.$id, rules.$workspace.history.$id);
});

test("未承認の索引変更・索引削除は歴史的指紋の除外前に拒否する", () => {
  for (const value of [undefined, null, [], "businessDate", ["status"], ["businessDate", "status"], ["businessDate", "businessDate"], { businessDate: true }]) {
    const changed = structuredClone(rules);
    if (value === undefined) delete changed.$workspace.history[".indexOn"];
    else changed.$workspace.history[".indexOn"] = value;
    assert.throws(() => withoutWorkAllowanceHistoryIndex(changed), assert.AssertionError);
  }
});

test("索引以外の権限緩和や検証変更をヘルパーで隠さない", () => {
  const changed = structuredClone(rules);
  changed.$workspace.history[".read"] = true;
  changed.$workspace.history[".write"] = true;
  changed.$workspace.history.$id.$field[".validate"] = true;
  changed.$workspace.history.unexpected = { ".write": true };
  const restored = withoutWorkAllowanceHistoryIndex(changed);
  assert.equal(restored.$workspace.history[".read"], true);
  assert.equal(restored.$workspace.history[".write"], true);
  assert.equal(restored.$workspace.history.$id.$field[".validate"], true);
  assert.deepEqual(restored.$workspace.history.unexpected, { ".write": true });
  assert.notDeepEqual(restored, withoutWorkAllowanceHistoryIndex(rules));
});
