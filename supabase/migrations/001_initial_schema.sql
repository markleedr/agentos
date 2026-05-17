-- UUID generation is built-in on Postgres 17+ (gen_random_uuid)

-- ─── BOTS ────────────────────────────────────────────────────────────────────
create table bots (
  id              uuid primary key default gen_random_uuid(),
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
  id                 uuid primary key default gen_random_uuid(),
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
  id                   uuid primary key default gen_random_uuid(),
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
  id               uuid primary key default gen_random_uuid(),
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
  id               uuid primary key default gen_random_uuid(),
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
  id           uuid primary key default gen_random_uuid(),
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
