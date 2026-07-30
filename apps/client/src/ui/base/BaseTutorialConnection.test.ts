import { describe, expect, it } from "vitest";
import { resumeInputSequence } from "./BaseTutorialConnection";

describe("BaseTutorialConnection replay cursor", () => {
  it("starts at zero and resumes after the server's last accepted frame", () => {
    expect(resumeInputSequence(0, -1)).toBe(0);
    expect(resumeInputSequence(1, 0)).toBe(1);
    expect(resumeInputSequence(0, 47)).toBe(48);
  });

  it("never rewinds when an older acknowledgement arrives", () => {
    expect(resumeInputSequence(52, 47)).toBe(52);
  });
});
