import assert from "node:assert/strict";

// 承認済みdev名簿の全式・全キーを厳密検証してから除外し、過去の保護式の指紋は更新しない。
export function withoutCastSalesRankingRosterRules(value) {
  const copy = structuredClone(value);
  const snapshot = copy.$workspace.accountingMonthSnapshots.$month.$revision;
  assert.deepEqual(snapshot.castSalesRankingRoster, {
    ".validate": "$workspace !== 'accounting-dev' || (newData.hasChildren(['schemaVersion']) && newData.child('schemaVersion').val() === 1)",
    schemaVersion: { ".validate": "$workspace !== 'accounting-dev' || newData.val() === 1" },
    entries: {
      ".validate": "$workspace !== 'accounting-dev' || newData.hasChildren()",
      $index: {
        ".validate": "$workspace !== 'accounting-dev' || ($index.matches(/^(0|[1-9]\\d*)$/) && newData.hasChildren(['id', 'name']) && newData.child('id').isString() && newData.child('id').val().length > 0 && newData.child('name').isString() && newData.child('name').val().matches(/.*\\S.*/))",
        $field: { ".validate": "$workspace !== 'accounting-dev' || $field.matches(/^(id|name)$/)" },
      },
    },
    $field: { ".validate": "$workspace !== 'accounting-dev' || $field.matches(/^(schemaVersion|entries)$/)" },
  }, "承認されたdev限定名簿のschema・全field検証・既存本番への非干渉を維持する");
  delete snapshot.castSalesRankingRoster;
  return copy;
}
