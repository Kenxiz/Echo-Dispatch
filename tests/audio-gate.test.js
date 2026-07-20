import { describe, expect, it } from "vitest";
import { analyzePcm16Mono, describeOfficerPanic, isDirectedRadioTraffic, isEmergencyTraffic, isLikelySpeech, isOfficerPanicTraffic } from "../src/voice/audio-gate.js";

function constantPcm(amplitude, durationMs, sampleRate = 48_000) {
  const samples = Math.floor(sampleRate * durationMs / 1000);
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
    expect(describeOfficerPanic("shots fired, taking fire")).toBe("is taking fire");
    expect(isOfficerPanicTraffic("1 Lincoln 18, Code 4 on the shots fired call")).toBe(false);
  });

  it("distinguishes directed radio traffic from unrelated background speech", () => {
    expect(isDirectedRadioTraffic("1 Lincoln 18", "1L-18")).toBe(true);
    expect(isDirectedRadioTraffic("Show me 10-8", "1L-18")).toBe(true);
    expect(isDirectedRadioTraffic("¿Qué es el número de serie?", "1L-18")).toBe(false);
  });
});
