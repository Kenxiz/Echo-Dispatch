import { defaultStaging, recommendUnits } from "./cad-intelligence.js";

export function buildCallRecord(input, { id, availableUnits = [], timestamp = new Date().toISOString() }) {
  const priority = Math.min(3, Math.max(1, input.priority ?? 2));
  const call = {
    id,
    source: input.source,
    sourceExternalId: input.sourceExternalId ?? null,
    incident: input.incident.trim(),
    radioCode: input.radioCode ?? null,
    location: input.location.trim(),
    description: input.description.trim(),
    suspectInfo: input.suspectInfo?.trim() || null,
    vehicleInfo: input.vehicleInfo?.trim() || null,
    weaponInfo: input.weaponInfo?.trim() || null,
    injuryInfo: input.injuryInfo?.trim() || null,
    priority,
    prioritySource: input.prioritySource ?? "MANUAL",
    priorityReason: input.priorityReason?.trim() || null,
    status: "AWAITING_UNIT",
    sceneStatus: "UNKNOWN",
    responseMode: input.responseMode ?? defaultResponseMode(priority),
    stopType: input.stopType ?? (input.incident.toLowerCase().includes("traffic stop") ? "ROUTINE_STOP" : null),
    riskLevel: input.riskLevel ?? "NORMAL",
    backupStatus: input.backupStatus ?? "NOT_NEEDED",
    assignedUnits: [],
    requestedResources: [],
    resourceRequests: [],
    stagedResources: [],
    operationalPlan: [],
    supervisorRecommendations: buildSupervisorRecommendations(input, priority),
    relatedCallIds: input.relatedCallIds ?? [],
    boloIds: [],
    boloRelated: false,
    officerSafetyLevel: "NORMAL",
    backupRecommended: false,
    boloMatches: [],
    observedPlates: [],
    vehicleObservations: [],
    warrantIds: [],
    pursuit: null,
    unitRoles: {},
    recommendedUnits: [],
    callerCount: 1,
    sourceExternalIds: input.sourceExternalId ? [input.sourceExternalId] : [],
    timeline: [{ timestamp, type: "CALL_CREATED", actor: null, text: `Call created as Priority ${priority}.` }],
    lastActivityAt: timestamp,
    watchdogLevel: 0,
    notes: [],
    createdAt: timestamp,
    closedAt: null,
    messageId: null,
    logMessageId: null,
    reannounced: false,
  };
  call.stagedResources = defaultStaging(call);
  call.recommendedUnits = recommendUnits(call, availableUnits);
  return call;
}

export function defaultResponseMode(priority) {
  return priority === 1 ? "CODE_3" : priority === 3 ? "CODE_1" : "CODE_2";
}

export function buildSupervisorRecommendations(input, priority) {
  const text = `${input.incident} ${input.description}`;
  const recommendations = [];
  if (priority === 1 || /\b(?:pursuit|felony stop|swat|barricad|hostage|officer down)\b/i.test(text))
    recommendations.push("Assign a supervisor and establish incident command.");
  if (/\b(?:pursuit|fleeing)\b/i.test(text))
    recommendations.push("Confirm pursuit policy factors, traffic conditions, and termination authority.");
  if (/\b(?:armed|weapon|shots? fired|barricad|hostage)\b/i.test(text))
    recommendations.push("Coordinate a safe perimeter and staging location before committing specialty resources.");
  return recommendations;
}
