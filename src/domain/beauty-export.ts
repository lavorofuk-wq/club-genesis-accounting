import type { WorkspaceData } from "./gms";
import type { MonthlyAccountingSnapshot } from "./month-accounting";
import { applyBeautyAllowances } from "./beauty-allowance";

/** 旧確定月は原本のまま、新計算の帳票には月次と同じ美容室手当を渡す。 */
export function beautyClosingsForExport(
  data: WorkspaceData,
  month: string,
  snapshot?: Pick<MonthlyAccountingSnapshot, "calculationVersion">,
) {
  if (snapshot) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(snapshot.calculationVersion || "");
    if (!match || Number(match[1]) < 2 || Number(match[1]) === 2 && Number(match[2]) < 50) return data.closings;
  }
  return applyBeautyAllowances(data, month).closings;
}
