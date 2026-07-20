const SAFETY_ONE =
  /\b(?:shots?|gunfire|weapon|gun|knife|officer down|officer needs help|bleeding|can't breathe|cannot breathe|not breathing|taking fire|started shooting|hostage|active shooter)\b/i;
const SAFETY_TWO = /\b(?:pursuit|fleeing|losing him|fight|domestic|burglary in progress|felony stop|injur(?:y|ed))\b/i;

export function recommendedPriority(text, currentPriority = 3) {
  if (SAFETY_ONE.test(text)) return Math.min(currentPriority, 1);
  if (SAFETY_TWO.test(text)) return Math.min(currentPriority, 2);
  return currentPriority;
}

export function defaultStaging(call) {
  const text = `${call.incident} ${call.description} ${call.weaponInfo ?? ""}`;
  if (
    call.priority === 1 &&
    /\b(?:shots?|gunfire|weapon|active shooter|fire|explosion|major crash|officer down)\b/i.test(text)
  )
    return ["EMS", "FIRE"];
  return [];
}

export function findMergeCandidate(calls, input, windowMs = 600_000, now = Date.now()) {
  const location = normalize(input.location);
  const incidentTokens = tokenSet(`${input.incident} ${input.description}`);
  return calls.find((call) => {
    if (now - new Date(call.createdAt).getTime() > windowMs) return false;
    const existingLocation = normalize(call.location);
    const locationMatch =
      location &&
      (location === existingLocation || location.includes(existingLocation) || existingLocation.includes(location));
    if (!locationMatch) return false;
    const existingTokens = tokenSet(`${call.incident} ${call.description}`);
    const overlap = [...incidentTokens].filter((token) => existingTokens.has(token)).length;
    return (
      overlap >= 1 ||
      relatedIncidentPair(`${input.incident} ${input.description}`, `${call.incident} ${call.description}`)
    );
  });
}

export function recommendUnits(call, units, limit = 3) {
  return units
    .filter((unit) => unit.active && unit.status === "AVAILABLE" && !unit.assignedCallId)
    .map((unit) => ({
      callsign: unit.callsign,
      etaSeconds: estimateEtaSeconds(unit.location, call.location),
      reason: unit.location ? `Available near ${unit.location}` : "Available; location not reported",
    }))
    .sort((a, b) => (a.etaSeconds ?? 9_999) - (b.etaSeconds ?? 9_999) || a.callsign.localeCompare(b.callsign))
    .slice(0, limit);
}

export function estimateEtaSeconds(from, to) {
  if (!from || !to) return null;
  if (normalize(from) === normalize(to)) return 12;
  const fromPostal = parsePostal(from);
  const toPostal = parsePostal(to);
  if (fromPostal !== null && toPostal !== null) return Math.min(300, 18 + Math.abs(fromPostal - toPostal) * 3);
  const fromCoordinates = parseCoordinates(from);
  const toCoordinates = parseCoordinates(to);
  if (fromCoordinates && toCoordinates) {
    const distance = Math.hypot(fromCoordinates[0] - toCoordinates[0], fromCoordinates[1] - toCoordinates[1]);
    return Math.min(600, Math.max(10, Math.round(distance / 30)));
  }
  return null;
}

export function buildHeatmap(calls) {
  const buckets = new Map();
  for (const call of calls) {
    const key = call.location.trim() || "Unknown";
    const current = buckets.get(key) ?? { location: key, calls: 0, pursuits: 0, crashes: 0, robberies: 0 };
    current.calls += 1;
    const text = `${call.incident} ${call.description}`;
    if (/pursuit|10-43/i.test(text)) current.pursuits += 1;
    if (/crash|collision|accident|10-50/i.test(text)) current.crashes += 1;
    if (/robbery|10-65/i.test(text)) current.robberies += 1;
    buckets.set(key, current);
  }
  return [...buckets.values()].sort((a, b) => b.calls - a.calls).slice(0, 10);
}

export function buildShiftStatistics(calls, transmissions, units, since) {
  const after = (timestamp) => !since || new Date(timestamp).getTime() >= new Date(since).getTime();
  const shiftCalls = calls.filter((call) => after(call.createdAt));
  const shiftTraffic = transmissions.filter((item) => after(item.timestamp));
  const counts = new Map();
  for (const item of shiftTraffic) if (item.callsign) counts.set(item.callsign, (counts.get(item.callsign) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const closed = shiftCalls.filter((call) => call.closedAt);
  const longest = closed.sort((a, b) => duration(b) - duration(a))[0];
  const responseTimes = shiftCalls.flatMap((call) => {
    const attached = call.timeline.find((event) => event.type === "UNIT_ATTACHED");
    return attached ? [Math.max(0, (new Date(attached.timestamp) - new Date(call.createdAt)) / 1000)] : [];
  });
  return {
    transmissions: shiftTraffic.length,
    calls: shiftCalls.length,
    priorityOne: shiftCalls.filter((call) => call.priority === 1).length,
    averageResponseSeconds: responseTimes.length
      ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
      : null,
    busiestUnit: busiest ? `${busiest[0]} (${busiest[1]} transmissions)` : "None",
    longestCall: longest ? `${longest.id} (${Math.round(duration(longest) / 60_000)} minutes)` : "None",
    activeUnits: units.filter((unit) => unit.active).length,
  };
}

function duration(call) {
  return new Date(call.closedAt) - new Date(call.createdAt);
}
function parsePostal(value) {
  const match = value.match(/\b(?:postal\s*)?(\d{2,5})\b/i);
  return match ? Number(match[1]) : null;
}
function parseCoordinates(value) {
  const values = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  return values?.length >= 2 ? values.slice(0, 2) : null;
}
function normalize(value = "") {
  return value
    .toLowerCase()
    .replace(/\b(?:the|at|near|postal)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function tokenSet(value) {
  return new Set(
    normalize(value)
      .split(" ")
      .filter(
        (token) => token.length > 3 && !["caller", "reports", "reported", "emergency", "incident"].includes(token),
      ),
  );
}
function relatedIncidentPair(left, right) {
  const relationships = [
    [/robbery/i, /fleeing vehicle|vehicle bolo/i],
    [/hit and run/i, /vehicle bolo|fleeing vehicle/i],
    [/shots? fired/i, /injured person|gunshot wound/i],
    [/stolen vehicle/i, /pursuit/i],
    [/missing person/i, /located subject/i],
  ];
  return relationships.some(
    ([first, second]) => (first.test(left) && second.test(right)) || (second.test(left) && first.test(right)),
  );
}
