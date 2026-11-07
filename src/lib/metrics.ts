export interface KeeperHealthInfo {
  lastRunAt: string | null
  lastResult: "ok" | "failed" | null
  heldItems: number
}

export interface IndexerHealthInfo {
  cursorLedger: number | null
  latestLedger: number | null
  lagLedgers: number | null
}

export class MetricsRegistry {
  private keeperRuns: Record<"ok" | "failed", number> = { ok: 0, failed: 0 }
  private keeperItems: Map<string, number> = new Map()
  private keeperLastRunTimestamp: number | null = null
  private keeperLastRunAt: string | null = null
  private keeperLastRunResult: "ok" | "failed" | null = null
  private keeperHoldsActive: number = 0
  private keeperAccountXlmBalance: number = 0

  private indexerCursorLedger: number | null = null
  private indexerLatestLedger: number | null = null
  private indexerLagLedgers: number | null = null
  private indexerUnresolvedGaps: number = 0

  incKeeperRuns(result: "ok" | "failed", amount = 1) {
    this.keeperRuns[result] = (this.keeperRuns[result] || 0) + amount
  }

  incKeeperItems(kind: "charge" | "disburse", result: string, amount = 1) {
    const key = `${kind}|${result}`
    this.keeperItems.set(key, (this.keeperItems.get(key) || 0) + amount)
  }

  setKeeperLastRun(timestampSeconds: number, dateIso: string, result: "ok" | "failed") {
    this.keeperLastRunTimestamp = timestampSeconds
    this.keeperLastRunAt = dateIso
    this.keeperLastRunResult = result
  }

  setKeeperHoldsActive(count: number) {
    this.keeperHoldsActive = count
  }

  setKeeperAccountXlmBalance(balance: number) {
    this.keeperAccountXlmBalance = balance
  }

  setIndexerProgress(cursor: number, latest: number, lag: number) {
    this.indexerCursorLedger = cursor
    this.indexerLatestLedger = latest
    this.indexerLagLedgers = lag
  }

  incIndexerUnresolvedGaps(amount = 1) {
    this.indexerUnresolvedGaps += amount
  }

  getKeeperHealth(): KeeperHealthInfo {
    return {
      lastRunAt: this.keeperLastRunAt,
      lastResult: this.keeperLastRunResult,
      heldItems: this.keeperHoldsActive,
    }
  }

  getIndexerHealth(): IndexerHealthInfo {
    return {
      cursorLedger: this.indexerCursorLedger,
      latestLedger: this.indexerLatestLedger,
      lagLedgers: this.indexerLagLedgers,
    }
  }

  renderPrometheus(): string {
    const lines: string[] = []

    lines.push("# HELP keeper_runs_total Total keeper runs by result")
    lines.push("# TYPE keeper_runs_total counter")
    lines.push(`keeper_runs_total{result="ok"} ${this.keeperRuns.ok}`)
    lines.push(`keeper_runs_total{result="failed"} ${this.keeperRuns.failed}`)
    lines.push("")

    lines.push("# HELP keeper_items_total Total items processed by the keeper")
    lines.push("# TYPE keeper_items_total counter")
    const standardKeys = [
      { kind: "charge", result: "charged" },
      { kind: "charge", result: "not_due" },
      { kind: "charge", result: "past_due" },
      { kind: "charge", result: "skipped" },
      { kind: "charge", result: "held" },
      { kind: "charge", result: "failed" },
      { kind: "disburse", result: "disbursed" },
      { kind: "disburse", result: "not_due" },
      { kind: "disburse", result: "past_due" },
      { kind: "disburse", result: "skipped" },
      { kind: "disburse", result: "held" },
      { kind: "disburse", result: "failed" },
    ]
    for (const { kind, result } of standardKeys) {
      const val = this.keeperItems.get(`${kind}|${result}`) || 0
      lines.push(`keeper_items_total{kind="${kind}",result="${result}"} ${val}`)
    }
    lines.push("")

    lines.push("# HELP keeper_last_run_timestamp Unix timestamp in seconds of the last keeper run")
    lines.push("# TYPE keeper_last_run_timestamp gauge")
    lines.push(`keeper_last_run_timestamp ${this.keeperLastRunTimestamp ?? 0}`)
    lines.push("")

    lines.push("# HELP keeper_holds_active Number of active keeper holds")
    lines.push("# TYPE keeper_holds_active gauge")
    lines.push(`keeper_holds_active ${this.keeperHoldsActive}`)
    lines.push("")

    lines.push("# HELP keeper_account_xlm_balance XLM balance of the keeper account")
    lines.push("# TYPE keeper_account_xlm_balance gauge")
    lines.push(`keeper_account_xlm_balance ${this.keeperAccountXlmBalance}`)
    lines.push("")

    lines.push("# HELP indexer_cursor_ledger Last indexed ledger sequence")
    lines.push("# TYPE indexer_cursor_ledger gauge")
    lines.push(`indexer_cursor_ledger ${this.indexerCursorLedger ?? 0}`)
    lines.push("")

    lines.push("# HELP indexer_lag_ledgers Number of ledgers the indexer is behind latest")
    lines.push("# TYPE indexer_lag_ledgers gauge")
    lines.push(`indexer_lag_ledgers ${this.indexerLagLedgers ?? 0}`)
    lines.push("")

    lines.push("# HELP indexer_unresolved_gaps Number of unresolved chain gaps")
    lines.push("# TYPE indexer_unresolved_gaps gauge")
    lines.push(`indexer_unresolved_gaps ${this.indexerUnresolvedGaps}`)
    lines.push("")

    return lines.join("\n")
  }

  reset() {
    this.keeperRuns = { ok: 0, failed: 0 }
    this.keeperItems.clear()
    this.keeperLastRunTimestamp = null
    this.keeperLastRunAt = null
    this.keeperLastRunResult = null
    this.keeperHoldsActive = 0
    this.keeperAccountXlmBalance = 0
    this.indexerCursorLedger = null
    this.indexerLatestLedger = null
    this.indexerLagLedgers = null
    this.indexerUnresolvedGaps = 0
  }
}

export const metrics = new MetricsRegistry()
