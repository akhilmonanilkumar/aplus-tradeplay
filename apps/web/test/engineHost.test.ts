import { describe, expect, it } from "vitest";
import { engineSignature } from "@/lib/server/engineHost";

describe("engine host signing", () => {
  it("matches the host's verification scheme", () => {
    // Same vector as services/engine (computed with Python's hmac module).
    expect(engineSignature("s3cret", "1700000000000", "GET", "/status", "")).toBe("ddaaa859d325078c1798c3073176e60cacd36e517b50b2beca3d461f30b249d2");
  });
});
