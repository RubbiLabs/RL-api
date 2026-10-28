# Contributing to RL-api

Thanks for helping build Rubbi. This file explains how to set up the
repository, how we branch and commit, what a pull request must contain, and
how outside contributors claim and complete a Drips Wave issue. The
[Code of Conduct](CODE_OF_CONDUCT.md) applies to every interaction, and
security problems go through [SECURITY.md](SECURITY.md), never a public issue.

Rubbi is three repositories; each has the same conventions:

| Repository | What it holds |
|---|---|
| [RL-smart-contracts](https://github.com/RubbiLabs/RL-smart-contracts) | Soroban contracts (vault, subscriptions, payroll), deploy and smoke scripts |
| [RL-api](https://github.com/RubbiLabs/RL-api) | Bun + Fastify backend: SEP-10 auth, event indexer, keeper, card issuer adapters |
| [RL-frontend](https://github.com/RubbiLabs/RL-frontend) | Next.js web app: wallet connection, dashboard, subscriptions, payroll, card |

## Setup and checks

Requirements: [Bun](https://bun.sh) 1.4.x, Docker (for Postgres and Redis).

```sh
git clone https://github.com/RubbiLabs/RL-api.git
cd RL-api
cp .env.example .env                      # testnet contract ids are already filled in
POSTGRES_PORT=5435 REDIS_PORT=6380 docker compose -f docker-compose.dev.yml up -d db redis
# then set DATABASE_URL / REDIS_URL in .env to the ports you chose
bun install --frozen-lockfile
bunx prisma generate
bunx prisma migrate deploy
bun run dev                               # http://localhost:3000, Swagger at /docs
```

Run every check before you push; CI runs the same list with Postgres and
Redis service containers:

```sh
bun run typecheck
bun test                                  # in-memory fakes; tests/db/* are skipped
TEST_DATABASE_URL=postgresql://rubbi:rubbi@localhost:5435/rubbi_test bun test   # with the Postgres suites
```

Create the test database once with
`docker exec rubbi-postgres-dev psql -U rubbi -d rubbi -c "CREATE DATABASE rubbi_test;"`
and apply the migrations to it (`DATABASE_URL=... bunx prisma migrate deploy`).

Schema changes get a **new** Prisma migration (`bunx prisma migrate dev --name
<change>`); never edit an existing migration. New environment variables are
added to the zod schema in `src/config/index.ts`, to `.env.example` with a
placeholder, and to the env table in `PRD.md`. Routes get Swagger schemas and
tests. Background work (indexer, keeper, workers) must stay disabled under
`NODE_ENV=test`.

## Branches and commits

- Work on a branch cut from the default branch. Name it after the change,
  e.g. `feat/payroll-end-date` or `fix/indexer-cursor-gap`.
- Never commit to the default branch directly and never force-push a branch
  that someone else has reviewed.
- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
  `type(scope): summary`, imperative mood, no trailing period. Types we use:
  `feat`, `fix`, `test`, `docs`, `chore`, `ci`, `refactor`, `perf`. Scopes are
  the area touched (`vault`, `subscriptions`, `payroll`, `indexer`, `keeper`,
  `auth`, `cards`, `wallet-page`, `readme`, ...).
- Keep commits small and self-contained; each one should pass the checks on
  its own. A reviewer should be able to read the history and understand the
  change step by step.
- Do not include attribution trailers, tool banners or generated boilerplate
  in commit messages.

## Pull requests

Open the pull request against the default branch and fill in the template.
Before you ask for review:

- [ ] The change does what the linked issue asks, and nothing more. Propose
      extra work in a separate issue instead of folding it in.
- [ ] Every check listed under "Setup and checks" above passes locally.
- [ ] New behaviour has tests; changed behaviour has updated tests. A bug fix
      includes a test that fails without the fix.
- [ ] Documentation that describes the changed behaviour is updated in the
      same pull request (README tables, error codes, env var tables, API docs).
- [ ] No secrets, private keys, `.env` files, build output or editor files
      are included. Only `.env.example` with placeholders may change.
- [ ] Money math uses integer stroops (`i128` / `bigint` / `Decimal`), never
      floating point. Stellar addresses are compared case-sensitively.
- [ ] You can explain every line of the diff, including code that an AI tool
      produced (see below).

Reviews are about the change, not the person. Expect questions; answer them in
the thread so the reasoning is preserved. A maintainer merges once CI is green
and at least one maintainer has approved.

## Tests

We treat the test suite as the specification. Every public contract function,
API route, worker and UI flow should have tests that cover the happy path, the
documented error paths and the authorization rules. For contract and backend
changes:

- Authorization tests must show both that the right signer succeeds **and**
  that a wrong signer fails.
- Time-gated behaviour is tested by moving the clock, not by sleeping.
- Idempotency (references, event ids) is tested by replaying the same input.
- Batches are tested at the limit and one over it.

Flaky tests are bugs; do not retry them away.

## Contributing via Drips Wave

Rubbi takes part in the Stellar Wave programme on [Drips](https://www.drips.network/).
Issues labelled **`Stellar Wave`** are scoped tasks that outside contributors
can complete and be paid for. To take one:

1. Read the issue in full: Context, Scope, Acceptance criteria, Out of scope.
   The acceptance criteria are the definition of done.
2. Comment on the issue to claim it. Say briefly how you plan to approach it
   and roughly when you expect to open a pull request. A maintainer assigns
   the issue to you; one claimed issue per contributor at a time.
3. If you go quiet for more than 7 days without an update, the issue may be
   released for someone else.
4. Open the pull request with `Closes #<issue>` in the description and the
   checklist above completed.
5. Address review feedback. The issue is considered complete when the pull
   request is merged.

What does **not** count as a Wave contribution: typo fixes, comment-only
changes, reformatting, dependency bumps without a reason, or pull requests
that implement something nobody asked for. The programme's terms prohibit
point farming, and so do we.

## AI-assisted contributions

You may use AI tools (code assistants, chat models, generators) while working
on Rubbi. The rules:

- **You are the author.** You must understand, have run, and be able to
  explain every line you submit. "The tool wrote it" is not an answer in
  review.
- **Test what you submit.** Generated code is held to exactly the same
  testing standard as hand-written code.
- **Verify, do not assume.** Check library versions against the registry,
  API shapes against the real documentation, and contract behaviour against
  the tests. Fabricated APIs, addresses or version numbers are grounds for
  closing the pull request.
- **Low-effort generated pull requests are closed without review**: large
  unrelated diffs, boilerplate rewrites, speculative refactors, or
  descriptions that do not match the code. Repeated submissions of that kind
  lead to a ban from Wave issues.

This mirrors the Drips Wave terms, which require contributors to take full
responsibility for AI-assisted work.

## Questions

Open a discussion or a plain issue (not a Wave issue) if something in this
guide is unclear. Improvements to this document are welcome.
