import { env } from "../config/index.js"

export type AlertCondition =
  | "keeper_run_failure"
  | "items_failing_alone"
  | "keeper_low_xlm"
  | "indexer_gap_detected"

export interface AlertPayload {
  condition: AlertCondition
  message: string
  details?: Record<string, unknown>
  timestamp: string
}

export class AlertDispatcher {
  private lastSentByCondition = new Map<AlertCondition, number>()
  public suppressionWindowMs = 60 * 60 * 1000 // 1 hour

  async dispatch(
    condition: AlertCondition,
    message: string,
    details?: Record<string, unknown>,
    nowMs: number = Date.now(),
  ): Promise<boolean> {
    const webhookUrl = env.ALERT_WEBHOOK_URL
    if (!webhookUrl) return false

    const lastSent = this.lastSentByCondition.get(condition)
    if (lastSent && nowMs - lastSent < this.suppressionWindowMs) {
      return false // Suppressed by rate limit
    }

    this.lastSentByCondition.set(condition, nowMs)

    const payload: AlertPayload = {
      condition,
      message,
      details,
      timestamp: new Date(nowMs).toISOString(),
    }

    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      return true
    } catch {
      return false
    }
  }

  reset() {
    this.lastSentByCondition.clear()
  }
}

export const alerts = new AlertDispatcher()
