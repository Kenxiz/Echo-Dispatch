import { parsePlate, parseVehicleObservation } from "../dispatch/officer-incident.js";

const EMERGENCY_PHRASES = [
  "panic",
  "officer down",
  "shots fired",
  "under fire",
  "taking fire",
  "send everybody",
  "requesting all units",
  "emergency traffic",
  "help",
  "suspect has a gun",
  "active gunmen",
  "attempting to ram",
  "unit not responding",
];
const NEGATION_PATTERNS = [
  /\bno\s+[^,.!?;]+/gi,
  /\bnegative\s+(?:on\s+)?[^,.!?;]+/gi,
  /\bdisregard\s+[^,.!?;]+/gi,
  /\bcancel\s+[^,.!?;]+/gi,
  /\bdo not\s+[^,.!?;]+/gi,
  /\bdon't\s+[^,.!?;]+/gi,
  /\bhold\s+[^,.!?;]+/gi,
];

export function normalizeRadioTransmission(rawTranscript, unit, codebook) {
  const raw = String(rawTranscript ?? "").trim();
  let traffic = raw
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  traffic = traffic.replace(/[\u2010-\u2015]/g, "-");
  const corrections = [];
  const callsignCorrection = recoverCallsign(traffic, unit?.callsign);
  if (callsignCorrection) {
    traffic = callsignCorrection.traffic;
    corrections.push({
      field: "CALLSIGN",
      from: callsignCorrection.from,
      to: unit.callsign,
      confidence: callsignCorrection.confidence,
      reason: "Registered Discord speaker identity resolved a likely spoken callsign.",
    });
  }
  if (/\bshow me tonight\b/i.test(traffic)) {
    traffic = traffic.replace(/\bshow me tonight\b/i, "show me 10-8");
    corrections.push({
      field: "RADIO_CODE",
      from: "tonight",
      to: "10-8",
      confidence: 0.96,
      reason: "Status-command context strongly supports a speech-to-text rendering of ten-eight.",
    });
  }
  const detected = codebook?.detect(traffic) ?? [];
  const codesDetected = dedupeCodes(detected);
  for (const match of codesDetected) {
    if (match.confidence < 0.99) continue;
    if (match.spokenForm.toLowerCase() === match.code.toLowerCase()) continue;
    traffic = replaceConfiguredForm(traffic, match.spokenForm, match.code);
    corrections.push({
      field: "RADIO_CODE",
      from: match.spokenForm,
      to: match.code,
      confidence: match.confidence,
      reason: `Matched the configured spoken form for ${match.code}.`,
    });
  }
  const unknownCodes = [
    ...new Set(
      [...traffic.matchAll(/\b10[\s-]?(\d{1,3})\b/gi)]
        .filter((match) => !looksLikeStreetNumber(traffic, match))
        .map((match) => `10-${Number(match[1])}`)
        .filter((code) => !codebook?.get(code)),
    ),
  ];
  const emergencyPhrases = EMERGENCY_PHRASES.filter((phrase) =>
    new RegExp(`\\b${phrase.replaceAll(" ", "\\s+")}\\b`, "i").test(traffic),
  );
  const negationScopes = NEGATION_PATTERNS.flatMap((pattern) =>
    [...traffic.matchAll(pattern)].map((match) => match[0].trim()),
  );
  const postal = traffic.match(/\bpostal\s*(\d{1,5})\b/i)?.[1] ?? null;
  const vehicleObservation = parseVehicleObservation(raw);
  const plate = vehicleObservation?.plate ?? parsePlate(raw);
  return {
    rawTranscript: raw,
    normalizedTraffic: traffic,
    normalizedTranscript: `${unit?.callsign ? `[${unit.callsign}] ` : ""}${traffic}`.trim(),
    corrections,
    codesDetected: codesDetected.map(({ start: _start, end: _end, ...match }) => match),
    unknownCodes,
    emergencyPhrases,
    negationScopes,
    plate,
    location: vehicleObservation?.location ?? null,
    postal,
  };
}

function recoverCallsign(traffic, callsign) {
  if (!callsign || !traffic) return null;
  const boundary = traffic.search(
    /,|\b(?:show me|be advised|i have|i'm|i am|start|out with|dispatch|requesting|request|are there|any active|check|run|advise|what(?:'s| is)|do we have|can you|could you)\b/i,
  );
  const opening = (boundary > 0 ? traffic.slice(0, boundary) : boundary === 0 ? "" : traffic).trim();
  if (
    !opening ||
    !/(?:\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b)/i.test(
      opening,
    )
  )
    return null;
  const target = compact(callsign);
  const spoken = compact(opening);
  const finalNumber = target.match(/\d+$/)?.[0] ?? "";
  const designator = target.match(/[A-Z]/)?.[0] ?? "";
  const plausible =
    spoken === target ||
    spoken.endsWith(finalNumber) ||
    spoken.includes(designator + finalNumber) ||
    (finalNumber && spoken === finalNumber);
  if (!plausible || opening.toUpperCase() === callsign.toUpperCase()) return null;
  // Registration is authoritative, so carry the callsign once in the
  // normalized envelope instead of duplicating an uncertain spoken opening.
  const remainder = traffic.slice(opening.length).replace(/^\s*[,;:-]?\s*/, "");
  return { traffic: remainder, from: opening, confidence: spoken === target ? 0.99 : 0.93 };
}

function compact(value) {
  const phonetics = {
    ADAM: "A",
    ALPHA: "A",
    BOY: "B",
    BRAVO: "B",
    CHARLES: "C",
    CHARLIE: "C",
    LINCOLN: "L",
    LINK: "L",
    NORA: "N",
    NOVEMBER: "N",
    SAM: "S",
    SIERRA: "S",
    TOM: "T",
    TANGO: "T",
  };
  const numbers = {
    ZERO: "0",
    OH: "0",
    ONE: "1",
    TWO: "2",
    THREE: "3",
    FOUR: "4",
    FIVE: "5",
    SIX: "6",
    SEVEN: "7",
    EIGHT: "8",
    NINE: "9",
    EIGHTEEN: "18",
    NINETEEN: "19",
  };
  return (
    String(value)
      .toUpperCase()
      .replace(/(?:LINK|LEAGUE)\s+IN|ONLY\s+CAN/g, "LINCOLN")
      .match(/[A-Z]+|\d+/g)
      ?.map((token) => phonetics[token] ?? numbers[token] ?? token)
      .join("") ?? ""
  );
}
function dedupeCodes(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.code}:${match.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function looksLikeStreetNumber(text, match) {
  const before = text.slice(Math.max(0, match.index - 12), match.index);
  const after = text.slice(match.index + match[0].length, match.index + match[0].length + 50);
  return (
    /\b(?:at|near|on)\s*$/i.test(before) &&
    /^\s+[A-Za-z][A-Za-z0-9' -]+\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Court|Ct|Lane|Ln|Highway|Parkway|Way)\b/i.test(
      after,
    )
  );
}
function replaceConfiguredForm(text, spokenForm, code) {
  const pattern = spokenForm
    .trim()
    .split(/[\s-]+/)
    .map(escapeRegex)
    .join("[\\s-]*");
  return text.replace(new RegExp(`\\b${pattern}\\b`, "i"), code);
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
