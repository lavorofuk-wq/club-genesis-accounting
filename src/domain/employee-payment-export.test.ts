import { describe, expect, it } from "vitest";
import type { DailyClosing } from "./gms";
import type { MonthlyAccountingSnapshot } from "./month-accounting";
import type { EmployeePaymentsSummary } from "./employee-payments";
import { employeePaymentsForExport } from "./employee-payment-export";

function fixture() {
  const employeePayments: EmployeePaymentsSummary = { dailyTotal: 15000, allowanceTotal: 3000, rows: [
    { id: "employee", name: "社員", sales: 1000, bottle: 2000, allowanceTotal: 3000, daily: 15000,
      days: [{ businessDate: "2026-09-01", dailyPayment: 10000 }, { businessDate: "2026-09-02", dailyPayment: 5000 }] },
  ] };
  const closings = [1, 2].map((day) => ({ id: `day-${day}`, checksum: `checksum-${day}`, updatedAt: "same",
    businessDate: `2026-09-0${day}`, status: "approved", staffWork: [],
    employeePayments: [{ staffId: "employee", name: "旧氏名", dailyPayment: day === 1 ? 10000 : 5000 }],
  })) as unknown as DailyClosing[];
  return { month: "2026-09", closings, results: { employeePayments } };
}
function frozen() {
  const input = fixture();
  const snapshot = { month: input.month, calculationVersion: "2.59.0", employeePayments: structuredClone(input.results.employeePayments),
    approvedClosings: input.closings.map(({ id, checksum, updatedAt }) => ({ id, checksum, updatedAt })),
  } as MonthlyAccountingSnapshot;
  return { ...input, snapshot };
}
describe("社員支払の帳票照合", () => {
  it("月額手当と日払いを別のまま保持し、氏名変更で過去日払いを拒否しない", () => {
    const input = fixture(); const before = structuredClone(input);
    expect(employeePaymentsForExport(input)).toEqual(input.results.employeePayments);
    expect(input).toEqual(before);
  });
  it.each(["none", "different"])("確定元が%sでも保存済み氏名と日別額を保持する", (state) => {
    const input = frozen();
    if (state === "none") input.closings = [];
    else { input.closings[0].checksum = "changed"; input.closings[0].employeePayments![0].dailyPayment = 1; }
    expect(employeePaymentsForExport(input)).toEqual(input.snapshot.employeePayments);
  });
  it("旧確定には社員支払を補完せず、後付けデータを拒否する", () => {
    const input = frozen(); input.snapshot.calculationVersion = "2.58.0";
    expect(() => employeePaymentsForExport(input)).toThrow(/計算版/);
    delete input.snapshot.employeePayments;
    const old = { ...input, results: {}, closings: input.closings.map((row) => ({ ...row, employeePayments: undefined })) };
    expect(employeePaymentsForExport(old)).toEqual({ rows: [], dailyTotal: 0, allowanceTotal: 0 });
  });
  it("新確定の社員集計欠落や保存額との不一致を拒否する", () => {
    const input = frozen(); delete input.snapshot.employeePayments;
    expect(() => employeePaymentsForExport(input)).toThrow(/計算版/);
    const altered = frozen(); altered.results.employeePayments.rows[0].sales += 1;
    expect(() => employeePaymentsForExport(altered)).toThrow(/確定時/);
  });
  it.each(["duplicate", "missing", "amount", "payroll"])("日払いの%s不整合を拒否する", (mode) => {
    const input = fixture();
    if (mode === "duplicate") input.closings[0].employeePayments!.push({ ...input.closings[0].employeePayments![0] });
    if (mode === "missing") input.closings[0].employeePayments = [];
    if (mode === "amount") input.closings[0].employeePayments![0].dailyPayment += 1;
    if (mode === "payroll") input.closings[0].staffWork.push({ staffId: "employee" } as DailyClosing["staffWork"][number]);
    expect(() => employeePaymentsForExport(input)).toThrow();
  });
});
