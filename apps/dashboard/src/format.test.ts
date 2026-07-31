import { describe, expect, it } from "vitest";
import { relativeTime } from "./format";

describe("relativeTime", () => {
  it("formats recent timestamps", () => {
    expect(relativeTime(90_000, 100_000)).toBe("10 秒前");
    expect(relativeTime(40_000, 100_000)).toBe("1 分鐘前");
  });
});

