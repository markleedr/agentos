# AgentOS

A multi-agent AI framework for Project Profile. Automates operations, client communications, content production, paid media, and reporting through a network of Claude-powered agents orchestrated via Supabase.

**Current phase:** Phase 1 — Foundation (infrastructure only, no agents deployed yet)

---

## Stack

- **Supabase** — database, Edge Functions, Realtime
- **Claude API** — `claude-sonnet-4-20250514`
- **CRM PM kanban** — frontend (external)

## Agent Pipeline

```
task_trigger → prompt_builder → claude_caller → output_writer → approval_router
```

---

## Setup

### 1. Prerequisites

```bash
npm install -g supabase
```

### 2. Clone and install

```bash
git clone https://github.com/markleedr/agentos.git
cd agentos
npm install
cp .env.example .env
# Fill in your credentials in .env
```

### 3. Link to Supabase

```bash
supabase link --project-ref your-project-ref
supabase db push
```

### 4. Set Edge Function secrets

```bash
supabase secrets set ANTHROPIC_API_KEY=your-key
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-key
```

### 5. Deploy Edge Functions

```bash
supabase functions deploy task-trigger
supabase functions deploy prompt-builder
supabase functions deploy claude-caller
supabase functions deploy output-writer
supabase functions deploy approval-router
```

### 6. Run the smoke test

```bash
npx ts-node tests/smoke-test.ts
```

---

## Phase 1 Definition of Done

- [ ] All six Supabase tables exist with correct schema
- [ ] All five Edge Functions deployed and returning 200
- [ ] Task created in tasks table appears within 2 seconds
- [ ] Claude API called and response returned
- [ ] Output written to task_outputs table
- [ ] Task status updated in Supabase
- [ ] Audit log entries captured for every step
- [ ] Action Required routing working
- [ ] Smoke test passes end-to-end with no manual steps

---

See `CLAUDE.md` for full project context and `AgentOS-Phase1-ClaudeCode.md` for the detailed build brief.
