import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import nodeTest from "node:test";
import ts from "typescript";
const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules;
const transport = rules.$workspace.transportMonths;
const settings = rules.$workspace.config.transportSettings;
const month = "2026-09", businessDate = "2026-09-02", now = 1800000000000;
class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  raw() { return this.path.reduce((value, key) => value?.[key], this.tree) ?? null; }
  val() { const value = this.raw(); return value && typeof value === "object" ? "RULE_DATA_SENTINEL" : value; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  exists() { return this.raw() !== null; }
  isNumber() { return typeof this.raw() === "number" && Number.isFinite(this.raw()); }
  isString() { return typeof this.raw() === "string"; }
  hasChildren(keys = []) { const value = this.raw(); return value && typeof value === "object" && Object.keys(value).length > 0 && keys.every((key) => this.child(key).exists()); }
}
for (const workspaceUnderTest of ["accounting-dev", "accounting"]) {
const test = (name, run) => nodeTest(workspaceUnderTest + ": " + name, run);
const identity = { $workspace: workspaceUnderTest, $month: month, $personId: "cast_1", $castId: "cast_1", $date: businessDate, $field: "", $entryId: "first", $legacyIndex: "0", $amountIndex: "0" };
function evaluate(rule, old, next, path, context = {}) {
  const variables = { ...identity, ...context };
  return Boolean(new Function("root", "data", "newData", "auth", "now", "query", ...Object.keys(variables),
    "return (" + rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(") + ");")(
    new Snapshot(old), new Snapshot(old, path.split("/")), new Snapshot(next, path.split("/")),
    context.auth === null ? null : { uid: "user" }, now, context.query || {}, ...Object.values(variables)));
}
function fixture(kind = "casts") {
  const old = { users: { user: { role: "shop" } }, [workspaceUnderTest]: {
    config: { transportSettings: { revision: 1, castRegistrations: { cast_1: { amounts: [500, 1000] } }, remoteAmounts: [500, 1000] } },
    casts: { cast_1: { name: "テスト", status: "active" } }, drivers: { driver_1: { name: "運転手" } },
    history: { daily_20260902: { status: "submitted", businessDate, casts: [{ masterId: "cast_1", kind: "regular" }], drivers: [{ driverId: "driver_1" }] } },
    accountingAdjustments: { [month]: { castInputs: { legacy_1: { kind: "transport", castId: "cast_1", businessDate, amount: 500 } } } },
  } };
  const next = structuredClone(old), id = kind === "casts" ? "cast_1" : "driver_1";
  const day = { attendanceClosingId: "daily_20260902", attendanceIndex: 0, ...(kind === "casts" ? { amount: 1000, legacyInputIds: ["legacy_1"] } : { entries: { first: 500, second: 1000 } }) };
  next[workspaceUnderTest].transportMonths = { [month]: { revision: 1, updatedAt: "2026-09-03T00:00:00.000Z", updatedBy: "user", [kind]: { [id]: { [businessDate]: day } } } };
  return { old, next, kind, id, day };
}
function allowed(f) {
  const monthPath = workspaceUnderTest + "/transportMonths/" + month, dayPath = monthPath + "/" + f.kind + "/" + f.id + "/" + businessDate;
  const context = { $personId: f.id }, dayRules = transport.$month[f.kind].$personId.$date;
  if (!evaluate(dayRules[".write"], f.old, f.next, dayPath, context) || !evaluate(transport.$month[".validate"], f.old, f.next, monthPath, context)
    || !evaluate(dayRules[".validate"], f.old, f.next, dayPath, context)) return false;
  for (const key of ["revision", "updatedAt", "updatedBy"]) if (!evaluate(transport.$month[key][".write"], f.old, f.next, monthPath + "/" + key, context)) return false;
  for (const [key, value] of Object.entries(f.day)) {
    if (key === "legacyInputIds") for (const index of Object.keys(value)) if (!evaluate(dayRules.legacyInputIds.$legacyIndex[".validate"], f.old, f.next, dayPath + "/legacyInputIds/" + index, { ...context, $legacyIndex: index })) return false;
    if (key === "entries") for (const id of Object.keys(value)) if (!evaluate(dayRules.entries.$entryId[".validate"], f.old, f.next, dayPath + "/entries/" + id, { ...context, $entryId: id })) return false;
    if (!evaluate(dayRules.$field[".validate"], f.old, f.next, dayPath + "/" + key, { ...context, $field: key })) return false;
  }
  return true;
}
test("送迎書込は店舗・OPだけに許可し、経理と対象外workspaceへの書込を拒否する", () => {
  for (const role of ["shop", "op"]) { const f = fixture(); f.old.users.user.role = role; assert.equal(allowed(f), true); }
  const f = fixture(); f.old.users.user.role = "accounting"; assert.equal(allowed(f), false);
  const node = transport.$month.casts.$personId.$date;
  assert.equal(evaluate(node[".write"], fixture().old, fixture().next, workspaceUnderTest + "/transportMonths/" + month + "/casts/cast_1/" + businessDate, { $workspace: "other" }), false);
});
test("CAS・確定月・確定処理ロックをサーバーで検査する", () => {
  for (const patch of [{ revision: 2 }, { updatedBy: "other" }]) { const f = fixture(); Object.assign(f.next[workspaceUnderTest].transportMonths[month], patch); assert.equal(allowed(f), false); }
  for (const status of ["closed", "closing"]) { const f = fixture(); f.old[workspaceUnderTest].accountingMonthStates = { [month]: { status } }; assert.equal(allowed(f), false); }
  const f = fixture(); f.old[workspaceUnderTest].accountingFinalizeLock = { expiresAt: now + 10000 }; assert.equal(allowed(f), false);
});
test("新規送迎は本人の送信済み出勤と500円刻み4候補だけを受け付ける", () => {
  for (const patch of [{ amount: 501 }, { amount: 2500 }, { attendanceIndex: 1 }, { attendanceClosingId: "missing" }]) { const f = fixture(); Object.assign(f.day, patch); assert.equal(allowed(f), false); }
  for (const status of ["returned", "withdrawn"]) { const f = fixture(); f.old[workspaceUnderTest].history.daily_20260902.status = status; assert.equal(allowed(f), false); }
  const f = fixture(); f.old[workspaceUnderTest].casts.cast_1.status = "trial"; assert.equal(allowed(f), false);
});
test("他人の旧追加入力を送迎日別記録で抑制できない", () => {
  const f = fixture(); f.old[workspaceUnderTest].accountingAdjustments[month].castInputs.legacy_1.castId = "other"; assert.equal(allowed(f), false);
});
test("送迎と遠方手当は論理削除できるが、日別記録の物理削除と月の一括書込を拒否する", () => {
  assert.equal(transport.$month[".write"], undefined);
  for (const kind of ["casts", "drivers"]) {
    const f = fixture(kind); const path = workspaceUnderTest + "/transportMonths/" + month + "/" + kind + "/" + f.id + "/" + businessDate;
    const before = structuredClone(f.next); delete f.next[workspaceUnderTest].transportMonths[month][kind][f.id][businessDate];
    assert.equal(evaluate(transport.$month[kind].$personId.$date[".write"], before, f.next, path, { $personId: f.id }), false);
    assert.equal(transport.$month[kind][".write"], undefined); assert.equal(transport.$month[kind].$personId[".write"], undefined);
    f.next = structuredClone(before); f.old = before; f.next[workspaceUnderTest].transportMonths[month].revision = 2;
    f.next[workspaceUnderTest].transportMonths[month].updatedAt = "2026-09-03T01:00:00.000Z";
    f.day = f.next[workspaceUnderTest].transportMonths[month][kind][f.id][businessDate];
    if (kind === "casts") f.day.amount = 0; else delete f.day.entries;
    f.old[workspaceUnderTest].history.daily_20260902.status = "returned";
    assert.equal(allowed(f), true);
  }
});
test("遠方手当は同日に複数回保持し、本人出勤以外や不正金額を拒否する", () => {
  const f = fixture("drivers"); assert.equal(allowed(f), true);
  f.day.entries.second = 501; assert.equal(allowed(f), false);
  f.day.entries.second = 1000; f.old[workspaceUnderTest].history.daily_20260902.drivers[0].driverId = "other"; assert.equal(allowed(f), false);
});
test("店舗は旧送迎クエリと旧遠方手当だけ読み取れ、経理入力全体を読めない", () => {
  const f = fixture(), monthly = rules.$workspace.accountingAdjustments.$month;
  assert.equal(evaluate(rules.$workspace.accountingAdjustments[".read"], f.old, f.next, workspaceUnderTest + "/accountingAdjustments"), false);
  const path = workspaceUnderTest + "/accountingAdjustments/" + month + "/castInputs";
  assert.equal(evaluate(monthly.castInputs[".read"], f.old, f.next, path, { query: { orderByChild: "kind", equalTo: "transport" } }), true);
  assert.equal(evaluate(monthly.castInputs[".read"], f.old, f.next, path), false);
  assert.equal(evaluate(monthly.castInputs[".read"], f.old, f.next, path, { query: { orderByChild: "kind", equalTo: "sales" } }), false);
  assert.deepEqual(monthly.castInputs[".indexOn"], ["kind"]);
  assert.equal(evaluate(monthly.driverRemoteAllowance[".read"], f.old, f.next, workspaceUnderTest + "/accountingAdjustments/" + month + "/driverRemoteAllowance"), true);
});
test("ルールに非対応メソッドや重複したワイルドカードを作らない", () => {
  function inspect(node, ancestors = []) {
    for (const [key, value] of Object.entries(node)) {
      if ([".validate", ".write", ".read"].includes(key) && typeof value === "string") {
        assert.equal(value.includes("numChildren("), false);
        const parsed = ts.createSourceFile("rule.ts", "(" + value + ");", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        assert.equal(parsed.parseDiagnostics.length, 0, value);
      } else if (value && typeof value === "object") {
        if (key.startsWith("$")) assert.equal(ancestors.includes(key), false, key);
        inspect(value, key.startsWith("$") ? [...ancestors, key] : ancestors);
      }
    }
  }
  inspect(transport, ["$workspace"]); inspect(settings, ["$workspace"]);
});

test("送迎データは認証済みの3権限だけ参照でき、対象外workspaceを拒否する", () => {
  const f = fixture();
  for (const role of ["shop", "accounting", "op", "unknown"]) {
    f.old.users.user.role = role;
    for (const [node, path] of [[settings, "config/transportSettings"], [transport, "transportMonths"]]) {
      assert.equal(evaluate(node[".read"], f.old, f.next, "other/" + path, { $workspace: "other" }), false);
      assert.equal(evaluate(node[".read"], f.old, f.next, workspaceUnderTest + "/" + path), role !== "unknown");
      assert.equal(evaluate(node[".read"], f.old, f.next, workspaceUnderTest + "/" + path, { auth: null }), false);
    }
  }
});

test("退店後の同額記録だけ現在の本人出勤へ根拠を修復できる", () => {
  const f = fixture(); f.old = structuredClone(f.next); f.next = structuredClone(f.old);
  f.old[workspaceUnderTest].casts.cast_1.status = "departed";
  f.old[workspaceUnderTest].history.daily_20260902.casts.unshift({ masterId: "other", kind: "regular" });
  Object.assign(f.next[workspaceUnderTest].transportMonths[month], { revision: 2, updatedAt: "2026-09-03T01:00:00.000Z" });
  f.day = f.next[workspaceUnderTest].transportMonths[month].casts.cast_1[businessDate]; f.day.attendanceIndex = 1;
  assert.equal(allowed(f), true);
  f.day.amount = 1500; assert.equal(allowed(f), false); f.day.amount = 1000;
  f.old[workspaceUnderTest].casts.cast_1.deletedAt = "2026-09-03T00:00:00Z"; assert.equal(allowed(f), false);
  delete f.old[workspaceUnderTest].casts.cast_1.deletedAt;
  f.old[workspaceUnderTest].history.daily_20260902.status = "returned"; assert.equal(allowed(f), false);
  f.old[workspaceUnderTest].history.daily_20260902.status = "approved";
  delete f.old[workspaceUnderTest].casts.cast_1; assert.equal(allowed(f), false);
});
test("退店者の新規送迎と旧額からの初回上書きを許可しない", () => {
  const f = fixture(); f.old[workspaceUnderTest].casts.cast_1.status = "departed";
  f.old[workspaceUnderTest].history.daily_20260902.casts[0].transportFee = 1000;
  assert.equal(allowed(f), false);
});

}
