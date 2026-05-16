import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const APPROVAL_REQUIRED_KEYWORDS = [
  'email', 'send', 'reply', 'publish', 'post', 'schedule', 'invoice',
  'payment', 'budget', 'scope', 'client'
]

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { task_id, bot_id, prompt_sent, response } = await req.json()

    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', task_id)
      .single()

    if (!task) throw new Error(`Task ${task_id} not found`)

    const { data: output } = await supabase
      .from('task_outputs')
      .insert({
        task_id,
        bot_instance_id: task.bot_instance_id,
        prompt_sent,
        response,
        parsed_output: { text: response },
        approval_status: 'pending'
      })
      .select()
      .single()

    await supabase.from('audit_log').insert({
      event_type: 'output_written',
      bot_id,
      task_id,
      description: `Output written for task "${task.title}"`,
      metadata: { output_id: output?.id },
      severity: 'info'
    })

    const taskText = `${task.title} ${task.description || ''}`.toLowerCase()
    const requiresApproval = APPROVAL_REQUIRED_KEYWORDS.some(kw => taskText.includes(kw))

    if (requiresApproval) {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/approval-router`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({ task_id, reason: 'Output requires human review', severity: 'info' })
      })
    } else {
      await supabase.from('tasks').update({ status: 'done' }).eq('id', task_id)
      await supabase.from('task_outputs').update({ approval_status: 'approved' }).eq('id', output?.id)
    }

    return new Response(JSON.stringify({ success: true, requires_approval: requiresApproval }), { status: 200 })

  } catch (error) {
    console.error('output-writer error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
