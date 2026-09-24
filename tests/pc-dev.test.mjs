import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

test("WindowsのURLハンドラーでlocalhostだけを開く", async () => {
  let invocation;
  let unrefCalled = false;
  const child = new EventEmitter();
  child.unref = () => { unrefCalled = true; };
  const opening = openDefaultBrowser(undefined, (...args) => {
    invocation = args;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  await opening;
  assert.equal(invocation[0], "explorer.exe");
  assert.deepEqual(invocation[1], ["http://localhost:3000"]);
  assert.equal(invocation[2].detached, true);
  assert.equal(unrefCalled, true);
});

test("ブラウザー起動に失敗した場合はエラーを返す", async () => {
  const expected = new Error("browser failed");
  const child = new EventEmitter();
  child.unref = () => {};
  const opening = openDefaultBrowser(undefined, () => {
    queueMicrotask(() => child.emit("error", expected));
    return child;
  });
  await assert.rejects(opening, expected);
});
