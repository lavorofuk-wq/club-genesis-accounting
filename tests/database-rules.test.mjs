import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rulesFile = new URL("../database.rules.json", import.meta.url);
const databaseRules = JSON.parse(await readFile(rulesFile, "utf8")).rules.$workspace;
const repositorySource = await readFile(new URL("../src/lib/firebase/repository.ts", import.meta.url), "utf8");

test("キャスト時給ルールは新しい0円を拒否し、旧0円の不変値だけを許容する", () => {
  const statusRule = databaseRules.casts.$id.status[".validate"];
  const monthlyRule = databaseRules.casts.$id.hourlyRates.$month[".validate"];
  const trialRule = databaseRules.casts.$id.trialHourlyRate[".validate"];
  assert.match(statusRule, /hourlyRates'\)\.hasChildren\(\)/);
  assert.match(statusRule, /trialHourlyRate'\)\.exists\(\)/);
  assert.match(monthlyRule, /newData\.val\(\) > 0/);
  assert.match(monthlyRule, /data\.exists\(\) && data\.val\(\) === 0 && newData\.val\(\) === 0/);
  assert.match(monthlyRule, /data\.parent\(\)\.parent\(\).*status.*!== 'trial'/);
  assert.match(trialRule, /status.*!== 'trial'/);
  assert.match(trialRule, /newData\.val\(\) > 0/);
  assert.match(trialRule, /data\.parent\(\).*status.*=== 'trial'/);
});

test("スタッフ時給ルールは在籍・体入それぞれの使用項目を正数に限定する", () => {
  const statusRule = databaseRules.staff.$id.status[".validate"];
  const hourlyRule = databaseRules.staff.$id.hourlyRate[".validate"];
  const trialRule = databaseRules.staff.$id.trialHourlyRate[".validate"];
  assert.match(statusRule, /hourlyRate'\)\.exists\(\)/);
  assert.match(statusRule, /trialHourlyRate'\)\.exists\(\)/);
  assert.match(hourlyRule, /status.*=== 'trial'/);
  assert.match(hourlyRule, /newData\.val\(\) > 0/);
  assert.match(hourlyRule, /data\.parent\(\).*status.*!== 'trial'/);
  assert.match(trialRule, /status.*!== 'trial'/);
  assert.match(trialRule, /newData\.val\(\) > 0/);
  assert.match(trialRule, /data\.parent\(\).*status.*=== 'trial'/);
});

test("送迎ドライバー日給ルールは正数または旧レコードの不変値だけを許容する", () => {
  const driverRule = databaseRules.drivers.$id[".validate"];
  assert.match(driverRule, /dailyRate'\)\.val\(\) > 0/);
  assert.match(driverRule, /data\.exists\(\).*data\.child\('dailyRate'\)\.val\(\) === 0.*newData\.child\('dailyRate'\)\.val\(\) === 0/);
});

test("紹介者削除・再設定履歴は権限・月・版・操作者・内容を検証する", () => {
  const eventRules = databaseRules.introducerMonthEvents;
  const writeRule = eventRules.$month.$castId[".write"];
  const validateRule = eventRules.$month.$castId[".validate"];
  assert.match(eventRules[".read"], /role.*shop.*accounting.*op/);
  assert.match(writeRule, /\$month\.matches/);
  assert.match(writeRule, /accountingFinalizeLock/);
  assert.match(writeRule, /state'\)\.val\(\) === 'deleted'/);
  assert.match(writeRule, /state'\)\.val\(\) === 'reassigned'/);
  assert.match(writeRule, /casts'\)\.child\(\$castId\).*updatedAt.*newData\.parent\(\)\.parent\(\)\.parent\(\)\.child\('casts'\)/);
  // 既存deletedイベントを単独更新して保存順だけ後ろへ動かす改ざんを拒否する。
  assert.match(writeRule, /data\.child\('state'\)\.val\(\) === 'deleted'.*newData\.child\('state'\)\.val\(\) === 'deleted'/);
  assert.match(writeRule, /root\.child\(\$workspace\)\.child\('introducers'\).*newData\.parent\(\)\.parent\(\)\.parent\(\)\.child\('introducers'\)/);
  assert.match(writeRule, /sourceCastId.*newData\.parent\(\)\.child.*state'\)\.val\(\) === 'reassigned'/);
  assert.match(validateRule, /data\.child\('state'\)\.val\(\) === 'reassigned'/);
  assert.match(validateRule, /sourceCastId/);
  assert.match(validateRule, /newData\.parent\(\)\.parent\(\)\.parent\(\).*child\('casts'\)/);
  assert.match(validateRule, /convertedFromTrialId/);
  assert.match(validateRule, /data\.exists\(\).*sourceCastId.*child\('state'\)\.val\(\) === 'reassigned'/);
  assert.match(validateRule, /!newData\.parent\(\)\.parent\(\)\.parent\(\).*child\('introducers'\)/);
  assert.match(validateRule, /newData\.child\('id'\)\.val\(\) === \$castId/);
  assert.match(validateRule, /newData\.child\('month'\)\.val\(\) === \$month/);
  assert.match(validateRule, /deletedAt'\)\.val\(\)\.matches/);
  assert.match(validateRule, /createdAt'\)\.val\(\)\.matches/);
  assert.match(validateRule, /updatedAt'\)\.val\(\)\.matches/);
  assert.match(validateRule, /reassignedAt'\)\.val\(\)\.matches/);
  assert.match(validateRule, /revision'\)\.val\(\) === data\.child\('revision'\)\.val\(\) \+ 1/);
  assert.match(validateRule, /updatedBy'\)\.val\(\) === auth\.uid/);
  assert.match(validateRule, /deletedBy'\)\.val\(\) === auth\.uid/);
  assert.match(validateRule, /reassignedAt'\)\.val\(\) !== data\.child\('reassignedAt'\)\.val\(\).*reassignedBy'\)\.val\(\) === auth\.uid/);
  assert.match(validateRule, /reassignedAt'\)\.val\(\) === data\.child\('reassignedAt'\)\.val\(\).*reassignedBy'\)\.val\(\) === data\.child\('reassignedBy'\)\.val\(\)/);
  assert.match(validateRule, /attendanceAdvisoryFee/);
  assert.match(validateRule, /entryAdvisoryFee/);
  assert.match(validateRule, /child\('introducer'\)\.child\('name'\)\.val\(\) === newData\.parent\(\)\.parent\(\)\.parent\(\).*child\('introducers'\)/);
  assert.match(validateRule, /child\('introducer'\)\.child\('feeType'\)\.val\(\) === newData\.parent\(\)\.parent\(\)\.parent\(\).*child\('introducers'\)/);
});

test("紹介者履歴を伴うキャスト原子的保存は直前updatedAtをCAS検証する", () => {
  const previousUpdatedAtRule = databaseRules.casts.$id.previousUpdatedAt[".validate"];
  const castParentValidate = databaseRules.casts.$id[".validate"];
  assert.match(previousUpdatedAtRule, /newData\.val\(\) === data\.val\(\)/);
  assert.match(previousUpdatedAtRule, /newData\.parent\(\)\.child\('updatedAt'\)\.val\(\) === data\.parent\(\)\.child\('updatedAt'\)\.val\(\)/);
  assert.match(previousUpdatedAtRule, /newData\.val\(\) === data\.parent\(\)\.child\('updatedAt'\)\.val\(\)/);
  assert.match(castParentValidate, /\$workspace === 'accounting'.*previousUpdatedAt.*data\.child\('updatedAt'\)/);
  assert.match(repositorySource, /applyCastAndIntroducerPlansAtomically/);
  assert.match(repositorySource, /hasAtomicFinancialEventPlan\s*=\s*Object\.keys\(entryEventPlan\)[\s\S]*Object\.keys\(introducerMonthEventPlan\)/);
  assert.match(repositorySource, /previousUpdatedAt:\s*before\?\.updatedAt/);
  assert.match(repositorySource, /export async function deleteCast[\s\S]*previousUpdatedAt:\s*row\.updatedAt/);
  assert.match(repositorySource, /\[`casts\/\$\{castId\}`\]: expectedCast/);
  assert.match(repositorySource, /const directExisting = existingCandidates\.find/);
  assert.match(repositorySource, /revision: directExisting \? directExisting\.revision \+ 1 : 1/);
  assert.match(repositorySource, /castUpdatedMonth > month && historicalEventIsValid/);
  assert.match(repositorySource, /historicalEventIsValid = Boolean\(event[\s\S]*event\.introducerId[\s\S]*event\.amount/);
  assert.match(repositorySource, /operationMonth !== desiredMonth[\s\S]*before\?\.hiredAt === next\.hiredAt/);
});

test("紹介者削除ロック・commit・キャスト更新は同じ原子的削除へ結び付く", () => {
  const lockWrite = databaseRules.introducerDeletionLocks.$introducerId[".write"];
  const commitRule = databaseRules.introducerDeletionCommits.$introducerId;
  const commitWrite = commitRule[".write"];
  const commitValidate = commitRule[".validate"];
  const castValidate = databaseRules.casts.$id[".validate"];
  const introducerWrite = databaseRules.introducers.$id[".write"];
  const driverWrite = databaseRules.drivers.$id[".write"];

  assert.match(lockWrite, /accountingFinalizeLock/);
  assert.match(lockWrite, /data\.child\('owner'\)\.val\(\) === auth\.uid \|\| data\.child\('expiresAt'\)\.val\(\) <= now/);
  assert.match(databaseRules.introducerDeletionLocks.$introducerId[".validate"], /acquiredAtMs'\)\.val\(\) === now/);
  assert.match(commitWrite, /\$workspace === 'accounting' \|\| \$workspace === 'accounting-dev'/);
  assert.match(commitWrite, /accountingMonthStates.*child\(newData\.child\('month'\)\.val\(\)\).*status.*open/);
  assert.match(commitWrite, /newData\.child\('token'\)\.val\(\) === root.*introducerDeletionLocks.*child\('token'\)\.val\(\)/);
  assert.match(commitWrite, /introducerDeletionLocks.*child\('expiresAt'\)\.val\(\) > now/);
  assert.match(commitWrite, /!newData\.parent\(\)\.parent\(\)\.child\('introducerDeletionLocks'\)/);
  assert.match(commitValidate, /completedAtMs'\)\.val\(\) === now/);
  assert.match(commitValidate, /deletedAtMs'\)\.val\(\) === root.*introducerDeletionLocks.*acquiredAtMs/);
  assert.equal(commitRule.linkedCastIds[".validate"], "newData.hasChildren()");
  assert.match(commitRule.linkedCastIds.$castId[".validate"], /casts.*introducerId.*\$introducerId/);
  assert.match(castValidate, /introducerDeletionLocks/);
  assert.match(introducerWrite, /introducerDeletionCommits.*token/);
  assert.match(introducerWrite, /newData\.exists\(\).*introducerDeletionLocks/);
  assert.doesNotMatch(driverWrite, /introducerDeletionLocks/);
  assert.match(databaseRules.accountingFinalizeLock[".write"], /introducerDeletionLocks'\)\.hasChildren/);
});

test("未承認日次の完全削除は権限・状態・版・月次状態を削除ロックで固定する", () => {
  const claimRules = databaseRules.posSubmissionClaims.$key;
  const lockRules = databaseRules.dailyClosingDeletionLock;
  const claimWriteRule = claimRules[".write"];
  const claimValidateRule = claimRules[".validate"];
  const readRule = lockRules[".read"];
  const writeRule = lockRules[".write"];
  const validateRule = lockRules[".validate"];

  assert.match(claimWriteRule, /!newData\.exists\(\) \|\| \$key\.matches\(\/\^\[0-9a-f\]\{64\}\$\//);
  assert.match(claimValidateRule, /!newData\.exists\(\) \|\| \(\$key\.matches\(\/\^\[0-9a-f\]\{64\}\$\//);
  assert.match(readRule, /role'\)\.val\(\) === 'shop'/);
  assert.match(readRule, /role'\)\.val\(\) === 'op'/);
  assert.match(writeRule, /role'\)\.val\(\) === 'shop'.*role'\)\.val\(\) === 'op'/);
  assert.match(writeRule, /accountingFinalizeLock/);
  assert.match(writeRule, /history.*status'\)\.val\(\) === 'submitted'/);
  assert.match(writeRule, /history.*status'\)\.val\(\) === 'returned'/);
  assert.match(writeRule, /history.*status'\)\.val\(\) === 'withdrawn'/);
  assert.match(writeRule, /businessDate'\)\.val\(\) === root.*history.*businessDate/);
  assert.match(writeRule, /updatedAt'\)\.val\(\) === root.*history.*updatedAt/);
  assert.match(writeRule, /submissionId'\)\.val\(\) === root.*history.*submissionId/);
  assert.match(writeRule, /checksum'\)\.val\(\) === root.*history.*checksum/);
  assert.match(writeRule, /accountingMonthStates.*status'\)\.val\(\) === 'open'/);
  assert.match(writeRule, /posSubmissionClaims.*claimKey.*id'\)\.val\(\) === newData\.child\('id'/);
  assert.match(validateRule, /owner'\)\.val\(\) === auth\.uid/);
  assert.match(validateRule, /claimKey'\)\.val\(\)\.matches\(\/\^\[0-9a-f\]\{64\}\$\//);
  assert.match(validateRule, /claimKey'\)\.val\(\) === newData\.child\('checksum'/);
  assert.match(validateRule, /acquiredAtMs'\)\.val\(\) === now/);
  assert.match(validateRule, /expiresAt'\)\.val\(\) > now/);
});

test("日次本体・POS重複防止情報・削除ロックを同じ原子的更新で除去する", () => {
  const historyWrite = databaseRules.history.$id[".write"];
  const finalizeWrite = databaseRules.accountingFinalizeLock[".write"];

  assert.match(historyWrite, /data\.exists\(\) && !newData\.exists\(\)/);
  assert.match(historyWrite, /data\.child\('status'\)\.val\(\) === 'submitted'/);
  assert.match(historyWrite, /data\.child\('status'\)\.val\(\) === 'returned'/);
  assert.match(historyWrite, /data\.child\('status'\)\.val\(\) === 'withdrawn'/);
  assert.match(historyWrite, /dailyClosingDeletionLock.*owner'\)\.val\(\) === auth\.uid/);
  assert.match(historyWrite, /dailyClosingDeletionLock.*updatedAt'\)\.val\(\) === data\.child\('updatedAt'/);
  assert.match(historyWrite, /dailyClosingDeletionLock.*submissionId'\)\.val\(\) === data\.child\('submissionId'/);
  assert.match(historyWrite, /dailyClosingDeletionLock.*checksum'\)\.val\(\) === data\.child\('checksum'/);
  assert.match(historyWrite, /posSubmissionClaims.*claimKey.*val\(\) === \$id/);
  assert.match(historyWrite, /!newData\.parent\(\)\.parent\(\)\.child\('dailyClosingDeletionLock'\)\.exists\(\)/);
  assert.match(historyWrite, /!newData\.parent\(\)\.parent\(\)\.child\('posSubmissionClaims'\).*claimKey/);
  assert.match(finalizeWrite, /!newData\.exists\(\) \|\| !root.*dailyClosingDeletionLock.*expiresAt'\)\.val\(\) <= now/);

  assert.match(repositorySource, /export async function deleteUnapprovedClosing[\s\S]*requireUser\(user, \["shop", "op"\]\)/);
  assert.match(repositorySource, /claimKey:\s*posSubmissionClaimKey\(expected\.checksum\)/);
  assert.match(repositorySource, /legacyClaimKey = claimKey\(lock\.submissionId, lock\.checksum\)/);
  assert.match(repositorySource, /const plan: Record<string, null> = \{[\s\S]*\[`history\/\$\{lock\.id\}`\]: null,[\s\S]*\[`posSubmissionClaims\/\$\{lock\.claimKey\}`\]: null,[\s\S]*dailyClosingDeletionLock: null/);
  assert.match(repositorySource, /plan\[`posSubmissionClaims\/\$\{legacyClaimKey\}`\] = null/);
  assert.match(repositorySource, /if \(before && !existing\) throw new Error\("再編集元データは完全削除されています/);
  assert.match(repositorySource, /await update\(rootRef\(\), plan\)/);
});

test("日次と紹介者イベントのサーバー保存時刻をdevで必須化し本番旧データを互換にする", () => {
  const statusTimestampRule = databaseRules.history.$id.$field[".validate"];
  const eventParentValidate = databaseRules.introducerMonthEvents.$month.$castId[".validate"];

  assert.match(statusTimestampRule, /accounting-dev'.*submittedAtMs'\)\.isNumber\(\).*val\(\) === now/);
  assert.match(statusTimestampRule, /accounting'.*!newData\.parent\(\)\.child\('submittedAtMs'\)\.exists\(\)/);
  assert.match(statusTimestampRule, /data\.parent\(\)\.child\('submittedAtMs'\).*newData\.parent\(\)\.child\('submittedAtMs'\)/);
  // 部分updateでstate子validateを通らなくても、イベント親で必ず検証する。
  assert.match(eventParentValidate, /accounting-dev'.*updatedAtMs'\)\.isNumber\(\).*val\(\) === now/);
  assert.match(eventParentValidate, /reassignedAtMs/);
  assert.match(eventParentValidate, /data\.child\('reassignedAtMs'\).*newData\.child\('reassignedAtMs'\)/);
  assert.match(repositorySource, /submittedAtMs:\s*serverOrderTimestamp\(\)/);
  assert.match(repositorySource, /updatedAtMs:\s*serverOrderTimestamp\(\)/);
  assert.match(repositorySource, /ref\(database, "\.info\/serverTimeOffset"\)/);
  assert.match(repositorySource, /new Date\(deletionLock\.acquiredAtMs\)\.toISOString\(\)/);
  assert.match(repositorySource, /cleanupExpiredIntroducerDeletionLocks/);
});
