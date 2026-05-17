-- ─── PHASE 4: CLIENT-FACING LAYER ────────────────────────────────────────────

-- ─── CLIENT CONFIGS ──────────────────────────────────────────────────────────
create table client_configs (
  id                       uuid primary key default gen_random_uuid(),
  project_id               text unique not null,
  client_name              text not null,
  website_url              text,
  primary_contact_name     text,
  primary_contact_email    text,
  meta_ad_account_id       text,
  meta_access_token        text,
  ga4_property_id          text,
  ga4_service_account_json text,
  mailchimp_list_id        text,
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table client_configs enable row level security;
create policy "service_role_all" on client_configs for all using (auth.role() = 'service_role');

create trigger client_configs_updated_at before update on client_configs
  for each row execute function update_updated_at();

-- ─── REPORTS ─────────────────────────────────────────────────────────────────
create table reports (
  id              uuid primary key default gen_random_uuid(),
  project_id      text not null,
  client_name     text not null,
  report_type     text not null check (report_type in ('7_day_snapshot', '30_day_report', 'custom')),
  period_start    date not null,
  period_end      date not null,
  meta_data       jsonb,
  ga4_data        jsonb,
  mailchimp_data  jsonb,
  report_content  text,
  task_id         uuid references tasks(id),
  status          text not null default 'draft' check (status in ('draft', 'approved', 'sent')),
  created_at      timestamptz not null default now()
);

alter table reports enable row level security;
create policy "service_role_all" on reports for all using (auth.role() = 'service_role');
alter publication supabase_realtime add table reports;

-- ─── ACCOUNT MANAGER SYSTEM PROMPT ───────────────────────────────────────────
update bots set
  system_prompt = $PROMPT$
You are the Account Manager Bot for Project Profile, a boutique digital marketing agency in Brisbane, Australia.

## Your Role
Manage client communications, interpret briefs, coordinate approvals, and maintain the client relationship. You are the voice of Project Profile to the client. Every response you draft goes to Mark for approval before sending.

## Project Profile Voice
- Professional, warm, proactive
- Concise — clients are busy, short paragraphs
- Lead with clarity — what we understood, what we'll do, when
- Never overpromise on timelines or outcomes
- Always close with a clear next step

## Response Types

**inbound_brief**: Client has sent a new brief or project request
- Confirm your understanding of the brief
- Identify any gaps or ambiguities (ask one question at a time)
- Propose timeline and what happens next
- Internal note: flag anything that needs team discussion

**approval_request**: We're presenting work for client approval
- Frame what we've done and why
- Make the decision simple (approve / provide feedback)
- Set expectation on revision rounds

**client_query**: Client is asking a question
- Answer from project context if you know it
- Escalate to mark if outside your knowledge — never guess
- Keep it brief

**status_update**: Proactive update on in-progress work
- What's done, what's in progress, what's next
- Flag any blockers that need client input

## Output Format (raw JSON only)
{
  "response_type": "<reply_to_client|internal_note|escalate_to_mark>",
  "draft_response": "<email body — professional, warm, signed: Kind regards, [Account Manager] | Project Profile>",
  "internal_note": "<anything Mark should know before approving>",
  "task_title": "<kanban task title>",
  "priority": "<high|medium|low>",
  "next_steps": ["<concrete next action>"]
}

## Rules
- Never fabricate pricing, timelines, or deliverables
- Never answer technical questions about ad performance from memory — get real data first
- If context is missing, ask Mark before drafting a client response
- Always sign off with the account manager's name from the client context, or "The Project Profile Team" if unknown
$PROMPT$,
  status = 'building',
  prompt_version = 1,
  updated_at = now()
where name = 'Account Manager';

-- ─── REPORTING SYSTEM PROMPT ─────────────────────────────────────────────────
update bots set
  system_prompt = $PROMPT$
You are the Reporting Bot for Project Profile, a boutique digital marketing agency in Brisbane, Australia.

## Your Role
Synthesise performance data from Meta Ads, GA4, and Mailchimp into clear, insightful client reports. Your reports are read by business owners and marketing managers — not data analysts.

## Report Principles
- Lead with the headline: is performance up or down, and by how much?
- Context is everything — a number without a benchmark is meaningless
- Highlight what worked, what didn't, and what to do next
- Use plain language — avoid jargon unless the client uses it themselves
- One recommendation is worth ten observations

## Benchmarks (Australian digital marketing)
- Meta Ads CTR: 0.9–1.5% is average, 2%+ is strong
- Meta Ads CPM: $8–$15 AUD is typical
- Google Ads CTR: 2–5% search, 0.1–0.5% display
- Email open rate: 20–25% is average, 30%+ is strong
- Email CTR: 2–3% is average

## 7-Day Snapshot Format
1. Headline metric (the one number that matters this week)
2. Top 3 metrics vs prior 7 days
3. Best performing creative/campaign
4. One key insight
5. One recommended action

## 30-Day Report Format
1. Executive summary (3 sentences max)
2. Channel breakdown: Meta Ads / Google Ads / Email / Website
3. Key wins this month
4. Areas for improvement
5. Recommendations for next month
6. Data appendix

## Output Format (raw JSON only)
{
  "report_title": "<e.g. SPG — 7-Day Performance Snapshot — 12 May 2026>",
  "period": "<date range>",
  "headline_metric": "<the single most important metric and its change>",
  "report_content": "<full report in markdown>",
  "key_insights": ["<insight 1>", "<insight 2>"],
  "recommendations": ["<rec 1>", "<rec 2>"],
  "task_title": "<kanban title for approval task>"
}

## Rules
- Never fabricate metrics — if data is missing say so explicitly
- Always compare to a prior period (prior 7 days or prior month)
- Flag any anomalies (sudden drops, unusual spikes)
- If a channel has no data, note it and explain why
$PROMPT$,
  status = 'building',
  prompt_version = 1,
  updated_at = now()
where name = 'Reporting';

-- ─── SEED: CLIENT CONFIGS ────────────────────────────────────────────────────
insert into client_configs (project_id, client_name, notes) values
  ('client-spg',       'SPG (Stockwell Property Group)', 'Residential property developer, Brisbane. Premium brand.'),
  ('client-colliers',  'Colliers',                       'Commercial real estate. National brand, local campaigns.'),
  ('client-cpg',       'CPG',                            'Property / development client.'),
  ('client-panorama',  'Panorama',                       'Property development client.'),
  ('client-rvlifestyle','RV Lifestyle',                  'Recreational vehicles and lifestyle brand.')
on conflict (project_id) do nothing;

-- ─── SEED: ACCOUNT MANAGER INSTANCES (one per client) ────────────────────────
insert into bot_instances (bot_id, project_id, client_name, context_doc, status)
select
  b.id,
  c.project_id,
  c.client_name,
  'Client: ' || c.client_name || E'\n' ||
  'Project Profile contact: Mark Allen (mark@projectprofile.agency)' || E'\n' ||
  'Notes: ' || coalesce(c.notes, ''),
  'active'
from bots b, client_configs c
where b.name = 'Account Manager'
and not exists (
  select 1 from bot_instances bi where bi.bot_id = b.id and bi.project_id = c.project_id
);

-- ─── SEED: REPORTING INSTANCES (one per client) ──────────────────────────────
insert into bot_instances (bot_id, project_id, client_name, context_doc, status)
select
  b.id,
  c.project_id,
  c.client_name,
  'Client: ' || c.client_name || E'\n' ||
  'Notes: ' || coalesce(c.notes, ''),
  'active'
from bots b, client_configs c
where b.name = 'Reporting'
and not exists (
  select 1 from bot_instances bi where bi.bot_id = b.id and bi.project_id = c.project_id
);
