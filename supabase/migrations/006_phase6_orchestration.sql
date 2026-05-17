-- ─── PHASE 6: FULL ORCHESTRATION ─────────────────────────────────────────────

-- ─── PERFORMANCE FEEDBACK LOG ────────────────────────────────────────────────
-- Stores learnings that feed back into bot_knowledge
create table performance_feedback (
  id              uuid primary key default gen_random_uuid(),
  bot_type        text not null,
  project_id      text not null,
  client_name     text,
  report_id       uuid references reports(id),
  task_id         uuid references tasks(id),
  category        text not null,
  learning        text not null,
  performance_evidence text,
  added_by        text not null default 'agent',
  applied_to_knowledge boolean not null default false,
  knowledge_id    uuid references bot_knowledge(id),
  created_at      timestamptz not null default now()
);

alter table performance_feedback enable row level security;
create policy "service_role_all" on performance_feedback for all using (auth.role() = 'service_role');

-- ─── AUTO-VERSION FUNCTION FOR BOT KNOWLEDGE ─────────────────────────────────
-- Returns the next version number for a given bot type
create or replace function next_knowledge_version(p_bot_type text)
returns integer as $$
  select coalesce(max(version), 0) + 1 from bot_knowledge where bot_type = p_bot_type;
$$ language sql;

-- ─── SCHEDULE: WEEKLY REPORTING (Monday 8am AEST = Sunday 10pm UTC) ──────────
select cron.schedule(
  'weekly-reporting-spg',
  '0 22 * * 0',
  format(
    $CRON$
    select net.http_post(
      url := '%s/functions/v1/reporting-processor',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer %s"}'::jsonb,
      body := '{"project_id":"client-spg","report_type":"7_day_snapshot"}'::jsonb
    );
    $CRON$,
    current_setting('app.supabase_url', true),
    current_setting('app.service_role_key', true)
  )
);

-- ─── MARK ALL PHASE 6 BOTS AS ACTIVE ─────────────────────────────────────────
update bots set status = 'active' where name in ('Eric', 'Content', 'PPC', 'Art Director', 'Copywriting', 'Reporting', 'Account Manager');
update bots set status = 'building' where name in ('Acquisition', 'Sales', 'Finance', 'Strategist');
