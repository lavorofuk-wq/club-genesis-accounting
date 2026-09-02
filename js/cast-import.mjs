export function normalizeSourceCastId(value) {
  return String(value ?? "").trim();
}

export function normalizeAliasList(value) {
  return Array.isArray(value) ? value.map(normalizeSourceCastId).filter(Boolean) : [];
}

export function sourceLinkDocumentId(sourceCastId) {
  const source = normalizeSourceCastId(sourceCastId);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const safe = source.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `pos_${safe}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function findMemberBySourceId(members, sourceCastId) {
  const id = normalizeSourceCastId(sourceCastId);
  if (!id) return null;
  return members.find((member) =>
    String(member.id || "") === id
    || normalizeSourceCastId(member.posCastId) === id
    || normalizeAliasList(member.previousPosCastIds).includes(id)
    || normalizeSourceCastId(member.personKey) === id
  ) || null;
}

function isoFromTimestamp(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function eventTime(raw, businessDate, type) {
  const explicit = String(raw.eventAt || raw.occurredAt || "").trim();
  if (explicit && !Number.isNaN(Date.parse(explicit))) return new Date(explicit).toISOString();
  const timestamp = type === "entered"
    ? raw.enteredAt || raw.registeredAt
    : type === "departed"
      ? raw.exitedAt
      : raw.trialEndedAt || raw.trialRegisteredAt;
  const fallbackTime = type === "entered" ? "00:00:00" : type === "departed" ? "23:59:59" : "12:00:00";
  return isoFromTimestamp(timestamp) || `${businessDate}T${fallbackTime}+09:00`;
}

function normalizeEvent(raw, type, businessDate, submissionId, index) {
  const sourceCastId = normalizeSourceCastId(raw.castId ?? raw.posCastId ?? raw.id);
  const eventAt = eventTime(raw, businessDate, type);
  const suffix = `${sourceCastId}_${type}_${eventAt}_${index}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const rawEventId = String(raw.eventId || `${submissionId}_${suffix}`);
  const eventId = rawEventId.length <= 300
    ? rawEventId
    : `${rawEventId.slice(0, 200)}_${sourceLinkDocumentId(rawEventId)}`;
  return {
    eventId,
    submissionId,
    sourceCastId,
    sourceName: String(raw.castName || raw.name || "").trim(),
    internalNo: Number(raw.internalNo || 0),
    eventType: type,
    eventAt,
    businessDate,
    entryDate: String(raw.entryDate || raw.enteredBizDay || raw.trialBizDay || businessDate),
    exitedDate: String(raw.exitedDate || raw.exitedBizDay || businessDate)
  };
}

export function normalizeLifecycleEvents(closing) {
  const businessDate = String(closing.businessDate || closing.date || "");
  const submissionId = String(
    closing.submissionId
    || closing.source?.submissionId
    || closing.id
    || `legacy_${businessDate}`
  );
  if (Array.isArray(closing.lifecycleEvents) && closing.lifecycleEvents.length) {
    return closing.lifecycleEvents
      .map((raw, index) => {
        const type = {
          active: "entered",
          enter: "entered",
          entered: "entered",
          departed: "departed",
          exit: "departed",
          exited: "departed",
          trial: "trial"
        }[String(raw.eventType || raw.type || raw.status || "")];
        return type ? normalizeEvent(raw, type, businessDate, submissionId, index) : null;
      })
      .filter((event) => event?.sourceCastId);
  }
  return [
    ...(closing.enteredCasts || []).map((raw, index) => normalizeEvent(raw, "entered", businessDate, submissionId, index)),
    ...(closing.exitedCasts || []).map((raw, index) => normalizeEvent(raw, "departed", businessDate, submissionId, index)),
    ...(closing.trialCasts || []).map((raw, index) => normalizeEvent(raw, "trial", businessDate, submissionId, index))
  ].filter((event) => event.sourceCastId);
}

export function lifecycleStatus(type) {
  return type === "departed" ? "departed" : type === "trial" ? "trial" : "active";
}

function effectiveAt(member) {
  const candidates = [
    member.statusEffectiveAt,
    member.lifecycleEffectiveAt,
    member.exitedDate ? `${member.exitedDate}T23:59:59+09:00` : "",
    member.entryDate ? `${member.entryDate}T00:00:00+09:00` : ""
  ].filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

export function lifecycleDecision(member, event) {
  if (!member) return { apply: false, reason: "unresolved" };
  if (member.deleted === true) return { apply: false, reason: "deleted" };
  if (String(member.statusSourceEventId || "") === event.eventId) {
    return { apply: false, reason: "duplicate-event" };
  }
  const incoming = Date.parse(event.eventAt);
  const current = effectiveAt(member);
  if (!Number.isFinite(incoming)) return { apply: false, reason: "invalid-event-time" };
  if (incoming < current) return { apply: false, reason: "older-event" };
  if (incoming === current && current !== 0) return { apply: false, reason: "same-time-conflict" };
  if (
    event.eventType === "trial"
    && member.convertedFromTrial === true
    && member.entryDate
    && event.businessDate <= member.entryDate
  ) {
    return { apply: false, reason: "converted-trial" };
  }
  return { apply: true, reason: "newer-event" };
}

function collectSourceRows(closing) {
  const rows = [];
  const add = (sourceCastId, sourceName, usage) => {
    const id = normalizeSourceCastId(sourceCastId);
    if (id) rows.push({ sourceCastId: id, sourceName: String(sourceName || "").trim(), usage });
  };
  normalizeLifecycleEvents(closing).forEach((event) => add(event.sourceCastId, event.sourceName, "lifecycle"));
  (closing.castWork || closing.castHours || []).forEach((row) =>
    add(row.castId || row.posCastId || row.id, row.castName || row.name, "work"));
  (closing.castSales || []).forEach((row) =>
    add(row.castId || row.posCastId || row.id, row.castName || row.name, "sales"));
  (closing.trialWork || []).forEach((row) =>
    add(row.castId || row.posCastId || row.id, row.castName || row.name, "trial-work"));
  (closing.transportDeductions || []).forEach((row) => {
    if (row.personType === "cast" || row.personType === "trial") {
      add(row.personId || row.posCastId, row.personName, "deduction");
    }
  });
  (closing.payrollDeductions || []).forEach((row) => {
    if (row.personType === "cast" || row.personType === "trial") {
      add(row.personId || row.posCastId, row.personName, "deduction");
    }
  });
  (closing.rosterSnapshot?.casts || []).forEach((row) =>
    add(row.castId || row.posCastId || row.id, row.castName || row.name, "roster"));
  (closing.transactions || []).forEach((transaction) => {
    (transaction.items || []).forEach((item) => {
      add(item.castId, item.castName, "transaction");
      (item.banaiExtCastIds || []).forEach((id) => add(id, "", "transaction"));
    });
  });
  return rows;
}

export function analyzeCastImport(closing, members, sourceLinks = []) {
  const links = new Map(sourceLinks
    .filter((link) => link.status !== "unlinked" && link.sourceCastId && link.memberId)
    .map((link) => [normalizeSourceCastId(link.sourceCastId), String(link.memberId)]));
  const membersById = new Map(members.map((member) => [String(member.id), member]));
  const identities = new Map();
  collectSourceRows(closing).forEach((row) => {
    const current = identities.get(row.sourceCastId) || {
      sourceCastId: row.sourceCastId,
      sourceName: row.sourceName,
      usages: new Set()
    };
    if (!current.sourceName && row.sourceName) current.sourceName = row.sourceName;
    current.usages.add(row.usage);
    identities.set(row.sourceCastId, current);
  });
  const resolved = [];
  const unresolved = [];
  identities.forEach((identity) => {
    const linkedMember = membersById.get(links.get(identity.sourceCastId));
    const member = linkedMember || findMemberBySourceId(members, identity.sourceCastId);
    const usableMember = member?.deleted === true ? null : member;
    const result = {
      ...identity,
      usages: [...identity.usages],
      member: usableMember || null,
      blockedMember: member?.deleted === true ? member : null
    };
    (usableMember ? resolved : unresolved).push(result);
  });
  const lifecycle = normalizeLifecycleEvents(closing).map((event) => {
    const identity = resolved.find((item) => item.sourceCastId === event.sourceCastId);
    const member = identity?.member || null;
    return { event, member, decision: lifecycleDecision(member, event) };
  });
  const rosterCasts = Array.isArray(closing.rosterSnapshot?.casts) ? closing.rosterSnapshot.casts : [];
  const rosterIds = new Set(rosterCasts.map((row) =>
    normalizeSourceCastId(row.castId ?? row.posCastId ?? row.id)
  ).filter(Boolean));
  const gmsOnlyActive = closing.rosterSnapshot?.complete === true
    ? members.filter((member) =>
      member.deleted !== true
      && member.status === "active"
      && ![normalizeSourceCastId(member.posCastId), ...normalizeAliasList(member.previousPosCastIds)]
        .some((id) => id && rosterIds.has(id))
    )
    : [];
  const statusMismatches = rosterCasts.flatMap((row) => {
    const sourceCastId = normalizeSourceCastId(row.castId ?? row.posCastId ?? row.id);
    const identity = resolved.find((item) => item.sourceCastId === sourceCastId);
    const sourceStatus = row.status === "departed" || row.active === false ? "departed" : "active";
    return identity?.member && identity.member.status !== sourceStatus
      ? [{ sourceCastId, sourceStatus, member: identity.member }]
      : [];
  });
  return {
    resolved,
    unresolved,
    lifecycle,
    roster: {
      complete: closing.rosterSnapshot?.complete === true,
      gmsOnlyActive,
      statusMismatches
    }
  };
}

export function importDuplicateDecision(existing, submissionId, checksum) {
  if (!existing) return { allow: true, reason: "new" };
  if (String(existing.submissionId || existing.id || "") !== String(submissionId || "")) {
    return { allow: true, reason: "different-submission" };
  }
  if (String(existing.checksum || "") === String(checksum || "")) {
    return { allow: false, reason: "already-imported" };
  }
  return { allow: false, reason: "submission-conflict" };
}
