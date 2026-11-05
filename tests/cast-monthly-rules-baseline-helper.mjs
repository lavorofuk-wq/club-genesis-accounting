import assert from "node:assert/strict";

// 月度キャスト追加箇所だけを外し、従来の保護式の指紋は維持する。
export function withoutCastMonthlyRules(value) {
  const copy = structuredClone(value);
  const workspace = copy.$workspace;
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
