import { describe, expect, it } from "vitest";
import { nextLayerDown } from "../../packages/core/src/index";

describe("nextLayerDown", () => {
  it("steps down one layer at a time", () => {
    expect(nextLayerDown("chair")).toBe("director");
    expect(nextLayerDown("director")).toBe("department");
    expect(nextLayerDown("department")).toBe("worker");
  });

  it("refuses to delegate past worker -- the bottom of the chain", () => {
    expect(nextLayerDown("worker")).toBeNull();
  });
});
