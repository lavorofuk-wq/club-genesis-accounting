import type { DailyClosing } from "./gms";

/** 新規作成から既存日次を上書きせず、現在の状態に合った操作を案内する。 */
export function existingClosingSubmissionMessage(row: Pick<DailyClosing, "businessDate" | "status">): string {
  const prefix = `${row.businessDate}の店舗データはすでに保存されています。新規作成からは送信できません。`;
  if (row.status === "returned" || row.status === "withdrawn") {
    return `${prefix}「送信済みデータ」の同営業日から「再編集」を開いてください。POS JSONを更新する場合も、再編集画面で同じ営業日のJSONを取り込んでください。`;
  }
  if (row.status === "submitted") {
    return `${prefix}現在は経理確認待ちです。「送信済みデータ」の同営業日を「取下げ」してから「再編集」を開いてください。`;
  }
  if (row.status === "approved") {
    return `${prefix}現在は承認済みです。経理またはOPが「差戻し」した後、「送信済みデータ」から「再編集」を開いてください。月次確定済みの場合は先に確定解除が必要です。`;
  }
  return `${prefix}保存状態を確認できません。「最新データを読込」で確認してください。`;
}

export function duplicateClosingForNewWorkflow(
  businessDate: string,
  initial: DailyClosing | null,
  closings: DailyClosing[],
): DailyClosing | undefined {
  if (initial || !businessDate) return undefined;
  return closings.find((row) => row.businessDate === businessDate);
}
