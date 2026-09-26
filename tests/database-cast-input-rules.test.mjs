import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const rules = JSON.parse(await readFile(new URL("../database.rules.json", import.meta.url), "utf8")).rules;
const monthly = rules.$workspace.accountingAdjustments.$month;
const collection = monthly.castInputs;
const month = "2026-09";
const now = 1800000000000;
class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  val() { return this.path.reduce((value, key) => value?.[key], this.tree) ?? null; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split("/")]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  exists() { return this.val() !== null; }
  isNumber() { return typeof this.val() === "number" && Number.isFinite(this.val()); }
  isString() { return typeof this.val() === "string"; }
  hasChildren(keys = []) { const value = this.val(); return value && typeof value === "object"
    && Object.keys(value).length > 0 && keys.every((key) => this.child(key).exists()); }
}
function evaluate(rule, old, next, path, workspace = "accounting-dev", variables = {}) {
  return Boolean(new Function("root", "data", "newData", "auth", "now", "$workspace", "$month", "$inputId", "$inputIndex", "$field", "$index", "$dayIndex",
    "return (" + rule.replaceAll(".matches(", ".match(").replaceAll(".beginsWith(", ".startsWith(") + ");")(
    new Snapshot(old), new Snapshot(old, path.split("/")), new Snapshot(next, path.split("/")),
    variables.auth === null ? null : { uid: "user" }, now, workspace, month, variables.inputId || "input_1",
    variables.inputIndex || "0", variables.field || "", variables.index || "0", variables.dayIndex || "0"));
}
const input = (extra = {}) => ({ id: "input_1", castId: "cast_1", castName: "テスト",
  kind: "sales", label: "追加売上", amount: 1230, businessDate: "2026-09-02",
  attendanceClosingId: "daily_20260902", attendanceIndex: 0, ...extra });
function fixture(workspace = "accounting-dev") {
  const base = { revision: 1, updatedAt: "before", updatedBy: "user", cardFee: 0 };
  const old = { users: { user: { role: "accounting" } }, [workspace]: {
    casts: { cast_1: { name: "テスト", status: "active", hiredAt: "2026-08-01" } },
    history: { daily_20260902: { businessDate: "2026-09-02", status: "approved",
      casts: [{ masterId: "cast_1", name: "テスト", kind: "regular", hours: 0 }] } },
    accountingAdjustments: { [month]: base } } };
  const next = structuredClone(old);
  Object.assign(next[workspace].accountingAdjustments[month], { revision: 2, updatedAt: "after", castInputs: { input_1: input() } });
  return { old, next, workspace };
}
function allowed({ old, next, workspace = "accounting-dev" }, options = {}) {
  const path = workspace + "/accountingAdjustments/" + month;
  if (!evaluate(monthly[".write"], old, next, path, workspace, options)
    || !evaluate(monthly[".validate"], old, next, path, workspace, options)) return false;
  const values = next[workspace].accountingAdjustments[month].castInputs;
  if (!values) return true;
  if (!evaluate(collection[".validate"], old, next, path + "/castInputs", workspace, options)) return false;
  for (const [inputId, row] of Object.entries(values)) {
    const context = { ...options, inputId };
    const entryPath = path + "/castInputs/" + inputId;
    if (!evaluate(collection.$inputId[".validate"], old, next, entryPath, workspace, context)) return false;
    for (const field of Object.keys(row)) if (!evaluate(collection.$inputId.$field[".validate"], old, next,
      entryPath + "/" + field, workspace, { ...context, field })) return false;
  }
  return true;
}
function row(f) { return f.next[f.workspace].accountingAdjustments[month].castInputs.input_1; }

test("devの経理/OPだけ本人の承認済み出勤を根拠に追加できる（0時間も出勤扱い）", () => {
  for (const role of ["accounting", "op"]) { const f = fixture(); f.old.users.user.role = role; assert.equal(allowed(f), true); }
  const shop = fixture(); shop.old.users.user.role = "shop"; assert.equal(allowed(shop), false);
  assert.equal(allowed(fixture(), { auth: null }), false);
  assert.equal(allowed(fixture("accounting")), false);
});
test("月次CAS、更新者、全体確定ロックと確定月保護をそのまま要求する", () => {
  for (const patch of [{ revision: 1 }, { revision: 3 }, { updatedBy: "other" }, { updatedAt: "before" }]) {
    const f = fixture(); Object.assign(f.next[f.workspace].accountingAdjustments[month], patch); assert.equal(allowed(f), false);
  }
  for (const status of ["closing", "closed"]) { const f = fixture(); f.old[f.workspace].accountingMonthStates = { [month]: { status } }; assert.equal(allowed(f), false); }
  const f = fixture(); f.old[f.workspace].accountingFinalizeLock = { expiresAt: now + 10000 }; assert.equal(allowed(f), false);
});
test("新規/変更行の在籍・本人・月・日付・承認状態をサーバーで検証する", () => {
  for (const status of ["trial", "departed"]) { const f = fixture(); f.old[f.workspace].casts.cast_1.status = status; assert.equal(allowed(f), false); }
  const deleted = fixture(); deleted.old[deleted.workspace].casts.cast_1.deletedAt = "deleted"; assert.equal(allowed(deleted), false);
  for (const change of [{ status: "submitted" }, { status: "returned" }, { businessDate: "2026-10-02" },
    { casts: [{ masterId: "other", hours: 0 }] }]) {
    const f = fixture(); Object.assign(f.old[f.workspace].history.daily_20260902, change); assert.equal(allowed(f), false);
  }
  for (const change of [{ castName: "別名" }, { businessDate: "2026-09-03" },
    { attendanceClosingId: "missing" }, { attendanceIndex: 1 }, { attendanceIndex: 0.5 }]) {
    const f = fixture(); Object.assign(row(f), change); assert.equal(allowed(f), false);
  }
});
test("同月在籍化した体入出勤は明示された変換IDだけを認める", () => {
  for (const sourcePresent of [true, false]) {
    const f = fixture(); const root = f.old[f.workspace]; root.history.daily_20260902.casts[0].masterId = "trial_1";
    Object.assign(root.casts.cast_1, { hiredAt: "2026-09-05", convertedFromTrialId: "trial_1" });
    if (sourcePresent) root.casts.trial_1 = { convertedToCastId: "cast_1" };
    assert.equal(allowed(f), true);
    root.casts.cast_1.hiredAt = "2026-10-05"; assert.equal(allowed(f), false);
  }
});
test("今月採用でも空の勤務行・区分不明の勤務から本人出勤を捏造できない", () => {
  for (const value of [{}, { masterId: "cast_1", kind: "dispatch" }]) {
    const f = fixture(); f.old[f.workspace].casts.cast_1.hiredAt = "2026-09-01";
    f.old[f.workspace].history.daily_20260902.casts[0] = value;
    assert.equal(allowed(f), false);
  }
});
test("日付省略は手当・送迎だけ許可し、本人出勤根拠は省略できない", () => {
  for (const kind of ["allowance", "transport"]) {
    const f = fixture(); Object.assign(row(f), { kind, amount: kind === "transport" ? 500 : 1 }); delete row(f).businessDate;
    assert.equal(allowed(f), true); delete row(f).attendanceClosingId; assert.equal(allowed(f), false);
  }
  const f = fixture(); delete row(f).businessDate; assert.equal(allowed(f), false);
});
test("金額単位・安全整数・型・名目・キーID・未知項目を検証する", () => {
  const invalid = [{ amount: -10 }, { amount: 1.5 }, { amount: 1234 }, { amount: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "transport", amount: 501 }, { kind: "unknown" }, { amount: "1000" }, { label: " " },
    { label: "a".repeat(101) }, { id: "other" }, { castId: "bad/path" }, { unknown: true }];
  for (const change of invalid) { const f = fixture(); Object.assign(row(f), change); assert.equal(allowed(f), false, JSON.stringify(change)); }
  for (const [kind, amount] of [["sales", 0], ["allowance", 1], ["transport", 500]]) {
    const f = fixture(); Object.assign(row(f), { kind, amount }); assert.equal(allowed(f), true);
  }
});
test("退店・差戻し後の保存行は不変なら保持でき、変更は拒否、削除は可能", () => {
  const f = fixture();
  f.old[f.workspace].accountingAdjustments[month].castInputs = { input_1: input() };
  f.old[f.workspace].casts.cast_1.status = "departed";
  f.old[f.workspace].history.daily_20260902.status = "returned";
  assert.equal(allowed(f), true);
  row(f).amount += 10; assert.equal(allowed(f), false);
  delete f.next[f.workspace].accountingAdjustments[month].castInputs; assert.equal(allowed(f), true);
});

const snapshotRules = rules.$workspace.accountingMonthSnapshots.$month.$revision;
function snapshotFixture() {
  const record = { id: "cast_1", name: "テスト", honShimeiSales: 0, jonaiExtensionSales: 0, totalSales: 1230,
    attendanceDays: 1, hours: 1, startTime: "20:00", endTime: "21:00", honShimeiLiquorCost: 0,
    jonaiExtensionLiquorCost: 0, totalLiquorCost: 0, honShimeiCount: 0, banaiShimeiCount: 0,
    nominationCount: 0, dohanCount: 0, backTotal: 0, beautyAllowance: 0,
    additionalSales: 1230, additionalAllowance: 100, additionalTransportFee: 500,
    accountingInputs: [input()] };
  const snapshot = { schemaVersion: 3, calculationVersion: "2.37.0",
    castSalesReports: [{ id: "cast_1", days: [{ ...record, businessDate: "2026-09-02" }], totals: record }],
    castRewards: [{ ...record, adoptedReward: 3000, beautyAllowance: 500, grossPay: 3600, transportFee: 1000 }] };
  const tree = { "accounting-dev": { accountingMonthSnapshots: { [month]: { 1: snapshot } } } };
  return { tree, snapshot, prefix: "accounting-dev/accountingMonthSnapshots/" + month + "/1/" };
}
test("snapshot新項目はschema3の対応版だけで金額・本人・日別計上を検証する", () => {
  const f = snapshotFixture();
  const sections = [[snapshotRules.castRewards.$index, "castRewards/0/"],
    [snapshotRules.castSalesReports.$index.days.$dayIndex, "castSalesReports/0/days/0/"],
    [snapshotRules.castSalesReports.$index.totals, "castSalesReports/0/totals/"]];
  for (const [node, path] of sections) {
    for (const key of ["additionalSales", "additionalAllowance", "additionalTransportFee"]) {
      assert.equal(evaluate(node[key][".validate"], {}, f.tree, f.prefix + path + key), true, path + key);
      f.snapshot.calculationVersion = "2.36.0";
      assert.equal(evaluate(node[key][".validate"], {}, f.tree, f.prefix + path + key), false);
      f.snapshot.calculationVersion = "2.37.0";
    }
    if (node.accountingInputs) {
      assert.equal(evaluate(node.accountingInputs[".validate"], {}, f.tree, f.prefix + path + "accountingInputs"), true);
      assert.equal(evaluate(node.accountingInputs.$inputIndex[".validate"], {}, f.tree, f.prefix + path + "accountingInputs/0"), true);
    }
  }
  f.snapshot.castRewards[0].grossPay = 3500;
  assert.equal(evaluate(snapshotRules.castRewards.$index.additionalAllowance[".validate"], {}, f.tree,
    f.prefix + "castRewards/0/additionalAllowance"), false);
});
test("本指名0円でも追加売上がある月の確定snapshotを日別・月合計の両方で許可する", () => {
  const f = snapshotFixture();
  const targets = [[snapshotRules.castSalesReports.$index.days.$dayIndex, "castSalesReports/0/days/0", f.snapshot.castSalesReports[0].days[0]],
    [snapshotRules.castSalesReports.$index.totals, "castSalesReports/0/totals", f.snapshot.castSalesReports[0].totals]];
  for (const [node, path, row] of targets) {
    assert.equal(row.honShimeiSales, 0);
    assert.equal(row.additionalSales, 1230);
    assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), true);
    assert.equal(evaluate(node.additionalSales[".validate"], {}, f.tree, f.prefix + path + "/additionalSales"), true);
    row.totalSales = 0;
    assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), false, "追加売上の欠落を拒否");
    row.totalSales = 2460;
    assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), false, "追加売上の二重加算を拒否");
    row.honShimeiSales = 500;
    row.totalSales = 1730;
    assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), true, "追加売上が本指名売上を上回っても許可");
    delete row.additionalSales; row.totalSales = 500;
    assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), true, "追加入力のない既存形式を維持");
  }
});
test("本番の既存合計式は追加売上が混入しても本指名＋場内のまま変更しない", () => {
  const f = snapshotFixture();
  const tree = { accounting: f.tree["accounting-dev"] };
  const prefix = f.prefix.replace("accounting-dev", "accounting");
  for (const [node, path, row] of [
    [snapshotRules.castSalesReports.$index.days.$dayIndex, "castSalesReports/0/days/0", f.snapshot.castSalesReports[0].days[0]],
    [snapshotRules.castSalesReports.$index.totals, "castSalesReports/0/totals", f.snapshot.castSalesReports[0].totals],
  ]) {
    assert.equal(evaluate(node[".validate"], {}, tree, prefix + path, "accounting"), false);
    assert.equal(evaluate(node.additionalSales[".validate"], {}, tree, prefix + path + "/additionalSales", "accounting"), false);
    row.totalSales = 0;
    assert.equal(evaluate(node[".validate"], {}, tree, prefix + path, "accounting"), true);
  }
});

function paymentTargets(f) {
  return [
    [snapshotRules.castSalesReports.$index.days.$dayIndex, "castSalesReports/0/days/0", f.snapshot.castSalesReports[0].days[0]],
    [snapshotRules.castSalesReports.$index.totals, "castSalesReports/0/totals", f.snapshot.castSalesReports[0].totals],
  ];
}

test("devの2.39以降の確定明細は日次と月合計に日払い・立替を両方要求する", () => {
  for (const version of ["2.39.0", "2.39.1", "2.40.0", "2.100.0", "3.0.0", "10.0.0"]) {
    const f = snapshotFixture(); f.snapshot.calculationVersion = version;
    for (const [node, path, row] of paymentTargets(f)) {
      assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), false, version + " " + path);
      row.dailyPayment = 0;
      assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), false, "立替欠損を拒否");
      row.advancePayment = 0;
      assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), true, "0円も記録する");
      delete row.dailyPayment;
      assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), false, "日払い欠損を拒否");
    }
  }
});

test("devのsnapshot日払い・立替は負数・非数値・安全上限超過を拒否する", () => {
  const f = snapshotFixture(); f.snapshot.calculationVersion = "2.39.0";
  for (const [node, path, row] of paymentTargets(f)) {
    Object.assign(row, { dailyPayment: 0, advancePayment: 0 });
    for (const field of ["dailyPayment", "advancePayment"]) {
      for (const amount of [0, 1, 1234, Number.MAX_SAFE_INTEGER]) {
        row[field] = amount;
        assert.equal(evaluate(node[field][".validate"], {}, f.tree, f.prefix + path + "/" + field), true,
          path + "/" + field + "=" + amount);
      }
      for (const amount of [-1, "1000", true, {}, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
        row[field] = amount;
        assert.equal(evaluate(node[field][".validate"], {}, f.tree, f.prefix + path + "/" + field), false,
          path + "/" + field + "=" + String(amount));
      }
      row[field] = 0;
    }
  }
});

test("既存の日払い・立替に小数がある場合も承認済み原額を丸めずsnapshotへ保持する", () => {
  const f = snapshotFixture(); f.snapshot.calculationVersion = "2.39.0";
  for (const [node, path, row] of paymentTargets(f)) {
    Object.assign(row, { dailyPayment: 1000.75, advancePayment: 250.25 });
    const original = structuredClone(row);
    assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), true);
    for (const field of ["dailyPayment", "advancePayment"]) {
      assert.equal(evaluate(node[field][".validate"], {}, f.tree, f.prefix + path + "/" + field), true);
    }
    assert.deepEqual(row, original, "支払済み金額へ新たな切捨て・丸めを加えない");
  }
});

test("2.38以前のsnapshotは日払い・立替明細の欠損を許容し過去形式を維持する", () => {
  for (const version of ["2.27.0", "2.37.0", "2.38.0", "2.38.99"]) {
    const f = snapshotFixture(); f.snapshot.calculationVersion = version;
    for (const [node, path] of paymentTargets(f)) {
      assert.equal(evaluate(node[".validate"], {}, f.tree, f.prefix + path), true, version + " " + path);
    }
  }
});

test("本番のsnapshotには新しい日払い・立替項目を必須化せず既存の検証を変えない", () => {
  const f = snapshotFixture(); f.snapshot.calculationVersion = "2.39.0";
  const tree = { accounting: f.tree["accounting-dev"] };
  const prefix = f.prefix.replace("accounting-dev", "accounting");
  for (const [node, path, row] of paymentTargets(f)) {
    // 本番は元の本指名＋場内売上の式を維持する。
    delete row.additionalSales; delete row.additionalAllowance; delete row.additionalTransportFee; delete row.accountingInputs;
    row.totalSales = 0;
    assert.equal(evaluate(node[".validate"], {}, tree, prefix + path, "accounting"), true);
    for (const field of ["dailyPayment", "advancePayment"]) {
      for (const value of [0, 1, 0.5, -1, "legacy"]) {
        row[field] = value;
        assert.equal(evaluate(node[field][".validate"], {}, tree, prefix + path + "/" + field, "accounting"), true,
          "本番で従来未検証だった追加キーの意味を変更しない");
      }
    }
  }
});

test("Rulesの新保護式は有効な構文で、入れ子の同名ワイルドカードを作らない", () => {
  function inspect(node, ancestors = []) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ".validate" || key === ".write" || key === ".read") {
        if (typeof value === "string") {
          const parsed = ts.createSourceFile("rule.ts", "(" + value + ");", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
          assert.equal(parsed.parseDiagnostics.length, 0, value);
        }
      } else if (value && typeof value === "object") {
        if (key.startsWith("$")) assert.equal(ancestors.includes(key), false, "重複ワイルドカード:" + key);
        inspect(value, key.startsWith("$") ? [...ancestors, key] : ancestors);
      }
    }
  }
  inspect(collection, ["$workspace", "$month"]);
  inspect(snapshotRules, ["$workspace", "$month", "$revision"]);
});
