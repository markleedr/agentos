import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { task_id, reason, severity = 'info' } = await req.json()

    const { error } = await supabase
      .from('tasks')
      .update({ status: 'action_required' })
      .eq('id', task_id)

    if (error) throw error

    await supabase.from('audit_log').insert({
      event_type: 'approval_required',
      task_id,
      description: reason,
      metadata: { routed_to: 'action_required' },
      severity
    })

    return new Response(JSON.stringify({ success: true, status: 'action_required' }), { status: 200 })

  } catch (error) {
    console.error('approval-router error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
