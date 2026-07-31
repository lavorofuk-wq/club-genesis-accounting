import { z } from "zod";
import type { CastMember, ImportDifference, ImportPreview, LifecycleEvent, PosClosing, RosterCast } from "./types";

const finiteNumber = z.coerce.number().finite().nonnegative();
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const workSchema = z.object({
  id: z.string().optional(),
  castId: z.string().optional(),
  staffId: z.string().optional(),
  name: z.string().optional(),
  castName: z.string().optional(),
  staffName: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  hours: finiteNumber,
  isTrial: z.boolean().optional()
}).passthrough();

const moneySchema = z.object({
  category: z.string().optional(),
  type: z.string().optional(),
  amount: finiteNumber,
  note: z.string().optional()
}).passthrough();

const lifecycleSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(["entered", "departed", "trial", "active", "enter", "exit", "exited"]).optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  castId: z.string().optional(),
  posCastId: z.string().optional(),
  id: z.string().optional(),
  castName: z.string().optional(),
  name: z.string().optional(),
  eventAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
}).passthrough();

const closingSchema = z.object({
  schema: z.literal("club-genesis-pos-closing"),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  submissionId: z.string().optional(),
  checksum: z.string().optional(),
  generatedAt: z.string().optional(),
  supersedesSubmissionId: z.string().optional(),
  businessDate: dateText.optional(),
  date: dateText.optional(),
  sales: z.object({
    totalSales: finiteNumber,
    cashSales: finiteNumber,
    cardSales: finiteNumber
  }).passthrough(),
  customers: z.object({
    groupCount: finiteNumber,
    totalCustomers: finiteNumber,
    customerUnitPrice: finiteNumber.optional()
  }).passthrough(),
  nominations: z.object({
    honShimeiCount: finiteNumber.optional(),
    honShimei: finiteNumber.optional(),
    jonaiCount: finiteNumber.optional(),
    jonai: finiteNumber.optional()
  }).passthrough(),
  expenses: z.array(moneySchema).default([]),
  allowances: z.array(moneySchema).default([]),
  transactions: z.array(z.record(z.string(), z.unknown())),
  castSales: z.array(z.record(z.string(), z.unknown())),
  castWork: z.array(workSchema),
  trialWork: z.array(workSchema).optional().default([]),
  staffWork: z.array(workSchema).optional().default([]),
  rosterSnapshot: z.object({
    complete: z.boolean(),
    capturedAt: z.string(),
    casts: z.array(z.record(z.string(), z.unknown()))
  }).optional(),
  lifecycleEvents: z.array(lifecycleSchema).optional().default([]),
  source: z.record(z.string(), z.unknown()).optional()
}).passthrough();

const normalizeEventType = (value: string): LifecycleEvent["eventType"] => {
  if (["entered", "active", "enter"].includes(value)) return "entered";
  if (["departed", "exit", "exited"].includes(value)) return "departed";
  return "trial";
};

export function closingChecksum(payload: Record<string, unknown>): string {
  const copy = { ...payload };
  delete copy.checksum;
  const text = JSON.stringify(copy);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
}

function rosterCast(raw: Record<string, unknown>): RosterCast {
  return {
    castId: String(raw.castId || raw.posCastId || raw.id || ""),
    name: String(raw.castName || raw.name || ""),
    internalNo: Number(raw.internalNo || 0),
    status: String(raw.status || "active")
  };
}

export function parsePosClosing(input: unknown): PosClosing {
  const result = closingSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" / ");
    throw new Error(`POS JSONの形式が正しくありません。${detail}`);
  }
  const source = input as Record<string, unknown>;
  const businessDate = String(result.data.businessDate || result.data.date || "");
  const submissionId = String(result.data.submissionId || result.data.source?.submissionId || "");
  if (result.data.schemaVersion === 2) {
    if (!submissionId) throw new Error("schemaVersion 2にはsubmissionIdが必要です。");
    if (!result.data.generatedAt || Number.isNaN(Date.parse(result.data.generatedAt))) {
      throw new Error("schemaVersion 2のgeneratedAtが不正です。");
    }
    if (!result.data.rosterSnapshot) throw new Error("schemaVersion 2にはrosterSnapshotが必要です。");
  }
  const expectedChecksum = closingChecksum(source);
  if (result.data.checksum && result.data.checksum !== expectedChecksum) {
    throw new Error("チェックサムが一致しません。POSからJSONを再出力してください。");
  }
  const effectiveSubmissionId = submissionId || `pos_json_${businessDate}_${expectedChecksum}`;
  const normalizedEvents = result.data.lifecycleEvents.map((event) => ({
    eventId: event.eventId,
    eventType: normalizeEventType(String(event.eventType || event.type || event.status || "")),
    castId: String(event.castId || event.posCastId || event.id || ""),
    castName: String(event.castName || event.name || ""),
    eventAt: event.eventAt
  }));
  const legacyEventRows = [
    ...legacyEvents(source.enteredCasts, "entered", businessDate, effectiveSubmissionId),
    ...legacyEvents(source.exitedCasts, "departed", businessDate, effectiveSubmissionId),
    ...legacyEvents(source.trialCasts, "trial", businessDate, effectiveSubmissionId)
  ];
  const lifecycleEvents = [...normalizedEvents, ...legacyEventRows]
    .filter((event, index, rows) => rows.findIndex((candidate) => candidate.eventId === event.eventId) === index);
  if (lifecycleEvents.some((event) => !event.castId)) {
    throw new Error("lifecycleEventsにcastIdがないイベントがあります。");
  }
  return {
    ...result.data,
    businessDate,
    submissionId: effectiveSubmissionId,
    checksum: result.data.checksum || expectedChecksum,
    transactions: result.data.transactions as PosClosing["transactions"],
    castSales: result.data.castSales as PosClosing["castSales"],
    rosterSnapshot: result.data.rosterSnapshot ? {
      complete: result.data.rosterSnapshot.complete,
      capturedAt: result.data.rosterSnapshot.capturedAt,
      casts: result.data.rosterSnapshot.casts.map(rosterCast)
    } : undefined,
    lifecycleEvents
  } as PosClosing;
}

function legacyEvents(
  value: unknown,
  eventType: LifecycleEvent["eventType"],
  businessDate: string,
  submissionId: string
): LifecycleEvent[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const raw = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const castId = String(raw.castId || raw.posCastId || raw.id || "");
    const eventAt = String(raw.eventAt || raw.occurredAt || `${businessDate}T12:00:00+09:00`);
    return {
      eventId: String(raw.eventId || `${submissionId}_${eventType}_${castId || index}`),
      eventType,
      castId,
      castName: String(raw.castName || raw.name || ""),
      eventAt
    };
  }).filter((event) => event.castId);
}

export function previewRoster(closing: PosClosing, members: CastMember[]): ImportPreview {
  const activeMembers = members.filter((member) => !member.deleted && member.status !== "departed");
  const bySourceId = new Map<string, CastMember[]>();
  members.filter((member) => !member.deleted).forEach((member) => {
    const ids = [member.posCastId, ...(member.previousPosCastIds || [])].filter(Boolean);
    ids.forEach((id) => bySourceId.set(id, [...(bySourceId.get(id) || []), member]));
  });
  const snapshotCasts = referencedCasts(closing);
  const sourceIds = new Set(snapshotCasts.map((cast) => cast.castId));
  const differences: ImportDifference[] = snapshotCasts.map((cast) => {
    const matches = bySourceId.get(cast.castId) || [];
    if (matches.length > 1) {
      return {
        kind: "conflict", sourceCastId: cast.castId, sourceName: cast.name,
        sourceInternalNo: cast.internalNo, sourceStatus: cast.status,
        message: "同じPOS IDに複数のGMS人物が紐づいています。", blocking: true
      };
    }
    const member = matches[0];
    if (!member) {
      return {
        kind: "new", sourceCastId: cast.castId, sourceName: cast.name,
        sourceInternalNo: cast.internalNo, sourceStatus: cast.status,
        message: "GMSに新規登録して紐づけます。", blocking: false
      };
    }
    if (member.name !== cast.name) {
      return {
        kind: "renamed", sourceCastId: cast.castId, sourceName: cast.name,
        sourceInternalNo: cast.internalNo, sourceStatus: cast.status,
        memberId: member.id, memberName: member.name,
        message: `同一IDの名称差分です。GMS表示名「${member.name}」は上書きせず維持します。`, blocking: false
      };
    }
    return {
      kind: "linked", sourceCastId: cast.castId, sourceName: cast.name,
      sourceInternalNo: cast.internalNo, sourceStatus: cast.status,
      memberId: member.id, memberName: member.name, message: "既存人物と一致しました。", blocking: false
    };
  });
  if (closing.rosterSnapshot?.complete) {
    activeMembers.filter((member) => !sourceIds.has(member.posCastId)).forEach((member) => {
      differences.push({
        kind: "missing-local",
        sourceCastId: member.posCastId,
        sourceName: "",
        memberId: member.id,
        memberName: member.name,
        message: "POSの完全スナップショットに存在しません。自動退店にはせず要確認とします。",
        blocking: true
      });
    });
  }
  return {
    closing,
    differences,
    blockingCount: differences.filter((item) => item.blocking).length,
    newCount: differences.filter((item) => item.kind === "new").length
  };
}

function referencedCasts(closing: PosClosing): RosterCast[] {
  const values = new Map<string, RosterCast>();
  const add = (castId: unknown, name: unknown, internalNo?: unknown, status?: unknown) => {
    const id = String(castId || "");
    if (!id) return;
    const existing = values.get(id);
    values.set(id, {
      castId: id,
      name: String(name || existing?.name || ""),
      internalNo: Number(internalNo || existing?.internalNo || 0),
      status: String(status || existing?.status || "active")
    });
  };
  closing.rosterSnapshot?.casts.forEach((cast) => add(cast.castId, cast.name, cast.internalNo, cast.status));
  closing.castWork.forEach((row) => {
    const raw = row as Record<string, unknown>;
    add(raw.castId || raw.posCastId || raw.id, raw.castName || raw.name, raw.internalNo, raw.isTrial ? "trial" : "active");
  });
  closing.castSales.forEach((row) => {
    const raw = row as Record<string, unknown>;
    add(raw.castId || raw.posCastId || raw.id, raw.castName || raw.name, raw.internalNo);
  });
  closing.lifecycleEvents.forEach((event) => add(event.castId, event.castName, 0, event.eventType === "trial" ? "trial" : "active"));
  return [...values.values()];
}

export function safeDocumentId(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 1400);
}
