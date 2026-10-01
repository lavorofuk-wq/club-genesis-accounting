import assert from "node:assert/strict";

// 承認済み本番・dev名簿の全式・全キーを厳密検証してから除外し、過去の保護式の指紋は更新しない。
export function withoutCastSalesRankingRosterRules(value) {
  const copy = structuredClone(value);
  const snapshot = copy.$workspace.accountingMonthSnapshots.$month.$revision;
  assert.deepEqual(snapshot.castSalesRankingRoster, {
    ".validate": "newData.hasChildren(['schemaVersion']) && newData.child('schemaVersion').val() === 1",
    schemaVersion: { ".validate": "newData.val() === 1" },
    entries: {
      ".validate": "newData.hasChildren()",
      $index: {
        ".validate": "$index.matches(/^(0|[1-9]\\d*)$/) && newData.hasChildren(['id', 'name']) && newData.child('id').isString() && newData.child('id').val().length > 0 && newData.child('name').isString() && newData.child('name').val().matches(/.*\\S.*/)",
        $field: { ".validate": "$field.matches(/^(id|name)$/)" },
      },
    },
    $field: { ".validate": "$field.matches(/^(schemaVersion|entries)$/)" },
  }, "承認された本番・dev名簿のschema・全field検証・既存項目への非干渉を維持する");
  delete snapshot.castSalesRankingRoster;
  return copy;
}
