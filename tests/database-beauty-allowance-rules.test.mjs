import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import nodeTest from "node:test";
const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules;
const beauty = rules.$workspace.beautyMonths, month = "2026-09", businessDate = "2026-09-02", now = 1800000000000;
for (const workspaceUnderTest of ["accounting-dev", "accounting"]) {
const test = (name, run) => nodeTest(workspaceUnderTest + ": " + name, run);
const monthPath = workspaceUnderTest + "/beautyMonths/" + month, dayPath = monthPath + "/casts/cast_1/" + businessDate;
const dayRules = beauty.$month.casts.$personId.$date;
class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  raw() { return this.path.reduce((value, key) => value?.[key], this.tree) ?? null; }
  val() { const value = this.raw(); return value && typeof value === "object" ? "RULE_DATA_SENTINEL" : value; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  exists() { return this.raw() !== null; }
  isNumber() { return typeof this.raw() === "number" && Number.isFinite(this.raw()); }
  isString() { return typeof this.raw() === "string"; }
  isBoolean() { return typeof this.raw() === "boolean"; }
  hasChildren(keys = []) { const value = this.raw(); return value && typeof value === "object" && Object.keys(value).length > 0 && keys.every((key) => this.child(key).exists()); }
}
function evaluate(rule, old, next, path, context = {}) {
  const variables = { $workspace: workspaceUnderTest, $month: month, $personId: "cast_1", $date: businessDate, $field: "", ...context };
  return Boolean(new Function("root", "data", "newData", "auth", "now", ...Object.keys(variables),
    "return (" + rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(") + ");")(
      new Snapshot(old), new Snapshot(old, path.split("/")), new Snapshot(next, path.split("/")),
      context.auth === null ? null : { uid: "user" }, now, ...Object.values(variables)));
}
function fixture() {
  const old = { users: { user: { role: "shop" } }, [workspaceUnderTest]: {
    casts: { cast_1: { status: "active" } },
    history: { daily_20260902: { businessDate, status: "submitted", casts: [{ masterId: "cast_1", posCastId: "pos_1", kind: "regular", beautyAllowance: 500 }] } },
  } };
  const next = structuredClone(old), day = { eligible: true, attendanceClosingId: "daily_20260902", attendanceIndex: 0, attendancePosCastId: "pos_1" };
  next[workspaceUnderTest].beautyMonths = { [month]: { revision: 1, updatedBy: "user", updatedAt: "2026-09-03T00:00:00.000Z", casts: { cast_1: { [businessDate]: day } } } };
  return { old, next, day };
}
function allowed(f, context = {}) {
  if (!evaluate(dayRules[".write"], f.old, f.next, dayPath, context)
    || !evaluate(beauty.$month[".validate"], f.old, f.next, monthPath, context)
    || !evaluate(beauty.$month.casts.$personId[".validate"], f.old, f.next, monthPath + "/casts/cast_1", context)
    || !evaluate(dayRules[".validate"], f.old, f.next, dayPath, context)) return false;
  for (const key of ["revision", "updatedAt", "updatedBy"]) if (!evaluate(beauty.$month[key][".write"], f.old, f.next, monthPath + "/" + key, context)) return false;
  for (const key of Object.keys(f.day)) if (!evaluate(dayRules.$field[".validate"], f.old, f.next, dayPath + "/" + key, { ...context, $field: key })) return false;
  return true;
}
function existing() {
  const f = fixture(); f.old = structuredClone(f.next);
  f.next[workspaceUnderTest].beautyMonths[month].revision = 2;
  f.next[workspaceUnderTest].beautyMonths[month].updatedAt = "2026-09-03T01:00:00.000Z";
  return f;
}
test("美容室手当は店舗・OPだけ書込可、読込は3権限だけ", () => {
  for (const role of ["shop", "op", "accounting", "unknown"]) {
    const f = fixture(); f.old.users.user.role = role;
    assert.equal(allowed(f), ["shop", "op"].includes(role));
    assert.equal(evaluate(beauty[".read"], f.old, f.next, workspaceUnderTest + "/beautyMonths"), role !== "unknown");
  }
  for (const $workspace of ["other", "accounting-test"]) {
    const f = fixture();
    assert.equal(allowed(f, { $workspace }), false);
    assert.equal(evaluate(beauty[".read"], f.old, f.next, workspaceUnderTest + "/beautyMonths", { $workspace }), false);
  }
  const f = fixture();
  assert.equal(allowed(f, { auth: null }), false);
  assert.equal(evaluate(beauty[".read"], f.old, f.next, workspaceUnderTest + "/beautyMonths", { auth: null }), false);
});
test("月CAS・更新者・時刻・月確定・全体確定lockをサーバー側で検証する", () => {
  for (const patch of [{ revision: 2 }, { revision: 1.5 }, { updatedBy: "other" }, { updatedAt: 123 }]) {
    const f = fixture(); Object.assign(f.next[workspaceUnderTest].beautyMonths[month], patch); assert.equal(allowed(f), false);
  }
  const unchanged = existing(); unchanged.next[workspaceUnderTest].beautyMonths[month].updatedAt = unchanged.old[workspaceUnderTest].beautyMonths[month].updatedAt; assert.equal(allowed(unchanged), false);
  for (const status of ["closed", "closing"]) {
    const f = fixture(); f.old[workspaceUnderTest].accountingMonthStates = { [month]: { status } }; assert.equal(allowed(f), false);
  }
  const f = fixture(); f.old[workspaceUnderTest].accountingFinalizeLock = { expiresAt: now + 10000 }; assert.equal(allowed(f), false);
  f.old[workspaceUnderTest].accountingFinalizeLock.expiresAt = now - 1; assert.equal(allowed(f), true);
});
test("可否はboolean、本人のregular送信済み出勤だけを新規指定できる", () => {
  for (const status of ["submitted", "approved"]) for (const eligible of [true, false]) {
    const f = fixture(); f.old[workspaceUnderTest].history.daily_20260902.status = status; f.day.eligible = eligible; assert.equal(allowed(f), true);
  }
  for (const patch of [{ eligible: 500 }, { eligible: "true" }, { eligible: null }, { attendanceIndex: -1 }, { attendanceIndex: 0.5 }, { attendanceIndex: 2 }, { attendanceClosingId: "missing" }, { extra: 500 }]) {
    const f = fixture(); Object.assign(f.day, patch); assert.equal(allowed(f), false);
  }
  for (const patch of [{ masterId: "other" }, { kind: "trial" }]) {
    const f = fixture(); Object.assign(f.old[workspaceUnderTest].history.daily_20260902.casts[0], patch);
    for (const eligible of [true, false]) { f.day.eligible = eligible; assert.equal(allowed(f), false); }
  }
  for (const status of ["returned", "withdrawn"]) {
    const f = fixture(); f.old[workspaceUnderTest].history.daily_20260902.status = status; assert.equal(allowed(f), false);
  }
});
test("体入IDの同月在籍化・逆リンクがあっても体入日の可否登録を拒否する", () => {
  const f = fixture();
  Object.assign(f.old[workspaceUnderTest].casts.cast_1, { hiredAt: "2026-09-03", convertedFromTrialId: "trial_1" });
  f.old[workspaceUnderTest].casts.trial_1 = { convertedToCastId: "cast_1" };
  Object.assign(f.old[workspaceUnderTest].history.daily_20260902.casts[0], { masterId: "trial_1", kind: "trial" });
  for (const eligible of [true, false]) { f.day.eligible = eligible; assert.equal(allowed(f), false); }
});
test("保存済み・旧日次手当は出勤取消後も否へ訂正できる", () => {
  for (const make of [fixture, existing]) {
    const f = make(); f.old[workspaceUnderTest].history.daily_20260902.status = "returned"; f.day.eligible = false; assert.equal(allowed(f), true);
  }
  const f = existing(); delete f.old[workspaceUnderTest].history; f.day.eligible = false; assert.equal(allowed(f), true);
  const empty = fixture(); empty.day.eligible = false;
  empty.old[workspaceUnderTest].history.daily_20260902.status = "returned"; empty.old[workspaceUnderTest].history.daily_20260902.casts[0].beautyAllowance = 0;
  assert.equal(allowed(empty), false);
});
test("退店者は保存済み可の出勤参照修復と否訂正だけ可能", () => {
  const fresh = fixture(); fresh.old[workspaceUnderTest].casts.cast_1.status = "departed"; assert.equal(allowed(fresh), false);
  const f = existing(); f.old[workspaceUnderTest].casts.cast_1.status = "departed";
  f.old[workspaceUnderTest].history.daily_20260902.casts.unshift({ masterId: "other", kind: "regular" }); f.day.attendanceIndex = 1;
  assert.equal(allowed(f), true);
  f.day.eligible = false; f.day.attendanceIndex = 0; assert.equal(allowed(f), true);
  f.day.attendanceIndex = 1;
  f.old[workspaceUnderTest].beautyMonths[month].casts.cast_1[businessDate].eligible = false; f.day.eligible = true; assert.equal(allowed(f), false);
  f.old[workspaceUnderTest].beautyMonths[month].casts.cast_1[businessDate].eligible = true;
  f.old[workspaceUnderTest].casts.cast_1.deletedAt = "2026-09-03"; assert.equal(allowed(f), false);
});
test("物理削除と月・castsの一括書込経路を与えない", () => {
  assert.equal(beauty[".write"], undefined); assert.equal(beauty.$month[".write"], undefined);
  assert.equal(beauty.$month.casts[".write"], undefined); assert.equal(beauty.$month.casts.$personId[".write"], undefined);
  const f = existing(); delete f.next[workspaceUnderTest].beautyMonths[month].casts.cast_1[businessDate];
  assert.equal(evaluate(dayRules[".write"], f.old, f.next, dayPath), false);
});
test("月・日付・対象者・フィールドの型境界を検証する", () => {
  for (const context of [{ $month: "2026-13" }, { $date: "2026-10-02" }, { $personId: "cast/1" }]) assert.equal(allowed(fixture(), context), false);
  for (const $field of ["drivers", "extra", "amount"]) {
    const f = fixture(); assert.equal(evaluate(beauty.$month.$field[".validate"], f.old, f.next, monthPath, { $field }), false);
  }
});
test("日次の同一キャスト行は旧美容室額を保持し、体入の在籍手当は禁止する", () => {
  const rule = rules.$workspace.history.$id.casts.$index[".validate"], path = workspaceUnderTest + "/history/daily_20260902/casts/0";
  const f = fixture(); assert.equal(evaluate(rule, f.old, f.next, path), true);
  f.next[workspaceUnderTest].history.daily_20260902.casts[0].beautyAllowance = 0;
  assert.equal(evaluate(rule, f.old, f.next, path), false);
  assert.equal(evaluate(rule, f.old, f.next, path, { $workspace: "other" }), true);
  f.next[workspaceUnderTest].history.daily_20260902.casts[0].beautyAllowance = 500;
  f.next[workspaceUnderTest].history.daily_20260902.casts[0].kind = "trial";
  assert.equal(evaluate(rule, f.old, f.next, path), false);
});

test("本人POS識別子の一致を検証し、false既存の元出勤アンカーは変更できない", () => {
  for (const patch of [{ attendancePosCastId: "" }, { attendancePosCastId: 123 }, { attendancePosCastId: "other-pos" }]) {
    const f = fixture(); Object.assign(f.day, patch); assert.equal(allowed(f), false);
  }
  const unicode = fixture(); unicode.day.attendancePosCastId = "POS:キャスト/1";
  unicode.old[workspaceUnderTest].history.daily_20260902.casts[0].posCastId = "POS:キャスト/1";
  assert.equal(allowed(unicode), true);
  const f = existing(); f.day.eligible = false;
  f.day.attendancePosCastId = "other-pos"; f.old[workspaceUnderTest].history.daily_20260902.casts[0].posCastId = "other-pos";
  assert.equal(allowed(f), false);
  f.day.attendancePosCastId = "pos_1"; f.day.attendanceIndex = 1;
  f.old[workspaceUnderTest].history.daily_20260902.casts.push({ masterId: "cast_1", kind: "regular", posCastId: "pos_1", beautyAllowance: 500 });
  assert.equal(allowed(f), false);
});

test("元POSが別キャストへ再照合されたままのtrue参照変更で旧額が復活しない", () => {
  const f = existing();
  f.old[workspaceUnderTest].history.daily_20260902.casts[0].masterId = "cast_b";
  f.old[workspaceUnderTest].history.daily_20260902.casts.push({ masterId: "cast_1", kind: "regular", posCastId: "pos_new", beautyAllowance: 0 });
  f.day.attendanceIndex = 1; f.day.attendancePosCastId = "pos_new";
  assert.equal(allowed(f), false);
  f.old[workspaceUnderTest].beautyMonths[month].casts.cast_b = { [businessDate]: { eligible: false, attendanceClosingId: "daily_20260902", attendanceIndex: 0, attendancePosCastId: "pos_1" } };
  assert.equal(allowed(f), true);
  f.old[workspaceUnderTest].history.daily_20260902.casts.unshift({ masterId: "other", kind: "regular", posCastId: "other-pos", beautyAllowance: 0 });
  f.day.attendanceIndex = 2;
  assert.equal(allowed(f), false, "元indexに別人の行がある複合変更は所在を推測せず拒否");
});
test("同じ本人の通常のPOS識別子変更・行順の修復は許可する", () => {
  const f = existing();
  f.old[workspaceUnderTest].history.daily_20260902.casts[0].posCastId = "pos_new"; f.day.attendancePosCastId = "pos_new";
  assert.equal(allowed(f), true);
  const reordered = existing();
  reordered.old[workspaceUnderTest].history.daily_20260902.casts.unshift({ masterId: "other", kind: "regular", posCastId: "other-pos" });
  reordered.day.attendanceIndex = 1;
  assert.equal(allowed(reordered), true);
});

test("照合先に同日記録が存在しても元POS・元日次への抑制引継ぎがなければ参照変更を拒否する", () => {
  for (const anchor of [
    { attendanceClosingId: "daily_20260902", attendancePosCastId: "pos_b" },
    { attendanceClosingId: "daily_other", attendancePosCastId: "pos_1" },
  ]) {
    const f = existing();
    f.old[workspaceUnderTest].history.daily_20260902.casts = [
      { masterId: "cast_b", kind: "regular", posCastId: "pos_1", beautyAllowance: 500 },
      { masterId: "cast_1", kind: "regular", posCastId: "pos_b", beautyAllowance: 500 },
    ];
    f.old[workspaceUnderTest].beautyMonths[month].casts.cast_b = { [businessDate]: { eligible: false, attendanceIndex: 1, ...anchor } };
    f.day.attendanceIndex = 1; f.day.attendancePosCastId = "pos_b";
    assert.equal(allowed(f), false);
  }
});

}
