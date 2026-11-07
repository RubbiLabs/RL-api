import { beforeAll, describe, expect, mock, test } from "bun:test"
import fastifyPlugin from "fastify-plugin"

import { makeFakePrisma } from "../fakes/prisma.js"
import { seedEnv } from "../helpers.js"
import { metrics } from "../../src/lib/metrics.js"
import { alerts } from "../../src/lib/alerts.js"

mock.module("ioredis", () => {
  const store: Record<string, string> = {}
  class MockRedis {
    get = async (key: string) => store[key] ?? null
    set = async (key: string, value: string) => {
      store[key] = value
      return "OK"
    }
    exists = async (key: string) => (key in store ? 1 : 0)
    on() {
      return this
    }
    quit() {
      return Promise.resolve()
    }
  }
  return { default: MockRedis, Redis: MockRedis }
})

mock.module("bullmq", () => ({
  Worker: class {
    on() {
      return this
    }
    close() {
      return Promise.resolve()
    }
  },
  Queue: class {
    add() {
      return Promise.resolve({ id: "mock" })
    }
    upsertJobScheduler() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  },
}))

const fakePrisma = makeFakePrisma()
mock.module("../../src/plugins/prisma.js", () => ({
  prismaPlugin: fastifyPlugin(async (app: any) => {
    app.decorate("prisma", fakePrisma)
  }),
}))

beforeAll(() => {
  seedEnv()
})

async function build() {
  const { buildApp } = await import("../../src/app.js")
  const app = await buildApp()
  await app.ready()
  return app
}

describe("Metrics, Health and Alerts", () => {
  test("GET /metrics exposes Prometheus series and reflects increments", async () => {
    metrics.reset()
    const app = await build()

    metrics.incKeeperRuns("ok")
    metrics.incKeeperItems("charge", "charged", 3)
    metrics.setKeeperLastRun(1700000000, "2026-11-06T20:00:00Z", "ok")
    metrics.setKeeperHoldsActive(2)
    metrics.setKeeperAccountXlmBalance(42.5)
    metrics.setIndexerProgress(1000, 1005, 5)

    const res = await app.inject({ method: "GET", url: "/metrics" })
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toContain("text/plain")

    const body = res.body
    expect(body).toContain('keeper_runs_total{result="ok"} 1')
    expect(body).toContain('keeper_items_total{kind="charge",result="charged"} 3')
    expect(body).toContain("keeper_last_run_timestamp 1700000000")
    expect(body).toContain("keeper_holds_active 2")
    expect(body).toContain("keeper_account_xlm_balance 42.5")
    expect(body).toContain("indexer_cursor_ledger 1000")
    expect(body).toContain("indexer_lag_ledgers 5")

    await app.close()
  })

  test("GET /health returns 200 when healthy, 503 when keeper is stale or indexer lag exceeds threshold", async () => {
    metrics.reset()
    const app = await build()

    // 1. Fresh state -> 200 OK
    const now = new Date()
    metrics.setKeeperLastRun(Math.floor(now.getTime() / 1000), now.toISOString(), "ok")
    metrics.setIndexerProgress(500, 502, 2)

    const healthyRes = await app.inject({ method: "GET", url: "/health" })
    expect(healthyRes.statusCode).toBe(200)
    expect(healthyRes.json()).toMatchObject({ status: "ok", service: "rubbi-api" })

    // 2. Stale keeper (> 1800s ago) -> 503 Service Unavailable
    const staleTime = new Date(Date.now() - 3600 * 1000) // 1 hour ago
    metrics.setKeeperLastRun(Math.floor(staleTime.getTime() / 1000), staleTime.toISOString(), "ok")

    const staleRes = await app.inject({ method: "GET", url: "/health" })
    expect(staleRes.statusCode).toBe(503)
    expect(staleRes.json().reason).toMatch(/keeper is stale/i)

    // 3. Fresh keeper but indexer lag > 100 -> 503 Service Unavailable
    metrics.setKeeperLastRun(Math.floor(now.getTime() / 1000), now.toISOString(), "ok")
    metrics.setIndexerProgress(100, 300, 200) // lag = 200 > 100

    const lagRes = await app.inject({ method: "GET", url: "/health" })
    expect(lagRes.statusCode).toBe(503)
    expect(lagRes.json().reason).toMatch(/indexer lag/i)

    await app.close()
  })

  test("Alert dispatcher sends condition and suppresses duplicates within 1 hour", async () => {
    alerts.reset()
    const sentAlerts: any[] = []

    // Mock global fetch to capture webhook calls
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: any, init?: any) => {
      sentAlerts.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }

    try {
      const baseTime = Date.now()
      // Dispatch alert under keeper_run_failure
      const sent1 = await alerts.dispatch("keeper_run_failure", "Keeper crashed", { err: "RPC timeout" }, baseTime)
      expect(sent1).toBe(true)
      expect(sentAlerts.length).toBe(1)
      expect(sentAlerts[0].condition).toBe("keeper_run_failure")

      // Immediate second dispatch for same condition is suppressed (rate limit 1/hour)
      const sent2 = await alerts.dispatch("keeper_run_failure", "Keeper crashed again", {}, baseTime + 60_000)
      expect(sent2).toBe(false)
      expect(sentAlerts.length).toBe(1)

      // Different condition is NOT suppressed
      const sent3 = await alerts.dispatch("items_failing_alone", "1 item failed alone", {}, baseTime + 120_000)
      expect(sent3).toBe(true)
      expect(sentAlerts.length).toBe(2)

      // After 1 hour, original condition is allowed again
      const sent4 = await alerts.dispatch("keeper_run_failure", "Keeper crashed later", {}, baseTime + 3600 * 1000 + 1000)
      expect(sent4).toBe(true)
      expect(sentAlerts.length).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
