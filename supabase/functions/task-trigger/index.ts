import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const payload = await req.json()
    const { record, type } = payload

    if (type !== 'INSERT' && type !== 'UPDATE') {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 })
    }

    if (type === 'UPDATE' && payload.old_record?.status === record.status) {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 })
    }

    if (['done', 'action_required'].includes(record.status)) {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 })
    }

    await supabase.from('audit_log').insert({
      event_type: 'task_triggered',
      task_id: record.id,
      description: `Task "${record.title}" triggered agent pipeline`,
      metadata: { task_status: record.status, source: record.source },
      severity: 'info'
    })

    const promptRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/prompt-builder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
      },
      body: JSON.stringify({ task: record })
    })

    if (!promptRes.ok) {
      throw new Error(`prompt-builder failed: ${await promptRes.text()}`)
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 })

  } catch (error) {
    console.error('task-trigger error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
