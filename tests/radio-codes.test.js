import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RadioCodebook } from "../src/radio/codebook.js";

const codes = JSON.parse(await readFile(new URL("../config/radio-codes.json", import.meta.url), "utf8"));

describe("department radio codes", () => {
  it("contains the supplied operational 10-code set", () => {
    expect(Object.keys(codes).filter((code) => code.startsWith("10-")).length).toBeGreaterThanOrEqual(103);
    expect(codes["10-1"].meaning).toBe("Signal Weak");
    expect(codes["10-50"].meaning).toBe("Motor Vehicle Accident");
    expect(codes["10-108"].meaning).toBe("Building Check");
  });

  it("defines response and scene-clear codes", () => {
    expect(codes["Code 1"].meaning).toBe("Routine Response");
    expect(codes["Code 3"].meaning).toBe("Emergency Response");
    expect(codes["Code 4"].meaning).toContain("Scene Secure");
    expect(codes["Code 5"].meaning).toContain("Felony Stop");
  });

  it("ships without conflicting aliases or invalid action mappings", async () => {
    const codebook = await RadioCodebook.load(new URL("../config/radio-codes.json", import.meta.url));
    expect(codebook.validate()).toEqual([]);
  });
});
