import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Dispatches an approved campaign brief to all 4 production bots in parallel
serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const baseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const {
      project_id,
      client_name,
      brief_content,
      brief_task_id,
      // optional overrides
      platform = 'instagram',
      post_type = 'feed',
      ppc_platform = 'meta',
      monthly_budget,
      campaign_objective = 'leads',
      campaign_name,
      copy_type = 'ad_copy',
      audience,
      formats
    } = await req.json()

    if (!project_id || !client_name || !brief_content) {
      throw new Error('project_id, client_name, and brief_content are required')
    }

    // Record the dispatch in brief_queue
    const { data: queueEntry } = await supabase
      .from('brief_queue')
      .insert({
        project_id,
        client_name,
        brief_task_id: brief_task_id || null,
        brief_content,
        dispatched_to: ['Content', 'PPC', 'Art Director', 'Copywriting'],
        status: 'dispatched'
      })
      .select()
      .single()

    const authHeader = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${serviceKey}` }

    const processors = [
      {
        name: 'content-processor',
        body: { project_id, client_name, platform, post_type, brief: brief_content, brief_task_id }
      },
      {
        name: 'ppc-processor',
        body: { project_id, client_name, platform: ppc_platform, monthly_budget, objective: campaign_objective, brief: brief_content, brief_task_id }
      },
      {
        name: 'art-director-processor',
        body: { project_id, client_name, campaign_name: campaign_name || client_name, formats, brief: brief_content, brief_task_id }
      },
      {
        name: 'copywriting-processor',
        body: { project_id, client_name, copy_type, audience, brief: brief_content, brief_task_id }
      }
    ]

    const results = await Promise.allSettled(
      processors.map(p =>
        fetch(`${baseUrl}/functions/v1/${p.name}`, {
          method: 'POST',
          headers: authHeader,
          body: JSON.stringify(p.body)
        }).then(async r => {
          const json = await r.json()
          if (!r.ok) throw new Error(json.error || `${p.name} returned ${r.status}`)
          return { processor: p.name, task_id: json.task_id }
        })
      )
    )

    const childTaskIds: string[] = []
    const errors: string[] = []

    results.forEach(r => {
      if (r.status === 'fulfilled') {
        if (r.value.task_id) childTaskIds.push(r.value.task_id)
      } else {
        errors.push(r.reason?.message || 'unknown error')
      }
    })

    // Update brief_queue with child task IDs
    await supabase
      .from('brief_queue')
      .update({
        child_task_ids: childTaskIds,
        status: errors.length === processors.length ? 'dispatched' : 'in_progress'
      })
      .eq('id', queueEntry?.id)

    await supabase.from('audit_log').insert({
      event_type: 'brief_dispatched',
      description: `Brief dispatched for ${client_name} — ${childTaskIds.length}/${processors.length} tasks created`,
      metadata: {
        project_id,
        queue_id: queueEntry?.id,
        child_task_ids: childTaskIds,
        errors: errors.length ? errors : undefined
      },
      severity: errors.length ? 'warn' : 'info'
    })

    return new Response(
      JSON.stringify({
        dispatched: true,
        queue_id: queueEntry?.id,
        child_task_ids: childTaskIds,
        errors: errors.length ? errors : undefined
      }),
      { status: 200 }
    )

  } catch (error) {
    console.error('brief-dispatcher error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
