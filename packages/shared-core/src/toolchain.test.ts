// Toolchain sanity test. Verifies that Vitest + fast-check + TypeScript strict mode
// are wired up for the monorepo. Real domain tests land in task 2.x.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

describe("toolchain", () => {
  it("runs a vitest unit test", () => {
    expect(1 + 1).toBe(2);
  });

  it("runs a fast-check property", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
    );
  });
});
