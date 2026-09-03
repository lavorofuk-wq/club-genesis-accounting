import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCastImport,
  findMemberBySourceId,
  importDuplicateDecision,
  lifecycleDecision,
  normalizeLifecycleEvents
} from "../js/cast-import.mjs";

test("人物はPOS IDまたは過去IDで照合し、名前だけでは照合しない", () => {
  const members = [
    { id: "member-a", posCastId: "pos-a", name: "同名" },
    { id: "member-b", posCastId: "pos-b", previousPosCastIds: ["old-b"], name: "同名" }
  ];
  assert.equal(findMemberBySourceId(members, "pos-a")?.id, "member-a");
  assert.equal(findMemberBySourceId(members, "old-b")?.id, "member-b");
  assert.equal(findMemberBySourceId(members, "同名"), null);
});

test("古いイベントは現在の在籍状態を巻き戻さない", () => {
  const member = {
    id: "member-a",
    status: "active",
    statusEffectiveAt: "2026-07-10T12:00:00+09:00"
  };
  const decision = lifecycleDecision(member, {
    eventId: "old-exit",
    eventType: "departed",
    eventAt: "2026-07-01T12:00:00+09:00",
    businessDate: "2026-07-01"
  });
  assert.deepEqual(decision, { apply: false, reason: "older-event" });
});

test("削除済みキャストはJSONで自動復元しない", () => {
  const decision = lifecycleDecision(
    { id: "member-a", deleted: true },
    {
      eventId: "new-enter",
      eventType: "entered",
      eventAt: "2026-07-25T12:00:00+09:00",
      businessDate: "2026-07-25"
    }
  );
  assert.deepEqual(decision, { apply: false, reason: "deleted" });
  const analysis = analyzeCastImport({
    id: "deleted-test",
    businessDate: "2026-07-25",
    castWork: [{ castId: "deleted-id", castName: "削除済み" }]
  }, [{ id: "member-deleted", posCastId: "deleted-id", name: "削除済み", deleted: true }]);
  assert.equal(analysis.unresolved.length, 1);
  assert.equal(analysis.unresolved[0].blockedMember.id, "member-deleted");
});

test("在籍化済み人物を古い体入イベントへ戻さない", () => {
  const decision = lifecycleDecision(
    {
      id: "member-a",
      status: "active",
      convertedFromTrial: true,
      entryDate: "2026-07-10"
    },
    {
      eventId: "old-trial",
      eventType: "trial",
      eventAt: "2026-07-01T12:00:00+09:00",
      businessDate: "2026-07-01"
    }
  );
  assert.equal(decision.apply, false);
});

test("v1 JSONの入退店配列をイベントへ変換する", () => {
  const events = normalizeLifecycleEvents({
    id: "submission-1",
    businessDate: "2026-07-25",
    enteredCasts: [{ castId: "a", castName: "A" }],
    exitedCasts: [{ castId: "b", castName: "B" }],
    trialCasts: [{ castId: "c", castName: "C" }]
  });
  assert.deepEqual(events.map((event) => event.eventType), ["entered", "departed", "trial"]);
  assert.ok(events[0].eventAt < events[1].eventAt);
});

test("未登録IDは名前一致させず未解決にする", () => {
  const analysis = analyzeCastImport({
    id: "submission-1",
    businessDate: "2026-07-25",
    castWork: [{ castId: "unknown-id", castName: "登録済みと同名" }]
  }, [{ id: "member-a", posCastId: "known-id", name: "登録済みと同名" }]);
  assert.equal(analysis.unresolved.length, 1);
  assert.equal(analysis.unresolved[0].sourceCastId, "unknown-id");
});

test("同一submissionIdとchecksumは再取込しない", () => {
  assert.deepEqual(
    importDuplicateDecision(
      { submissionId: "submission-1", checksum: "abc" },
      "submission-1",
      "abc"
    ),
    { allow: false, reason: "already-imported" }
  );
  assert.deepEqual(
    importDuplicateDecision(
      { submissionId: "submission-1", checksum: "abc" },
      "submission-1",
      "different"
    ),
    { allow: false, reason: "submission-conflict" }
  );
});

test("完全名簿に存在しないGMS在籍者を差分として検出する", () => {
  const analysis = analyzeCastImport({
    id: "submission-2",
    businessDate: "2026-07-25",
    rosterSnapshot: {
      complete: true,
      casts: [{ castId: "pos-a", name: "A", status: "active" }]
    }
  }, [
    { id: "member-a", posCastId: "pos-a", name: "A", status: "active" },
    { id: "member-b", posCastId: "pos-b", name: "B", status: "active" }
  ]);
  assert.deepEqual(analysis.roster.gmsOnlyActive.map((member) => member.id), ["member-b"]);
});
