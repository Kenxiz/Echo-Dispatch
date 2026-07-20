import { speakCallsign } from "../utils/radio.js";

const ACKNOWLEDGEMENTS = [
  "10-4.",
  "Received.",
  "Copy that.",
  "Affirmative.",
  "Copy, standby.",
  "Roger.",
  "10-4, go ahead.",
  "Received, standby.",
];
let acknowledgementIndex = 0;

export function nextAcknowledgement() {
  const value = ACKNOWLEDGEMENTS[acknowledgementIndex % ACKNOWLEDGEMENTS.length];
  acknowledgementIndex += 1;
  return value;
}

export function assessTransmissionConfidence(transcript, result = {}) {
  const text = transcript.trim();
  if (!text) return { score: 0, disposition: "REPEAT", uncertainPart: "the transmission" };

  let score = 0.98;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) score -= 0.08;
  if (/\b(?:inaudible|unintelligible|unclear|unknown|maybe|possibly|something|someone)\b/i.test(text)) score -= 0.12;
  if (/\b(?:one|won)\b.*\b(?:detained|deceased)\b|\b(?:detained|deceased)\b.*\b(?:one|won)\b/i.test(text))
    score -= 0.18;
  if (/\b(?:at|on|near)\s+(?:the|a)?\s*$/i.test(text)) score -= 0.2;
  if (
    /\b(?:need|send|requesting)\b/i.test(text) &&
    !/\b(?:unit|backup|ems|fire|tow|wrecker|supervisor|k-?9|swat|air|help)\b/i.test(text)
  )
    score -= 0.17;
  if ((result.actions?.length ?? 0) > 0) score += 0.01;
  if (!result.inProgress && !result.outputTranscript?.trim() && (result.audio?.length ?? 0) === 0) score -= 0.28;
  score = Math.max(0, Math.min(1, score));

  if (score >= 0.95) return { score, disposition: "EXECUTE", uncertainPart: null };
  if (score >= 0.8) return { score, disposition: "STANDBY", uncertainPart: inferUncertainPart(text) };
  if (score >= 0.6) return { score, disposition: "CLARIFY", uncertainPart: inferUncertainPart(text) };
  return { score, disposition: "REPEAT", uncertainPart: inferUncertainPart(text) };
}

export function confidenceReply(unit, assessment, transcript = "") {
  const callsign = speakCallsign(unit.callsign);
  if (assessment.disposition === "STANDBY") return `${callsign}, copy traffic, standby.`;
  if (assessment.disposition === "CLARIFY") {
    if (/\bdetained\b.*\bdeceased\b|\bdeceased\b.*\bdetained\b/i.test(transcript))
      return `${callsign}, copy traffic. Did you advise one detained or one deceased?`;
    return `${callsign}, copy traffic. Confirm ${assessment.uncertainPart ?? "the unclear portion"}.`;
  }
  return `${callsign}, 10-9 your traffic.`;
}

function inferUncertainPart(text) {
  if (/\b(?:at|on|near|location|postal)\b/i.test(text)) return "your location";
  if (/\b(?:suspect|vehicle|plate|weapon|gun|knife)\b/i.test(text)) return "the suspect or vehicle information";
  if (/\b(?:detained|deceased|injured|victim)\b/i.test(text)) return "the subject's condition";
  if (/\b(?:need|send|requesting)\b/i.test(text)) return "the resource requested";
  return "the last part of your traffic";
}

export function compressRadioTraffic(transcript) {
  const facts = [];
  const rules = [
    ["Pursuit", /\b(?:pursuit|fleeing|taking off|not stopping|losing him)\b/i],
    ["Traffic stop", /\b(?:traffic stop|10-61|out with)\b/i],
    ["Shots fired", /\b(?:shots? fired|started shooting|gunfire|taking fire)\b/i],
    ["Officer down", /\bofficer down\b/i],
    ["EMS requested", /\b(?:request(?:ing)?|need|send)\s+(?:an?\s+)?(?:ambulance|ems|medic)\b/i],
    ["K9 requested", /\b(?:request(?:ing)?|need|send)\s+(?:a\s+)?k-?9\b/i],
    ["SWAT requested", /\b(?:request(?:ing)?|need|send)\s+(?:swat|tactical)\b/i],
    ["Felony stop", /\b(?:felony|high-risk)\s+stop\b/i],
  ];
  for (const [label, pattern] of rules) if (pattern.test(transcript)) facts.push(label);
  const plate = transcript.match(/\b(?:plate|tag)\s+(?:is\s+)?([A-Z0-9-]{3,10})\b/i)?.[1];
  if (plate) facts.push(`Plate ${plate.toUpperCase()}`);
  const vehicle = transcript.match(
    /\b((?:white|black|red|blue|gray|grey|silver|green|yellow|orange|brown)\s+(?:sedan|suv|truck|van|coupe|vehicle|car))\b/i,
  )?.[1];
  if (vehicle) facts.push(vehicle.replace(/\b\w/g, (value) => value.toUpperCase()));
  return facts;
}

export const RADIO_PRIORITY = Object.freeze({
  EMERGENCY: 800,
  OFFICER_PANIC: 700,
  DISPATCHER_EMERGENCY: 600,
  UNIT_EMERGENCY: 500,
  PRIORITY_1: 400,
  PRIORITY_2: 300,
  PRIORITY_3: 200,
  ROUTINE_REPLY: 100,
});

export function callRadioPriority(call) {
  return call.priority === 1
    ? RADIO_PRIORITY.PRIORITY_1
    : call.priority === 2
      ? RADIO_PRIORITY.PRIORITY_2
      : RADIO_PRIORITY.PRIORITY_3;
}
