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

    const { transcript, meeting_title, project_id } = await req.json()

    if (!transcript) throw new Error('transcript is required')

    // Load Eric's system prompt
    const { data: eric } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Eric')
      .single()

    const userMessage = `
## WIP Meeting Transcript
Meeting: ${meeting_title || 'Team WIP'}

${transcript}

---

Extract all action items from this transcript. Respond with a JSON array (no markdown, raw JSON only):
[
  {
    "action": "<what needs to be done>",
    "owner": "<mark|beck|amit — best guess from context>",
    "due_date": "<YYYY-MM-DD if mentioned, otherwise null>",
    "priority": "<high|medium|low>",
    "context": "<any relevant context from the discussion>"
  }
]

Extract every single action item, no matter how small. If someone said they would do something, it's an action item.
`.trim()

    const claudeResponse = await callClaude(eric?.system_prompt || '', userMessage)

    let actionItems: Array<{
      action: string
      owner: string
      due_date: string | null
      priority: string
      context: string
    }>

    try {
      actionItems = JSON.parse(claudeResponse)
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    if (!Array.isArray(actionItems) || actionItems.length === 0) {
      await supabase.from('audit_log').insert({
        event_type: 'wip_processed',
        bot_id: eric?.id,
        description: `Eric processed WIP transcript "${meeting_title}" — no action items found`,
        metadata: { meeting_title, project_id },
        severity: 'info'
      })
      return new Response(JSON.stringify({ processed: true, tasks_created: 0 }), { status: 200 })
    }

    // Create a task for each action item
    const createdTaskIds: string[] = []
    for (const item of actionItems) {
      const { data: task } = await supabase
        .from('tasks')
        .insert({
          project_id: project_id || 'project-profile-internal',
          title: item.action,
          description: item.context || '',
          assignee: item.owner as 'mark' | 'beck' | 'amit',
          priority: item.priority as 'high' | 'medium' | 'low',
          status: 'to_do',
          source: 'wip_transcript',
          due_date: item.due_date || null
        })
        .select()
        .single()

      if (task) createdTaskIds.push(task.id)
    }

    await supabase.from('audit_log').insert({
      event_type: 'wip_processed',
      bot_id: eric?.id,
      description: `Eric processed WIP transcript "${meeting_title}" — ${createdTaskIds.length} tasks created`,
      metadata: { meeting_title, project_id, task_count: createdTaskIds.length, task_ids: createdTaskIds },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, tasks_created: createdTaskIds.length, task_ids: createdTaskIds }),
      { status: 200 }
    )

  } catch (error) {
    console.error('wip-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
