import assert from "node:assert/strict";

// Ver2.49の送迎追加箇所だけを外し、従来の全Rules指紋を検証する。
export function withoutTransportRules(value) {
  const copy = structuredClone(value), workspace = copy.$workspace;
  assert.ok(workspace.transportMonths && workspace.config.transportSettings);
  delete workspace.transportMonths;
  delete workspace.config.transportSettings;
  const inputs = workspace.accountingAdjustments.$month.castInputs;
  assert.ok(inputs[".read"] && inputs[".indexOn"]);
  delete inputs[".read"]; delete inputs[".indexOn"];
  assert.ok(workspace.accountingAdjustments.$month.driverRemoteAllowance[".read"]);
  delete workspace.accountingAdjustments.$month.driverRemoteAllowance[".read"];
  const marker = ") && ($workspace !== 'accounting-dev' || (newData.child('kind').val() !== 'transport'";
  const expression = inputs.$inputId[".validate"], end = expression.lastIndexOf(marker);
  assert.ok(expression.startsWith("(") && end > 0);
  inputs.$inputId[".validate"] = expression.slice(1, end);
  const snapshot = workspace.accountingMonthSnapshots.$month.$revision;
  for (const row of [snapshot.castSalesReports.$index.days.$dayIndex, snapshot.castSalesReports.$index.totals]) {
    const rule = row[".validate"], boundary = rule.lastIndexOf(" && ($workspace !== 'accounting-dev' || !(");
    assert.ok(boundary > 0 && rule.slice(boundary).includes("transportFee"));
    row[".validate"] = rule.slice(0, boundary);
  }
  return copy;
}
