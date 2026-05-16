# CLAUDE.md — AgentOS Project Context

This file is read automatically by Claude Code at startup. It contains everything needed to work on AgentOS without additional explanation.

---

## What This Project Is

AgentOS is a multi-agent AI framework for **Project Profile**, a three-person digital marketing agency in Brisbane, Australia. It automates operations, client communications, content production, paid media, and reporting through a coordinated network of Claude-powered agents.

**Team:**
- Mark Allen — Business Development, Ops, Account Management
- Beck — Creative and Content
- Amit — PPC and Technical

**Active clients:** SPG (Stockwell Property Group), Colliers, CPG, Panorama, RV Lifestyle

---

## Current Phase

**Phase 1 — Foundation.** Building the Supabase infrastructure that all agents run on. No agents are deployed yet. See `AgentOS-Phase1-ClaudeCode.md` for the full build brief including schema, Edge Function code, and smoke test.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | CRM PM kanban (external — we build the backend only) |
| Orchestration | Supabase Edge Functions + DB Triggers + Realtime |
| Intelligence | Claude API — model: `claude-sonnet-4-20250514` |
| Database | Supabase (Postgres) |
| Email (Phase 2) | Outlook — eric@projectprofile.agency |

**No Zapier.** All orchestration is native Supabase. This is a hard constraint.

---

## Bot Roster

### Internal (Project Profile only)
| Bot | Status |
|-----|--------|
| Eric | Phase 2 |
| Acquisition | Phase 3 |
| Sales | Phase 3 |
| Finance | Phase 3 |
| Strategist | Phase 3 |

### Universal (cloned per client project)
| Bot | Status |
|-----|--------|
| Account Manager | Phase 4 |
| Content | Phase 5 |
| PPC | Phase 5 |
| Art Director | Phase 5 |
| Copywriting | Phase 5 |
| Reporting | Phase 4 |

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `bots` | Bot configurations and system prompts |
| `bot_instances` | Per-project clones with client context |
| `bot_knowledge` | Versioned learnings per bot type |
| `tasks` | CRM PM task records |
| `task_outputs` | Agent responses per task |
| `audit_log` | Full activity log |

---

## Edge Functions (Pipeline Order)

```
task_trigger → prompt_builder → claude_caller → output_writer → approval_router
```

Every agent runs through this same pipeline. The pipeline does not change between phases — only the system prompts and bot configurations change.

---

## Key Rules

- **Never use Zapier** — orchestration is Supabase-only
- **Always use service role key** in Edge Functions — never the anon key
- **Exponential backoff on Claude API calls** — 2s, 4s, 8s — always
- **Never proceed with ambiguous input** — log to audit_log and route to action_required
- **Never fabricate brand or client context** — stop and request missing information
- **All agent outputs require human approval** before any client-facing action is taken
- **action_required is the human gate** — nothing bypasses it for client-facing outputs
- **Audit log every event** — task creation, output written, approval, rejection, error

---

## Folder Structure

```
agentos/
├── supabase/
│   ├── migrations/
│   │   └── 001_initial_schema.sql
│   ├── functions/
│   │   ├── task-trigger/index.ts
│   │   ├── prompt-builder/index.ts
│   │   ├── claude-caller/index.ts
│   │   ├── output-writer/index.ts
│   │   └── approval-router/index.ts
│   └── config.toml
├── tests/
│   └── smoke-test.ts
├── .env.example
├── CLAUDE.md          ← this file
└── README.md
```

---

## Environment Variables Required

```bash
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
```

Set locally in `.env` and in Supabase via:
```bash
supabase secrets set ANTHROPIC_API_KEY=your-key
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-key
```

---

## Phase 1 Definition of Done

The smoke test in `tests/smoke-test.ts` must pass completely before Phase 2 begins. It validates:

1. Task created in `tasks` table
2. `task_trigger` Edge Function fires
3. `prompt_builder` assembles prompt
4. `claude_caller` calls Claude API and gets response
5. `output_writer` writes to `task_outputs`
6. Task status updates in Supabase
7. Audit log captures every step
8. `approval_router` moves task to `action_required` when needed

---

## Reference Documents

All in the project folder:
- `AgentOS-Phase1-ClaudeCode.md` — full Phase 1 build brief with all code
- `AgentOS-Phase1-PRD.docx` — Phase 1 PRD (human-readable)
- `AgentOS-PRD.docx` — full AgentOS PRD across all phases
- `AgentOS-Agent-Spec.docx` — detailed agent specifications
- `AgentOS-Implementation.md` — full 6-phase implementation plan
