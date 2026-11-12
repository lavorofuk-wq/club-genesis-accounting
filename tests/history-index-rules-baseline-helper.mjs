import assert from "node:assert/strict";

/** 営業日検索の索引だけを歴史的な保護ルール指紋から除く。権限・検証条件は保持する。 */
export function withoutWorkAllowanceHistoryIndex(value) {
  const copy = structuredClone(value);
  assert.deepEqual(copy.$workspace?.history?.[".indexOn"], ["businessDate"], "承認済みの日次索引だけを除外する");
  delete copy.$workspace.history[".indexOn"];
  return copy;
}
