# AgentOS Phase 1 — Claude Code Brief

## What You're Building

The infrastructure layer for AgentOS — a multi-agent AI framework for Project Profile, a boutique digital marketing agency. No agents are deployed in Phase 1. You are building the plumbing that every future agent runs on.

**Stack:**
- Supabase (database + Edge Functions + Realtime)
- Claude API via Anthropic SDK (claude-sonnet-4-20250514)
- CRM PM kanban (frontend — you are building the backend only)

**Phase 1 is complete when:**
A dummy test task triggers a Supabase Edge Function → calls Claude API → writes response to Supabase → updates the kanban via Realtime → routes output to Action Required column. Full loop, no manual steps.

---

## Repository Structure

```
agentos/
├── supabase/
│   ├── migrations/
│   │   └── 001_initial_schema.sql
│   ├── functions/
│   │   ├── task-trigger/
│   │   │   └── index.ts
│   │   ├── prompt-builder/
│   │   │   └── index.ts
│   │   ├── claude-caller/
│   │   │   └── index.ts
│   │   ├── output-writer/
│   │   │   └── index.ts
│   │   └── approval-router/
│   │       └── index.ts
│   └── config.toml
├── tests/
│   └── smoke-test.ts
├── .env.example
└── README.md
```

---

## Database Schema

Run this migration first. All tables must exist before Edge Functions are deployed.

```sql
-- 001_initial_schema.sql

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- ─── BOTS ────────────────────────────────────────────────────────────────────
create table bots (
  id              uuid primary key default uuid_generate_v4(),
  name            text not null,
  type            text not null check (type in ('internal', 'universal')),
  scope           text not null check (scope in ('project_profile', 'all_projects', 'pp_and_all')),
  system_prompt   text not null default '',
  prompt_version  integer not null default 1,
  status          text not null default 'planned' check (status in ('active', 'building', 'planned')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ─── BOT INSTANCES ───────────────────────────────────────────────────────────
create table bot_instances (
  id                 uuid primary key default uuid_generate_v4(),
  bot_id             uuid not null references bots(id) on delete cascade,
  project_id         text not null,
  client_name        text,
  context_doc        text not null default '',
  knowledge_version  integer not null default 1,
  status             text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at         timestamptz not null default now()
);

-- ─── BOT KNOWLEDGE ───────────────────────────────────────────────────────────
create table bot_knowledge (
  id                   uuid primary key default uuid_generate_v4(),
  bot_type             text not null,
  version              integer not null,
  category             text not null,
  content              text not null,
  added_by             text not null default 'mark',
  performance_evidence text,
  created_at           timestamptz not null default now(),
  unique (bot_type, version)
);

-- ─── TASKS ───────────────────────────────────────────────────────────────────
create table tasks (
  id               uuid primary key default uuid_generate_v4(),
  crm_task_id      text unique,
  project_id       text not null,
  bot_instance_id  uuid references bot_instances(id),
  title            text not null,
  description      text,
  assignee         text check (assignee in ('mark', 'beck', 'amit', 'agent')),
  priority         text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status           text not null default 'inbox' check (status in ('inbox', 'to_do', 'in_progress', 'action_required', 'done')),
  due_date         date,
  source           text not null default 'manual' check (source in ('email', 'manual', 'agent', 'wip_transcript')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ─── TASK OUTPUTS ────────────────────────────────────────────────────────────
create table task_outputs (
  id               uuid primary key default uuid_generate_v4(),
  task_id          uuid not null references tasks(id) on delete cascade,
  bot_instance_id  uuid references bot_instances(id),
  prompt_sent      text,
  response         text,
  parsed_output    jsonb,
  approval_status  text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  approved_by      text,
  rejection_notes  text,
  created_at       timestamptz not null default now()
);

-- ─── AUDIT LOG ───────────────────────────────────────────────────────────────
create table audit_log (
  id           uuid primary key default uuid_generate_v4(),
  event_type   text not null,
  bot_id       uuid references bots(id),
  task_id      uuid references tasks(id),
  description  text not null,
  metadata     jsonb,
  severity     text not null default 'info' check (severity in ('info', 'warning', 'error')),
  created_at   timestamptz not null default now()
);

-- ─── UPDATED_AT TRIGGERS ─────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger bots_updated_at before update on bots
  for each row execute function update_updated_at();

create trigger tasks_updated_at before update on tasks
  for each row execute function update_updated_at();

-- ─── REALTIME ────────────────────────────────────────────────────────────────
-- Enable Realtime on the tasks table so the CRM PM kanban gets live updates
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table task_outputs;
alter publication supabase_realtime add table audit_log;

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
alter table bots enable row level security;
alter table bot_instances enable row level security;
alter table bot_knowledge enable row level security;
alter table tasks enable row level security;
alter table task_outputs enable row level security;
alter table audit_log enable row level security;

-- Service role bypass (Edge Functions use service role key)
create policy "service_role_all" on bots for all using (auth.role() = 'service_role');
create policy "service_role_all" on bot_instances for all using (auth.role() = 'service_role');
create policy "service_role_all" on bot_knowledge for all using (auth.role() = 'service_role');
create policy "service_role_all" on tasks for all using (auth.role() = 'service_role');
create policy "service_role_all" on task_outputs for all using (auth.role() = 'service_role');
create policy "service_role_all" on audit_log for all using (auth.role() = 'service_role');

-- ─── SEED: BOT ROSTER ────────────────────────────────────────────────────────
insert into bots (name, type, scope, status) values
  ('Eric',            'internal',  'project_profile', 'planned'),
  ('Acquisition',     'internal',  'project_profile', 'planned'),
  ('Sales',           'internal',  'project_profile', 'planned'),
  ('Finance',         'internal',  'project_profile', 'planned'),
  ('Strategist',      'internal',  'project_profile', 'planned'),
  ('Account Manager', 'universal', 'pp_and_all',      'planned'),
  ('Content',         'universal', 'pp_and_all',      'planned'),
  ('PPC',             'universal', 'pp_and_all',      'planned'),
  ('Art Director',    'universal', 'pp_and_all',      'planned'),
  ('Copywriting',     'universal', 'pp_and_all',      'planned'),
  ('Reporting',       'universal', 'pp_and_all',      'planned');
```

---

## Edge Functions

Deploy all five to Supabase. They are called in sequence: task_trigger → prompt_builder → claude_caller → output_writer → approval_router (when needed).

### task-trigger/index.ts

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const payload = await req.json()
    const { record, type } = payload

    // Only fire on insert or status change
    if (type !== 'INSERT' && type !== 'UPDATE') {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 })
    }

    // If UPDATE, only proceed if status changed
    if (type === 'UPDATE' && payload.old_record?.status === record.status) {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 })
    }

    // Skip tasks in done or action_required — no agent processing needed
    if (['done', 'action_required'].includes(record.status)) {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 })
    }

    // Log trigger event
    await supabase.from('audit_log').insert({
      event_type: 'task_triggered',
      task_id: record.id,
      description: `Task "${record.title}" triggered agent pipeline`,
      metadata: { task_status: record.status, source: record.source },
      severity: 'info'
    })

    // Call prompt-builder
    const promptRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/prompt-builder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
      },
      body: JSON.stringify({ task: record })
    })

    if (!promptRes.ok) {
      throw new Error(`prompt-builder failed: ${await promptRes.text()}`)
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 })

  } catch (error) {
    console.error('task-trigger error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
```

### prompt-builder/index.ts

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { task } = await req.json()

    // Load bot instance for this task
    let systemPrompt = 'You are an AgentOS assistant for Project Profile, a digital marketing agency.'
    let contextDoc = ''
    let botId = null

    if (task.bot_instance_id) {
      const { data: instance } = await supabase
        .from('bot_instances')
        .select('*, bots(name, system_prompt, id)')
        .eq('id', task.bot_instance_id)
        .single()

      if (instance) {
        systemPrompt = instance.bots.system_prompt || systemPrompt
        contextDoc = instance.context_doc || ''
        botId = instance.bots.id

        // Load latest knowledge base version for this bot type
        const { data: knowledge } = await supabase
          .from('bot_knowledge')
          .select('content, category')
          .eq('bot_type', instance.bots.name)
          .order('version', { ascending: false })
          .limit(10)

        if (knowledge && knowledge.length > 0) {
          const knowledgeText = knowledge
            .map(k => `[${k.category}]: ${k.content}`)
            .join('\n')
          systemPrompt += `\n\n## Universal Learnings\n${knowledgeText}`
        }
      }
    }

    // Assemble the full prompt
    const userMessage = [
      contextDoc ? `## Project Context\n${contextDoc}` : '',
      `## Task\nTitle: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      `Priority: ${task.priority}`,
      task.due_date ? `Due: ${task.due_date}` : '',
    ].filter(Boolean).join('\n\n')

    const prompt = {
      task_id: task.id,
      bot_id: botId,
      system_prompt: systemPrompt,
      user_message: userMessage
    }

    // Call claude-caller
    const claudeRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/claude-caller`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
      },
      body: JSON.stringify(prompt)
    })

    if (!claudeRes.ok) {
      throw new Error(`claude-caller failed: ${await claudeRes.text()}`)
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 })

  } catch (error) {
    console.error('prompt-builder error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
```

### claude-caller/index.ts

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const MAX_RETRIES = 3
const BACKOFF = [2000, 4000, 8000]

serve(async (req) => {
  const { task_id, bot_id, system_prompt, user_message } = await req.json()

  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, BACKOFF[attempt - 1]))
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: system_prompt,
          messages: [{ role: 'user', content: user_message }]
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Anthropic API error ${response.status}: ${errorText}`)
      }

      const data = await response.json()
      const responseText = data.content?.[0]?.text || ''

      // Call output-writer
      const writerRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/output-writer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({
          task_id,
          bot_id,
          prompt_sent: user_message,
          response: responseText
        })
      })

      if (!writerRes.ok) {
        throw new Error(`output-writer failed: ${await writerRes.text()}`)
      }

      return new Response(JSON.stringify({ success: true, attempt: attempt + 1 }), { status: 200 })

    } catch (error) {
      lastError = error
      console.error(`claude-caller attempt ${attempt + 1} failed:`, error.message)
    }
  }

  // All retries exhausted — escalate to Mark via approval-router
  await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/approval-router`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
    },
    body: JSON.stringify({
      task_id,
      reason: `Claude API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
      severity: 'error'
    })
  })

  return new Response(JSON.stringify({ error: lastError?.message }), { status: 500 })
})
```

### output-writer/index.ts

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Outputs that always require human approval before execution
const APPROVAL_REQUIRED_KEYWORDS = [
  'email', 'send', 'reply', 'publish', 'post', 'schedule', 'invoice',
  'payment', 'budget', 'scope', 'client'
]

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { task_id, bot_id, prompt_sent, response } = await req.json()

    // Fetch the task to determine routing
    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', task_id)
      .single()

    if (!task) throw new Error(`Task ${task_id} not found`)

    // Write output to task_outputs
    const { data: output } = await supabase
      .from('task_outputs')
      .insert({
        task_id,
        bot_instance_id: task.bot_instance_id,
        prompt_sent,
        response,
        parsed_output: { text: response },
        approval_status: 'pending'
      })
      .select()
      .single()

    // Log to audit
    await supabase.from('audit_log').insert({
      event_type: 'output_written',
      bot_id,
      task_id,
      description: `Output written for task "${task.title}"`,
      metadata: { output_id: output?.id },
      severity: 'info'
    })

    // Determine if approval is required
    const taskText = `${task.title} ${task.description || ''}`.toLowerCase()
    const requiresApproval = APPROVAL_REQUIRED_KEYWORDS.some(kw => taskText.includes(kw))

    if (requiresApproval) {
      // Route to Action Required
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/approval-router`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({ task_id, reason: 'Output requires human review', severity: 'info' })
      })
    } else {
      // Mark done directly
      await supabase.from('tasks').update({ status: 'done' }).eq('id', task_id)
      await supabase.from('task_outputs').update({ approval_status: 'approved' }).eq('id', output?.id)
    }

    return new Response(JSON.stringify({ success: true, requires_approval: requiresApproval }), { status: 200 })

  } catch (error) {
    console.error('output-writer error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
```

### approval-router/index.ts

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { task_id, reason, severity = 'info' } = await req.json()

    // Move task to action_required
    const { error } = await supabase
      .from('tasks')
      .update({ status: 'action_required' })
      .eq('id', task_id)

    if (error) throw error

    // Log escalation
    await supabase.from('audit_log').insert({
      event_type: 'approval_required',
      task_id,
      description: reason,
      metadata: { routed_to: 'action_required' },
      severity
    })

    return new Response(JSON.stringify({ success: true, status: 'action_required' }), { status: 200 })

  } catch (error) {
    console.error('approval-router error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
```

---

## Environment Variables

Create a `.env` file (never commit this):

```bash
# Supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Anthropic
ANTHROPIC_API_KEY=your-anthropic-api-key
```

These must also be set as Supabase Edge Function secrets:
```bash
supabase secrets set ANTHROPIC_API_KEY=your-key
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-key
```

---

## Smoke Test

Run this after all functions are deployed. It validates the full stack end-to-end.

```typescript
// tests/smoke-test.ts
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function smokeTest() {
  console.log('🔵 AgentOS Phase 1 — Smoke Test\n')

  // 1. Insert a dummy task
  console.log('1. Creating dummy task...')
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .insert({
      project_id: 'smoke-test',
      title: 'Smoke test task',
      description: 'This is a smoke test. Respond with a short confirmation that AgentOS Phase 1 is operational.',
      priority: 'high',
      source: 'manual',
      status: 'to_do'
    })
    .select()
    .single()

  if (taskError) throw new Error(`Task creation failed: ${taskError.message}`)
  console.log(`   ✅ Task created: ${task.id}`)

  // 2. Manually trigger the pipeline (in production this fires via DB webhook)
  console.log('2. Triggering agent pipeline...')
  const triggerRes = await supabase.functions.invoke('task-trigger', {
    body: { record: task, type: 'INSERT' }
  })
  if (triggerRes.error) throw new Error(`Pipeline trigger failed: ${triggerRes.error.message}`)
  console.log('   ✅ Pipeline triggered')

  // 3. Wait for processing
  console.log('3. Waiting for Claude to process...')
  await new Promise(resolve => setTimeout(resolve, 5000))

  // 4. Check task_outputs
  console.log('4. Checking output...')
  const { data: outputs } = await supabase
    .from('task_outputs')
    .select('*')
    .eq('task_id', task.id)

  if (!outputs || outputs.length === 0) throw new Error('No output written to task_outputs')
  console.log(`   ✅ Output written: "${outputs[0].response?.substring(0, 80)}..."`)

  // 5. Check task status updated
  console.log('5. Checking task status...')
  const { data: updatedTask } = await supabase
    .from('tasks')
    .select('status')
    .eq('id', task.id)
    .single()

  console.log(`   ✅ Task status: ${updatedTask?.status}`)

  // 6. Check audit log
  console.log('6. Checking audit log...')
  const { data: logs } = await supabase
    .from('audit_log')
    .select('event_type, description')
    .eq('task_id', task.id)
    .order('created_at', { ascending: true })

  console.log(`   ✅ Audit entries: ${logs?.length}`)
  logs?.forEach(l => console.log(`      — [${l.event_type}] ${l.description}`))

  // 7. Clean up
  await supabase.from('tasks').delete().eq('id', task.id)
  console.log('\n✅ Smoke test passed. Phase 1 is operational. Phase 2 (Eric) can begin.')
}

smokeTest().catch(err => {
  console.error('\n❌ Smoke test failed:', err.message)
  process.exit(1)
})
```

---

## Deployment Order

Run these steps in order. Do not skip ahead.

```bash
# 1. Install Supabase CLI
npm install -g supabase

# 2. Initialise project
supabase init

# 3. Link to your Supabase project
supabase link --project-ref your-project-ref

# 4. Run the migration
supabase db push

# 5. Set secrets
supabase secrets set ANTHROPIC_API_KEY=your-key

# 6. Deploy all Edge Functions
supabase functions deploy task-trigger
supabase functions deploy prompt-builder
supabase functions deploy claude-caller
supabase functions deploy output-writer
supabase functions deploy approval-router

# 7. Run the smoke test
npx ts-node tests/smoke-test.ts
```

---

## Phase 1 Success Criteria

Phase 1 is complete when the smoke test passes with all of the following confirmed:

- [ ] All six Supabase tables exist with correct schema
- [ ] All five Edge Functions deployed and returning 200
- [ ] Task created in tasks table appears within 2 seconds
- [ ] Claude API called and response returned
- [ ] Output written to task_outputs table
- [ ] Task status updated in Supabase
- [ ] Audit log entries captured for every step
- [ ] Action Required routing working (task moves to action_required status)
- [ ] Smoke test passes end-to-end with no manual steps

**Do not begin Phase 2 (Eric) until every item above is checked off.**

---

## What Comes Next (Phase 2)

Phase 2 builds Eric — the Ops Manager agent — on top of this foundation. Eric adds:
- Outlook inbox polling (eric@projectprofile.agency)
- Email triage and intent classification
- Task creation from inbound emails
- Draft reply staging in Action Required
- WIP transcript processing
- Overdue task detection and escalation

The Edge Function architecture does not change. Eric is a new bot record in the bots table with a system prompt, connected to an Outlook polling trigger.

---

*AgentOS Phase 1 Build Brief · Project Profile · Confidential · May 2026*
