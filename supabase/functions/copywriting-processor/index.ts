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
      max_tokens: 8192,
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

    // copy_type: landing_page | email | email_sequence | ad_copy | proposal
    const { project_id, client_name, copy_type, audience, brief, brief_task_id } = await req.json()

    if (!project_id || !copy_type || !brief) {
      throw new Error('project_id, copy_type, and brief are required')
    }

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Copywriting')
      .single()

    const { data: instance } = await supabase
      .from('bot_instances')
      .select('context_doc, id')
      .eq('project_id', project_id)
      .eq('bot_id', bot?.id)
      .single()

    const userMessage = `
## Client Context
${instance?.context_doc || `Client: ${client_name}`}

## Brief
${brief}

## Request
Copy type: ${copy_type}
${audience ? `Target audience: ${audience}` : ''}

Write the copy for this brief.
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      copy_type: string
      headline_variants: string[]
      body_copy: string
      cta_variants: string[]
      subject_line_variants?: string[]
      word_count: number
      reading_level: string
      task_title: string
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    const outputText = [
      `## ${parsed.copy_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`,
      '',
      parsed.headline_variants?.length
        ? `**Headline options:**\n${parsed.headline_variants.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
        : '',
      parsed.subject_line_variants?.length
        ? `**Subject lines:**\n${parsed.subject_line_variants.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : '',
      '',
      `**Body copy:**\n${parsed.body_copy}`,
      '',
      parsed.cta_variants?.length
        ? `**CTA options:**\n${parsed.cta_variants.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
        : '',
      `\n*${parsed.word_count} words · ${parsed.reading_level} reading level*`
    ].filter(Boolean).join('\n\n')

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id,
        title: parsed.task_title,
        description: `${client_name} | ${copy_type.replace(/_/g, ' ')}`,
        assignee: 'mark',
        priority: 'medium',
        status: 'action_required',
        source: 'agent',
        parent_task_id: brief_task_id || null
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
      event_type: 'copy_generated',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Copywriting Bot generated ${copy_type} for ${client_name}`,
      metadata: { project_id, copy_type, word_count: parsed.word_count },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('copywriting-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
