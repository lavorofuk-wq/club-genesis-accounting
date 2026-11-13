import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { employeeHistorySuffix, employeeSnapshotSuffix, withoutEmployeeRules } from './employee-rules-baseline-helper.mjs';

const all = JSON.parse(readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8')).rules;
const rules = all.$workspace;
class Snapshot {
  constructor(tree, path = []) { this.tree = tree; this.path = path; }
  raw() { return this.path.reduce((v, k) => v?.[k], this.tree) ?? null; }
  val() { const v = this.raw(); return v && typeof v === 'object' ? null : v; }
  exists() { return this.raw() !== null; }
  child(path) { return new Snapshot(this.tree, [...this.path, ...String(path).split('/')]); }
  parent() { return new Snapshot(this.tree, this.path.slice(0, -1)); }
  isString() { return typeof this.raw() === 'string'; }
  isNumber() { return typeof this.raw() === 'number' && Number.isFinite(this.raw()); }
  hasChildren(keys = []) { const v = this.raw(); return v && typeof v === 'object' && Object.keys(v).length > 0 && keys.every(k => this.child(k).exists()); }
}
const compiled = new Map();
function check(rule, before, after, path = [], extra = {}) {
  const args = { root: new Snapshot(extra.root || {}), data: new Snapshot(before, path), newData: new Snapshot(after, path),
    auth: extra.auth ?? { uid: 'user' }, now: 10000, $workspace: extra.workspace || 'accounting-dev',
    $month: '2026-09', $employeeIndex: '0', $dayIndex: '0', $field: extra.field || '' };
  if (!compiled.has(rule)) compiled.set(rule, new Function(...Object.keys(args), 'return (' + rule.replaceAll('.matches(', '.match(').replaceAll('.beginsWith(', '.startsWith(') + ');'));
  return Boolean(compiled.get(rule)(...Object.values(args)));
}
const employee = () => ({ name: '社員', status: 'active', hiredAt: '2026-09-01', employmentType: 'employee', createdAt: 'a', updatedAt: 'b' });

test('社員の名前・入社日登録を認め、アルバイトの時給必須を維持する', () => {
  const master = rules.staff.$id;
  assert.equal(check(master['.validate'], null, employee()), true);
  assert.equal(check(master.status['.validate'], null, employee(), ['status']), true);
  const regular = { ...employee() }; delete regular.employmentType;
  assert.equal(check(master.status['.validate'], null, regular, ['status']), false);
  regular.hourlyRates = { '2026-09': 1500 };
  assert.equal(check(master.status['.validate'], null, regular, ['status']), true);
  for (const extra of [{ employmentType: 'unknown' }, { hourlyRate: 0 }, { hourlyRates: { '2026-09': 1500 } },
    { trialHourlyRate: 0 }, { convertedFromTrialId: 'trial' }, { status: 'trial', trialDate: '2026-09-01' }, { hiredAt: null }, { name: ' ' }]) {
    assert.equal(check(master['.validate'], null, { ...employee(), ...extra }), false, JSON.stringify(extra));
  }
});

test('社員とアルバイトの区分変更を拒否し、改名・退職・削除の権限を従来どおり守る', () => {
  const master = rules.staff.$id, before = employee();
  assert.equal(check(master['.validate'], before, { ...before, name: '改名', updatedAt: 'c' }), true);
  const changed = { ...before, employmentType: undefined, hourlyRates: { '2026-09': 1000 } };
  assert.equal(check(master['.validate'], before, changed), false);
  assert.equal(check(master['.validate'], changed, before), false);
  for (const workspace of ['accounting-dev', 'accounting']) {
    for (const role of ['shop', 'accounting', 'op', 'unknown']) {
      const root = { users: { user: { role } } };
      assert.equal(check(master['.write'], null, before, [], { root, workspace }), role !== 'unknown');
      root[workspace] = { accountingFinalizeLock: { expiresAt: 20000 } };
      assert.equal(check(master['.write'], null, before, [], { root, workspace }), false);
    }
  }
});

test('社員を勤務・時給給与欄へ混在させない', () => {
  const rule = rules.history.$id.staffWork.$employeeIndex['.validate'];
  const root = { 'accounting-dev': { staff: { employee: employee() } } };
  assert.equal(check(rule, null, { staffId: 'employee' }, [], { root }), false);
  assert.equal(check(rule, null, { staffId: 'regular' }, [], { root }), true);
});

test('社員日払いJSONは承認・差戻し・取下げ時の変更と部分削除を拒否し、再送時だけ変更可能', () => {
  const rule = rules.history.$id.employeePaymentsJson['.validate'];
  const payment = { staffId: 'employee', name: '社員', dailyPayment: 1234 };
  const rows = [payment, { ...payment, staffId: 'employee2', name: '社員2' }];
  const before = { status: 'submitted', employeePaymentsJson: JSON.stringify(rows) };
  assert.equal(check(rule, null, before, ['employeePaymentsJson']), true);
  assert.deepEqual(rules.history.$id.employeePayments, { '.validate': false });
  for (const status of ['approved', 'returned', 'withdrawn']) {
    assert.equal(check(rule, before, { ...before, status }, ['employeePaymentsJson']), true);
    for (const next of [JSON.stringify([payment]), JSON.stringify([]), JSON.stringify([...rows, payment]),
      JSON.stringify([{ ...payment, dailyPayment: 9999 }, rows[1]]), null]) {
      const after = { status, employeePaymentsJson: next };
      // 親の検証も使用し、フィールド全体の削除で子validateが走らない場合も防ぐ。
      assert.equal(check(employeeHistorySuffix.slice(4), before, after), false);
      if (next !== null) assert.equal(check(rule, before, after, ['employeePaymentsJson']), false);
    }
  }
  assert.equal(check(rule, { ...before, status: 'returned' }, { status: 'submitted', employeePaymentsJson: JSON.stringify([payment]) }, ['employeePaymentsJson']), true);
  for (const value of ['bad-json', 1234, {}, []]) assert.equal(check(rule, null, { status: 'submitted', employeePaymentsJson: value }, ['employeePaymentsJson']), false);
});

test('2.59以降に社員支払summaryを必須とし、旧確定月へ後付けしない', () => {
  const rule = employeeSnapshotSuffix.slice(4);
  for (const calculationVersion of ['2.59.0', '2.59.1', '2.60.0', '2.100.0', '3.0.0', '10.0.0']) {
    assert.equal(check(rule, null, { calculationVersion }), false);
    assert.equal(check(rule, null, { calculationVersion, employeePayments: { dailyTotal: 0, allowanceTotal: 0 } }), true);
  }
  for (const calculationVersion of ['2.54.0', '2.58.0', '2.58.99']) {
    assert.equal(check(rule, null, { calculationVersion }), true);
    assert.equal(check(rule, null, { calculationVersion, employeePayments: { dailyTotal: 0, allowanceTotal: 0 } }), false);
  }
});

test('社員の保存手当・日払い・日付を検証し給与欄を認めない', () => {
  const summary = rules.accountingMonthSnapshots.$month.$revision.employeePayments;
  const row = { id: 'employee', name: '社員', sales: 2000, bottle: 3000, allowanceTotal: 5000, daily: 10000,
    days: [{ businessDate: '2026-09-09', dailyPayment: 10000 }] };
  const snapshot = { calculationVersion: '2.59.0', employeePayments: { rows: [row], dailyTotal: 10000, allowanceTotal: 5000 } };
  assert.equal(check(summary['.validate'], null, snapshot, ['employeePayments']), true);
  assert.equal(check(summary.rows.$employeeIndex['.validate'], null, row), true);
  assert.equal(check(summary.rows.$employeeIndex['.validate'], null, { ...row, allowanceTotal: 4000 }), false);
  assert.equal(check(summary.rows.$employeeIndex['.validate'], null, { ...row, daily: 1, days: undefined }), false);
  const dayRule = summary.rows.$employeeIndex.days.$dayIndex['.validate'];
  assert.equal(check(dayRule, null, row.days[0]), true);
  assert.equal(check(dayRule, null, { ...row.days[0], businessDate: '2026-10-01' }), false);
  assert.equal(check(dayRule, null, { ...row.days[0], dailyPayment: -1 }), false);
  for (const field of ['gross', 'net', 'hours', 'hourly']) assert.equal(check(summary.rows.$employeeIndex.$field['.validate'], null, 1, [], { field }), false);
});

test('社員追加以外の既存保護式を除外せず歴史的な指紋で検証できる', () => {
  const baseline = withoutEmployeeRules(all);
  assert.equal(baseline.$workspace.staff.$id['.write'], rules.staff.$id['.write']);
  assert.equal(baseline.$workspace.history.$id['.write'], rules.history.$id['.write']);
  assert.equal(baseline.$workspace.accountingMonthSnapshots.$month.$revision['.write'], rules.accountingMonthSnapshots.$month.$revision['.write']);
  const changed = structuredClone(all); changed.$workspace.staff.$id['.validate'] += ' || true';
  assert.throws(() => withoutEmployeeRules(changed));
});
