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

    // mode: 'campaign_brief' | 'brand_analysis' | 'competitive_research'
    const {
      mode,
      client_name,
      project_id,
      objective,
      background,
      budget,
      timeline,
      channels,
      competitors,
      brand_materials
    } = await req.json()

    if (!mode || !client_name) throw new Error('mode and client_name are required')

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Strategist')
      .single()

    const modeLabels = {
      campaign_brief: 'Generate a full campaign brief',
      brand_analysis: 'Produce a brand analysis',
      competitive_research: 'Produce a competitive research report'
    }

    const userMessage = `
## ${modeLabels[mode as keyof typeof modeLabels] || mode} for ${client_name}

**Objective:** ${objective || 'Not specified'}
**Background:** ${background || 'Not provided'}
${budget ? `**Budget:** ${budget}` : ''}
${timeline ? `**Timeline:** ${timeline}` : ''}
${channels ? `**Preferred channels:** ${channels}` : ''}
${competitors ? `**Known competitors:** ${competitors}` : ''}
${brand_materials ? `**Brand materials / notes:** ${brand_materials}` : ''}

Produce the ${mode.replace(/_/g, ' ')} output.
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      output_type: string
      title: string
      content: string
      task_title: string
      confidence: string
      missing_inputs?: string[]
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    const hasMissingInputs = parsed.missing_inputs && parsed.missing_inputs.length > 0
    const priority = hasMissingInputs || parsed.confidence === 'low' ? 'medium' : 'high'

    const outputText = [
      `# ${parsed.title}`,
      `**Client:** ${client_name} | **Type:** ${parsed.output_type} | **Confidence:** ${parsed.confidence}`,
      hasMissingInputs ? `\n⚠ **Missing inputs that would strengthen this brief:**\n${parsed.missing_inputs!.map(m => `- ${m}`).join('\n')}` : '',
      `\n${parsed.content}`
    ].filter(Boolean).join('\n\n')

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id: project_id || `client-${client_name.toLowerCase().replace(/\s+/g, '-')}`,
        title: parsed.task_title,
        description: `Strategist Bot produced ${mode.replace(/_/g, ' ')} for ${client_name}. Confidence: ${parsed.confidence}.${hasMissingInputs ? ` Missing inputs: ${parsed.missing_inputs?.length}` : ''}`,
        assignee: 'mark',
        priority,
        status: 'action_required',
        source: 'agent'
      })
      .select()
      .single()

    await supabase.from('task_outputs').insert({
      task_id: task?.id,
      prompt_sent: userMessage,
      response: outputText,
      parsed_output: parsed,
      approval_status: 'pending'
    })

    await supabase.from('audit_log').insert({
      event_type: 'strategist_processed',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Strategist Bot produced ${mode} for ${client_name} (confidence: ${parsed.confidence})`,
      metadata: { mode, client_name, confidence: parsed.confidence, missing_inputs_count: parsed.missing_inputs?.length || 0 },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id, confidence: parsed.confidence, missing_inputs: parsed.missing_inputs }),
      { status: 200 }
    )

  } catch (error) {
    console.error('strategist-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
