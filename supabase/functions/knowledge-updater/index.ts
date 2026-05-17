import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Adds a new versioned learning to bot_knowledge
serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const {
      bot_type,
      category,
      content,
      project_id,
      client_name,
      source_task_id,
      source_report_id,
      added_by = 'agent'
    } = await req.json()

    if (!bot_type || !category || !content) {
      throw new Error('bot_type, category, and content are required')
    }

    // Get next version number via the SQL function
    const { data: versionRow } = await supabase
      .rpc('next_knowledge_version', { p_bot_type: bot_type })

    const version = versionRow || 1

    const { data: knowledge, error } = await supabase
      .from('bot_knowledge')
      .insert({
        bot_type,
        version,
        category,
        content,
        added_by
      })
      .select()
      .single()

    if (error) throw error

    // If sourced from a performance_feedback record, mark it as applied
    if (source_task_id || source_report_id) {
      await supabase
        .from('performance_feedback')
        .update({ applied_to_knowledge: true, knowledge_id: knowledge.id })
        .match({
          ...(source_task_id ? { task_id: source_task_id } : {}),
          ...(source_report_id ? { report_id: source_report_id } : {}),
          applied_to_knowledge: false
        })
    }

    await supabase.from('audit_log').insert({
      event_type: 'knowledge_updated',
      description: `${bot_type} bot knowledge updated — v${version} | ${category}`,
      metadata: {
        bot_type,
        version,
        category,
        knowledge_id: knowledge.id,
        project_id,
        client_name
      },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ created: true, knowledge_id: knowledge.id, version }),
      { status: 200 }
    )

  } catch (error) {
    console.error('knowledge-updater error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
