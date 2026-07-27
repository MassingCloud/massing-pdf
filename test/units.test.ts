import { describe, expect, it } from "vitest";
import {
  SCALE_PRESETS, calibrationFromMeasure, calibrationFromPreset, convertLength, findPreset,
  formatFeetInches, formatQuantity, measure, parseLength, recalculate,
} from "../src/core/units";
import type { Calibration } from "../src/core/types";

describe("scale presets", () => {
  it('derives 1/4" = 1\'-0" as 4 feet per plotted inch', () => {
    const p = findPreset(`1/4" = 1'-0"`)!;
    // One PDF point is 1/72", so a point covers 4/72 ft.
    expect(p.unitsPerPoint).toBeCloseTo(4 / 72, 9);
    // A 72pt line (one plotted inch) is therefore 4 feet.
    expect(72 * p.unitsPerPoint).toBeCloseTo(4, 9);
  });

  it("derives 1:100 as 100 mm of reality per plotted mm", () => {
    const p = findPreset("1:100")!;
    // One inch plotted = 100 inches real = 2.54 m; a point is 1/72 of that.
    expect(72 * p.unitsPerPoint).toBeCloseTo(2.54, 6);
  });

  it("builds a calibration from a preset label", () => {
    const cal = calibrationFromPreset(`1/8" = 1'-0"`, 3);
    expect(cal).toMatchObject({ unit: "ft", source: "preset", page: 3 });
    expect(cal!.unitsPerPoint).toBeCloseTo(8 / 72, 9);
  });

  it("returns null for an unknown preset rather than a wrong scale", () => {
    expect(calibrationFromPreset("1/7\" = 1'-0\"")).toBeNull();
  });

  it("offers both imperial and metric scales", () => {
    expect(SCALE_PRESETS.some((p) => p.system === "imperial")).toBe(true);
    expect(SCALE_PRESETS.some((p) => p.system === "metric")).toBe(true);
  });
});

describe("calibration from a drawn line", () => {
  it("derives units per point from a measured line", () => {
    const cal = calibrationFromMeasure(100, 5, "m")!;
    expect(cal.unitsPerPoint).toBeCloseTo(0.05, 9);
    expect(cal.unit).toBe("m");
    expect(cal.source).toBe("measured");
  });

  it("recognises when a hand-drawn calibration lands on a standard scale", () => {
    // 72pt drawn as 4ft is exactly 1/4" = 1'-0".
    const cal = calibrationFromMeasure(72, 4, "ft")!;
    expect(cal.label).toBe(`1/4" = 1'-0"`);
  });

  it("leaves the label unset when it matches no standard scale", () => {
    const cal = calibrationFromMeasure(72, 3.3, "ft")!;
    expect(cal.label).toBeUndefined();
  });

  it("rejects a zero-length or zero-value calibration", () => {
    expect(calibrationFromMeasure(0, 5, "m")).toBeNull();
    expect(calibrationFromMeasure(100, 0, "m")).toBeNull();
  });
});

describe("parseLength", () => {
  it("parses a bare number with the fallback unit", () => {
    expect(parseLength("5", "m")).toEqual({ value: 5, unit: "m" });
  });

  it("parses decimal values with a unit suffix", () => {
    expect(parseLength("12.5 ft")).toEqual({ value: 12.5, unit: "ft" });
    expect(parseLength("300mm")).toEqual({ value: 300, unit: "mm" });
    expect(parseLength("4 meters")).toEqual({ value: 4, unit: "m" });
  });

  it("parses feet and inches", () => {
    expect(parseLength(`12'-6"`)!.unit).toBe("ft");
    expect(parseLength(`12'-6"`)!.value).toBeCloseTo(12.5, 9);
    expect(parseLength(`12'`)!.value).toBeCloseTo(12, 9);
    expect(parseLength(`6"`)!.value).toBeCloseTo(0.5, 9);
  });

  it("parses fractional inches", () => {
    expect(parseLength(`12' 6 1/2"`)!.value).toBeCloseTo(12 + 6.5 / 12, 9);
    expect(parseLength(`3/4"`)!.value).toBeCloseTo(0.0625, 9);
  });

  it("rejects nonsense instead of guessing", () => {
    expect(parseLength("about five metres")).toBeNull();
    expect(parseLength("")).toBeNull();
  });
});

describe("formatting", () => {
  it("renders decimal feet as feet and inches", () => {
    expect(formatFeetInches(12.5)).toBe(`12'-6"`);
    expect(formatFeetInches(12)).toBe(`12'-0"`);
  });

  it("reduces inch fractions", () => {
    expect(formatFeetInches(1 + 6.5 / 12)).toBe(`1'-6 1/2"`);
    expect(formatFeetInches(1 + 6.25 / 12)).toBe(`1'-6 1/4"`);
  });

  it("carries a rounded-up inch into the next foot", () => {
    // 11.999 inches must not render as 0'-12".
    expect(formatFeetInches(11.9999 / 12)).toBe(`1'-0"`);
  });

  it("renders counts, angles and areas with their own conventions", () => {
    expect(formatQuantity({ value: 7, unit: "ea" })).toBe("7 ea");
    expect(formatQuantity({ value: 90.4, unit: "°" })).toBe("90.4°");
    expect(formatQuantity({ value: 120.5, unit: "ft²" })).toBe("120.50 SF");
    expect(formatQuantity({ value: 12.34, unit: "m" })).toBe("12.34 m");
  });

  it("can render imperial as decimal when asked", () => {
    expect(formatQuantity({ value: 12.5, unit: "ft" }, { feetInches: false })).toBe("12.50 ft");
  });
});

describe("measure", () => {
  const cal: Calibration = { unitsPerPoint: 0.05, unit: "m", source: "measured", page: 1 };

  it("measures distance against a calibration", () => {
    const q = measure("distance", [{ x: 0, y: 0 }, { x: 100, y: 0 }], cal)!;
    expect(q.value).toBeCloseTo(5, 9);
    expect(q.unit).toBe("m");
    expect(q.raw).toBe(100);
  });

  it("squares the scale factor for areas", () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const q = measure("area", square, cal)!;
    // 100pt × 100pt at 0.05 m/pt is 5m × 5m.
    expect(q.value).toBeCloseTo(25, 9);
    expect(q.unit).toBe("m²");
  });

  it("cubes the scale factor and applies depth for volumes", () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const q = measure("volume", square, cal, 2)!;
    expect(q.value).toBeCloseTo(50, 9);
    expect(q.unit).toBe("m³");
  });

  it("counts and measures angles without needing a calibration", () => {
    expect(measure("count", [{ x: 1, y: 1 }], undefined)!.unit).toBe("ea");
    const angle = measure("angle", [{ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10, y: 0 }], undefined)!;
    expect(angle.value).toBeCloseTo(90, 6);
  });

  it("refuses to invent a length without a calibration", () => {
    expect(measure("distance", [{ x: 0, y: 0 }, { x: 100, y: 0 }], undefined)).toBeNull();
    expect(measure("area", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], undefined)).toBeNull();
  });
});

describe("recalculate", () => {
  it("re-derives a length from the retained raw magnitude", () => {
    const cal: Calibration = { unitsPerPoint: 0.1, unit: "m", source: "preset", page: 1 };
    const q = recalculate({ value: 5, unit: "m", raw: 100 }, "distance", cal);
    expect(q.value).toBeCloseTo(10, 9);
  });

  it("re-derives an area with the squared factor", () => {
    const cal: Calibration = { unitsPerPoint: 0.1, unit: "m", source: "preset", page: 1 };
    const q = recalculate({ value: 25, unit: "m²", raw: 10000 }, "area", cal);
    expect(q.value).toBeCloseTo(100, 9);
    expect(q.unit).toBe("m²");
  });

  it("leaves counts alone", () => {
    const cal: Calibration = { unitsPerPoint: 0.1, unit: "m", source: "preset", page: 1 };
    const q = { value: 3, unit: "ea", raw: 3 };
    expect(recalculate(q, "count", cal)).toEqual(q);
  });
});

describe("unit conversion", () => {
  it("converts between imperial and metric", () => {
    expect(convertLength(1, "ft", "m")).toBeCloseTo(0.3048, 9);
    expect(convertLength(1000, "mm", "m")).toBeCloseTo(1, 9);
    expect(convertLength(12, "in", "ft")).toBeCloseTo(1, 9);
  });
});
