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

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // message_type: 'inbound_brief' | 'approval_request' | 'client_query' | 'status_update'
    const { project_id, client_name, message_type, message, from_name, from_email, subject } = await req.json()

    if (!project_id || !message_type || !message) {
      throw new Error('project_id, message_type, and message are required')
    }

    // Load Account Manager bot + instance for this client
    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Account Manager')
      .single()

    const { data: instance } = await supabase
      .from('bot_instances')
      .select('context_doc, id')
      .eq('project_id', project_id)
      .eq('bot_id', bot?.id)
      .single()

    const contextBlock = instance?.context_doc
      ? `## Client Context\n${instance.context_doc}`
      : `## Client\n${client_name}`

    const userMessage = `
${contextBlock}

## Inbound Communication

Type: ${message_type}
${from_name ? `From: ${from_name}${from_email ? ` <${from_email}>` : ''}` : ''}
${subject ? `Subject: ${subject}` : ''}

Message:
${message}

Draft the appropriate response and provide your internal notes.
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      response_type: string
      draft_response: string
      internal_note: string
      task_title: string
      priority: string
      next_steps: string[]
    }

    try {
      parsed = JSON.parse(claudeResponse)
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    const priority = parsed.priority as 'high' | 'medium' | 'low'
    const taskStatus = parsed.response_type === 'escalate_to_mark' ? 'action_required' : 'action_required'

    const outputText = [
      `## ${parsed.response_type === 'escalate_to_mark' ? '⚠ Escalation Required' : 'Draft Client Response'}`,
      parsed.response_type === 'escalate_to_mark'
        ? `**This requires Mark's direct input before a response can be drafted.**\n\n${parsed.internal_note}`
        : parsed.draft_response,
      parsed.internal_note && parsed.response_type !== 'escalate_to_mark'
        ? `\n---\n**Internal note for Mark:** ${parsed.internal_note}`
        : '',
      parsed.next_steps?.length
        ? `\n**Next steps:**\n${parsed.next_steps.map(s => `- ${s}`).join('\n')}`
        : ''
    ].filter(Boolean).join('\n\n')

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id,
        title: parsed.task_title,
        description: `${client_name} | ${message_type}${subject ? `: ${subject}` : ''}`,
        assignee: 'mark',
        priority,
        status: taskStatus,
        source: 'agent'
      })
      .select()
      .single()

    await supabase.from('task_outputs').insert({
      task_id: task?.id,
      bot_instance_id: instance?.id,
      prompt_sent: userMessage,
      response: outputText,
      parsed_output: parsed,
      approval_status: 'pending'
    })

    await supabase.from('audit_log').insert({
      event_type: 'account_manager_processed',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Account Manager processed ${message_type} for ${client_name}`,
      metadata: { project_id, message_type, response_type: parsed.response_type },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id, response_type: parsed.response_type }),
      { status: 200 }
    )

  } catch (error) {
    console.error('account-manager-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
