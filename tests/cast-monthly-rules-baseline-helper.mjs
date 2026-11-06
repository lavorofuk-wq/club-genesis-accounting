import assert from "node:assert/strict";

function withoutCastEntryCancellationRules(workspace) {
  const cast = workspace.casts.$id;
  const originalForward = "(!data.child('convertedToCastId').exists() || newData.child('convertedToCastId').val() === data.child('convertedToCastId').val())";
  const castRule = cast[".validate"];
  const forwardStart = castRule.indexOf(originalForward.slice(0, -1) + " || (data.child('status').val() === 'trial'");
  const forwardEnd = castRule.indexOf(")) && ((!newData.child('deletedAt').exists()", forwardStart);
  const activeStart = castRule.indexOf(" && ((!newData.child('entryCancelledAt').exists()");
  assert.ok(forwardStart > 0 && forwardEnd > forwardStart && activeStart > forwardEnd);
  cast[".validate"] = castRule.slice(0, forwardStart) + originalForward + castRule.slice(forwardEnd + 2, activeStart);

  const historyCast = workspace.history.$id.casts.$index;
  const historyRule = historyCast[".validate"];
  const historyEnd = historyRule.lastIndexOf(") && ((newData.parent().parent().child('status').val() !== 'submitted'");
  assert.ok(historyRule.startsWith("(") && historyEnd > 0);
  historyCast[".validate"] = historyRule.slice(1, historyEnd);

  const cashLock = workspace.cashManagementLock;
  for (const snapshot of ["data", "newData"]) {
    const role = " || (" + snapshot + ".child('operation').val() === 'cancelCastConversion' && root.child('users').child(auth.uid).child('role').val() === 'accounting')";
    assert.ok(cashLock[".write"].includes(role));
    cashLock[".write"] = cashLock[".write"].replace(role, "");
  }
  const cashRule = cashLock[".validate"];
  const additionalOperation = " || newData.child('operation').val() === 'cancelCastConversion'";
  const cashEnd = cashRule.lastIndexOf(" && (newData.child('operation').val() === 'cancelCastConversion' ?");
  assert.ok(cashRule.includes(additionalOperation) && cashEnd > 0);
  cashLock[".validate"] = cashRule.slice(0, cashEnd).replace(additionalOperation, "");
  assert.ok(cashLock.$field[".validate"].includes("|expiresAt|month"));
  cashLock.$field[".validate"] = cashLock.$field[".validate"].replace("|expiresAt|month", "|expiresAt");
}

// 月度キャスト追加箇所だけを外し、従来の保護式の指紋は維持する。
export function withoutCastMonthlyRules(value) {
  const copy = structuredClone(value);
  const workspace = copy.$workspace;
  withoutCastEntryCancellationRules(workspace);
  const cast = workspace.casts.$id;
  for (const key of ["departureLockToken", "trialHourlyRates", "monthlyIntroducers"]) {
    assert.ok(cast[key]);
    delete cast[key];
  }
  assert.ok(workspace.castDepartureLock);
  delete workspace.castDepartureLock;
  const expressions = [
    [cast, ".write", " && (" + "newData.child('status').val() !== 'departed' || (data.child('status').val() === 'departed' && newData.child('departedAt').val() === data.child('departedAt').val()) || ((data.child('status').val() === 'active' || data.child('status').val() === 'departed') && root.child($workspace).child('castDepartureLock').exists() && root.child($workspace).child('castDepartureLock').child('expiresAt').val() > now && root.child($workspace).child('castDepartureLock').child('owner').val() === auth.uid && newData.child('departedAt').isString() && newData.child('departedAt').val().beginsWith(root.child($workspace).child('castDepartureLock').child('month').val() + '-') && newData.child('departedAt').val() >= newData.child('hiredAt').val() && newData.child('departureLockToken').val() === root.child($workspace).child('castDepartureLock').child('token').val())" + ")"],
    [cast, ".validate", " && " + "(!data.child('trialHourlyRates').exists() || newData.child('trialHourlyRates').hasChildren()) && (!(newData.child('conversionLock').exists() || (data.child('conversionLock').exists() && data.child('conversionLock').child('expiresAt').val() > now)) || newData.child('trialHourlyRates').exists() === data.child('trialHourlyRates').exists()) && (!data.child('monthlyIntroducers').exists() || newData.child('monthlyIntroducers').hasChildren()) && (!(newData.child('conversionLock').exists() || (data.child('conversionLock').exists() && data.child('conversionLock').child('expiresAt').val() > now)) || newData.child('monthlyIntroducers').exists() === data.child('monthlyIntroducers').exists())"],
    [workspace.history.$id, ".write", " && (" + "newData.child('status').val() !== 'approved' || data.child('status').val() === 'approved' || !(root.child($workspace).child('castDepartureLock').exists() && root.child($workspace).child('castDepartureLock').child('expiresAt').val() > now) || !newData.child('businessDate').val().beginsWith(root.child($workspace).child('castDepartureLock').child('month').val() + '-')" + ")"],
  ];
  for (const [node, key, suffix] of expressions) {
    const rule = node[key];
    assert.ok(rule.startsWith("(") && rule.endsWith(")" + suffix));
    node[key] = rule.slice(1, -(suffix.length + 1));
  }
  return copy;
}
