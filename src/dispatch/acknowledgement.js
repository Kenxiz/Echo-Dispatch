import { speakCallsign, speakPlate } from "../utils/radio.js";
import { formatResource, joinWords, numberWord, withIndefiniteArticle } from "../utils/format.js";

export function buildOfficerAcknowledgement(unit, interpretation, context, call) {
  const ambiguous = context.failedActions.find(
    (item) => item.action === "create_or_match_call" && item.reason.startsWith("Multiple plausible active calls:"),
  );
  if (ambiguous)
    return `${speakCallsign(unit.callsign)}, ${ambiguous.reason.replace("Multiple plausible active calls:", "are you referring to").replace(". Confirm which incident.", "?")}`;
  const parts = [];
  const actionSucceeded = (prefix) =>
    context.actionResults.some((result) => result.ok && result.action.startsWith(prefix));
  const completedCodes = interpretation.codeOperations.filter(
    (operation) => !operation.negated && actionSucceeded(`radio_code:${operation.code}:`),
  );
  for (const operation of completedCodes.filter((operation) => operation.action === "SET_UNIT_STATUS"))
    parts.push(`You're ${operation.code}`);
  for (const operation of completedCodes.filter((operation) => operation.action === "SET_UNIT_ACTIVITY"))
    parts.push(`Active ${operation.code}, ${operation.meaning}`);
  for (const operation of completedCodes.filter((operation) => operation.action === "SET_RESPONSE_MODE"))
    parts.push(`${operation.code} response set`);
  appendIncidentReadback(parts, interpretation);
  if (context.boloMatches?.[0]) parts.push(boloMatchAdvisory(context.boloMatches[0]));
  appendResourceReadback(parts, interpretation, actionSucceeded);
  appendSceneReadback(parts, interpretation, context, actionSucceeded);
  appendInformationReadback(parts, context);
  if (interpretation.contextAction && actionSucceeded("context:"))
    parts.push(
      interpretation.contextAction === "CLOSE_LAST"
        ? "the last unresolved call is closed"
        : `you're attached to ${context.selectedCallId}`,
    );
  if (interpretation.bolo)
    parts.push(
      context.failedActions.some((item) => item.action.startsWith("bolo:"))
        ? "the BOLO action could not be completed"
        : `the ${interpretation.bolo.type.toLowerCase()} BOLO ${interpretation.bolo.operation === "CANCEL" ? "is cancelled" : interpretation.bolo.operation === "UPDATE" ? "is updated" : "has been issued"}`,
    );
  if (interpretation.warrant)
    parts.push(
      context.failedActions.some((item) => item.action.startsWith("warrant:"))
        ? "the warrant action was not authorized"
        : `the warrant ${interpretation.warrant.operation === "CLEAR" ? "is cleared" : interpretation.warrant.operation === "QUERY" ? "status was checked" : "has been entered"}`,
    );
  if (interpretation.pursuit)
    parts.push(
      interpretation.pursuit.active
        ? "pursuit traffic logged; supervisor and nearby-unit options prepared"
        : "pursuit terminated",
    );
  if (interpretation.unknownCodes.length)
    parts.push(
      `I do not have a definition for ${joinWords(interpretation.unknownCodes)} in the active agency codebook; 10-9 only that portion`,
    );
  if (!parts.length && call) parts.push(`update added to ${call.id}`);
  const failed = context.failedActions.filter((item) => !item.action.startsWith("warrant:"));
  if (failed.length)
    parts.push(`${failed.length} action${failed.length === 1 ? "" : "s"} could not be completed; details are logged`);
  return `${speakCallsign(unit.callsign)}, copy. ${parts.join(". ")}.`.replace(/\.\./g, ".");
}

function appendIncidentReadback(parts, interpretation) {
  if (interpretation.unitUpdates.status === "ON_SCENE")
    parts.push(
      `You're 10-23${interpretation.unitUpdates.location ? ` at ${interpretation.unitUpdates.location}` : ""}${interpretation.incident ? ` with ${withIndefiniteArticle(interpretation.incident.description.toLowerCase())}` : ""}`,
    );
  else if (interpretation.incident)
    parts.push(
      `You're logged with ${withIndefiniteArticle(interpretation.incident.description.toLowerCase())}${interpretation.incident.location ? ` at ${interpretation.incident.location}` : ""}`,
    );
}

function appendResourceReadback(parts, interpretation, actionSucceeded) {
  const successful = interpretation.resources.filter((item) =>
    actionSucceeded(`request_resource:${item.resourceType}`),
  );
  const law = successful.find((item) => item.resourceType === "LAW_ENFORCEMENT");
  if (law)
    parts.push(
      `${numberWord(law.quantity)} additional ${law.quantity === 1 ? "unit" : "units"} requested${law.purpose === "TRAFFIC_CONTROL" ? " for traffic control" : ""}`,
    );
  const named = successful
    .filter((item) => item.resourceType !== "LAW_ENFORCEMENT")
    .map((item) => formatResource(item.resourceType));
  if (named.length)
    parts.push(
      `${joinWords(named)} ${named.length === 1 ? "has" : "have"} been requested${successful.some((item) => item.disposition === "STAGE") ? " to stage" : ""}`,
    );
  if (interpretation.resourceIntent?.additionalUnits === "NEGATIVE") parts.push("no additional units requested");
  const cancelled = interpretation.resourceCancellations
    .filter((resource) => actionSucceeded(`cancel_resource:${resource}`))
    .map(formatResource);
  if (cancelled.length) parts.push(`${joinWords(cancelled)} cancelled`);
}

function appendSceneReadback(parts, interpretation, context, actionSucceeded) {
  if (interpretation.sceneResolution && actionSucceeded("scene_resolution:")) {
    const resolution = context.effectiveSceneResolution ?? interpretation.sceneResolution;
    if (resolution === "CLOSE_ALL") parts.push("the call is closed and all attached units are 10-8");
    else if (resolution === "CLEAR_SELF") parts.push("you're clear; other assigned units remain");
    else if (resolution === "RELEASE_BACKUP") parts.push("the scene is Code 4; backup units are released");
    else parts.push("the scene is Code 4 and you remain attached");
  }
  if (interpretation.felonyStop && actionSucceeded("upgrade_felony_stop"))
    parts.push("felony-stop traffic; Priority One, backup responds Code 3");
}

function appendInformationReadback(parts, context) {
  const information = context.informationResult;
  if (information?.type === "CALL_LOCATION") parts.push(`${information.callId} is at ${information.value}`);
  else if (information?.type === "UNIT_LOCATION") parts.push(`your location is ${information.value}`);
  else if (information?.type === "ACTIVE_BOLOS") parts.push(activeBoloReadback(information.bolos));
  else if (information?.type === "PLATE_CHECK") {
    if (!information.plate?.knownCharacters) parts.push("10-9 the plate characters");
    else if (!(information.boloMatches?.length || information.warrantMatches?.length))
      parts.push(
        `Plate ${speakPlate(information.plate.knownCharacters)} has no active local BOLO or warrant match; a verified registration return is unavailable because no records provider is configured`,
      );
    else {
      if (information.warrantMatches?.length)
        parts.push(
          `plate ${speakPlate(information.plate.knownCharacters)} matches active warrant ${information.warrantMatches[0].id}; use caution`,
        );
      parts.push("A verified registration return is unavailable because no records provider is configured");
    }
  } else if (information) parts.push(String(information.value).replace(/\.$/, ""));
}

function boloMatchAdvisory(match) {
  const bolo = match.bolo;
  const knownPlate = bolo.plate?.knownCharacters || bolo.plate?.normalizedPattern?.replaceAll("*", "");
  const plate = knownPlate
    ? ` for ${bolo.plate.plateType === "FULL" ? "plate" : "a partial plate beginning with"} ${spokenBoloPlate(bolo.plate)}`
    : "";
  const caution = bolo.threatInformation ? ` Caution: ${bolo.threatInformation}.` : "";
  return `Possible BOLO match, ${bolo.id}. Vehicle matches an active BOLO${plate}.${caution} Use caution and advise your status`;
}

function activeBoloReadback(bolos = []) {
  if (!bolos.length) return "There are no active BOLOs";
  const summaries = bolos.slice(0, 3).map(formatBoloSummary);
  const remainder =
    bolos.length > summaries.length
      ? `; ${bolos.length - summaries.length} additional active BOLO${bolos.length - summaries.length === 1 ? "" : "s"} in CAD`
      : "";
  return `${bolos.length === 1 ? "One active BOLO" : `${bolos.length} active BOLOs`}: ${summaries.join("; ")}${remainder}`;
}

function formatBoloSummary(bolo) {
  const subject =
    bolo.type === "VEHICLE"
      ? [
          bolo.color,
          bolo.doors ? `${bolo.doors}-door` : null,
          bolo.make,
          bolo.model,
          bolo.vehicleType ?? (!bolo.make && !bolo.model ? "vehicle" : null),
        ]
          .filter(Boolean)
          .join(" ")
      : [bolo.race, bolo.sex, bolo.nameOrAlias ?? "subject"].filter(Boolean).join(" ");
  const plate = bolo.plate?.knownCharacters
    ? `, ${bolo.plate.plateType === "FULL" ? "plate" : "partial plate"} ${speakPlate(bolo.plate.knownCharacters)}`
    : "";
  const direction = bolo.directionOfTravel
    ? `, last seen ${bolo.directionOfTravel}${bolo.lastKnownLocation ? ` on ${bolo.lastKnownLocation}` : ""}`
    : bolo.lastKnownLocation
      ? `, last seen at ${bolo.lastKnownLocation}`
      : "";
  const caution = bolo.threatInformation ? `, caution ${bolo.threatInformation}` : "";
  return `${bolo.id}, ${subject || bolo.type.toLowerCase()}${plate}${direction}${caution}`;
}

function spokenBoloPlate(plate) {
  const original = plate.rawTranscript
    .replace(/^.*?\b(?:plate|tag)\b[, ]*/i, "")
    .replace(/^partial\s+/i, "")
    .replace(/^(?:starts?|begins?|beginning)\s+(?:with\s+)?/i, "")
    .trim();
  return original && !/\b(?:unknown|unreadable|remaining|or)\b/i.test(original)
    ? original.replaceAll("-", " ")
    : speakPlate(plate.knownCharacters || plate.normalizedPattern.replaceAll("*", ""));
}
