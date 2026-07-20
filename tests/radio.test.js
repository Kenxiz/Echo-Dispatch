import { describe, expect, it } from "vitest";
import { detectRadioCode, normalizeCallsign, speakCallsign, speakPlate } from "../src/utils/radio.js";
describe("radio formatting", () => {
  it("normalizes and speaks compact callsigns", () => {
    expect(normalizeCallsign("1l\u201318")).toBe("1L-18");
    expect(speakCallsign("1L-18")).toBe("1-Lincoln-18");
    expect(speakCallsign("1S-03")).toBe("1-Sam-03");
  });
  it("uses law-enforcement phonetics for plates", () => {
    expect(speakPlate("ABC-123")).toBe("Adam-Boy-Charles-1-2-3");
  });
  it("maps only known MVA aliases", () => {
    expect(detectRadioCode("two-car crash")).toBe("10-50");
    expect(detectRadioCode("unknown disturbance")).toBeNull();
  });
  it("maps common call descriptions to the configured department codes", () => {
    expect(detectRadioCode("armed robbery in progress")).toBe("10-65");
    expect(detectRadioCode("commercial bank alarm")).toBe("10-46");
    expect(detectRadioCode("domestic disturbance")).toBe("10-80");
  });
});
