import assert from "node:assert/strict";

const snapshot = "newData.parent().parent().parent()";
const version = "/^(2[.]50[.][1-9][0-9]*|2[.](5[1-9]|[6-9][0-9]|[1-9][0-9]{2,})[.](0|[1-9][0-9]*)|([3-9]|[1-9][0-9]+)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*))$/";
const gate = "($workspace === 'accounting-dev' || $workspace === 'accounting') && " + snapshot + ".child('schemaVersion').val() === 3 && "
  + snapshot + ".child('calculationVersion').isString() && " + snapshot + ".child('calculationVersion').val().matches(" + version + ")";
const numeric = "newData.isNumber() && newData.val() >= 0 && ";
const legacyUnit = "newData.val() % 10 === 0";

// 承認済みVer2.50.1以降のdev・本番2式を全一致で確認してから旧式へ戻す。
// 指紋の固定値と、それ以外の全保護式は変更・除外しない。
export function withoutOneYenSalesRewardRules(value) {
  const copy = structuredClone(value);
  const rewards = copy.$workspace.accountingMonthSnapshots.$month.$revision.castRewards.$index;
  for (const [key, nextUnit] of [
    ["salesRewardBase", "newData.val() <= 9007199254740991"],
    ["salesReward", "(newData.val() <= 9007199254740991 && newData.val() % 1 === 0)"],
  ]) {
    assert.deepEqual(rewards[key], {
      ".validate": numeric + "((" + gate + ") ? " + nextUnit + " : " + legacyUnit + ")",
    }, `${key}: dev・本番のschema 3・Ver2.50.1以降の限定条件と旧版の10円条件を維持する`);
    rewards[key][".validate"] = numeric + legacyUnit;
  }
  return copy;
}
