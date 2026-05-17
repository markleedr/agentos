import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

async function addToMailchimp(email: string, firstName: string, lastName: string, tag: string): Promise<string | null> {
  const apiKey = Deno.env.get('MAILCHIMP_API_KEY')
  const listId = Deno.env.get('MAILCHIMP_LIST_ID')
  if (!apiKey || !listId) return null

  const dc = apiKey.split('-').pop()
  const res = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`anystring:${apiKey}`)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email_address: email,
      status: 'subscribed',
      merge_fields: { FNAME: firstName, LNAME: lastName || '' },
      tags: [tag]
    })
  })

  if (!res.ok) {
    const err = await res.json()
    // Already subscribed — update tags instead
    if (err.title === 'Member Exists') {
      const hash = await crypto.subtle.digest('MD5', new TextEncoder().encode(email.toLowerCase()))
      const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
      await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members/${hashHex}/tags`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`anystring:${apiKey}`)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tags: [{ name: tag, status: 'active' }] })
      })
      return err.id || null
    }
    console.error('Mailchimp error:', err)
    return null
  }

  const data = await res.json()
  return data.id || null
}


function parseClaudeJSON(text: string): unknown {
  let json = text.trim()
  if (json.startsWith('```')) {
    const nl = String.fromCharCode(10)
    const firstNewline = json.indexOf(nl)
    json = firstNewline !== -1 ? json.slice(firstNewline + 1) : json.slice(3)
    const end = json.lastIndexOf('```')
    if (end !== -1) json = json.slice(0, end)
    json = json.trim()
  }
  return JSON.parse(json)
}

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { first_name, last_name, email, company, phone, source, message } = await req.json()
    if (!email || !first_name) throw new Error('email and first_name are required')

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Acquisition')
      .single()

    const userMessage = `
## New Lead

Name: ${first_name} ${last_name || ''}
Email: ${email}
Company: ${company || 'Not provided'}
Phone: ${phone || 'Not provided'}
Source: ${source}
Message: ${message || 'No message provided'}

Score this lead and provide acquisition guidance.
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      score: number
      fit_summary: string
      nurture_path: string
      task_title: string
      task_description: string
      priority: string
      recommended_response: string
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    // Insert lead record
    const { data: lead } = await supabase
      .from('leads')
      .insert({
        first_name,
        last_name,
        email,
        company,
        phone,
        source,
        message,
        score: parsed.score,
        fit_summary: parsed.fit_summary,
        nurture_status: parsed.nurture_path === 'disqualify' ? 'disqualified' : 'new'
      })
      .select()
      .single()

    // Create task for Mark (skip if disqualified)
    let task = null
    if (parsed.nurture_path !== 'disqualify') {
      const { data: t } = await supabase
        .from('tasks')
        .insert({
          project_id: 'project-profile-internal',
          title: parsed.task_title,
          description: `${parsed.task_description}\n\n**Lead Score:** ${parsed.score}/10\n**Fit:** ${parsed.fit_summary}\n\n**Recommended Response:**\n${parsed.recommended_response}`,
          assignee: 'mark',
          priority: parsed.priority as 'high' | 'medium' | 'low',
          status: 'action_required',
          source: 'agent'
        })
        .select()
        .single()
      task = t

      // Write full output
      await supabase.from('task_outputs').insert({
        task_id: task?.id,
        bot_instance_id: null,
        prompt_sent: userMessage,
        response: claudeResponse,
        parsed_output: parsed,
        approval_status: 'pending'
      })

      // Update lead with task reference
      await supabase.from('leads').update({ task_id: task?.id }).eq('id', lead?.id)
    }

    // Add to Mailchimp nurture sequence
    let mailchimpId = null
    if (parsed.nurture_path !== 'disqualify') {
      const tag = `nurture-${parsed.nurture_path}` // hot, warm, cold
      mailchimpId = await addToMailchimp(email, first_name, last_name || '', tag)
      if (mailchimpId) {
        await supabase.from('leads').update({
          mailchimp_id: mailchimpId,
          nurture_status: 'nurturing'
        }).eq('id', lead?.id)
      }
    }

    await supabase.from('audit_log').insert({
      event_type: 'lead_processed',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Acquisition Bot scored lead ${email}: ${parsed.score}/10 (${parsed.nurture_path})`,
      metadata: { lead_id: lead?.id, score: parsed.score, nurture_path: parsed.nurture_path, mailchimp_id: mailchimpId },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, lead_id: lead?.id, score: parsed.score, nurture_path: parsed.nurture_path, task_id: task?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('acquisition-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
