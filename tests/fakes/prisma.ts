import { Prisma } from "@prisma/client"

/**
 * A small in-memory stand-in for the Prisma client, covering the query
 * shapes the services, indexer and workers use. `$transaction` runs the
 * callback against the same store (no rollback); atomicity is covered by
 * the Postgres-backed tests in tests/db.
 */

type Row = Record<string, any>

interface ModelSpec {
  uniques: string[][]
  relations?: Record<string, { model: string; localField: string; foreignField: string; many?: boolean }>
  defaults?: () => Row
}

const MODELS: Record<string, ModelSpec> = {
  user: {
    uniques: [["id"], ["stellarAddress"], ["username"]],
    relations: {
      card: { model: "card", localField: "id", foreignField: "userId" },
      cardMovements: { model: "cardMovement", localField: "id", foreignField: "userId", many: true },
    },
    defaults: () => ({
      username: null,
      walletBalance: new Prisma.Decimal(0),
      cardBalance: new Prisma.Decimal(0),
    }),
  },
  card: {
    uniques: [["id"], ["userId"], ["issuerId"]],
    relations: { user: { model: "user", localField: "userId", foreignField: "id" } },
    defaults: () => ({ status: "ACTIVE" }),
  },
  deposit: { uniques: [["id"], ["eventId"]], defaults: () => ({ status: "CONFIRMED", confirmedAt: null }) },
  transaction: { uniques: [["id"]], defaults: () => ({ metadata: null }) },
  cardMovement: {
    uniques: [["id"], ["reference"]],
    relations: { user: { model: "user", localField: "userId", foreignField: "id" } },
    defaults: () => ({ status: "PENDING", txHash: null, failureReason: null, settledAt: null, completedAt: null }),
  },
  subscriptionPlan: { uniques: [["id"]], defaults: () => ({ active: true }) },
  subscription: {
    uniques: [["id"], ["onChainSubId"]],
    relations: { plan: { model: "subscriptionPlan", localField: "planId", foreignField: "id" } },
    defaults: () => ({ status: "ACTIVE", userId: null, lastChargedAt: null }),
  },
  payrollSchedule: {
    uniques: [["id"], ["onChainId"]],
    defaults: () => ({ status: "ACTIVE", employerUserId: null, lastDisbursedAt: null }),
  },
  chainCursor: { uniques: [["id"]] },
  processedEvent: { uniques: [["eventId"]] },
  chainGap: { uniques: [["id"]], defaults: () => ({ resolvedAt: null }) },
}

let idCounter = 0
const nextId = (model: string) => `${model}-${++idCounter}`

function uniqueError(model: string, fields: string[]) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the fields: (${fields.join(",")})`,
    { code: "P2002", clientVersion: "fake", meta: { modelName: model, target: fields } },
  )
}

function notFoundError(model: string) {
  return new Prisma.PrismaClientKnownRequestError(`No ${model} found`, {
    code: "P2025",
    clientVersion: "fake",
  })
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Prisma.Decimal || b instanceof Prisma.Decimal) {
    return new Prisma.Decimal(a as any).equals(new Prisma.Decimal(b as any))
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  return a === b
}

function compare(a: any, b: any): number {
  if (a instanceof Prisma.Decimal || b instanceof Prisma.Decimal) {
    return new Prisma.Decimal(a).comparedTo(new Prisma.Decimal(b))
  }
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime()
  if (typeof a === "bigint" || typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0
  return a < b ? -1 : a > b ? 1 : 0
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === "object" && !(condition instanceof Date) && !(condition instanceof Prisma.Decimal)) {
    const c = condition as Record<string, unknown>
    if ("in" in c) return (c.in as unknown[]).some((v) => sameValue(value, v))
    if ("notIn" in c) return !(c.notIn as unknown[]).some((v) => sameValue(value, v))
    if ("not" in c) return !matchesCondition(value, c.not)
    if ("lte" in c && !(compare(value, c.lte) <= 0)) return false
    if ("lt" in c && !(compare(value, c.lt) < 0)) return false
    if ("gte" in c && !(compare(value, c.gte) >= 0)) return false
    if ("gt" in c && !(compare(value, c.gt) > 0)) return false
    if ("equals" in c && !sameValue(value, c.equals)) return false
    return true
  }
  return sameValue(value, condition)
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true
  for (const [key, condition] of Object.entries(where)) {
    if (key === "AND") {
      if (!(condition as Row[]).every((w) => matches(row, w))) return false
      continue
    }
    if (key === "OR") {
      if (!(condition as Row[]).some((w) => matches(row, w))) return false
      continue
    }
    if (key === "NOT") {
      if (matches(row, condition as Row)) return false
      continue
    }
    if (!matchesCondition(row[key], condition)) return false
  }
  return true
}

function applyUpdate(row: Row, data: Row): Row {
  const next = { ...row }
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && !(value instanceof Date) && !(value instanceof Prisma.Decimal) && !Array.isArray(value)) {
      const op = value as Record<string, unknown>
      if ("increment" in op) {
        next[key] = new Prisma.Decimal(next[key] ?? 0).plus(new Prisma.Decimal(op.increment as any))
        continue
      }
      if ("decrement" in op) {
        next[key] = new Prisma.Decimal(next[key] ?? 0).minus(new Prisma.Decimal(op.decrement as any))
        continue
      }
      if ("set" in op) {
        next[key] = op.set
        continue
      }
    }
    next[key] = value
  }
  next.updatedAt = new Date()
  return next
}

export class FakePrisma {
  readonly tables: Record<string, Row[]> = {}
  readonly log: Array<{ model: string; op: string; args: unknown }> = []

  constructor() {
    for (const model of Object.keys(MODELS)) {
      this.tables[model] = []
      ;(this as any)[model] = this.delegate(model)
    }
  }

  async $transaction<T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return cb(this)
  }

  async $connect() {}
  async $disconnect() {}

  seed(model: string, rows: Row[]) {
    for (const row of rows) this.insert(model, row)
  }

  rows(model: string): Row[] {
    return this.tables[model] ?? []
  }

  private insert(model: string, data: Row): Row {
    const spec = MODELS[model]!
    const row: Row = {
      id: nextId(model),
      ...(spec.defaults?.() ?? {}),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }
    for (const fields of spec.uniques) {
      if (fields.some((f) => row[f] === undefined || row[f] === null)) continue
      const clash = this.tables[model]!.some((r) => fields.every((f) => sameValue(r[f], row[f])))
      if (clash) throw uniqueError(model, fields)
    }
    this.tables[model]!.push(row)
    return row
  }

  private withInclude(model: string, row: Row | null, args: Row | undefined): Row | null {
    if (!row || !args?.include) return row
    const spec = MODELS[model]!
    const out = { ...row }
    for (const [name, wanted] of Object.entries(args.include)) {
      if (!wanted) continue
      const rel = spec.relations?.[name]
      if (!rel) continue
      const nested = typeof wanted === "object" ? (wanted as Row) : undefined
      const related = this.tables[rel.model]!
        .filter((r) => sameValue(r[rel.foreignField], row[rel.localField]))
        .map((r) => this.withInclude(rel.model, r, nested))
      out[name] = rel.many ? related : (related[0] ?? null)
    }
    return out
  }

  private findOne(model: string, where: Row): Row | null {
    return this.tables[model]!.find((r) => matches(r, where)) ?? null
  }

  private delegate(model: string) {
    const self = this
    const record = (op: string, args: unknown) => self.log.push({ model, op, args })
    return {
      async findUnique(args: Row) {
        record("findUnique", args)
        return self.withInclude(model, self.findOne(model, args.where), args)
      },
      async findUniqueOrThrow(args: Row) {
        record("findUniqueOrThrow", args)
        const row = self.findOne(model, args.where)
        if (!row) throw notFoundError(model)
        return self.withInclude(model, row, args)
      },
      async findFirst(args: Row = {}) {
        record("findFirst", args)
        const rows = self.query(model, args)
        return self.withInclude(model, rows[0] ?? null, args)
      },
      async findMany(args: Row = {}) {
        record("findMany", args)
        return self.query(model, args).map((r) => self.withInclude(model, r, args))
      },
      async count(args: Row = {}) {
        record("count", args)
        return self.tables[model]!.filter((r) => matches(r, args.where)).length
      },
      async create(args: Row) {
        record("create", args)
        return self.withInclude(model, self.insert(model, args.data), args)
      },
      async update(args: Row) {
        record("update", args)
        const existing = self.findOne(model, args.where)
        if (!existing) throw notFoundError(model)
        const updated = applyUpdate(existing, args.data)
        self.replace(model, existing, updated)
        return self.withInclude(model, updated, args)
      },
      async updateMany(args: Row) {
        record("updateMany", args)
        let count = 0
        for (const row of self.tables[model]!.filter((r) => matches(r, args.where))) {
          self.replace(model, row, applyUpdate(row, args.data))
          count++
        }
        return { count }
      },
      async upsert(args: Row) {
        record("upsert", args)
        const existing = self.findOne(model, args.where)
        if (existing) {
          const updated = applyUpdate(existing, args.update)
          self.replace(model, existing, updated)
          return self.withInclude(model, updated, args)
        }
        return self.withInclude(model, self.insert(model, args.create), args)
      },
      async delete(args: Row) {
        record("delete", args)
        const existing = self.findOne(model, args.where)
        if (!existing) throw notFoundError(model)
        self.tables[model] = self.tables[model]!.filter((r) => r !== existing)
        return existing
      },
      async deleteMany(args: Row = {}) {
        record("deleteMany", args)
        const before = self.tables[model]!.length
        self.tables[model] = self.tables[model]!.filter((r) => !matches(r, args.where))
        return { count: before - self.tables[model]!.length }
      },
    }
  }

  private replace(model: string, oldRow: Row, newRow: Row) {
    const table = self(this).tables[model]!
    const index = table.indexOf(oldRow)
    table[index] = newRow
  }

  private query(model: string, args: Row): Row[] {
    let rows = this.tables[model]!.filter((r) => matches(r, args.where))
    if (args.orderBy) {
      const orders = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]
      rows = [...rows].sort((a, b) => {
        for (const order of orders) {
          const [field, dir] = Object.entries(order)[0] as [string, string]
          const c = compare(a[field], b[field])
          if (c !== 0) return dir === "desc" ? -c : c
        }
        return 0
      })
    }
    if (args.skip) rows = rows.slice(args.skip)
    if (args.take !== undefined) rows = rows.slice(0, args.take)
    return rows
  }
}

function self(x: FakePrisma) {
  return x
}

export function makeFakePrisma() {
  return new FakePrisma() as FakePrisma & Record<string, any>
}
