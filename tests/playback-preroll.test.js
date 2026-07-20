import { describe, expect, it } from "vitest";
import { addPlaybackPreroll } from "../src/voice/playback.js";

describe("voice playback pre-roll", () => {
  it("adds silence before the first synthesized sample without altering the transmission", () => {
    const audio = Buffer.alloc(4);
    audio.writeInt16LE(1234, 0);
    audio.writeInt16LE(-1234, 2);
    const padded = addPlaybackPreroll(audio, 180);
    expect(padded.length).toBe(8_640 + audio.length);
    expect(padded.subarray(0, 8_640).every((value) => value === 0)).toBe(true);
    expect(padded.subarray(8_640)).toEqual(audio);
  });
});
