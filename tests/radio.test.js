import { describe, expect, it } from "vitest";
import {
  detectRadioCode,
  enforceFullCallsign,
  normalizeCallsign,
  speakCallsign,
  speakPlate,
} from "../src/utils/radio.js";
describe("radio formatting", () => {
  it("normalizes and speaks compact callsigns", () => {
    expect(normalizeCallsign("1l\u201318")).toBe("1L-18");
    expect(speakCallsign("1L-18")).toBe("1-Lincoln-18");
    expect(speakCallsign("1S-03")).toBe("1-Sam-03");
    expect(speakCallsign("1S-02")).toBe("1-Sam-02");
    expect(speakCallsign("1C-1")).toBe("1-Charles-1");
  });
  it("expands shortened dispatcher references while accepting an already complete spoken callsign", () => {
    expect(enforceFullCallsign("Lincoln 18, copy.", "1L-18")).toEqual({ text: "1-Lincoln-18, copy.", changed: true });
    expect(enforceFullCallsign("1 Lincoln 18, copy.", "1L-18")).toEqual({
      text: "1 Lincoln 18, copy.",
      changed: false,
    });
  });
  it("uses law-enforcement phonetics for plates", () => {
    expect(speakPlate("ABC-123")).toBe("Adam-Boy-Charles-1-2-3");
    expect(speakPlate("GT9*")).toBe("George-Tom-9-unknown characters");
    expect(speakPlate("ABC123|ABC128")).toContain(" or ");
  });
  it("maps configured incident aliases", () => {
    expect(detectRadioCode("two-car crash")).toBe("10-50");
    expect(detectRadioCode("unknown disturbance")).toBe("10-18");
  });
  it("maps common call descriptions to the configured department codes", () => {
    expect(detectRadioCode("armed robbery in progress")).toBe("10-65");
    expect(detectRadioCode("commercial bank alarm")).toBe("10-90");
    expect(detectRadioCode("domestic disturbance")).toBe("10-18");
  });
});
