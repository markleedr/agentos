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

const EXTRACTION_PROMPT = `You are an expert at extracting performance learnings from marketing data.

Given a performance report, extract 2-5 discrete learnings that should inform future bot behaviour.

For each learning, output:
- bot_type: which bot should learn this (Content | PPC | Reporting | Art Director | Copywriting | Account Manager)
- category: what kind of learning (audience | creative | copy | budget | timing | channel | format | tone)
- learning: the specific, actionable learning in one sentence
- performance_evidence: the specific metric or observation that supports it

Output raw JSON array only:
[
  {
    "bot_type": "...",
    "category": "...",
    "learning": "...",
    "performance_evidence": "..."
  }
]`


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

    const baseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const {
      report_id,
      project_id,
      client_name,
      report_content,
      auto_apply = false  // if true, immediately pushes learnings into bot_knowledge
    } = await req.json()

    if (!project_id || !report_content) {
      throw new Error('project_id and report_content are required')
    }

    // Extract learnings from the report
    const userMessage = `
## Client: ${client_name}
## Project: ${project_id}

## Report Content:
${report_content}

Extract the performance learnings from this report.
`.trim()

    const claudeResponse = await callClaude(EXTRACTION_PROMPT, userMessage)

    let learnings: Array<{
      bot_type: string
      category: string
      learning: string
      performance_evidence: string
    }>

    try {
      learnings = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    // Store all learnings in performance_feedback
    const feedbackInserts = learnings.map(l => ({
      bot_type: l.bot_type,
      project_id,
      client_name: client_name || null,
      report_id: report_id || null,
      category: l.category,
      learning: l.learning,
      performance_evidence: l.performance_evidence,
      added_by: 'agent',
      applied_to_knowledge: false
    }))

    const { data: feedbackRows } = await supabase
      .from('performance_feedback')
      .insert(feedbackInserts)
      .select()

    const feedbackIds = feedbackRows?.map(r => r.id) || []

    // Optionally push directly to bot_knowledge
    if (auto_apply && feedbackRows?.length) {
      const authHeader = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` }

      await Promise.allSettled(
        feedbackRows.map(fb =>
          fetch(`${baseUrl}/functions/v1/knowledge-updater`, {
            method: 'POST',
            headers: authHeader,
            body: JSON.stringify({
              bot_type: fb.bot_type,
              category: fb.category,
              content: fb.learning,
              project_id,
              client_name,
              source_report_id: report_id || null,
              added_by: 'performance_feedback'
            })
          })
        )
      )
    }

    await supabase.from('audit_log').insert({
      event_type: 'performance_feedback_logged',
      description: `${learnings.length} learnings extracted from ${client_name} report`,
      metadata: {
        project_id,
        report_id,
        feedback_ids: feedbackIds,
        auto_applied: auto_apply,
        learning_count: learnings.length
      },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({
        processed: true,
        learnings_count: learnings.length,
        feedback_ids: feedbackIds,
        auto_applied: auto_apply,
        learnings: learnings.map(l => ({ bot_type: l.bot_type, category: l.category, learning: l.learning }))
      }),
      { status: 200 }
    )

  } catch (error) {
    console.error('performance-feedback error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
