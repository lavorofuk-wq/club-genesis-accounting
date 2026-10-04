import assert from "node:assert/strict";

// Ver2.49の送迎追加箇所だけを外し、従来の全Rules指紋を検証する。
export function withoutTransportRules(value) {
  const copy = structuredClone(value), workspace = copy.$workspace;
  assert.ok(workspace.transportMonths && workspace.config.transportSettings);
  // Ver2.50: 追加パスと、同じ日次行の美容室手当を保持する検証だけを除く。
  assert.ok(workspace.beautyMonths);
  delete workspace.beautyMonths;
  assert.equal(workspace.history.$id.casts.$index[".validate"], "$workspace !== 'accounting-dev' || ((newData.child('beautyAllowance').val() === 0 || (newData.child('kind').val() === 'regular' && newData.child('beautyAllowance').val() === 500)) && (!data.parent().parent().exists() || data.child('kind').val() !== newData.child('kind').val() || (data.child('masterId').val() !== newData.child('masterId').val() && data.child('posCastId').val() !== newData.child('posCastId').val()) || newData.child('beautyAllowance').val() === (data.child('beautyAllowance').exists() ? data.child('beautyAllowance').val() : 0)))");
  delete workspace.history.$id.casts.$index[".validate"];
  delete workspace.transportMonths;
  delete workspace.config.transportSettings;
  const inputs = workspace.accountingAdjustments.$month.castInputs;
  assert.ok(inputs[".read"] && inputs[".indexOn"]);
  delete inputs[".read"]; delete inputs[".indexOn"];
  assert.ok(workspace.accountingAdjustments.$month.driverRemoteAllowance[".read"]);
  delete workspace.accountingAdjustments.$month.driverRemoteAllowance[".read"];
  const marker = ") && (($workspace !== 'accounting-dev' && $workspace !== 'accounting') || (newData.child('kind').val() !== 'transport'";
  const expression = inputs.$inputId[".validate"], end = expression.lastIndexOf(marker);
  assert.ok(expression.startsWith("(") && end > 0);
  inputs.$inputId[".validate"] = expression.slice(1, end);
  const snapshot = workspace.accountingMonthSnapshots.$month.$revision;
  for (const row of [snapshot.castSalesReports.$index.days.$dayIndex, snapshot.castSalesReports.$index.totals]) {
    const rule = row[".validate"], boundary = rule.lastIndexOf(" && (($workspace !== 'accounting-dev' && $workspace !== 'accounting') || !(");
    assert.ok(boundary > 0 && rule.slice(boundary).includes("transportFee"));
    row[".validate"] = rule.slice(0, boundary);
  }
  return copy;
}
