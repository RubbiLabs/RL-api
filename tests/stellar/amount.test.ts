import { describe, expect, test } from "bun:test"
import { Prisma } from "@prisma/client"

import { decimalToStroops, formatUsdc, isValidUsdcAmount, stroopsToDecimal } from "../../src/lib/stellar/amount.js"

describe("stroopsToDecimal", () => {
  test("converts stroops to a 7-decimal Decimal with string arithmetic", () => {
    expect(formatUsdc(stroopsToDecimal(10_000_000n))).toBe("1")
    expect(formatUsdc(stroopsToDecimal(1n))).toBe("0.0000001")
    expect(formatUsdc(stroopsToDecimal("123456789"))).toBe("12.3456789")
    expect(formatUsdc(stroopsToDecimal(0n))).toBe("0")
  })

  test("keeps precision for very large i128 amounts", () => {
    const big = 123_456_789_012_345_678_901_234_567n
    expect(stroopsToDecimal(big).toFixed(7)).toBe("12345678901234567890.1234567")
  })

  test("rejects negative amounts", () => {
    expect(() => stroopsToDecimal(-1n)).toThrow("negative")
  })
})

describe("decimalToStroops", () => {
  test("round-trips with stroopsToDecimal", () => {
    for (const stroops of [1n, 7n, 10_000_000n, 123_456_789n, 999_999_999_999_999n]) {
      expect(decimalToStroops(stroopsToDecimal(stroops))).toBe(stroops)
    }
  })

  test("accepts strings and Decimals", () => {
    expect(decimalToStroops("25")).toBe(250_000_000n)
    expect(decimalToStroops("0.1")).toBe(1_000_000n)
    expect(decimalToStroops(new Prisma.Decimal("0.0000001"))).toBe(1n)
  })

  test("rejects more than 7 decimals, negatives and non-finite values", () => {
    expect(() => decimalToStroops("0.00000001")).toThrow("at most 7 decimals")
    expect(() => decimalToStroops("-1")).toThrow("invalid")
    expect(() => decimalToStroops("abc")).toThrow()
  })
})

describe("isValidUsdcAmount", () => {
  test("accepts positive amounts with up to 7 decimals", () => {
    expect(isValidUsdcAmount("1")).toBe(true)
    expect(isValidUsdcAmount("0.0000001")).toBe(true)
    expect(isValidUsdcAmount("12.5")).toBe(true)
  })

  test("rejects zero, negatives, exponents and too many decimals", () => {
    expect(isValidUsdcAmount("0")).toBe(false)
    expect(isValidUsdcAmount("-1")).toBe(false)
    expect(isValidUsdcAmount("1e3")).toBe(false)
    expect(isValidUsdcAmount("0.00000001")).toBe(false)
    expect(isValidUsdcAmount("1.")).toBe(false)
    expect(isValidUsdcAmount("")).toBe(false)
  })
})
