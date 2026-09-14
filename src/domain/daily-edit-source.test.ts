import { describe, expect, it } from "vitest";
import type { DailyClosing } from "./gms";
import { duplicateClosingForNewWorkflow, existingClosingSubmissionMessage } from "./daily-edit-source";

const existing = { id: "daily_20260902", businessDate: "2026-09-02", status: "returned", updatedAt: "2026-09-15T00:00:00Z" } as DailyClosing;

describe("既存営業日の新規重複送信を案内する", () => {
  it.each(["returned", "withdrawn", "submitted", "approved"] as const)("%sの既存日次をID形式に依存せず検知する", (status) => {
    const row = { ...existing, id: "old-id", status };
    expect(duplicateClosingForNewWorkflow("2026-09-02", null, [row])).toBe(row);
  });
  it("別営業日や正式な再編集は新規重複扱いしない", () => {
    expect(duplicateClosingForNewWorkflow("2026-09-03", null, [existing])).toBeUndefined();
    expect(duplicateClosingForNewWorkflow("", null, [existing])).toBeUndefined();
    expect(duplicateClosingForNewWorkflow("2026-09-02", existing, [existing])).toBeUndefined();
    expect(existing.updatedAt).toBe("2026-09-15T00:00:00Z");
  });
  it.each([
    ["returned", "「再編集」"], ["withdrawn", "「再編集」"], ["submitted", "「取下げ」"], ["approved", "「差戻し」"],
  ] as const)("%sでは必要な操作を営業日付きで案内する", (status, action) => {
    const message = existingClosingSubmissionMessage({ ...existing, status });
    expect(message).toContain("2026-09-02");
    expect(message).toContain("新規作成からは送信できません");
    expect(message).toContain(action);
  });
});
