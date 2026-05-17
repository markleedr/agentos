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

    const { project_id, client_name, campaign_name, formats, brief, brief_task_id } = await req.json()

    if (!project_id || !brief) {
      throw new Error('project_id and brief are required')
    }

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Art Director')
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

## Campaign
Name: ${campaign_name || 'Campaign'}
Required formats: ${formats ? formats.join(', ') : '1:1, 9:16, 16:9'}

Define the visual direction for this campaign.
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      visual_concept: string
      colour_palette: Array<{ name: string; hex: string; usage: string }>
      typography: { heading: string; body: string; hierarchy_notes: string }
      imagery_style: string
      image_prompts: Array<{ asset_type: string; prompt: string; notes: string }>
      moodboard_references: string
      layout_principles: string
      task_title: string
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    const paletteText = parsed.colour_palette?.map(c => `- **${c.name}** ${c.hex}: ${c.usage}`).join('\n') || ''
    const promptsText = parsed.image_prompts?.map(p =>
      `**${p.asset_type}:** ${p.prompt}${p.notes ? `\n*Notes: ${p.notes}*` : ''}`
    ).join('\n\n') || ''

    const outputText = [
      `## Visual Direction: ${parsed.visual_concept}`,
      '',
      `**Colour palette:**\n${paletteText}`,
      '',
      `**Typography:** ${parsed.typography?.heading} / ${parsed.typography?.body}`,
      parsed.typography?.hierarchy_notes ? `*${parsed.typography.hierarchy_notes}*` : '',
      '',
      `**Imagery style:** ${parsed.imagery_style}`,
      '',
      `**Moodboard:** ${parsed.moodboard_references}`,
      '',
      `**Layout principles:** ${parsed.layout_principles}`,
      '',
      `**Image prompts:**\n${promptsText}`
    ].filter(Boolean).join('\n\n')

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id,
        title: parsed.task_title,
        description: `${client_name} | Visual direction | ${campaign_name || 'Campaign'}`,
        assignee: 'beck',
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
      event_type: 'art_direction_generated',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Art Director Bot generated visual direction for ${client_name}`,
      metadata: { project_id, campaign_name },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('art-director-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
