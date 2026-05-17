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

    // mode: 'categorise' | 'bas_report'
    // For categorise: pass transactions array
    // For bas_report: pass period (e.g. "Q3 2025-26")
    const { mode, transactions, period, project_id } = await req.json()

    if (!mode) throw new Error('mode is required')

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Finance')
      .single()

    let userMessage = ''

    if (mode === 'categorise') {
      if (!transactions || !Array.isArray(transactions)) throw new Error('transactions array is required for categorise mode')
      userMessage = `
## Transaction Categorisation Request

Please categorise the following ${transactions.length} transactions for Project Profile.

Transactions:
${transactions.map((t: { id?: string; date: string; description: string; amount: number; type?: string }, i: number) =>
  `${i + 1}. ID: ${t.id || i} | Date: ${t.date} | Description: ${t.description} | Amount: $${t.amount} AUD | Type: ${t.type || 'unknown'}`
).join('\n')}

Categorise each transaction and provide a BAS summary.
`.trim()
    } else if (mode === 'bas_report') {
      if (!period) throw new Error('period is required for bas_report mode')
      userMessage = `
## BAS Report Request

Period: ${period}

Please review the categorised transactions for this period and produce a BAS summary ready for accountant review.
Note any items requiring clarification or that may need adjustment before lodgement.
`.trim()
    }

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      categorised?: Array<{
        transaction_id: string
        description: string
        amount: number
        category_code: string
        category_name: string
        gst_applicable: boolean
        gst_amount: number | null
        confidence: string
        notes: string
      }>
      flags?: string[]
      bas_summary?: {
        gst_collected: number
        gst_paid: number
        net_gst: number
      }
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    const flagCount = parsed.flags?.length || 0
    const lowConfidenceCount = parsed.categorised?.filter(t => t.confidence === 'low').length || 0
    const priority = flagCount > 0 || lowConfidenceCount > 2 ? 'high' : 'medium'

    const taskTitle = mode === 'categorise'
      ? `Finance: Review ${transactions?.length} transactions${flagCount > 0 ? ` — ${flagCount} flag${flagCount > 1 ? 's' : ''}` : ''}`
      : `Finance: BAS report ${period} ready for review`

    const outputText = [
      mode === 'bas_report' ? `## BAS Report — ${period}` : `## Transaction Categorisation`,
      parsed.bas_summary ? `\n**GST Collected:** $${parsed.bas_summary.gst_collected?.toFixed(2)}\n**GST Paid:** $${parsed.bas_summary.gst_paid?.toFixed(2)}\n**Net GST Payable:** $${parsed.bas_summary.net_gst?.toFixed(2)}` : '',
      parsed.flags?.length ? `\n## Flags Requiring Review\n${parsed.flags.map(f => `- ${f}`).join('\n')}` : '',
      parsed.categorised?.length ? `\n## Categorised Transactions\n${parsed.categorised.map(t =>
        `- [${t.category_code}] ${t.description}: $${t.amount} — ${t.category_name}${t.confidence === 'low' ? ' ⚠ LOW CONFIDENCE' : ''}${t.notes ? ` — ${t.notes}` : ''}`
      ).join('\n')}` : ''
    ].filter(Boolean).join('\n')

    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id: project_id || 'project-profile-internal',
        title: taskTitle,
        description: `Finance Bot processed ${mode === 'categorise' ? `${transactions?.length} transactions` : `BAS for ${period}`}. ${flagCount} flags, ${lowConfidenceCount} low-confidence items.`,
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
      event_type: 'finance_processed',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Finance Bot ran ${mode}: ${flagCount} flags, ${lowConfidenceCount} low-confidence`,
      metadata: { mode, period, transaction_count: transactions?.length, flag_count: flagCount },
      severity: flagCount > 0 ? 'warning' : 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, task_id: task?.id, flags: flagCount, low_confidence: lowConfidenceCount }),
      { status: 200 }
    )

  } catch (error) {
    console.error('finance-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
