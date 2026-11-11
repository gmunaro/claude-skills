---
name: new-project
description: Compose, plan or start a new project. Use when the user wants to create, start, plan, compose, specify or "scaffold" a project, app, SaaS, site or tool, or asks for help defining the stack, scope, MVP or architecture of something new.
---

# New project

Goal: go from an idea to a repo with a SPEC, a project CLAUDE.md and a verified scaffold. **Don't generate code before step 4.**

## 1. Interview (grill), one question at a time
Ask one question at a time, always with a recommendation and the reason. Stop when the answers below are clear (usually 6 to 12 questions):
- The problem and who suffers from it. How do users solve it today?
- The MVP: the 3 to 5 things that must work on day 1, and what stays out.
- The surfaces: web, mobile, desktop, CLI, API.
- Data and real time: is there collaboration or live updating?
- Auth, payments, uploads, email.
- Non-negotiables: performance, offline, privacy, cost.
- The domain vocabulary. It becomes the glossary.

If a technical question comes up that needs research, launch `researcher` (Haiku) in parallel and keep interviewing.
For a deeper interview, with ADRs and a GLOSSARY.md, suggest `/grill-with-docs`.

## 2. Default stack (Theo style, 2026). Propose it and adjust to the answers
| Layer | Default | Alternative when... |
|---|---|---|
| Language | TypeScript strict | — |
| Packages/runtime | Bun | pnpm if the template requires it |
| Web | TanStack Start (React 19 + Vite) | Next.js 16 if you need something specific to the Next ecosystem |
| Backend/DB | Convex (realtime, typed end to end) | Drizzle + Postgres when you need heavy SQL/relational |
| Auth | Clerk (with Convex) | Better Auth if you want self-hosted |
| UI | Tailwind 4 + shadcn/ui | — |
| Payments | Stripe, following t3dotgg/stripe-recommendations (a single `syncStripeData` function, never trust the order of webhooks) | — |
| Uploads | UploadThing | — |
| Lint/format | oxlint + oxfmt | Biome |
| Tests | Vitest | Playwright for e2e |
| Deploy | Vercel | Cloudflare |
| Monorepo + mobile | create-t3-turbo (Expo) | — |

Living reference: `pingdotgg/lawn` (Bun + TanStack Start + Convex + Clerk + Stripe + Vercel) and `pingdotgg/t3code`.

## 3. Documents (show them to the owner before scaffolding)
Create in the new repo:
- `docs/SPEC.md`: problem, users, MVP (testable acceptance criteria), out of scope, chosen stack with the reasons, risks and a plan in small phases.
- The project's `CLAUDE.md`, written for agents and not for humans, with these sections:
  1. Identity: what it is, in 3 lines.
  2. Non-negotiables.
  3. Glossary.
  4. Commands: the exact dev, typecheck, lint, test and build commands.
  5. Verification: what to run before saying "done".
  6. "All surfaces" checklist.
  7. Taste.
  Short. It will grow with real failures.
- `AGENTS.md` with a single line: `@CLAUDE.md` (for Codex and other harnesses).
- Project with a UI: `docs/PRODUCT.md` and `docs/DESIGN.md` from [`templates/`](templates/), filled in during the interview, and a line in `CLAUDE.md` telling agents to read them before generating any screen. The anti-references are the part that does the most to prevent generic UI.

## 4. Scaffold
- Run the official generator in the directory the owner chose. Examples:
  - `bun create convex@latest`
  - `npx create-turbo@latest -e https://github.com/t3-oss/create-t3-turbo`
  - `pnpm create t3-app@latest --CI ...` (in Git Bash use flags, because interactive mode doesn't work in MinTTY)
- Configure lint, format, typecheck and test in `package.json` under the names the CLAUDE.md documents.
- Verify: install, typecheck, lint, test and build all pass. Use `auditor` if you want a second check.
- `git init` and an initial commit **only if the owner asks**.

## 5. Delivery
Summarize the stack, the files created and the commands verified (with results). Suggest the first task of phase 1 as a ready-to-paste prompt for a new thread.
