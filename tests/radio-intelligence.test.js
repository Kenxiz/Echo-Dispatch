import { describe, expect, it } from "vitest";
import {
  assessTransmissionConfidence,
  compressRadioTraffic,
  confidenceReply,
  nextAcknowledgement,
} from "../src/voice/radio-intelligence.js";

describe("confidence-based radio intelligence", () => {
  it("executes clear traffic and requests a targeted clarification for uncertain traffic", () => {
    expect(
      assessTransmissionConfidence("Dispatch, 1 Lincoln 12, show me 10-8.", {
        outputTranscript: "10-4",
        audio: Buffer.from([1]),
      }),
    ).toMatchObject({ disposition: "EXECUTE" });
    const uncertain = assessTransmissionConfidence("I have one detained, maybe deceased", {
      outputTranscript: "copy",
      audio: Buffer.from([1]),
    });
    expect(uncertain.disposition).toBe("CLARIFY");
    expect(confidenceReply({ callsign: "1L-12" }, uncertain, "one detained or deceased")).toContain(
      "one detained or one deceased",
    );
  });

  it("uses 10-9 only for low-confidence traffic", () => {
    const assessment = assessTransmissionConfidence("unclear something maybe", {
      outputTranscript: "",
      audio: Buffer.alloc(0),
    });
    expect(assessment.disposition).toBe("REPEAT");
    expect(confidenceReply({ callsign: "1L-12" }, assessment)).toBe("1-Lincoln-12, 10-9 your traffic.");
  });

  it("extracts compressed operational facts and varies acknowledgements", () => {
    expect(compressRadioTraffic("Starting pursuit of a white sedan, plate ABC123, requesting K9")).toEqual(
      expect.arrayContaining(["Pursuit", "K9 requested", "Plate ABC123", "White Sedan"]),
    );
    expect(nextAcknowledgement()).not.toBe(nextAcknowledgement());
  });
});
