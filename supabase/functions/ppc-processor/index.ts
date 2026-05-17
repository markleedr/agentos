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

    const { project_id, client_name, platform, monthly_budget, objective, brief, brief_task_id } = await req.json()

    if (!project_id || !brief) {
      throw new Error('project_id and brief are required')
    }

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'PPC')
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

## Campaign Parameters
Platform: ${platform || 'meta'}
Monthly budget: $${monthly_budget || 'TBD'} AUD
Objective: ${objective || 'leads'}

Build the campaign structure for this brief.
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      platform: string
      campaign_structure: object
      keywords?: object
      targeting_rationale: string
      budget_breakdown: object
      optimisation_recommendations: string[]
      task_title: string
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    const outputText = [
      `## PPC Campaign: ${parsed.platform}`,
      '',
      `**Targeting rationale:** ${parsed.targeting_rationale}`,
      '',
      `**Budget breakdown:**\n\`\`\`json\n${JSON.stringify(parsed.budget_breakdown, null, 2)}\n\`\`\``,
      '',
      `**Campaign structure:**\n\`\`\`json\n${JSON.stringify(parsed.campaign_structure, null, 2)}\n\`\`\``,
      parsed.keywords ? `\n**Keywords:**\n\`\`\`json\n${JSON.stringify(parsed.keywords, null, 2)}\n\`\`\`` : '',
      parsed.optimisation_recommendations?.length
        ? `\n**Optimisation recommendations:**\n${parsed.optimisation_recommendations.map(r => `- ${r}`).join('\n')}`
        : ''
    ].filter(Boolean).join('\n\n')

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id,
        title: parsed.task_title,
        description: `${client_name} | ${parsed.platform} campaign | ${objective || 'leads'}`,
        assignee: 'amit',
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
      event_type: 'ppc_campaign_generated',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `PPC Bot generated ${parsed.platform} campaign for ${client_name}`,
      metadata: { project_id, platform: parsed.platform, budget: monthly_budget },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('ppc-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
