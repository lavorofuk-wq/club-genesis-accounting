import assert from 'node:assert/strict';

const number = field => `newData.child('${field}').isNumber() && newData.child('${field}').val() >= 0 && newData.child('${field}').val() <= 9007199254740991`;
const text = field => `newData.child('${field}').isString() && newData.child('${field}').val().matches(/.*\\S.*/)`;
const index = key => `${key}.matches(/^(0|[1-9]\\d*)$/)`;
const employeeVersion = path => `${path}.val().matches(/^(2[.](59|[6-9][0-9]|[1-9][0-9]{2,})[.][0-9]+|([3-9]|[1-9][0-9]+)[.][0-9]+[.][0-9]+)$/)`;
export const employeeStaffSuffix = " && (!newData.exists() || ((!newData.child('employmentType').exists() || newData.child('employmentType').val() === 'employee') && (!data.exists() || newData.child('employmentType').val() === data.child('employmentType').val()) && (newData.child('employmentType').val() !== 'employee' || ((newData.child('status').val() === 'active' || newData.child('status').val() === 'departed') && !newData.child('hourlyRate').exists() && !newData.child('hourlyRates').exists() && !newData.child('trialHourlyRate').exists() && !newData.child('trialDate').exists() && !newData.child('convertedFromTrialId').exists() && !newData.child('convertedToStaffId').exists()))))";
export const employeeStatusPrefix = "newData.parent().child('employmentType').val() === 'employee' ? (newData.val() === 'active' || newData.val() === 'departed') : (";
export const employeeSnapshotSuffix = ` && (${employeeVersion("newData.child('calculationVersion')")} ? newData.child('employeePayments').exists() : !newData.child('employeePayments').exists())`;
const resubmission = "!data.parent().exists() || ((data.parent().child('status').val() === 'returned' || data.parent().child('status').val() === 'withdrawn') && newData.parent().child('status').val() === 'submitted')";
export const employeeHistorySuffix = " && (!newData.exists() || !data.exists() || ((data.child('status').val() === 'returned' || data.child('status').val() === 'withdrawn') && newData.child('status').val() === 'submitted') || newData.child('employeePaymentsJson').val() === data.child('employeePaymentsJson').val())";

export function employeeDailyRules() {
  return {
    '.validate': `newData.isString() && newData.val().matches(/^\\[.*\\]$/) && ((${resubmission}) || newData.val() === data.val())`,
  };
}
export function employeeSummaryRules() {
  return {
    '.validate': `newData.hasChildren(['dailyTotal', 'allowanceTotal']) && ${employeeVersion("newData.parent().child('calculationVersion')")} && ${number('dailyTotal')} && ${number('allowanceTotal')} && (newData.child('rows').hasChildren() || (newData.child('dailyTotal').val() === 0 && newData.child('allowanceTotal').val() === 0))`,
    rows: {
      '.validate': 'newData.hasChildren()',
      '$employeeIndex': {
        '.validate': `${index('$employeeIndex')} && newData.hasChildren(['id', 'name', 'sales', 'bottle', 'allowanceTotal', 'daily']) && ${text('id')} && newData.child('id').val().matches(/^[A-Za-z0-9_-]+$/) && ${text('name')} && ${['sales','bottle','allowanceTotal','daily'].map(number).join(' && ')} && newData.child('allowanceTotal').val() === newData.child('sales').val() + newData.child('bottle').val() && (newData.child('days').hasChildren() || newData.child('daily').val() === 0)`,
        days: {
          '.validate': 'newData.hasChildren()',
          '$dayIndex': {
            '.validate': `${index('$dayIndex')} && newData.hasChildren(['businessDate', 'dailyPayment']) && newData.child('businessDate').isString() && newData.child('businessDate').val().matches(/^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$/) && newData.child('businessDate').val().beginsWith($month + '-') && ${number('dailyPayment')}`,
            '$field': { '.validate': "$field.matches(/^(businessDate|dailyPayment)$/)" },
          },
        },
        '$field': { '.validate': "$field.matches(/^(id|name|sales|bottle|allowanceTotal|daily)$/)" },
      },
    },
    '$field': { '.validate': "$field.matches(/^(dailyTotal|allowanceTotal)$/)" },
  };
}
export const employeeStaffWorkRule = { '$employeeIndex': { '.validate': "root.child($workspace).child('staff').child(newData.child('staffId').val()).child('employmentType').val() !== 'employee'" } };

/** 社員追加分を厳密に検証して除き、既存のアクセス権・検証式の過去指紋を維持する。 */
export function withoutEmployeeRules(value) {
  const copy = structuredClone(value), workspace = copy.$workspace;
  const staff = workspace.staff.$id;
  assert.ok(staff['.validate'].endsWith(employeeStaffSuffix));
  staff['.validate'] = staff['.validate'].slice(0, -employeeStaffSuffix.length);
  assert.ok(staff.status['.validate'].startsWith(employeeStatusPrefix) && staff.status['.validate'].endsWith(')'));
  staff.status['.validate'] = staff.status['.validate'].slice(employeeStatusPrefix.length, -1);
  const history = workspace.history.$id;
  assert.ok(history['.validate'].endsWith(employeeHistorySuffix));
  history['.validate'] = history['.validate'].slice(0, -employeeHistorySuffix.length);
  assert.deepEqual(history.employeePayments, { '.validate': false });
  assert.deepEqual(history.employeePaymentsJson, employeeDailyRules());
  assert.deepEqual(history.staffWork, employeeStaffWorkRule);
  delete history.employeePayments; delete history.employeePaymentsJson; delete history.staffWork;
  const snapshot = workspace.accountingMonthSnapshots.$month.$revision;
  assert.ok(snapshot['.validate'].endsWith(employeeSnapshotSuffix));
  snapshot['.validate'] = snapshot['.validate'].slice(0, -employeeSnapshotSuffix.length);
  assert.deepEqual(snapshot.employeePayments, employeeSummaryRules());
  delete snapshot.employeePayments;
  return copy;
}
