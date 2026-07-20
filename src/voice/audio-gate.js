export const EMERGENCY_TRAFFIC_PATTERN = /\b(?:emergency traffic|officer (?:needs help|down)|shots? fired|send everybody|hold the air|priority traffic|need units now|assist officer|being shot at)\b/i;
export const OFFICER_PANIC_PATTERN = /\b(?:10-33|mass panic|panic (?:button|alarm|traffic)|emergency traffic|officer (?:needs help|down|in distress)|shots? fired|being shot at|taking fire|under fire|assist officer|send everybody|need units now)\b/i;

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
    durationMs: sampleCount / sampleRate * 1000,
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
  return metrics.durationMs >= minimumDurationMs
    && metrics.rms >= rmsThreshold
    && metrics.peak >= Math.max(1_200, rmsThreshold * 2)
    && metrics.activeMs >= minimumActiveMs;
}

export function isEmergencyTraffic(transcript) {
    return EMERGENCY_TRAFFIC_PATTERN.test(transcript);
}

export function isOfficerPanicTraffic(transcript) {
  if (/\b(?:clear|closed|code\s*4|disregard|cancel)\b.{0,40}\bshots? fired\b/i.test(transcript)) return false;
  return OFFICER_PANIC_PATTERN.test(transcript);
}

export function describeOfficerPanic(transcript) {
  if (/\b(?:being shot at|taking fire|under fire)\b/i.test(transcript)) return "is taking fire";
  if (/\bofficer down\b/i.test(transcript)) return "reports an officer down";
  if (/\bshots? fired\b/i.test(transcript)) return "reports shots fired";
  if (/\b(?:10-33|panic (?:button|alarm|traffic)|mass panic)\b/i.test(transcript)) return "activated an officer panic";
  return "declared emergency traffic";
}

export function isDirectedRadioTraffic(transcript, callsign = "") {
  const text = transcript.trim();
  if (!text) return false;
  const compactText = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const compactCallsign = callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compactCallsign && compactText.includes(compactCallsign)) return true;
  if (/\b\d+\s*(?:adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-?ray|young|zebra)\s*\d+\b/i.test(text)) return true;
  return isEmergencyTraffic(text) || /\b(?:dispatch|show me|10-\d+|signal\s+\d+|code\s*[1-4]|attach|call|clear me|en route|on scene|traffic|radio check|copy|go ahead|advise|status|check|confirm|acknowledge|radar|out with|respond|location|postal|unit|repeat|stand by|available|busy|station|transport|pursuit|backup|supervisor)\b/i.test(text);
}
