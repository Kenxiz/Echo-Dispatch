export const EMERGENCY_TRAFFIC_PATTERN =
  /\b(?:emergency traffic|officer (?:needs help|down)|shots? fired|started shooting|gunfire|send everybody|hold the air|priority traffic|need units now|assist officer|being shot at|taking fire|under fire|can't breathe|cannot breathe|not breathing)\b/i;
export const OFFICER_PANIC_PATTERN =
  /\b(?:10-33|mass panic|panic (?:button|alarm|traffic)|emergency traffic|officer (?:needs help|down|in distress)|shots? fired|started shooting|gunfire|being shot at|taking fire|under fire|assist officer|send everybody|need units now|can't breathe|cannot breathe|not breathing)\b/i;

export function analyzePcm16Mono(buffer, sampleRate = 48_000, activityThreshold = 450) {
  const sampleCount = Math.floor(buffer.length / 2);
  if (sampleCount === 0) return { durationMs: 0, rms: 0, peak: 0, activeMs: 0 };

  const frameSamples = Math.max(1, Math.floor(sampleRate * 0.02));
  let sumSquares = 0;
  let peak = 0;
  let activeFrames = 0;

  for (let frameStart = 0; frameStart < sampleCount; frameStart += frameSamples) {
    const frameEnd = Math.min(sampleCount, frameStart + frameSamples);
    let frameSquares = 0;
    for (let index = frameStart; index < frameEnd; index++) {
      const sample = buffer.readInt16LE(index * 2);
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      const square = sample * sample;
      sumSquares += square;
      frameSquares += square;
    }
    const frameRms = Math.sqrt(frameSquares / (frameEnd - frameStart));
    if (frameRms >= activityThreshold) activeFrames += 1;
  }

  return {
    durationMs: (sampleCount / sampleRate) * 1000,
    rms: Math.sqrt(sumSquares / sampleCount),
    peak,
    activeMs: activeFrames * 20,
  };
}

export function isLikelySpeech(buffer, options = {}) {
  const minimumDurationMs = options.minimumDurationMs ?? 300;
  const rmsThreshold = options.rmsThreshold ?? 450;
  const metrics = analyzePcm16Mono(buffer, options.sampleRate ?? 48_000, rmsThreshold);
  const minimumActiveMs = Math.min(140, Math.max(80, minimumDurationMs * 0.3));
  return (
    metrics.durationMs >= minimumDurationMs &&
    metrics.rms >= rmsThreshold &&
    metrics.peak >= Math.max(1_200, rmsThreshold * 2) &&
    metrics.activeMs >= minimumActiveMs
  );
}

export function isEmergencyTraffic(transcript) {
  return EMERGENCY_TRAFFIC_PATTERN.test(transcript);
}

export function isOfficerPanicTraffic(transcript) {
  if (/\b(?:clear|closed|code\s*4|disregard|cancel)\b.{0,40}\bshots? fired\b/i.test(transcript)) return false;
  return classifyEmergencyTraffic(transcript).kind === "OFFICER_PANIC";
}

export function classifyEmergencyTraffic(transcript) {
  const text = String(transcript ?? "");
  if (
    /\b(?:panic(?:,\s*panic){1,}|10-33|mass panic|panic (?:button|alarm|traffic)|officer (?:down|needs help|in distress)|being shot at|shots? fired (?:at|toward) (?:me|us|my)|taking fire|under fire|send everybody|requesting all units|need units now|assist officer|vehicle (?:is )?attempting to ram (?:me|the officer)|unit not responding after (?:a )?panic)\b/i.test(
      text,
    )
  )
    return { kind: "OFFICER_PANIC", priority: 1, description: describeOfficerPanic(text) };
  if (
    /\b(?:shots? fired|gunfire|started shooting|active gunm[ae]n|suspect has (?:a )?gun|person with (?:a )?gun|vehicle attempting to ram|officer not responding)\b/i.test(
      text,
    )
  )
    return {
      kind: "URGENT_OFFICER_SAFETY",
      priority: 1,
      description: /\bshots? fired|gunfire|shooting\b/i.test(text)
        ? "reports shots fired"
        : "reports an armed or immediate threat",
    };
  if (/\b(?:emergency traffic|help|priority traffic)\b/i.test(text))
    return { kind: "OFFICER_PANIC", priority: 1, description: "declared emergency traffic" };
  return { kind: "NONE", priority: null, description: null };
}

export function describeOfficerPanic(transcript) {
  if (/\b(?:being shot at|taking fire|under fire)\b/i.test(transcript)) return "is taking fire";
  if (/\b(?:started shooting|gunfire)\b/i.test(transcript)) return "reports active gunfire";
  if (/\bofficer down\b/i.test(transcript)) return "reports an officer down";
  if (/\bshots? fired\b/i.test(transcript)) return "reports shots fired";
  if (/\b(?:10-33|panic (?:button|alarm|traffic)|mass panic)\b/i.test(transcript)) return "activated an officer panic";
  return "declared emergency traffic";
}

export function isDirectedRadioTraffic(transcript, callsign = "") {
  const text = transcript.trim();
  if (!text) return false;
  const compactText = compactSpokenRadioText(text);
  const compactCallsign = callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compactCallsign && compactText.includes(compactCallsign)) return true;
  if (
    /\b\d+\s*(?:adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-?ray|young|zebra)\s*\d+\b/i.test(
      text,
    )
  )
    return true;
  return isEmergencyTraffic(text) || containsDispatchInformation(text, callsign);
}

export function containsDispatchInformation(transcript, callsign = "") {
  const text = transcript.trim();
  if (!text) return false;
  const compactCallsign = callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compactCallsign && compactSpokenRadioText(text).includes(compactCallsign)) return true;
  return /\b(?:dispatch|unit|radio|traffic|priority|emergency|10\s*-?\s*\d+|signal\s+\d+|code\s*[1-4]|show\s+me|be\s+on\s+the\s+lookout|b\.?o\.?l\.?o\.?(?:s)?|unable\s+to\s+(?:find|locate)|no\s+suspect|suspect|subject|victim|caller|vehicle|plate|tag|weapon|gun|knife|injur(?:y|ed)|bleeding|last\s+seen|direction\s+of\s+travel|heading\s+(?:north|south|east|west)|northbound|southbound|eastbound|westbound|on\s+foot|vicinity|scene|en\s+route|responding|arrived|clear|available|busy|out\s+of\s+service|standby|request(?:ing)?|need\s+(?:another|backup|ems|fire|tow|supervisor|units?)|send\s+(?:another|backup|ems|fire|units?)|pursuit|traffic\s+stop|felony\s+stop|detain(?:ed|ing)?|custody|transport|location|postal|intersection|street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|court|ct\.?|lane|ln\.?|highway|route|county\s+jail|station|hospital|bank|gas\s+station|school|residence|address|north|south|east|west|copy|affirmative|negative|repeat|10-9)\b/i.test(
    text,
  );
}

export function classifyRadioTransmission(input) {
  const transcript = String(input.transcript ?? "").trim();
  const metrics = analyzePcm16Mono(input.pcm ?? Buffer.alloc(0), input.sampleRate ?? 48_000, input.rmsThreshold ?? 450);
  const hasDispatchInformation = containsDispatchInformation(transcript, input.callsign ?? "");
  const emergency = isEmergencyTraffic(transcript) || isOfficerPanicTraffic(transcript);
  const wordCount = transcript.split(/\s+/).filter(Boolean).length;

  if (emergency)
    return decision(
      "EMERGENCY_INTERRUPTION",
      1,
      "Explicit officer-safety or emergency traffic was detected.",
      true,
      true,
    );
  if (input.overlap)
    return decision(
      "CROSS_TRANSMISSION",
      hasDispatchInformation ? 0.98 : 0.82,
      hasDispatchInformation
        ? "A separate overlapping unit stream contained dispatch-related information."
        : "The transmission overlapped another unit and must not be treated as a hot mic.",
      hasDispatchInformation,
      !hasDispatchInformation && metrics.durationMs >= 1200,
    );
  if (hasDispatchInformation)
    return decision(
      "VALID_RADIO_TRAFFIC",
      0.99,
      "The transmission contains a callsign or understandable operational dispatch information.",
      true,
      false,
    );
  if (metrics.durationMs < (input.briefNoiseMs ?? 700))
    return decision(
      "BRIEF_ACCIDENTAL_NOISE",
      0.98,
      "The activation was brief and contained no confirmed dispatch information.",
      false,
      false,
    );
  if (!transcript || /^(?:um+|uh+|er+|hmm+|okay|so|wait|correction|stand\s*by)[\s,.!?-]*$/i.test(transcript))
    return decision(
      "UNCLEAR_RADIO_TRAFFIC",
      0.75,
      "The audio was empty, hesitant, or incomplete; uncertainty is not a hot mic.",
      false,
      true,
    );

  const unrelatedEvidence = unrelatedConversationEvidence(transcript);
  const prolonged =
    metrics.durationMs >= (input.hotMicMinimumMs ?? 5000) &&
    metrics.activeMs >= 1800 &&
    (wordCount >= 10 || unrelatedEvidence.explicitMedia);
  const strongEvidence = unrelatedEvidence.score >= 2 || unrelatedEvidence.explicitMedia;
  if (prolonged && strongEvidence) {
    const confidence = Math.min(0.99, 0.9 + unrelatedEvidence.score * 0.025 + (metrics.durationMs >= 8000 ? 0.02 : 0));
    return decision(
      "CONFIRMED_HOT_MIC",
      confidence,
      `Prolonged unrelated audio with strong accidental-open-mic evidence: ${unrelatedEvidence.reasons.join(", ")}.`,
      false,
      false,
    );
  }
  return decision(
    "UNCLEAR_RADIO_TRAFFIC",
    0.68,
    "No dispatch information was confirmed, but the evidence is insufficient to punish as a hot mic.",
    false,
    true,
  );
}

export function isConfirmedHotMic(transcript, pcm, options = {}) {
  const result = classifyRadioTransmission({
    transcript,
    pcm,
    callsign: options.callsign,
    hotMicMinimumMs: options.minimumDurationMs,
    rmsThreshold: options.rmsThreshold,
  });
  return result.classification === "CONFIRMED_HOT_MIC" && result.confidence >= (options.confidenceThreshold ?? 0.9);
}

function compactSpokenRadioText(text) {
  const phonetics = {
    ADAM: "A",
    BOY: "B",
    CHARLES: "C",
    DAVID: "D",
    EDWARD: "E",
    FRANK: "F",
    GEORGE: "G",
    HENRY: "H",
    IDA: "I",
    JOHN: "J",
    KING: "K",
    LINCOLN: "L",
    MARY: "M",
    NORA: "N",
    OCEAN: "O",
    PAUL: "P",
    QUEEN: "Q",
    ROBERT: "R",
    SAM: "S",
    TOM: "T",
    UNION: "U",
    VICTOR: "V",
    WILLIAM: "W",
    XRAY: "X",
    YOUNG: "Y",
    ZEBRA: "Z",
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
    TEN: "10",
    ELEVEN: "11",
    TWELVE: "12",
    THIRTEEN: "13",
    FOURTEEN: "14",
    FIFTEEN: "15",
    SIXTEEN: "16",
    SEVENTEEN: "17",
    EIGHTEEN: "18",
    NINETEEN: "19",
  };
  return (
    text
      .toUpperCase()
      .replace(/X[\s-]?RAY/g, "XRAY")
      .match(/[A-Z]+|\d+/g)
      ?.map((token) => phonetics[token] ?? numbers[token] ?? token)
      .join("") ?? ""
  );
}

function unrelatedConversationEvidence(text) {
  const patterns = [
    [
      "casual conversation",
      /\b(?:what are you doing|how are you|did you see|do you want|are you going|i told you|you told me|he said|she said|we were talking)\b/i,
    ],
    ["personal plans", /\b(?:dinner|lunch|breakfast|going home|after work|this weekend|tomorrow night|pick me up)\b/i],
    [
      "entertainment or media",
      /\b(?:youtube|tiktok|television|\btv\b|movie|video game|playing a game|song|music|streaming|podcast)\b/i,
    ],
    [
      "room conversation",
      /\b(?:can you hear me|come here|look at this|give me that|where did you put|turn it up|turn it down)\b/i,
    ],
  ];
  const reasons = patterns.filter(([, pattern]) => pattern.test(text)).map(([reason]) => reason);
  const explicitMedia = /\b(?:youtube|tiktok|television|\btv\b|movie|video game|song|music|streaming|podcast)\b/i.test(
    text,
  );
  return { score: reasons.length, reasons, explicitMedia };
}

function decision(classification, confidence, reason, containsDispatchInformation, requiresRepeat) {
  return { classification, confidence, reason, containsDispatchInformation, requiresRepeat };
}
