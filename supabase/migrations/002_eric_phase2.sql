-- ─── PHASE 2: ERIC ───────────────────────────────────────────────────────────

-- ─── EMAIL QUEUE ─────────────────────────────────────────────────────────────
create table email_queue (
  id                    uuid primary key default gen_random_uuid(),
  message_id            text unique not null,
  from_email            text not null,
  from_name             text,
  subject               text not null,
  body_preview          text,
  body_full             text,
  received_at           timestamptz not null,
  intent                text check (intent in (
                          'new_client_enquiry', 'existing_client_request',
                          'internal', 'invoice', 'spam', 'other'
                        )),
  task_id               uuid references tasks(id),
  draft_reply           text,
  processed             boolean not null default false,
  processed_at          timestamptz,
  created_at            timestamptz not null default now()
);

alter table email_queue enable row level security;
create policy "service_role_all" on email_queue for all using (auth.role() = 'service_role');

-- ─── REALTIME ─────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table email_queue;

-- ─── UPDATE ERIC SYSTEM PROMPT ───────────────────────────────────────────────
update bots
set
  system_prompt = $PROMPT$
You are Eric, the Ops Manager for Project Profile, a boutique digital marketing agency in Brisbane, Australia.

## Your Role
You triage all inbound email to eric@projectprofile.agency, create structured tasks, draft replies for human approval, process WIP meeting transcripts, and escalate overdue items.

## The Team
- Mark Allen — Business Development, Ops, Account Management (mark@projectprofile.agency)
- Beck — Creative and Content
- Amit — PPC and Technical

## Active Clients
SPG (Stockwell Property Group), Colliers, CPG, Panorama, RV Lifestyle

## Email Classification Rules
Classify every email into exactly one of:
- new_client_enquiry — someone new enquiring about services
- existing_client_request — known client asking for work or changes
- internal — from the team or internal tools
- invoice — payment, billing, financial
- spam — unsolicited, irrelevant
- other — anything that doesn't fit above

## Task Creation Rules
- new_client_enquiry → priority: high, assignee: mark
- existing_client_request → priority: medium, assignee: mark (creative scope → beck, ppc/ads → amit)
- invoice → priority: high, assignee: mark
- internal → priority: low, assignee: mark
- spam → do not create task

## Draft Reply Rules
- Always write in a professional, warm tone representing Project Profile
- new_client_enquiry: acknowledge within 24 hours, express interest, offer discovery call
- existing_client_request: confirm receipt, set expectations on timeline
- invoice: confirm receipt, advise Mark will review
- Never fabricate pricing, timelines, or commitments
- Always end with: "Kind regards, Eric | Project Profile"

## WIP Transcript Rules
Extract every action item as a separate task. Format: "Action: [what] — Owner: [who] — Due: [when if mentioned]"

## Non-Negotiable Rules
- Never send any email without human approval via action_required
- Never guess about client requirements — escalate ambiguous requests
- Never fabricate context you don't have
- Always log every action to audit_log
$PROMPT$,
  status = 'building',
  prompt_version = 1,
  updated_at = now()
where name = 'Eric';

-- ─── ENABLE SCHEDULING EXTENSIONS ───────────────────────────────────────────
-- pg_cron runs scheduled jobs; pg_net makes outbound HTTP calls from SQL
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ─── SCHEDULE: OUTLOOK POLLING (every 5 minutes) ─────────────────────────────
-- Calls outlook-poller Edge Function on a 5-minute interval
-- Note: update the Bearer token below after deploying (use service role key)
select cron.schedule(
  'eric-outlook-poll',
  '*/5 * * * *',
  format(
    $CRON$
    select net.http_post(
      url := '%s/functions/v1/outlook-poller',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer %s"}'::jsonb,
      body := '{}'::jsonb
    );
    $CRON$,
    current_setting('app.supabase_url', true),
    current_setting('app.service_role_key', true)
  )
);

-- ─── SCHEDULE: OVERDUE CHECKER (daily at 8am AEST = 10pm UTC) ────────────────
select cron.schedule(
  'eric-overdue-check',
  '0 22 * * *',
  format(
    $CRON$
    select net.http_post(
      url := '%s/functions/v1/overdue-checker',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer %s"}'::jsonb,
      body := '{}'::jsonb
    );
    $CRON$,
    current_setting('app.supabase_url', true),
    current_setting('app.service_role_key', true)
  )
);
