import { describe, expect, it } from "vitest";
import { isQuadValid, orderQuadCorners } from "./fitPerspectiveQuad";

describe("orderQuadCorners", () => {
  it("orders disordered corners into TL TR BR BL", () => {
    const q = orderQuadCorners([
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 0 },
    ]);
    expect(q.tl).toEqual({ x: 0, y: 0 });
    expect(q.tr).toEqual({ x: 10, y: 0 });
    expect(q.br).toEqual({ x: 10, y: 10 });
    expect(q.bl).toEqual({ x: 0, y: 10 });
    expect(isQuadValid(q)).toBe(true);
  });
});
