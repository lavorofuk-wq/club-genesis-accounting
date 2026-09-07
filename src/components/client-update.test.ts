import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientReleaseState } from "@/lib/client-release";
import type { UpdateDraftRecovery } from "@/lib/update-drafts";
import { ClientUpdateNotice } from "./client-update";

const drafts = vi.hoisted(() => ({
  recovery: null as UpdateDraftRecovery | null,
  recoveryError: "",
  assertIdle: vi.fn(),
  saveForReload: vi.fn(),
  restore: vi.fn(),
  discard: vi.fn(),
}));

vi.mock("./update-drafts", () => ({ useUpdateDrafts: () => drafts }));

const outdated: ClientReleaseState = {
  status: "outdated",
  release: { schema: 1, version: "9.0.0", buildId: "new-build", environment: "production" },
};
const recovery: UpdateDraftRecovery = { savedAt: "2026-09-07T12:00:00.000Z", view: "store", entryCount: 26 };

function render(state: ClientReleaseState, props: { busy?: boolean; dirty?: boolean } = {}) {
  const onReload = vi.fn();
  const markup = renderToStaticMarkup(createElement(ClientUpdateNotice, {
    state, busy: props.busy ?? false, dirty: props.dirty ?? false, onReload,
  }));
  // 検知・表示だけで入力の退避、復元、破棄やreloadを開始しない。
  expect(onReload).not.toHaveBeenCalled();
  for (const action of [drafts.assertIdle, drafts.saveForReload, drafts.restore, drafts.discard]) {
    expect(action).not.toHaveBeenCalled();
  }
  return markup;
}

function button(markup: string, label: string) {
  const row = [...markup.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find((match) => match[2] === label);
  expect(row, `「${label}」ボタンが表示される`).toBeDefined();
  return { disabled: /\bdisabled(?:=|\s|$)/.test(row![1]) };
}

beforeEach(() => {
  drafts.recovery = null;
  drafts.recoveryError = "";
  vi.clearAllMocks();
});

describe("最新版更新・退避復元の案内", () => {
  it("最新版で退避・エラーがなければ表示しない", () => {
    expect(render({ status: "current" })).toBe("");
  });

  it("旧版では入力を退避して更新する操作と新しい保存操作の停止を案内する", () => {
    const markup = render(outdated);
    expect(markup).toContain("保存・送信・承認・差戻しなどの新しい操作は停止しています");
    expect(button(markup, "入力を退避して最新版に更新").disabled).toBe(false);
    expect(button(markup, "最新版を再確認").disabled).toBe(false);
  });

  it("退避済みのままさらに新版が出ても、退避を捨てず再更新またはローカル復元できる", () => {
    drafts.recovery = recovery;
    const markup = render(outdated);
    expect(button(markup, "退避入力を残して最新版に更新").disabled).toBe(false);
    expect(button(markup, "退避入力を復元する").disabled).toBe(false);
    expect(markup).toContain("復元しても自動保存・送信はしません");
  });

  it("前回退避と新しい未保存入力が両方ある場合は直接更新せず、復元を選べる", () => {
    drafts.recovery = recovery;
    const markup = render(outdated, { dirty: true });
    expect(button(markup, "退避入力を残して最新版に更新").disabled).toBe(true);
    expect(button(markup, "退避入力を復元する").disabled).toBe(false);
  });

  it("保存等の処理中は更新・確認・復元・破棄のすべてを無効化する", () => {
    drafts.recovery = recovery;
    const markup = render(outdated, { busy: true });
    for (const label of ["退避入力を残して最新版に更新", "最新版を再確認", "退避入力を復元する", "退避入力を破棄"]) {
      expect(button(markup, label).disabled).toBe(true);
    }
  });

  it("退避がまだない場合も処理中は更新を無効化する", () => {
    expect(button(render(outdated, { busy: true }), "入力を退避して最新版に更新").disabled).toBe(true);
  });

  it("最新版に到達したあとも退避入力の復元・破棄を案内する", () => {
    drafts.recovery = recovery;
    const markup = render({ status: "current" });
    expect(button(markup, "退避入力を復元する").disabled).toBe(false);
    expect(button(markup, "退避入力を破棄").disabled).toBe(false);
    expect(markup).not.toContain("最新版に更新</button>");
  });

  it("壊れた退避だけがある場合も、明示的に破棄する導線とエラーを表示する", () => {
    drafts.recoveryError = "退避入力が破損しているため復元できません。";
    const markup = render({ status: "current" });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(drafts.recoveryError);
    expect(button(markup, "読み込めない退避入力を破棄").disabled).toBe(false);
    expect(markup).not.toContain("退避入力を復元する");
  });

  it("壊れた退避の破棄も処理中は実行できない", () => {
    drafts.recoveryError = "読込エラー";
    expect(button(render({ status: "current" }, { busy: true }), "読み込めない退避入力を破棄").disabled).toBe(true);
  });

  it("通信不能でも既存退避のローカル復元を妨げない", () => {
    drafts.recovery = recovery;
    const markup = render({ status: "unavailable", message: "通信状態を確認してください。" });
    expect(markup).toContain("通信状態を確認してください。");
    expect(button(markup, "退避入力を復元する").disabled).toBe(false);
    expect(button(markup, "最新版を再確認").disabled).toBe(false);
  });
});
