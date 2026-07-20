const ASSIGNED_RESPONSE_STATUSES = new Set(["ATTACHED", "EN_ROUTE", "ON_SCENE", "HOLDING"]);

export function inspectDatabaseIntegrity(data) {
  const issues = [];
  const callIds = new Set(data.calls.map((call) => call.id));
  const boloIds = new Set(data.bolos.map((bolo) => bolo.id));
  const warrantIds = new Set(data.warrants.map((warrant) => warrant.id));

  reportDuplicateKeys(data.units, "discordUserId", "unit Discord user", issues);
  reportDuplicateKeys(data.units, "callsign", "unit callsign", issues);
  reportDuplicateKeys(data.calls, "id", "call", issues);
  reportDuplicateKeys(data.bolos, "id", "BOLO", issues);
  reportDuplicateKeys(data.warrants, "id", "warrant", issues);
  reportDuplicateKeys(data.transmissions, "id", "transmission", issues);

  for (const unit of data.units) {
    if (unit.assignedCallId && !callIds.has(unit.assignedCallId))
      issues.push(`Unit ${unit.callsign} references missing call ${unit.assignedCallId}.`);
    if (!unit.assignedCallId && ASSIGNED_RESPONSE_STATUSES.has(unit.responseStatus))
      issues.push(`Unit ${unit.callsign} has ${unit.responseStatus} without an assigned call.`);
  }
  for (const call of data.calls) {
    for (const id of call.relatedCallIds)
      if (!callIds.has(id)) issues.push(`Call ${call.id} references missing related call ${id}.`);
    for (const id of call.boloIds) if (!boloIds.has(id)) issues.push(`Call ${call.id} references missing BOLO ${id}.`);
    for (const id of call.warrantIds)
      if (!warrantIds.has(id)) issues.push(`Call ${call.id} references missing warrant ${id}.`);
  }
  for (const bolo of data.bolos)
    if (bolo.callId && !callIds.has(bolo.callId))
      issues.push(`BOLO ${bolo.id} references missing call ${bolo.callId}.`);
  for (const warrant of data.warrants)
    if (warrant.callId && !callIds.has(warrant.callId))
      issues.push(`Warrant ${warrant.id} references missing call ${warrant.callId}.`);
  return issues;
}

export function repairDatabaseIntegrity(data) {
  const changes = [];
  const archives = structuredClone(data.archives ?? []);
  const calls = deduplicate(data.calls, "id", "call", "calls", changes, archives);
  const bolos = deduplicate(data.bolos, "id", "BOLO", "bolos", changes, archives);
  const warrants = deduplicate(data.warrants, "id", "warrant", "warrants", changes, archives);
  const transmissions = deduplicate(data.transmissions, "id", "transmission", "transmissions", changes, archives);
  const units = deduplicate(
    deduplicate(data.units, "discordUserId", "unit Discord user", "units", changes, archives),
    "callsign",
    "unit callsign",
    "units",
    changes,
    archives,
  );
  const callIds = new Set(calls.map((call) => call.id));
  const boloIds = new Set(bolos.map((bolo) => bolo.id));
  const warrantIds = new Set(warrants.map((warrant) => warrant.id));

  for (const unit of units) {
    if (unit.assignedCallId && !callIds.has(unit.assignedCallId)) {
      changes.push(`Cleared missing call ${unit.assignedCallId} from unit ${unit.callsign}.`);
      unit.lastActiveCallId ??= unit.assignedCallId;
      unit.assignedCallId = null;
      unit.responseStatus = "UNASSIGNED";
      unit.responseMode = null;
      unit.sceneRole = null;
    } else if (!unit.assignedCallId && ASSIGNED_RESPONSE_STATUSES.has(unit.responseStatus)) {
      changes.push(`Reset orphaned response status for unit ${unit.callsign}.`);
      unit.responseStatus = "UNASSIGNED";
      unit.responseMode = null;
      unit.sceneRole = null;
    }
  }
  for (const call of calls) {
    call.relatedCallIds = filteredReferences(
      call.relatedCallIds,
      callIds,
      call.id,
      `related calls on ${call.id}`,
      changes,
    );
    call.boloIds = filteredReferences(call.boloIds, boloIds, null, `BOLOs on ${call.id}`, changes);
    call.warrantIds = filteredReferences(call.warrantIds, warrantIds, null, `warrants on ${call.id}`, changes);
    call.assignedUnits = unique(call.assignedUnits);
    call.requestedResources = unique(call.requestedResources);
    call.stagedResources = unique(call.stagedResources);
    call.sourceExternalIds = unique(call.sourceExternalIds);
  }
  for (const record of [...bolos, ...warrants]) {
    if (record.callId && !callIds.has(record.callId)) {
      changes.push(`Cleared missing call ${record.callId} from ${record.id}.`);
      record.callId = null;
    }
  }
  return { data: { ...data, units, calls, transmissions, bolos, warrants, archives }, changes };
}

function reportDuplicateKeys(records, key, label, issues) {
  const seen = new Set();
  for (const record of records) {
    const value = String(record[key]).toUpperCase();
    if (seen.has(value)) issues.push(`Duplicate ${label} ${record[key]}.`);
    seen.add(value);
  }
}

function deduplicate(records, key, label, dataset, changes, archives) {
  const merged = new Map();
  for (const record of records) {
    const identity = String(record[key]).toUpperCase();
    if (!merged.has(identity)) merged.set(identity, structuredClone(record));
    else {
      const existing = merged.get(identity);
      merged.set(identity, mergeRecords(existing, record));
      const archiveId = `${dataset}:${key}:${identity}:${archives.length + 1}`;
      archives.push({
        id: archiveId,
        dataset,
        identity,
        reason: `Superseded duplicate ${label}; merged into the canonical active record.`,
        archivedAt: new Date().toISOString(),
        record: structuredClone(existing),
      });
      changes.push(`Archived and merged duplicate ${label} ${record[key]}.`);
    }
  }
  return [...merged.values()];
}

function mergeRecords(older, newer) {
  const merged = { ...older };
  for (const [key, value] of Object.entries(newer)) {
    if (Array.isArray(value)) merged[key] = unique([...(Array.isArray(merged[key]) ? merged[key] : []), ...value]);
    else if (value !== null && value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}

function filteredReferences(values, allowed, excluded, label, changes) {
  const filtered = unique(values).filter((value) => allowed.has(value) && value !== excluded);
  if (filtered.length !== values.length) changes.push(`Removed invalid or duplicate ${label}.`);
  return filtered;
}

function unique(values) {
  return [...new Set(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))))].map(
    (value) => {
      if (typeof value !== "string" || !value.startsWith("{")) return value;
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    },
  );
}
