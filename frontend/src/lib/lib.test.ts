import { afterEach, describe, expect, it } from "vitest";
import { formatAmount, formatProbability, formatTimestamp, toFiniteNumber } from "./format";
import { safeNextPath } from "./navigation";
import { isAllowedAnalyst } from "./server/auth";

describe("formatting", () => {
  it("parses PostgREST numeric strings and rejects junk", () => {
    expect(toFiniteNumber("12.5")).toBe(12.5);
    expect(toFiniteNumber("")).toBeNull();
    expect(toFiniteNumber("abc")).toBeNull();
    expect(toFiniteNumber(Infinity)).toBeNull();
    expect(toFiniteNumber(null)).toBeNull();
  });

  it("renders amounts without inventing a currency", () => {
    expect(formatAmount(1234.5)).toBe("1,234.50");
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount(1e15)).toBe("1,000,000,000,000,000.00");
  });

  it("only treats values in [0, 1] as probabilities", () => {
    expect(formatProbability(0.405)).toBe("40.5%");
    expect(formatProbability("0.98", 2)).toBe("98.00%");
    expect(formatProbability(1.5)).toBe("—");
    expect(formatProbability(-0.1)).toBe("—");
  });

  it("formats timestamps in UTC and tolerates invalid input", () => {
    expect(formatTimestamp("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04 UTC");
    expect(formatTimestamp("not a date")).toBe("—");
    expect(formatTimestamp(null)).toBe("—");
  });
});

describe("safeNextPath", () => {
  it.each([
    ["/network?account=abc", "/network?account=abc"],
    ["/alerts", "/alerts"],
    ["https://evil.example", "/alerts"],
    ["//evil.example", "/alerts"],
    ["/\\evil.example", "/alerts"],
    ["/login?next=/x", "/alerts"],
    [null, "/alerts"],
  ])("maps %s to %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe("analyst allowlist", () => {
  const original = process.env.MULEWATCH_ANALYST_EMAILS;

  afterEach(() => {
    if (original === undefined) delete process.env.MULEWATCH_ANALYST_EMAILS;
    else process.env.MULEWATCH_ANALYST_EMAILS = original;
  });

  it("allows any authenticated user when unset", () => {
    delete process.env.MULEWATCH_ANALYST_EMAILS;
    expect(isAllowedAnalyst("anyone@example.com")).toBe(true);
  });

  it("matches listed emails case-insensitively", () => {
    process.env.MULEWATCH_ANALYST_EMAILS = " Analyst@Example.com , second@example.com";
    expect(isAllowedAnalyst("analyst@example.com")).toBe(true);
    expect(isAllowedAnalyst("SECOND@example.com")).toBe(true);
    expect(isAllowedAnalyst("intruder@example.com")).toBe(false);
    expect(isAllowedAnalyst(undefined)).toBe(false);
  });
});
