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
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  })
  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
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

    // mode: 'research' | 'outreach' | 'followup_sequence'
    const { mode, prospect_name, prospect_company, prospect_role, prospect_url, context, lead_id } = await req.json()

    if (!mode || !prospect_name) throw new Error('mode and prospect_name are required')

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Sales')
      .single()

    const modeInstructions = {
      research: 'Produce a full prospect research brief for this person.',
      outreach: 'Write a cold outreach email and full 3-touch follow-up sequence for this prospect.',
      followup_sequence: 'Write a 3-touch follow-up sequence picking up from the initial outreach.'
    }

    const userMessage = `
## Prospect

Name: ${prospect_name}
Company: ${prospect_company || 'Unknown'}
Role: ${prospect_role || 'Unknown'}
Website: ${prospect_url || 'Not provided'}
Additional context: ${context || 'None'}

Task: ${modeInstructions[mode as keyof typeof modeInstructions] || modeInstructions.research}
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      research_brief?: string
      outreach_subject?: string
      outreach_body?: string
      followup_sequence?: Array<{ day: number; subject: string; body: string }>
      task_title: string
      recommended_channel?: string
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    // Format output for task
    const outputParts = []
    if (parsed.research_brief) outputParts.push(`## Research Brief\n\n${parsed.research_brief}`)
    if (parsed.outreach_subject) {
      outputParts.push(`## Cold Outreach\n\n**Subject:** ${parsed.outreach_subject}\n\n${parsed.outreach_body}`)
    }
    if (parsed.followup_sequence?.length) {
      const followupText = parsed.followup_sequence
        .map(f => `### Day ${f.day}\n**Subject:** ${f.subject}\n\n${f.body}`)
        .join('\n\n')
      outputParts.push(`## Follow-up Sequence\n\n${followupText}`)
    }
    if (parsed.recommended_channel) {
      outputParts.push(`**Recommended channel:** ${parsed.recommended_channel}`)
    }

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id: 'project-profile-internal',
        title: parsed.task_title,
        description: `Prospect: ${prospect_name} @ ${prospect_company || 'Unknown'}`,
        assignee: 'mark',
        priority: 'medium',
        status: 'action_required',
        source: 'agent'
      })
      .select()
      .single()

    await supabase.from('task_outputs').insert({
      task_id: task?.id,
      prompt_sent: userMessage,
      response: outputParts.join('\n\n---\n\n'),
      parsed_output: parsed,
      approval_status: 'pending'
    })

    await supabase.from('audit_log').insert({
      event_type: 'sales_processed',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Sales Bot generated ${mode} for ${prospect_name} @ ${prospect_company}`,
      metadata: { mode, prospect_name, prospect_company, lead_id },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id, mode }),
      { status: 200 }
    )

  } catch (error) {
    console.error('sales-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
