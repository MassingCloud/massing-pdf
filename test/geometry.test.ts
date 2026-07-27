import { describe, expect, it } from "vitest";
import {
  angleAt, bbox, centroid, circumradius, cloudPath, distToSegment, mean, pathLength, perimeter,
  pointInPolygon, polygonArea, rectCorners, rotateAbout, scaleAbout, simplify, snapAngle,
} from "../src/core/geometry";

describe("length and area", () => {
  it("measures a polyline's length", () => {
    expect(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBe(5);
    expect(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }])).toBe(15);
  });

  it("returns zero length for a degenerate path", () => {
    expect(pathLength([])).toBe(0);
    expect(pathLength([{ x: 1, y: 1 }])).toBe(0);
  });

  it("closes the loop when measuring a perimeter", () => {
    const square = rectCorners({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(perimeter(square)).toBe(40);
  });

  it("measures polygon area regardless of winding order", () => {
    const cw = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(polygonArea(cw)).toBe(100);
    expect(polygonArea([...cw].reverse())).toBe(100);
  });

  it("measures a non-convex polygon (the shoelace, not the bounding box)", () => {
    // An L: 10×10 square with a 5×5 bite out of the top-right → 75.
    const l = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 },
      { x: 10, y: 5 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ];
    expect(polygonArea(l)).toBe(75);
  });

  it("treats a polygon of fewer than three points as having no area", () => {
    expect(polygonArea([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toBe(0);
  });
});

describe("angles and radii", () => {
  it("measures a right angle", () => {
    expect(angleAt({ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90, 6);
  });

  it("measures a straight line as 180 degrees", () => {
    expect(angleAt({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 })).toBeCloseTo(180, 6);
  });

  it("recovers the radius of a circle through three points", () => {
    // Three points on a circle of radius 5 centred at the origin.
    const r = circumradius({ x: 5, y: 0 }, { x: 0, y: 5 }, { x: -5, y: 0 });
    expect(r).toBeCloseTo(5, 6);
  });

  it("reports zero radius for collinear points rather than infinity", () => {
    expect(circumradius({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toBe(0);
  });
});

describe("hit testing", () => {
  it("measures distance to a segment, clamping past the ends", () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 };
    expect(distToSegment({ x: 5, y: 3 }, a, b)).toBe(3);
    // Past the far end, the nearest point is the endpoint itself.
    expect(distToSegment({ x: 14, y: 0 }, a, b)).toBe(4);
  });

  it("detects points inside and outside a polygon", () => {
    const square = rectCorners({ x: 0, y: 0 }, { x: 10, y: 10 });
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it("computes a bounding box over unordered points", () => {
    expect(bbox([{ x: 5, y: 9 }, { x: -2, y: 1 }, { x: 3, y: 4 }]))
      .toEqual({ x: -2, y: 1, w: 7, h: 8 });
  });

  it("computes the area centroid, not the mean of the vertices", () => {
    // An L: a 6×2 band plus a 2×4 column. Its area centroid and its vertex mean differ, which is
    // the whole reason the quantity label uses the former — the latter drifts toward whichever
    // corner happens to have the most vertices.
    // This L is symmetric about y = x, so its centroid must sit on that line — which makes the
    // expected value checkable by inspection rather than by trusting the implementation.
    const l = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 6 }, { x: 0, y: 6 }];
    const c = centroid(l);
    expect(c.x).toBeCloseTo(2.2, 6);
    expect(c.y).toBeCloseTo(2.2, 6);
    expect(mean(l)).toEqual({ x: 16 / 6, y: 16 / 6 });
  });

  it("puts a convex shape's centroid at its centre", () => {
    expect(centroid(rectCorners({ x: 0, y: 0 }, { x: 10, y: 20 }))).toEqual({ x: 5, y: 10 });
  });

  it("falls back to the vertex mean for degenerate input", () => {
    expect(centroid([{ x: 2, y: 4 }])).toEqual({ x: 2, y: 4 });
    expect(centroid([])).toEqual({ x: 0, y: 0 });
    // Collinear points enclose no area, so there is no area centroid to compute.
    expect(centroid([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 });
  });
});

describe("transforms", () => {
  it("rotates about an origin", () => {
    const [p] = rotateAbout([{ x: 10, y: 0 }], { x: 0, y: 0 }, 90);
    expect(p!.x).toBeCloseTo(0, 6);
    expect(p!.y).toBeCloseTo(10, 6);
  });

  it("scales about an origin", () => {
    const [p] = scaleAbout([{ x: 10, y: 10 }], { x: 5, y: 5 }, 2);
    expect(p).toEqual({ x: 15, y: 15 });
  });

  it("snaps a drag to the nearest 15 degrees while preserving length", () => {
    const a = { x: 0, y: 0 };
    const snapped = snapAngle(a, { x: 10, y: 1 }, 15);
    expect(Math.hypot(snapped.x, snapped.y)).toBeCloseTo(Math.hypot(10, 1), 6);
    expect(Math.atan2(snapped.y, snapped.x)).toBeCloseTo(0, 6);
  });
});

describe("simplify", () => {
  it("collapses a straight run of ink to its endpoints", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplify(line, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 49, y: 0 }]);
  });

  it("keeps a corner that exceeds the tolerance", () => {
    const pts = [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }];
    expect(simplify(pts, 0.5)).toHaveLength(3);
  });

  it("leaves short paths untouched", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    expect(simplify(pts, 5)).toEqual(pts);
  });
});

describe("revision cloud", () => {
  it("emits a closed arc path", () => {
    const d = cloudPath(rectCorners({ x: 0, y: 0 }, { x: 40, y: 40 }), 6, true);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("A");
  });

  it("leaves an open cloud unclosed", () => {
    const d = cloudPath([{ x: 0, y: 0 }, { x: 40, y: 0 }], 6, false);
    expect(d.endsWith("Z")).toBe(false);
  });

  it("scales the number of scallops with the path length", () => {
    const short = cloudPath([{ x: 0, y: 0 }, { x: 20, y: 0 }], 6, false);
    const long = cloudPath([{ x: 0, y: 0 }, { x: 200, y: 0 }], 6, false);
    const arcs = (s: string) => (s.match(/A/g) ?? []).length;
    expect(arcs(long)).toBeGreaterThan(arcs(short));
  });

  it("produces nothing for a single point", () => {
    expect(cloudPath([{ x: 1, y: 1 }])).toBe("");
  });
});
