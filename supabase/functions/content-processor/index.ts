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

    const { project_id, client_name, platform, post_type, brief, brief_task_id } = await req.json()

    if (!project_id || !platform || !brief) {
      throw new Error('project_id, platform, and brief are required')
    }

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Content')
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
Platform: ${platform}
Post type: ${post_type || 'feed'}

Generate social media copy for this brief.
`.trim()

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      platform: string
      post_type: string
      copy_variants: Array<{ variant: string; caption: string; headline?: string; cta: string }>
      hashtags: string[]
      notes: string
      task_title: string
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    const outputText = [
      `## Content: ${parsed.platform} ${parsed.post_type}`,
      '',
      ...parsed.copy_variants.map(v => [
        `### Variant ${v.variant}`,
        v.headline ? `**Headline:** ${v.headline}` : '',
        `**Caption:**\n${v.caption}`,
        `**CTA:** ${v.cta}`
      ].filter(Boolean).join('\n')),
      parsed.hashtags?.length ? `\n**Hashtags:** ${parsed.hashtags.join(' ')}` : '',
      parsed.notes ? `\n---\n**Creative notes:** ${parsed.notes}` : ''
    ].filter(Boolean).join('\n\n')

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id,
        title: parsed.task_title,
        description: `${client_name} | ${platform} ${parsed.post_type}`,
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
      event_type: 'content_generated',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Content Bot generated ${platform} ${parsed.post_type} copy for ${client_name}`,
      metadata: { project_id, platform, post_type: parsed.post_type },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('content-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
