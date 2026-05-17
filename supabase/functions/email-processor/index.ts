import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const ERIC_EMAIL = 'eric@projectprofile.agency'

async function getMicrosoftToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${Deno.env.get('MICROSOFT_TENANT_ID')}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('MICROSOFT_CLIENT_ID')!,
        client_secret: Deno.env.get('MICROSOFT_CLIENT_SECRET')!,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    }
  )
  if (!res.ok) throw new Error(`Token fetch failed: ${await res.text()}`)
  const data = await res.json()
  return data.access_token
}

async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  })
  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { email_queue_id } = await req.json()

    // Load the email
    const { data: email, error: emailError } = await supabase
      .from('email_queue')
      .select('*')
      .eq('id', email_queue_id)
      .single()

    if (emailError || !email) throw new Error(`Email not found: ${email_queue_id}`)
    if (email.processed) return new Response(JSON.stringify({ skipped: true }), { status: 200 })

    // Load Eric's system prompt
    const { data: eric } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Eric')
      .single()

    const systemPrompt = eric?.system_prompt || ''

    // Ask Claude to classify and draft a reply
    const userMessage = `
## Inbound Email

From: ${email.from_name} <${email.from_email}>
Subject: ${email.subject}
Received: ${email.received_at}

Body:
${email.body_full || email.body_preview}

---

Respond with a JSON object (no markdown, raw JSON only):
{
  "intent": "<new_client_enquiry|existing_client_request|internal|invoice|spam|other>",
  "urgency": "<high|medium|low>",
  "assignee": "<mark|beck|amit>",
  "task_title": "<concise task title>",
  "task_description": "<full context for the task>",
  "draft_reply": "<complete draft reply email body, or null if intent is spam>"
}
`.trim()

    const claudeResponse = await callClaude(systemPrompt, userMessage)

    // Parse Claude's JSON response
    let parsed: {
      intent: string
      urgency: string
      assignee: string
      task_title: string
      task_description: string
      draft_reply: string | null
    }

    try {
      parsed = JSON.parse(claudeResponse)
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    // Don't create tasks for spam
    if (parsed.intent === 'spam') {
      await supabase
        .from('email_queue')
        .update({ intent: 'spam', processed: true, processed_at: new Date().toISOString() })
        .eq('id', email_queue_id)

      await supabase.from('audit_log').insert({
        event_type: 'email_classified_spam',
        bot_id: eric?.id,
        description: `Eric classified email from ${email.from_email} as spam`,
        metadata: { email_queue_id, subject: email.subject },
        severity: 'info'
      })

      return new Response(JSON.stringify({ processed: true, intent: 'spam' }), { status: 200 })
    }

    // Create a task
    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id: 'project-profile-internal',
        title: parsed.task_title,
        description: parsed.task_description,
        assignee: parsed.assignee,
        priority: parsed.urgency,
        status: 'inbox',
        source: 'email'
      })
      .select()
      .single()

    // Write the draft reply as a task output pending approval
    if (parsed.draft_reply && task) {
      const draftBody = `
## Draft Reply to: ${email.from_name} <${email.from_email}>
## Subject: Re: ${email.subject}

${parsed.draft_reply}

---
_This is a draft. Approve to send via eric@projectprofile.agency_
`.trim()

      await supabase.from('task_outputs').insert({
        task_id: task.id,
        prompt_sent: userMessage,
        response: draftBody,
        parsed_output: {
          intent: parsed.intent,
          draft_reply: parsed.draft_reply,
          from_email: email.from_email,
          subject: email.subject
        },
        approval_status: 'pending'
      })

      // If draft reply exists, always route to action_required for human approval
      await supabase
        .from('tasks')
        .update({ status: 'action_required' })
        .eq('id', task.id)
    }

    // Mark email as processed
    await supabase
      .from('email_queue')
      .update({
        intent: parsed.intent,
        task_id: task?.id,
        draft_reply: parsed.draft_reply,
        processed: true,
        processed_at: new Date().toISOString()
      })
      .eq('id', email_queue_id)

    // Audit log
    await supabase.from('audit_log').insert({
      event_type: 'email_processed',
      bot_id: eric?.id,
      task_id: task?.id,
      description: `Eric processed email from ${email.from_email}: intent=${parsed.intent}, task created`,
      metadata: { email_queue_id, intent: parsed.intent, assignee: parsed.assignee },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, intent: parsed.intent, task_id: task?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('email-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
