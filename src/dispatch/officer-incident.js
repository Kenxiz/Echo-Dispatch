import { z } from "zod";
import { fallbackCallPriority } from "../ai/call-triage.js";

const TRAFFIC_STOP_PATTERN =
  /\b(?:traffic stop|stopping (?:a|the) vehicle|vehicle stop|felony stop|10[ -]?61|1061|show me on\s+(?:a\s+)?(?:10[ -]?11|18[ -]?11|1811))\b/i;

const INCIDENTS = [
  [
    "Motor Vehicle Accident",
    "MOTOR_VEHICLE_ACCIDENT",
    /\b(?:motor vehicle accident|mva|vehicle accident|traffic (?:accident|collision)|crash|collision)\b/i,
  ],
  ["Traffic Stop", "TRAFFIC_STOP", TRAFFIC_STOP_PATTERN],
  ["Disabled Vehicle", "DISABLED_VEHICLE", /\b(?:disabled|stranded) (?:motorist|vehicle)\b/i],
  ["Suspicious Person", "SUSPICIOUS_PERSON", /\b(?:suspicious (?:person|subject)|prowler)\b/i],
  ["Suspicious Vehicle", "SUSPICIOUS_VEHICLE", /\bsuspicious vehicle\b/i],
  ["Domestic Disturbance", "DOMESTIC_DISTURBANCE", /\b(?:domestic|family) (?:incident|disturbance|dispute|fight)\b/i],
  ["Disturbance", "DISTURBANCE", /\b(?:disturbance|disorderly subject)\b/i],
  ["Fight", "FIGHT", /\b(?:fight|subjects fighting)\b/i],
  ["Vehicle Pursuit", "PURSUIT", /\b(?:vehicle pursuit|pursuit|failing to stop|felony evasion)\b/i],
  ["Shots Fired", "SHOTS_FIRED", /\b(?:shots? fired|gunfire)\b/i],
  ["Robbery", "ROBBERY", /\b(?:armed )?robbery\b/i],
  ["Vehicle Theft", "VEHICLE_THEFT", /\b(?:vehicle theft|stolen vehicle|auto theft)\b/i],
  ["Wanted Person", "WANTED_PERSON", /\bwanted (?:person|subject)\b/i],
  ["Reckless Driver", "RECKLESS_DRIVER", /\b(?:reckless driver|reckless vehicle|dangerous driver)\b/i],
  [
    "Medical Emergency",
    "MEDICAL_EMERGENCY",
    /\b(?:medical emergency|unconscious|not breathing|overdose|serious injur)\b/i,
  ],
  ["Structure Fire", "FIRE", /\b(?:structure fire|building fire|vehicle fire|fire reported)\b/i],
  [
    "Road Hazard",
    "ROAD_HAZARD",
    /\b(?:road hazard|roadway blocked|debris in (?:the )?road|tree down|traffic hazard)\b/i,
  ],
  [
    "Officer-Initiated Investigation",
    "INVESTIGATION",
    /\b(?:investigating|flagged down|out with|checking out|building check)\b/i,
  ],
];

const NEW_INCIDENT_CUE =
  /\b(?:show me (?:on scene(?: of)?|out(?: with)?|investigating|on\s+(?:a\s+)?(?:10[ -]?11|18[ -]?11|1811))|i(?:'m| am) on scene of|i have (?:a|an)|be advised[, ]+(?:i have|we have)|start(?:ing)? (?:me )?(?:a call|a traffic stop)|out with (?:a|an|the)|being flagged down for)\b/i;
const DIRECTIONS =
  /\b(northbound|southbound|eastbound|westbound|heading north|heading south|heading east|heading west)\b/i;
const COLORS = /\b(black|white|red|blue|silver|gray|grey|green|yellow|orange|brown|tan|gold|purple|maroon)\b/i;

const resourceSchema = z.object({
  resourceType: z.string(),
  quantity: z.number().int().min(1).max(20),
  purpose: z.string(),
  responseMode: z.enum(["CODE_1", "CODE_2", "CODE_3"]),
  disposition: z.enum(["RESPOND", "STAGE"]),
});
const interpretationSchema = z.object({
  classification: z.enum([
    "ROUTINE_TRAFFIC",
    "UNIT_OPERATION",
    "INFORMATION_REQUEST",
    "SCENE_RESOLUTION",
    "FELONY_STOP",
    "OFFICER_INITIATED_INCIDENT",
    "INCIDENT_FOLLOW_UP",
    "BOLO_ACTION",
    "WARRANT_ACTION",
    "PURSUIT_UPDATE",
  ]),
  normalizedTranscript: z.string(),
  incident: z
    .object({
      type: z.string(),
      code: z.string(),
      radioCode: z.string().nullable().default(null),
      description: z.string(),
      location: z.string().nullable(),
      priority: z.number().int().min(1).max(3),
      responseCode: z.number().int().min(1).max(3),
    })
    .nullable(),
  unitUpdates: z.object({ status: z.string().nullable(), location: z.string().nullable() }),
  resourceIntent: z.object({
    additionalUnits: z.enum(["AFFIRMATIVE", "NEGATIVE", "NONE"]),
    quantity: z.number().int().min(1).max(20).nullable(),
  }),
  resources: z.array(resourceSchema),
  resourceCancellations: z.array(z.string()).default([]),
  notes: z.array(z.string()),
  bolo: z.record(z.string(), z.unknown()).nullable(),
  warrant: z.record(z.string(), z.unknown()).nullable(),
  pursuit: z.record(z.string(), z.unknown()).nullable(),
  vehicleObservation: z.record(z.string(), z.unknown()).nullable(),
  codeOperations: z.array(z.record(z.string(), z.unknown())).default([]),
  unknownCodes: z.array(z.string()).default([]),
  sceneResolution: z
    .enum(["SCENE_SECURE", "SCENE_SECURE_KEEP_ATTACHED", "CLOSE_ALL", "CLEAR_SELF", "RELEASE_BACKUP"])
    .nullable()
    .default(null),
  felonyStop: z.boolean().default(false),
  informationRequest: z.string().nullable().default(null),
  contextAction: z.enum(["ATTACH_ACTIVE", "ATTACH_LAST", "CLOSE_LAST"]).nullable().default(null),
  normalization: z.record(z.string(), z.unknown()).nullable().default(null),
  confidence: z.number().min(0).max(1),
});

export function interpretOfficerTransmission(transcript, unit, codebook = null, suppliedNormalization = null) {
  const rawOriginal = String(suppliedNormalization?.rawTranscript ?? transcript ?? "").trim();
  const raw = String(suppliedNormalization?.normalizedTraffic ?? transcript ?? "").trim();
  const incidentMatch = INCIDENTS.find(
    ([, code, pattern]) =>
      pattern.test(raw) &&
      !(code === "VEHICLE_THEFT" && /\b(?:not stolen|negative stolen|no stolen vehicle)\b/i.test(raw)),
  );
  const hasNewCue = NEW_INCIDENT_CUE.test(raw);
  const location = extractLocation(raw);
  let incident = incidentMatch ? buildIncident(raw, incidentMatch, location) : null;
  const detectedDefinitions = suppliedNormalization?.codesDetected ?? codebook?.detect(raw) ?? [];
  const codeOperations = deriveCodeOperations(detectedDefinitions, raw);
  const configuredIncident = detectedDefinitions.find(
    (match) =>
      ["INCIDENT", "OFFICER_SAFETY"].includes(match.definition.category) &&
      match.definition.action === "CREATE_OR_UPDATE_CALL" &&
      !(match.definition.code === "10-75" && /\b(?:not stolen|negative stolen|no stolen vehicle)\b/i.test(raw)),
  );
  if (!incident && configuredIncident) incident = buildConfiguredIncident(configuredIncident.definition, location);
  const resourceIntent = parseAdditionalUnitIntent(raw);
  const resources = parseResources(raw, incident?.responseCode ?? 2);
  const resourceCancellations = parseResourceCancellations(raw);
  const bolo = parseBolo(raw);
  const warrant = parseWarrant(raw);
  if ((bolo || warrant) && !hasNewCue) incident = null;
  const pursuit = parsePursuit(raw, location);
  const vehicleObservation = parseVehicleObservation(rawOriginal, location);
  const sceneResolution = parseSceneResolution(raw, detectedDefinitions);
  const felonyStop =
    codeOperations.some((operation) => operation.action === "UPGRADE_FELONY_STOP") ||
    /\b(?:felony|high[ -]risk|armed vehicle) stop\b|\bvehicle extraction\b/i.test(raw);
  if (felonyStop && !incident)
    incident = {
      type: "Traffic Stop",
      code: "TRAFFIC_STOP",
      radioCode:
        detectedDefinitions.find((match) => match.definition.action === "UPGRADE_FELONY_STOP")?.code ?? "Code 5",
      description: "Felony Stop",
      location,
      priority: 1,
      responseCode: 3,
    };
  const informationRequest = parseInformationRequest(raw, codeOperations);
  const contextAction = /\battach me to (?:the )?active call\b/i.test(raw)
    ? "ATTACH_ACTIVE"
    : /\battach me to (?:the )?(?:last|that) call\b/i.test(raw)
      ? "ATTACH_LAST"
      : /\bclose (?:the )?last call\b/i.test(raw)
        ? "CLOSE_LAST"
        : null;
  const followUp =
    !hasNewCue &&
    Boolean(unit?.assignedCallId) &&
    /\b(?:add that|update|be advised|vehicle one|suspect|subject|driver|plate|last seen|now|also|further)\b/i.test(raw);
  const urgentIncident = ["SHOTS_FIRED", "ROBBERY", "MEDICAL_EMERGENCY", "FIRE"].includes(incident?.code);
  let classification = "ROUTINE_TRAFFIC";
  if (sceneResolution) classification = "SCENE_RESOLUTION";
  else if (felonyStop && unit?.assignedCallId) classification = "FELONY_STOP";
  else if ((hasNewCue || configuredIncident?.definition.createsCall || felonyStop || urgentIncident) && incident)
    classification = "OFFICER_INITIATED_INCIDENT";
  else if (warrant) classification = "WARRANT_ACTION";
  else if (bolo) classification = "BOLO_ACTION";
  else if (pursuit) classification = "PURSUIT_UPDATE";
  else if (followUp || (unit?.assignedCallId && (resources.length || incident))) classification = "INCIDENT_FOLLOW_UP";
  else if (informationRequest) classification = "INFORMATION_REQUEST";
  else if (contextAction) classification = "UNIT_OPERATION";
  else if (codeOperations.length) classification = "UNIT_OPERATION";

  return interpretationSchema.parse({
    classification,
    normalizedTranscript:
      suppliedNormalization?.normalizedTranscript ?? (unit?.callsign ? `[${unit.callsign}] ${raw}` : raw),
    incident,
    unitUpdates: {
      status: /\b(?:on scene|10\s*-?\s*23)\b/i.test(raw)
        ? "ON_SCENE"
        : /\b(?:en route|10\s*-?\s*17)\b/i.test(raw)
          ? "EN_ROUTE"
          : incident?.code === "TRAFFIC_STOP"
            ? "TRAFFIC_STOP"
            : pursuit
              ? "PURSUIT"
              : null,
      location,
    },
    resourceIntent,
    resources,
    resourceCancellations,
    notes: classification === "ROUTINE_TRAFFIC" ? [] : [rawOriginal],
    bolo,
    warrant,
    pursuit,
    vehicleObservation,
    codeOperations,
    unknownCodes: suppliedNormalization?.unknownCodes ?? [],
    sceneResolution,
    felonyStop,
    informationRequest,
    contextAction,
    normalization: suppliedNormalization,
    confidence:
      incident || bolo || warrant || pursuit || informationRequest
        ? 0.97
        : followUp || resources.length || codeOperations.length
          ? 0.9
          : 0.35,
  });
}

function deriveCodeOperations(detected, text) {
  return detected
    .map((match) => match.definition)
    .filter((definition) => definition.action)
    .map((definition) => ({
      code: definition.code,
      meaning: definition.meaning,
      category: definition.category,
      action: definition.action,
      value: definition.actionValue,
      priority: definition.priority,
      responseCode: definition.responseCode,
      negated: isCodeNegated(text, definition.code),
    }));
}
function isCodeNegated(text, code) {
  return new RegExp(
    `\\b(?:no|negative|disregard|cancel|do not|don't)\\b[^,.!?;]{0,40}${escapePattern(code).replace("-", "[ -]?")}`,
    "i",
  ).test(text);
}
function buildConfiguredIncident(definition, location) {
  const priority = definition.priority ?? 2;
  return {
    type: definition.meaning,
    code: definition.actionValue ?? definition.code.replace(/[^A-Z0-9]+/gi, "_"),
    radioCode: definition.code,
    description: definition.meaning,
    location,
    priority,
    responseCode: definition.responseCode ?? (priority === 1 ? 3 : priority === 3 ? 1 : 2),
  };
}
function parseInformationRequest(text, operations) {
  const configured = operations.find(
    (operation) => operation.action === "REQUEST_INFORMATION" && !operation.negated,
  )?.value;
  if (configured) return configured;
  if (
    /\b(?:(?:are there|do we have|advise|list|check for|show me)\s+(?:any\s+)?active\s+bolos?|any\s+active\s+bolos?|active\s+bolos?\s+(?:check|status))\b/i.test(
      text,
    )
  )
    return "ACTIVE_BOLOS";
  if (
    /\b(?:repeat|read back|what(?:'s| is))\s+(?:the )?(?:last |call )?location\b|\bwhere is (?:that|the|my) call\b/i.test(
      text,
    )
  )
    return "CALL_LOCATION";
  if (
    /\b(?:(?:run|check) (?:the )?(?:plate|registration|registered owner)|(?:request(?:ing)?\s+)?(?:a\s+)?(?:plate|registration) check)\b/i.test(
      text,
    )
  )
    return "REGISTRATION";
  if (/\b(?:run|check) (?:the )?(?:driver|license)\b/i.test(text)) return "LICENSE";
  if (/\b(?:check|confirm|run).{0,20}\b(?:wants?|warrants?|record)\b/i.test(text)) return "WARRANT_RECORD";
  return null;
}
function parseSceneResolution(text, detected) {
  const code4 = detected.some((match) => match.definition.action === "RESOLVE_SCENE") || /\bcode\s*4\b/i.test(text);
  if (/\b(?:i(?:'m| am) clear|clear me)\b.*\b(?:other units? remain|keep (?:the )?other units?)\b/i.test(text))
    return "CLEAR_SELF";
  if (/\b(?:all units? (?:can )?clear|clear all units?|close (?:the )?call)\b/i.test(text)) return "CLOSE_ALL";
  if (/\b(?:release|clear) (?:the )?(?:backup|other) units?\b/i.test(text)) return "RELEASE_BACKUP";
  if (code4 && /\b(?:keep me attached|remain attached|i(?:'ll| will) remain)\b/i.test(text))
    return "SCENE_SECURE_KEEP_ATTACHED";
  return code4 ? "SCENE_SECURE" : null;
}

function buildIncident(text, match, location) {
  const [type, code] = match;
  let description = type;
  if (code === "MOTOR_VEHICLE_ACCIDENT") {
    const count = /\b(?:dual|two)[ -]?(?:(?:motor )?vehicle|car)\b/i.test(text)
      ? 2
      : /\bthree[ -]?(?:(?:motor )?vehicle|car)\b/i.test(text)
        ? 3
        : null;
    description = count ? `${count === 2 ? "Two" : "Three"}-vehicle motor vehicle accident` : "Motor vehicle accident";
  }
  const fallback = fallbackCallPriority({ incident: type, description: text, location: location ?? "Unknown" });
  let priority = fallback.priority;
  if (code === "MOTOR_VEHICLE_ACCIDENT") {
    if (/\b(?:entrap|eject|fatal|not breathing|serious injur|vehicle fire|explosion)\b/i.test(text)) priority = 1;
    else if (/\b(?:unknown injur|blocking|traffic control|requesting .*ems|requesting .*fire|fd and ems)\b/i.test(text))
      priority = 2;
    else if (/\b(?:no injur|property damage only|minor)\b/i.test(text)) priority = 3;
  }
  if (code === "TRAFFIC_STOP" && /\b(?:felony stop|armed|wanted violent|fleeing felony)\b/i.test(text)) priority = 1;
  else if (code === "TRAFFIC_STOP") priority = 3;
  if (/\b(?:armed|shots? fired|officer down|taking fire|hostage)\b/i.test(text)) priority = 1;
  return { type, code, description, location, priority, responseCode: priority === 1 ? 3 : priority === 2 ? 2 : 1 };
}

export function parseResources(text, defaultResponseCode = 2) {
  const resources = [];
  const disposition = /\b(?:stage|stand by nearby)\b/i.test(text) ? "STAGE" : "RESPOND";
  const responseMode = `CODE_${Math.max(1, Math.min(3, defaultResponseCode))}`;
  const unitIntent = parseAdditionalUnitIntent(text);
  if (unitIntent.additionalUnits === "AFFIRMATIVE")
    resources.push({
      resourceType: "LAW_ENFORCEMENT",
      quantity: unitIntent.quantity ?? 1,
      purpose: /\btraffic control\b/i.test(text) ? "TRAFFIC_CONTROL" : "BACKUP",
      responseMode,
      disposition,
    });
  addResource(
    resources,
    text,
    "FIRE",
    /\b(?:(?:start|send|request(?:ing)?|need|have)\s+(?:the\s+)?(?:fire department|fire|fd)|requesting\b[^.!?]*\b(?:fire department|fd)|10\s*-?\s*77)\b/i,
    /\b(?:no|negative|cancel|disregard)\b[^.!?]*\b(?:fire department|fire|fd|10\s*-?\s*77)\b/i,
    "INCIDENT_RESPONSE",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "EMS",
    /\b(?:(?:start|send|request(?:ing)?|need|have)\s+(?:an?\s+)?(?:ems|ambulance|medics?)|requesting\b[^.!?]*\b(?:ems|ambulance|medics?)|10\s*-?\s*52)\b/i,
    /\b(?:no|negative|cancel|disregard)\b[^.!?]*\b(?:ems|ambulance|medics?|10\s*-?\s*52)\b/i,
    "MEDICAL_RESPONSE",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "SUPERVISOR",
    /\b(?:send|request(?:ing)?|need|start) (?:a )?(?:supervisor|sergeant)\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\b(?:supervisor|sergeant)\b/i,
    "SUPERVISION",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "COUNTY",
    /\b(?:requesting|send|start) county\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\bcounty\b/i,
    "AGENCY_ASSIST",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "WRECKER",
    /\b(?:(?:request|requesting|send|start|need)\s+(?:a )?(?:tow|wrecker)|have\s+(?:a )?(?:tow|wrecker)\s+(?:respond|stage)|10\s*-?\s*51)\b/i,
    /\b(?:no|negative|cancel|disregard|hold|do not|don't)\b[^.!?]*\b(?:tow|wrecker|10\s*-?\s*51)\b/i,
    "VEHICLE_RECOVERY",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "DOT",
    /\b(?:request|requesting|send|start|need)\s+(?:dot|department of transportation)\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\b(?:dot|department of transportation)\b/i,
    "ROADWAY_CONTROL",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "AIR_SUPPORT",
    /\b(?:request|requesting|send|start|need)\s+(?:air support|aviation|helicopter)\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\b(?:air support|aviation|helicopter)\b/i,
    "AERIAL_SUPPORT",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "K9",
    /\b(?:request|requesting|send|start|need)\s+(?:a )?(?:k-?9|canine)\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\b(?:k-?9|canine)\b/i,
    "K9_SUPPORT",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "SWAT",
    /\b(?:request|requesting|send|start|need)\s+(?:swat|tactical team)\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\b(?:swat|tactical team)\b/i,
    "TACTICAL_RESPONSE",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "NEGOTIATOR",
    /\b(?:request|requesting|send|start|need)\s+(?:a )?negotiator\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\bnegotiator\b/i,
    "CRISIS_NEGOTIATION",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "SPIKE_STRIPS",
    /\b(?:request|requesting|send|start|need|deploy)\s+(?:the )?(?:spike strips?|stop sticks?)\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\b(?:spike strips?|stop sticks?)\b/i,
    "PURSUIT_INTERVENTION",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "ROADBLOCK",
    /\b(?:request|requesting|send|start|need|set up)\s+(?:a )?roadblock\b/i,
    /\b(?:no|cancel|disregard)\b[^.!?]*\broadblock\b/i,
    "PURSUIT_CONTAINMENT",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "CORONER",
    /\b(?:(?:request|requesting|send|start|need|notify)\s+(?:the )?(?:coroner|medical examiner)|10\s*-?\s*66)\b/i,
    /\b(?:no|negative|cancel|disregard|hold|do not|don't)\b[^.!?]*\b(?:coroner|medical examiner|10\s*-?\s*66)\b/i,
    "DEATH_INVESTIGATION",
    responseMode,
    disposition,
  );
  addResource(
    resources,
    text,
    "ANIMAL_CONTROL",
    /\b(?:request|requesting|send|start|need|notify)\s+(?:the )?animal control\b/i,
    /\b(?:no|negative|cancel|disregard|hold|do not|don't)\b[^.!?]*\banimal control\b/i,
    "ANIMAL_CALL",
    responseMode,
    disposition,
  );
  if (/\b(?:send|start|request(?:ing)?|need)\b[^.!?;]*/i.test(text)) {
    addCoordinatedResource(resources, text, "FIRE", /\b(?:fire|fd)\b/i, "INCIDENT_RESPONSE", responseMode, disposition);
    addCoordinatedResource(
      resources,
      text,
      "EMS",
      /\b(?:ems|ambulance|medics?)\b/i,
      "MEDICAL_RESPONSE",
      responseMode,
      disposition,
    );
    addCoordinatedResource(
      resources,
      text,
      "WRECKER",
      /\b(?:tow|wrecker)\b/i,
      "VEHICLE_RECOVERY",
      responseMode,
      disposition,
    );
    addCoordinatedResource(
      resources,
      text,
      "SUPERVISOR",
      /\b(?:supervisor|sergeant)\b/i,
      "SUPERVISION",
      responseMode,
      disposition,
    );
  }
  return resources;
}

function addCoordinatedResource(target, text, resourceType, pattern, purpose, responseMode, disposition) {
  const negative = new RegExp(
    `\\b(?:no|negative|cancel|disregard|hold|do not|don't)\\b[^.!?;]{0,50}${pattern.source}`,
    "i",
  ).test(text);
  if (pattern.test(text) && !negative && !target.some((resource) => resource.resourceType === resourceType))
    target.push({ resourceType, quantity: 1, purpose, responseMode, disposition });
}

export function parseResourceCancellations(text) {
  const source = String(text ?? "");
  const resources = [
    ["LAW_ENFORCEMENT", /\b(?:backup|additional units?|32s?)\b/i],
    ["FIRE", /\b(?:fire|fd)\b/i],
    ["EMS", /\b(?:ems|ambulance|medics?)\b/i],
    ["WRECKER", /\b(?:tow|wrecker)\b/i],
    ["SUPERVISOR", /\b(?:supervisor|sergeant)\b/i],
    ["K9", /\b(?:k-?9|canine)\b/i],
    ["SWAT", /\b(?:swat|tactical team)\b/i],
    ["AIR_SUPPORT", /\b(?:air support|aviation|helicopter)\b/i],
    ["DOT", /\b(?:dot|department of transportation)\b/i],
    ["CORONER", /\b(?:coroner|medical examiner)\b/i],
    ["ANIMAL_CONTROL", /\banimal control\b/i],
  ];
  return resources
    .filter(([, resource]) =>
      new RegExp(`\\b(?:no|negative|disregard|cancel|hold|do not|don't)\\b[^.!?;]{0,50}${resource.source}`, "i").test(
        source,
      ),
    )
    .map(([name]) => name);
}

export function parseAdditionalUnitIntent(text) {
  const value = String(text ?? "");
  const negative =
    /\b(?:no additional units? (?:needed|required)?|no 32s? (?:needed|required)?|negative (?:on )?(?:any )?(?:additional units?|backup|32s?)|disregard (?:the )?(?:backup|additional units?)|no backup (?:needed|required)?|(?:i(?:'m| am)|we(?:'re| are)) good|i do(?:n't| not) need (?:(?:an|any)\s+)?other units?|no further units?|cancel (?:the |any )?(?:backup|additional units?)|hold (?:everyone else|all other units?)|no (?:more|extra) units?)\b/i.test(
      value,
    );
  if (negative) return { additionalUnits: "NEGATIVE", quantity: null };
  const affirmative =
    /\b(?:(?:need|request(?:ing)?|send|start(?: me)?|get|give me|could use|can (?:you )?(?:send|start|get))\s+(?:(?:one|two|three|four|five|\d+)\s+)?(?:an?other|additional|more|extra)?\s*(?:law[- ]enforcement )?(?:unit|units|backup|32s?)|have\s+(?:(?:one|two|three|four|five|\d+)\s+)?(?:an?other|additional|more|extra)?\s*(?:law[- ]enforcement )?units?\s+(?:respond|start|en route)|10\s*-?\s*32)\b/i.exec(
      value,
    );
  if (!affirmative) return { additionalUnits: "NONE", quantity: null };
  return { additionalUnits: "AFFIRMATIVE", quantity: extractQuantity(affirmative[0]) ?? 1 };
}

function addResource(
  target,
  text,
  resourceType,
  affirmativePattern,
  negativePattern,
  purpose,
  responseMode,
  disposition,
) {
  if (affirmativePattern.test(text) && !negativePattern.test(text))
    target.push({ resourceType, quantity: 1, purpose, responseMode, disposition });
}

export function parsePlate(text) {
  const plateContext = extractPlateContext(String(text));
  if (!plateContext) return null;
  const { rawTranscript, characterText, jurisdiction, warnings } = plateContext;
  if (/\btemporary (?:tag|plate)\b/i.test(rawTranscript))
    return plate("TEMPORARY_TAG", jurisdiction, rawTranscript, "TEMP", "", null, 0.99, warnings);
  if (/\b(?:no readable|unreadable) (?:plate|tag)\b/i.test(rawTranscript))
    return plate("UNREADABLE", jurisdiction, rawTranscript, "*", "", null, 0.99, warnings);
  if (/\bno (?:plate|tag)\b/i.test(rawTranscript))
    return plate("NO_PLATE", jurisdiction, rawTranscript, "", "", 0, 0.99, warnings);
  const alternatives = characterText
    .split(/\s+or\s+/i)
    .map(decodePlateCharacters)
    .filter(Boolean);
  if (!alternatives.length || alternatives.some((value) => value.length > 20)) {
    return plate("POSSIBLE", jurisdiction, rawTranscript, "*", "", null, 0.35, [
      ...warnings,
      "Plate characters could not be isolated safely; observation retained as uncertain.",
    ]);
  }
  const knownCharacters = alternatives.length > 1 ? commonPrefix(alternatives) : (alternatives[0] ?? "");
  const plateType =
    /\bpossible\b/i.test(rawTranscript) || alternatives.length > 1
      ? "POSSIBLE"
      : /\bpartial\b|\blast (?:three|four)\b|\bunknown\b/i.test(rawTranscript)
        ? "PARTIAL"
        : "FULL";
  let normalizedPattern = alternatives.length > 1 ? alternatives.join("|") : knownCharacters;
  if (alternatives.length === 1 && plateType !== "FULL")
    normalizedPattern = /\blast (?:three|four)\b/i.test(rawTranscript)
      ? `*${knownCharacters}`
      : `${normalizedPattern}*`;
  return plate(
    plateType,
    jurisdiction,
    rawTranscript,
    normalizedPattern,
    knownCharacters,
    plateType === "FULL" ? 0 : null,
    plateType === "FULL" ? 0.98 : 0.87,
    warnings,
  );
}

function decodePlateCharacters(value) {
  const phonetics = {
    adam: "A",
    alpha: "A",
    boy: "B",
    bravo: "B",
    charles: "C",
    charlie: "C",
    david: "D",
    delta: "D",
    edward: "E",
    echo: "E",
    frank: "F",
    foxtrot: "F",
    george: "G",
    golf: "G",
    henry: "H",
    hotel: "H",
    ida: "I",
    idaho: "I",
    india: "I",
    john: "J",
    juliett: "J",
    king: "K",
    kilo: "K",
    lincoln: "L",
    lima: "L",
    mary: "M",
    mike: "M",
    nora: "N",
    november: "N",
    ocean: "O",
    oscar: "O",
    paul: "P",
    papa: "P",
    queen: "Q",
    quebec: "Q",
    robert: "R",
    romeo: "R",
    sam: "S",
    sierra: "S",
    tom: "T",
    tango: "T",
    union: "U",
    uniform: "U",
    victor: "V",
    william: "W",
    whiskey: "W",
    xray: "X",
    young: "Y",
    yankee: "Y",
    zebra: "Z",
    zulu: "Z",
  };
  const ignored = new Set([
    "license",
    "plate",
    "tag",
    "partial",
    "possible",
    "starts",
    "with",
    "last",
    "three",
    "four",
    "are",
    "is",
    "remaining",
    "characters",
    "character",
    "unknown",
    "state",
    "temporary",
    "no",
    "readable",
    "may",
    "be",
    "beginning",
    "begins",
  ]);
  const normalized = value.replace(/x-ray/gi, "xray");
  return (
    normalized
      .match(/[A-Za-z0-9]+/g)
      ?.map((rawToken) => {
        const token = rawToken.toLowerCase();
        if (phonetics[token]) return phonetics[token];
        if (ignored.has(token)) return "";
        if (
          /^\d+$/.test(token) ||
          /^[A-Za-z]$/.test(rawToken) ||
          (/^[A-Z0-9]{2,8}$/.test(rawToken) && /\d/.test(rawToken))
        )
          return rawToken.toUpperCase();
        return "";
      })
      .join("") ?? ""
  );
}

function extractPlateContext(text) {
  const source = String(text).replace(/\s+/g, " ").trim();
  const finalFragment = source.match(/\blast (?:three|four) (?:are|is) [^,.!?;]*/i)?.[0];
  const indicator = /\b(?:license\s+)?(?:plate|tag)\b/i.test(source);
  if (!indicator && !finalFragment) return null;
  const jurisdictionMatch = source.match(
    new RegExp(`\\b(${US_JURISDICTIONS})\\s+(?:license\\s+)?(?:plate|tag)\\b`, "i"),
  );
  const jurisdiction = jurisdictionMatch?.[1] ? titleCase(jurisdictionMatch[1]) : null;
  const fragments = [];
  const plateIndicators = [...source.matchAll(/\b(?:(?:possible|partial)\s+)?(?:license\s+)?(?:plate|tag)\b/gi)];
  const primaryCandidates = plateIndicators
    .map((indicator) =>
      source
        .slice(indicator.index)
        .match(
          /^\b(?:(?:possible|partial)\s+)?(?:license\s+)?(?:plate|tag)(?:\s+(?:is|number|starts?|begins?|beginning|may be))?\s+([^,.!?;]+)/i,
        ),
    )
    .filter(
      (match) =>
        match?.[1] &&
        !new RegExp(`^(?:${US_JURISDICTIONS})$`, "i").test(match[1].trim()) &&
        !/^(?:check|lookup|return)\b/i.test(match[1].trim()) &&
        decodePlateCharacters(match[1]),
    );
  const primaryMatch = primaryCandidates.at(-1) ?? null;
  const primary = primaryMatch?.[1] ?? null;
  if (primary) fragments.push(primary);
  const trailingPartial = source.match(/[,;]\s*(?:possible|partial)\s+(?!license\s+(?:plate|tag))([^,.!?;]+)/i)?.[1];
  if (!primary && trailingPartial) fragments.push(trailingPartial);
  const remaining = source.match(/\bremaining\s+(?:characters?|digits?)\s+(?:are\s+|is\s+)?([^,.!?;]+)/i)?.[1];
  if (remaining) fragments.push(remaining);
  if (finalFragment) fragments.push(finalFragment.replace(/^last (?:three|four) (?:are|is) /i, ""));
  const characterText = fragments
    .join(" ")
    .replace(new RegExp(`\\b(?:${US_JURISDICTIONS})\\s+(?:license\\s+)?(?:plate|tag)\\b`, "ig"), " ")
    .trim();
  const relevant = [
    primaryMatch?.[0] ??
      source.match(
        /\b(?:(?:possible|partial|temporary|no readable|unreadable|no)\s+)?(?:license\s+)?(?:plate|tag)\b[^,.!?;]*/i,
      )?.[0],
    !primary && trailingPartial && `partial ${trailingPartial}`,
    remaining && `remaining characters ${remaining}`,
    !indicator && finalFragment,
  ]
    .filter(Boolean)
    .join(", ");
  const warnings = [];
  const rawTranscript = relevant.length <= 1000 ? relevant : fragments.join(" ");
  if (relevant.length > 1000)
    warnings.push(
      "The surrounding sentence was omitted from raw plate context because it exceeded the audit-field limit; extracted plate phrases were retained intact.",
    );
  return { rawTranscript, characterText, jurisdiction, warnings };
}

function plate(
  plateType,
  jurisdiction,
  rawTranscript,
  normalizedPattern,
  knownCharacters,
  unknownCharacterCount,
  confidence,
  parsingWarnings = [],
) {
  return {
    plateType,
    jurisdiction,
    rawTranscript,
    normalizedPattern,
    knownCharacters,
    unknownCharacterCount,
    confidence,
    parsingWarnings,
  };
}

const US_JURISDICTIONS =
  "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming";
function titleCase(value) {
  return value.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function parseVehicleObservation(text, providedLocation = null) {
  const plateValue = parsePlate(text);
  const colors = [
    ...new Set(
      [...String(text).matchAll(new RegExp(COLORS.source, "gi"))].map((match) =>
        match[1].toLowerCase().replace("grey", "gray"),
      ),
    ),
  ];
  const makeModel = vehicleMakeModel(text);
  const vehicleType =
    text.match(/\b(sedan|suv|truck|van|coupe|motorcycle|pickup|hatchback|wagon)\b/i)?.[1]?.toLowerCase() ?? null;
  const damage = text.match(/\b(?:heavy|minor|major)?\s*(?:front|rear|side)[ -]end damage\b/i)?.[0] ?? null;
  const occupantCount = parseOccupants(text);
  const directionOfTravel = text.match(DIRECTIONS)?.[1]?.toLowerCase() ?? null;
  const location = providedLocation ?? extractLocation(text);
  if (!plateValue && !colors.length && !makeModel.make && !vehicleType && occupantCount === null && !directionOfTravel)
    return null;
  return {
    rawTranscript: String(text).trim(),
    colors,
    ...makeModel,
    vehicleType,
    damage,
    occupantCount,
    directionOfTravel,
    location,
    plate: plateValue,
  };
}

export function findActiveBoloMatches(bolos, observation, threshold = 0.5) {
  if (!observation) return [];
  return bolos
    .filter((bolo) => bolo.status === "ACTIVE" && bolo.type === "VEHICLE")
    .map((bolo) => {
      let score = 0;
      const reasons = [];
      const conflictingFields = [];
      const plateMatch = comparePlatePatterns(bolo.plate, observation.plate);
      if (plateMatch) {
        score += plateMatch.score;
        reasons.push(plateMatch.reason);
      }
      if (bolo.plate?.jurisdiction && observation.plate?.jurisdiction) {
        if (sameText(bolo.plate.jurisdiction, observation.plate.jurisdiction)) {
          score += 0.06;
          reasons.push(`plate jurisdiction ${bolo.plate.jurisdiction}`);
        } else {
          score -= 0.08;
          conflictingFields.push(`plate jurisdiction ${bolo.plate.jurisdiction} vs ${observation.plate.jurisdiction}`);
        }
      }
      if (bolo.color && observation.colors.includes(bolo.color.toLowerCase().replace("grey", "gray"))) {
        score += 0.12;
        reasons.push(`color ${bolo.color}`);
      } else if (bolo.color && observation.colors.length)
        conflictingFields.push(`color ${bolo.color} vs ${observation.colors.join("/")}`);
      if (sameVehicleMake(bolo.make, observation.make)) {
        score += 0.23;
        reasons.push(`make ${bolo.make}`);
      } else if (bolo.make && observation.make) conflictingFields.push(`make ${bolo.make} vs ${observation.make}`);
      if (sameText(bolo.model, observation.model)) {
        score += 0.27;
        reasons.push(`model ${bolo.model}`);
      } else if (bolo.model && observation.model) conflictingFields.push(`model ${bolo.model} vs ${observation.model}`);
      if (sameVehicleType(bolo.vehicleType, observation.vehicleType)) {
        score += 0.12;
        reasons.push(`vehicle type ${bolo.vehicleType}`);
      } else if (bolo.vehicleType && observation.vehicleType)
        conflictingFields.push(`vehicle type ${bolo.vehicleType} vs ${observation.vehicleType}`);
      if (sameText(bolo.damage, observation.damage)) {
        score += 0.12;
        reasons.push(`damage ${bolo.damage}`);
      } else if (bolo.damage && observation.damage)
        conflictingFields.push(`damage ${bolo.damage} vs ${observation.damage}`);
      if (
        bolo.occupantCount !== null &&
        observation.occupantCount !== null &&
        bolo.occupantCount === observation.occupantCount
      ) {
        score += 0.08;
        reasons.push(`${bolo.occupantCount} occupant${bolo.occupantCount === 1 ? "" : "s"}`);
      } else if (bolo.occupantCount !== null && observation.occupantCount !== null)
        conflictingFields.push(`occupants ${bolo.occupantCount} vs ${observation.occupantCount}`);
      if (sameDirection(bolo.directionOfTravel, observation.directionOfTravel)) {
        score += 0.05;
        reasons.push(`direction ${bolo.directionOfTravel}`);
      }
      if (
        bolo.lastKnownLocation &&
        observation.location &&
        locationSimilarity(bolo.lastKnownLocation, observation.location)
      ) {
        score += 0.08;
        reasons.push("near last known location");
      }
      const boloTimestamp = bolo.updatedAt ?? bolo.createdAt;
      const ageHours = boloTimestamp ? (Date.now() - Date.parse(boloTimestamp)) / 3_600_000 : null;
      if (ageHours !== null && Number.isFinite(ageHours) && ageHours <= 24) {
        score += 0.04;
        reasons.push("BOLO issued within 24 hours");
      } else if (ageHours !== null && Number.isFinite(ageHours) && ageHours > 720) score -= 0.05;
      score -= Math.min(0.18, conflictingFields.length * 0.04);
      const confidence = Math.max(0, Math.min(0.99, score));
      return {
        bolo,
        confidence,
        score: confidence,
        reasons,
        matchedFields: reasons,
        conflictingFields,
        plateMatchType: plateMatch?.matchType ?? "NONE",
        threatLevel: boloThreatLevel(bolo),
      };
    })
    .filter((match) => match.confidence >= threshold)
    .sort(
      (a, b) =>
        b.confidence - a.confidence || b.reasons.length - a.reasons.length || a.bolo.id.localeCompare(b.bolo.id),
    );
}

function comparePlatePatterns(expected, observed) {
  if (
    !expected ||
    !observed ||
    ["UNREADABLE", "NO_PLATE", "TEMPORARY_TAG"].includes(expected.plateType) ||
    ["UNREADABLE", "NO_PLATE", "TEMPORARY_TAG"].includes(observed.plateType)
  )
    return null;
  let best = null;
  for (const left of plateAlternatives(expected.normalizedPattern))
    for (const right of plateAlternatives(observed.normalizedPattern)) {
      const leftKnown = left.replace(/\*/g, "");
      const rightKnown = right.replace(/\*/g, "");
      let candidate = null;
      if (left === right && !left.includes("*"))
        candidate = { score: 0.82, reason: `exact plate ${right}`, matchType: "EXACT" };
      else if (wildcardMatches(left, rightKnown))
        candidate = {
          score: 0.74,
          reason: `plate matches BOLO pattern ${left}`,
          matchType: left.startsWith("*") ? "PARTIAL_SUFFIX" : left.endsWith("*") ? "PARTIAL_PREFIX" : "WILDCARD",
        };
      else if (wildcardMatches(right, leftKnown))
        candidate = { score: 0.7, reason: `observed partial plate matches ${leftKnown}`, matchType: "POSSIBLE" };
      else if (leftKnown.length >= 3 && rightKnown.startsWith(leftKnown))
        candidate = { score: 0.68, reason: `plate prefix ${leftKnown}`, matchType: "PARTIAL_PREFIX" };
      else if (leftKnown.length >= 3 && rightKnown.endsWith(leftKnown))
        candidate = { score: 0.66, reason: `plate suffix ${leftKnown}`, matchType: "PARTIAL_SUFFIX" };
      else if (rightKnown.length >= 3 && (leftKnown.startsWith(rightKnown) || leftKnown.endsWith(rightKnown)))
        candidate = { score: 0.62, reason: `partial plate fragment ${rightKnown}`, matchType: "POSSIBLE" };
      if (candidate && (!best || candidate.score > best.score)) best = candidate;
    }
  return best;
}

function plateAlternatives(value = "") {
  return value
    .toUpperCase()
    .split("|")
    .map((part) => part.replace(/[^A-Z0-9*]/g, ""))
    .filter(Boolean);
}
function wildcardMatches(pattern, value) {
  return pattern.includes("*") && new RegExp(`^${pattern.split("*").map(escapePattern).join(".*")}$`).test(value);
}
function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sameText(left, right) {
  return Boolean(left && right && normalize(left) === normalize(right));
}
function sameVehicleMake(left, right) {
  return Boolean(left && right && vehicleMakeKey(left) === vehicleMakeKey(right));
}
function sameVehicleType(left, right) {
  return Boolean(left && right && vehicleTypeKey(left) === vehicleTypeKey(right));
}
function sameDirection(left, right) {
  return Boolean(left && right && directionKey(left) === directionKey(right));
}
function vehicleMakeKey(value) {
  const key = normalize(value);
  return { chevy: "chevrolet", mercedesbenz: "mercedes" }[key.replaceAll(" ", "")] ?? key;
}
function vehicleTypeKey(value) {
  const key = normalize(value);
  return { pickup: "truck", sportutilityvehicle: "suv" }[key.replaceAll(" ", "")] ?? key;
}
function directionKey(value) {
  return normalize(value).replace("heading ", "").replace("bound", "");
}
function boloThreatLevel(bolo) {
  return /\b(?:officer down|shoot|automatic|rifle|armed|gun|weapon|violent|dangerous|hostage)\b/i.test(
    `${bolo.threatInformation ?? ""} ${bolo.wantedReason ?? ""}`,
  )
    ? "HIGH"
    : "UNKNOWN";
}

function parseBolo(text) {
  if (!/\bbolos?\b|\bbe on the lookout\b/i.test(text)) return null;
  if (
    /\b(?:are there|do we have|advise|list|check for|show me|any)\b[^.!?;]{0,50}\bactive\s+bolos?\b|\bactive\s+bolos?\s+(?:check|status)\b/i.test(
      text,
    )
  )
    return null;
  const operation = /\b(?:cancel|clear)\b/i.test(text)
    ? "CANCEL"
    : /\b(?:add that|update)\b/i.test(text)
      ? "UPDATE"
      : "CREATE";
  const vehicle = /\b(?:vehicle|sedan|suv|truck|van|coupe|charger|plate|tag|four-door|two-door)\b/i.test(text);
  const direction = text.match(DIRECTIONS)?.[1] ?? null;
  const location = extractLocation(text);
  const threatInformation = text.match(/\b(?:armed|weapon|gun|knife|dangerous|violent)[^,.!?;]*/i)?.[0] ?? null;
  const wantedReason = text.match(/\b(?:wanted for|fled from|in connection with)\s+([^,.!?;]+)/i)?.[1]?.trim() ?? null;
  if (vehicle) {
    return {
      operation,
      type: "VEHICLE",
      color: text.match(COLORS)?.[1] ?? null,
      ...vehicleMakeModel(text),
      vehicleType: text.match(/\b(sedan|suv|truck|van|coupe)\b/i)?.[1] ?? null,
      doors: /\bfour-door\b/i.test(text) ? 4 : /\btwo-door\b/i.test(text) ? 2 : null,
      damage: text.match(/\b(?:heavy|minor|major)?\s*(?:front|rear|side)[ -]end damage\b/i)?.[0] ?? null,
      occupantCount: parseOccupants(text),
      plate: parsePlate(text),
      lastKnownLocation: location,
      directionOfTravel: direction,
      travelMode: "VEHICLE",
      threatInformation,
      wantedReason,
      rawDescription: text,
    };
  }
  return {
    operation,
    type: "PERSON",
    nameOrAlias: text.match(/\b(?:bolo for|wanted person)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/)?.[1] ?? null,
    sex: text.match(/\b(male|female)\b/i)?.[1] ?? null,
    race: text.match(/\b(white|black|asian|hispanic|native american)\s+(?:male|female|person|subject)\b/i)?.[1] ?? null,
    approximateAge: text.match(/\b(?:approximately|about|around)\s+(\d{1,2})\b/i)?.[1] ?? null,
    height: text.match(/\b\d\s*(?:feet|foot|')\s*\d{0,2}\s*(?:inches|inch|\")?\b/i)?.[0] ?? null,
    weightOrBuild: text.match(/\b(?:thin|slim|medium|stocky|heavy|muscular) build\b/i)?.[0] ?? null,
    hair: text.match(/\b(?:black|brown|blond|blonde|red|gray) hair\b/i)?.[0] ?? null,
    clothing: text.match(/\b(?:wearing|in)\s+([^,.!?;]+)/i)?.[1]?.trim() ?? null,
    distinguishingFeatures: text.match(/\b(?:tattoo|scar|mask|ski mask)[^,.!?;]*/i)?.[0] ?? null,
    lastKnownLocation: location,
    directionOfTravel: direction,
    travelMode: /\bon foot\b/i.test(text) ? "ON_FOOT" : "UNKNOWN",
    threatInformation,
    wantedReason,
    rawDescription: text,
  };
}

function parseWarrant(text) {
  if (/\b(?:do not|don't|negative|disregard)\b[^.!?;]{0,60}\bwarrant\b/i.test(text)) return null;
  const explicit =
    /\b(?:enter|create|issue|add|clear|cancel|confirm)\s+(?:(?:an?|the)\s+)?(?:arrest\s+|search\s+)?warrant\b/i.test(
      text,
    );
  if (!explicit) return null;
  const operation = /\b(?:clear|cancel)\b/i.test(text) ? "CLEAR" : /\bconfirm\b/i.test(text) ? "QUERY" : "CREATE";
  const vehicle = /\b(?:vehicle|plate|registered owner)\b/i.test(text);
  return {
    operation,
    subjectType: vehicle ? "VEHICLE" : "PERSON",
    subjectName: text.match(/\b(?:warrant for|for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/)?.[1] ?? null,
    vehicleDescription: vehicle ? (text.match(/\b(?:vehicle|for)\s+([^,.!?;]+)/i)?.[1]?.trim() ?? null) : null,
    plate: parsePlate(text),
    warrantType: /\barrest warrant\b/i.test(text) ? "ARREST" : /\bsearch warrant\b/i.test(text) ? "SEARCH" : "GENERAL",
    chargesOrReason:
      text.match(/\b(?:for|connection with)\s+([^,.!?;]+)/i)?.[1]?.trim() ?? "Reason stated in officer transmission",
    threatFlags: text.match(/\b(?:armed|dangerous|violent)[^,.!?;]*/gi) ?? [],
    cautionFlags: /\bdo not serve without a supervisor\b/i.test(text) ? ["DO_NOT_SERVE_WITHOUT_SUPERVISOR"] : [],
    rawDescription: text,
  };
}

function parsePursuit(text, location) {
  if (
    !/\b(?:pursuit|failing to stop|fleeing vehicle|terminate pursuit|pursuit terminated|foot chase|foot pursuit|bailed out)\b/i.test(
      text,
    )
  )
    return null;
  return {
    active: !/\b(?:terminate|terminated|discontinue|ended)\b/i.test(text),
    type: /\b(?:foot chase|foot pursuit|bailed out|bailout)\b/i.test(text) ? "FOOT" : "VEHICLE",
    direction: text.match(DIRECTIONS)?.[1] ?? null,
    lastLocation: location,
    road: location,
    postal: text.match(/\bpostal\s*(\d{1,5})\b/i)?.[1] ?? null,
    vehicle:
      text
        .match(
          /\b(?:black|white|red|blue|silver|gray|grey|green|yellow|brown|tan)?\s*(?:sedan|suv|truck|van|coupe|charger)\b/i,
        )?.[0]
        ?.trim() ?? null,
    plate: parsePlate(text),
    occupants: parseOccupants(text),
    speed: Number(text.match(/\b(\d{2,3})\s*(?:miles per hour|mph)\b/i)?.[1]) || null,
    trafficConditions: text.match(/\b(?:light|moderate|heavy) traffic\b/i)?.[0] ?? null,
    weather: text.match(/\b(?:clear|rainy|raining|foggy|snowy|icy) conditions\b/i)?.[0] ?? null,
    reason: text.match(/\b(?:pursuit for|fleeing from|wanted for)\s+([^,.!?;]+)/i)?.[1]?.trim() ?? null,
    weapons: text.match(/\b(?:weapon|gun|rifle|knife)[^,.!?;]*/i)?.[0] ?? null,
    pitStatus: /\bpit (?:authorized|approved)\b/i.test(text)
      ? "AUTHORIZED"
      : /\bpit denied\b/i.test(text)
        ? "DENIED"
        : /\brequest(?:ing)? (?:a )?pit\b/i.test(text)
          ? "REQUESTED"
          : "NONE",
    spikeStripsRequested: /\b(?:spike strips?|stop sticks?)\b/i.test(text),
    bailout: /\b(?:bailed out|bailout)\b/i.test(text),
  };
}

export function scoreOfficerCallCandidates(calls, interpretation, unit, threshold = 0.72) {
  const incident = interpretation.incident;
  const location = incident?.location ?? interpretation.unitUpdates.location;
  return calls
    .filter((call) => call.status !== "CLOSED")
    .map((call) => {
      let score = 0;
      const reasons = [];
      const contextualFollowUp = interpretation.classification !== "OFFICER_INITIATED_INCIDENT";
      if (contextualFollowUp && unit.assignedCallId === call.id) {
        score += 0.55;
        reasons.push("speaker assigned");
      }
      if (incident && normalize(call.incident).includes(normalize(incident.type))) {
        score += 0.3;
        reasons.push("incident type");
      }
      if (incident && normalize(incident.type).includes(normalize(call.incident))) {
        score += 0.2;
        reasons.push("incident family");
      }
      if (location && locationSimilarity(location, call.location)) {
        score += 0.45;
        reasons.push("location");
      }
      if (contextualFollowUp && call.assignedUnits.includes(unit.callsign)) {
        score += 0.2;
        reasons.push("existing assignment");
      }
      const ageMinutes = (Date.now() - new Date(call.createdAt).getTime()) / 60_000;
      if (ageMinutes <= 15) {
        score += 0.05;
        reasons.push("recent");
      }
      return {
        callId: call.id,
        score: Math.min(1, score),
        reason: reasons.join(", ") || "weak contextual match",
        strong: score >= threshold,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function extractLocation(text) {
  const street =
    text.match(
      /\b(?:at|near|on)\s+(\d{1,6}\s+[A-Za-z0-9' -]+?\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Court|Ct|Lane|Ln|Highway|Parkway|Way))(?:\b|,)/i,
    )?.[1] ??
    text.match(
      /\b(?:at|near|on)\s+((?!scene\b)[A-Za-z][A-Za-z0-9' -]+?\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Court|Ct|Lane|Ln|Highway|Parkway|Way))(?:\b|,)/i,
    )?.[1] ??
    text.match(
      /\b(\d{1,6}\s+[A-Za-z][A-Za-z0-9' -]+?\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Court|Ct|Lane|Ln|Highway|Parkway|Way))(?:\b|,)/i,
    )?.[1];
  if (street) return street.replace(/\s+/g, " ").trim();
  const route = text.match(/\b(?:on|near|at)\s+((?:Highway|Route)\s+[A-Za-z0-9-]+)\b/i)?.[1];
  if (route) return route.replace(/\s+/g, " ").trim();
  const postal = text.match(/\bpostal\s*(\d{1,5})\b/i)?.[1];
  return postal ? `Postal ${postal}` : null;
}

function extractQuantity(value = "") {
  const token = value.match(/\b(one|two|three|four|five|\d+)\b/i)?.[1]?.toLowerCase();
  return token ? ({ one: 1, two: 2, three: 3, four: 4, five: 5 }[token] ?? Number(token)) : null;
}
function parseOccupants(text) {
  const value = text.match(
    /\b(?:occupied\s+(?:times\s+)?(one|two|three|four|five|\d+)|(one|two|three|four|five|\d+)\s+occupants?)\b/i,
  );
  return extractQuantity(value?.[1] ?? value?.[2]);
}
function vehicleMakeModel(text) {
  const match = text.match(/\b(Dodge|Ford|Chevrolet|Chevy|Toyota|Honda|Nissan|BMW|Mercedes|Jeep)\s+([A-Za-z0-9-]+)\b/i);
  return { make: match?.[1] ?? null, model: match?.[2] ?? null };
}
function commonPrefix(values) {
  if (!values.length) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) while (prefix && !value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}
function normalize(value = "") {
  return value
    .toLowerCase()
    .replace(/\b(?:the|at|near|postal)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function locationSimilarity(a, b) {
  const left = normalize(a);
  const right = normalize(b);
  return left && right && (left === right || left.includes(right) || right.includes(left));
}
