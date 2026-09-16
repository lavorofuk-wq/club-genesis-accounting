import assert from "node:assert/strict";
import test from "node:test";
import { isGmsReady, openDefaultBrowser, waitForGms } from "../scripts/pc-dev.mjs";

test("GMSのローカルrelease応答だけを起動済みと判定する", async () => {
  assert.equal(await isGmsReady(async () => ({ ok: true, json: async () => ({ schema: 1, environment: "local" }) })), true);
  assert.equal(await isGmsReady(async () => ({ ok: false, json: async () => ({}) })), false);
  assert.equal(await isGmsReady(async () => ({ ok: true, json: async () => ({ schema: 1, environment: "production" }) })), false);
  assert.equal(await isGmsReady(async () => { throw new Error("offline"); }), false);
});

test("起動応答が得られるまで待ってから完了する", async () => {
  let attempts = 0;
  await waitForGms({
    fetcher: async () => ({ ok: ++attempts >= 3, json: async () => ({ schema: 1, environment: "local" }) }),
    timeoutMs: 1_000,
    intervalMs: 0,
  });
  assert.equal(attempts, 3);
});

test("開発サーバーが先に終了した場合は待機を中断する", async () => {
  const expected = new Error("server stopped");
  await assert.rejects(
    waitForGms({
      fetcher: async () => ({ ok: false, json: async () => ({}) }),
      timeoutMs: 1_000,
      intervalMs: 0,
      getAbortError: () => expected,
    }),
    expected,
  );
});

test("既定ブラウザーはlocalhostだけを開く", () => {
  let invocation;
  const child = { unref() {} };
  openDefaultBrowser(undefined, (...args) => {
    invocation = args;
    return child;
  });
  assert.equal(invocation[0], "cmd.exe");
  assert.match(invocation[1].at(-1), /^start "" "http:\/\/localhost:3000"$/);
  assert.equal(invocation[2].detached, true);
});
