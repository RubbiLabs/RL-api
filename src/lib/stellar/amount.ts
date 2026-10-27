import { Prisma } from "@prisma/client"

/** USDC on Stellar has 7 decimals; contract amounts are i128 stroops. */
export const USDC_DECIMALS = 7
const SCALE = 10n ** BigInt(USDC_DECIMALS)

/**
 * Converts an i128 stroop amount to a 7-decimal `Prisma.Decimal`, using
 * string arithmetic only. Negative inputs are rejected: contract amounts are
 * always positive and a sign is applied by the caller.
 */
export function stroopsToDecimal(stroops: bigint | string): Prisma.Decimal {
  const value = typeof stroops === "bigint" ? stroops : BigInt(stroops)
  if (value < 0n) {
    throw new Error(`negative stroop amount: ${value}`)
  }
  const whole = value / SCALE
  const fraction = (value % SCALE).toString().padStart(USDC_DECIMALS, "0")
  return new Prisma.Decimal(`${whole}.${fraction}`)
}

/**
 * Converts a decimal USDC amount (string or Decimal) to i128 stroops.
 * Rejects more than 7 decimals, negative and non-finite values.
 */
export function decimalToStroops(amount: Prisma.Decimal | string): bigint {
  const decimal = typeof amount === "string" ? new Prisma.Decimal(amount) : amount
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new Error(`invalid USDC amount: ${decimal.toString()}`)
  }
  if (decimal.decimalPlaces() > USDC_DECIMALS) {
    throw new Error(`USDC amounts have at most ${USDC_DECIMALS} decimals: ${decimal.toString()}`)
  }
  return BigInt(decimal.mul(SCALE.toString()).toFixed(0))
}

/** `true` when `amount` is a positive USDC amount with at most 7 decimals. */
export function isValidUsdcAmount(amount: string): boolean {
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) return false
  return new Prisma.Decimal(amount).greaterThan(0)
}

/** Plain decimal notation (never exponent form) for API responses and logs. */
export function formatUsdc(amount: Prisma.Decimal): string {
  return amount.toFixed()
}
