import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RadioCodebook } from "../src/radio/codebook.js";

const codes = JSON.parse(await readFile(new URL("../config/radio-codes.json", import.meta.url), "utf8"));

describe("department radio codes", () => {
  it("contains the supplied operational 10-code set", () => {
    const expected = [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30, 31, 32,
      34, 35, 36, 37, 38, 39, 41, 42, 43, 44, 45, 46, 50, 51, 52, 53, 54, 55, 56, 60, 61, 62, 63, 64, 65, 66, 67, 70,
      71, 73, 76, 80, 85, 86, 88, 89, 90, 91, 93, 94, 97, 99,
    ].map((number) => `10-${number}`);
    expect(
      Object.keys(codes)
        .filter((code) => code.startsWith("10-"))
        .sort(),
    ).toEqual(expected.sort());
    expect(codes["10-1"].meaning).toBe("Frequency Change");
    expect(codes["10-11"].meaning).toBe("Traffic Stop");
    expect(codes["10-13"].meaning).toBe("Shots Fired");
    expect(codes["10-50"].meaning).toBe("Vehicle Accident");
    expect(codes["10-99"].meaning).toBe("Officer In Distress");
    expect(codes["11-44"].meaning).toBe("Person Deceased");
  });

  it("defines response and scene-clear codes", () => {
    expect(codes["Code 1"].meaning).toBe("Routine Response");
    expect(codes["Code 3"].meaning).toBe("Emergency Response");
    expect(codes["Code 4"].meaning).toBe("Scene Handled");
    expect(codes["Code 5"].meaning).toContain("Felony Stop");
    expect(codes["Code 6"].meaning).toBe("In The Area");
    expect(codes["Signal 11"].meaning).toBe("Running Radar");
    expect(codes["Signal 13"].meaning).toBe("Clear for Crime Broadcast");
    expect(codes["Signal 100"].meaning).toBe("Emergency Traffic Only");
  });

  it("ships without conflicting aliases or invalid action mappings", async () => {
    const codebook = await RadioCodebook.load(new URL("../config/radio-codes.json", import.meta.url));
    expect(codebook.validate()).toEqual([]);
  });
});
