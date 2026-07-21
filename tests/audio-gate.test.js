import { describe, expect, it } from "vitest";
import {
  analyzePcm16Mono,
  classifyRadioTransmission,
  describeOfficerPanic,
  isConfirmedHotMic,
  isDirectedRadioTraffic,
  isEmergencyTraffic,
  isLikelySpeech,
  isOfficerPanicTraffic,
} from "../src/voice/audio-gate.js";

function constantPcm(amplitude, durationMs, sampleRate = 48_000) {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(amplitude, index * 2);
  return buffer;
}

describe("voice noise gate", () => {
  it("rejects silence, brief clicks, and low-level background noise", () => {
    expect(isLikelySpeech(constantPcm(0, 1000))).toBe(false);
    expect(isLikelySpeech(constantPcm(5000, 40))).toBe(false);
    expect(isLikelySpeech(constantPcm(150, 1000))).toBe(false);
  });

  it("accepts sustained speech-level PCM", () => {
    const pcm = constantPcm(2200, 400);
    expect(isLikelySpeech(pcm)).toBe(true);
    expect(analyzePcm16Mono(pcm)).toMatchObject({ peak: 2200 });
  });

  it("recognizes only explicit emergency declarations", () => {
    expect(isEmergencyTraffic("Emergency traffic, officer needs help")).toBe(true);
    expect(isEmergencyTraffic("Show me on scene at the bank")).toBe(false);
  });

  it("recognizes officer panic traffic without reopening a cleared shots-fired call", () => {
    expect(isOfficerPanicTraffic("1 Lincoln 18, shots fired, taking fire")).toBe(true);
    expect(isOfficerPanicTraffic("1 Lincoln 18, 10-99")).toBe(true);
    expect(isEmergencyTraffic("Signal 100, emergency traffic only")).toBe(true);
    expect(describeOfficerPanic("shots fired, taking fire")).toBe("is taking fire");
    expect(isOfficerPanicTraffic("1 Lincoln 18, Code 4 on the shots fired call")).toBe(false);
  });

  it("distinguishes directed radio traffic from unrelated background speech", () => {
    expect(isDirectedRadioTraffic("1 Lincoln 18", "1L-18")).toBe(true);
    expect(isDirectedRadioTraffic("Show me 10-8", "1L-18")).toBe(true);
    expect(isDirectedRadioTraffic("Are there any active BOLOs?", "1L-18")).toBe(true);
    expect(isDirectedRadioTraffic("¿Qué es el número de serie?", "1L-18")).toBe(false);
  });
  it("confirms sustained background conversation as a hot mic but ignores brief activations", () => {
    const unrelated = "What are you doing? Come here and look at this video game on YouTube with me.";
    expect(isConfirmedHotMic(unrelated, constantPcm(2200, 6000), { callsign: "1L-18" })).toBe(true);
    expect(isConfirmedHotMic(unrelated, constantPcm(2200, 400), { callsign: "1L-18" })).toBe(false);
    expect(isConfirmedHotMic("Dispatch, show me 10-8 please", constantPcm(2200, 6000), { callsign: "1L-18" })).toBe(
      false,
    );
    expect(
      classifyRadioTransmission({ transcript: "music", pcm: constantPcm(2200, 6000), callsign: "1L-18" }),
    ).toMatchObject({
      classification: "CONFIRMED_HOT_MIC",
      containsDispatchInformation: false,
    });
  });

  it("classifies operational traffic before considering hot-mic evidence", () => {
    const cases = [
      "One Lincoln 18, unable to find suspect in vicinity. Be on the lookout for a red sedan.",
      "One Lincoln 18, no suspect on scene.",
      "One Lincoln 18, suspect last seen heading west on Franklin Court on foot.",
      "Um, correction, One Lincoln 18, suspect is now eastbound.",
    ];
    for (const transcript of cases) {
      expect(classifyRadioTransmission({ transcript, pcm: constantPcm(2200, 9000), callsign: "1L-18" })).toMatchObject({
        classification: "VALID_RADIO_TRAFFIC",
        containsDispatchInformation: true,
      });
    }
  });

  it("separates unclear traffic, brief noise, cross traffic, and emergencies", () => {
    expect(
      classifyRadioTransmission({ transcript: "um", pcm: constantPcm(2200, 1200), callsign: "1L-18" }),
    ).toMatchObject({ classification: "UNCLEAR_RADIO_TRAFFIC", requiresRepeat: true });
    expect(
      classifyRadioTransmission({ transcript: "static", pcm: constantPcm(2200, 300), callsign: "1L-18" }),
    ).toMatchObject({ classification: "BRIEF_ACCIDENTAL_NOISE" });
    expect(
      classifyRadioTransmission({
        transcript: "I was just talking",
        pcm: constantPcm(2200, 6000),
        callsign: "1L-18",
        overlap: true,
      }),
    ).toMatchObject({ classification: "CROSS_TRANSMISSION" });
    expect(
      classifyRadioTransmission({
        transcript: "Emergency traffic, shots fired",
        pcm: constantPcm(2200, 1200),
        callsign: "1L-18",
        overlap: true,
      }),
    ).toMatchObject({ classification: "EMERGENCY_INTERRUPTION" });
  });
});
