import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async () => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: eric } = await supabase
      .from('bots')
      .select('id')
      .eq('name', 'Eric')
      .single()

    // Find all overdue tasks (due_date in the past, not done or action_required)
    const today = new Date().toISOString().split('T')[0]
    const { data: overdueTasks, error } = await supabase
      .from('tasks')
      .select('*')
      .lt('due_date', today)
      .not('status', 'in', '("done","action_required")')
      .not('due_date', 'is', null)

    if (error) throw error

    if (!overdueTasks || overdueTasks.length === 0) {
      await supabase.from('audit_log').insert({
        event_type: 'overdue_check',
        bot_id: eric?.id,
        description: 'Eric ran overdue check — no overdue tasks found',
        severity: 'info'
      })
      return new Response(JSON.stringify({ checked: true, overdue_count: 0 }), { status: 200 })
    }

    // Create one escalation task for Mark listing all overdue items
    const overdueList = overdueTasks
      .map(t => `- [${t.priority.toUpperCase()}] "${t.title}" — due ${t.due_date} — assigned to ${t.assignee || 'unassigned'} — status: ${t.status}`)
      .join('\n')

    const { data: escalationTask } = await supabase
      .from('tasks')
      .insert({
        project_id: 'project-profile-internal',
        title: `⚠ ${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''} require attention`,
        description: `Eric detected the following overdue tasks:\n\n${overdueList}`,
        assignee: 'mark',
        priority: 'high',
        status: 'action_required',
        source: 'agent'
      })
      .select()
      .single()

    await supabase.from('audit_log').insert({
      event_type: 'overdue_escalation',
      bot_id: eric?.id,
      task_id: escalationTask?.id,
      description: `Eric escalated ${overdueTasks.length} overdue tasks to Mark`,
      metadata: {
        overdue_count: overdueTasks.length,
        overdue_task_ids: overdueTasks.map(t => t.id)
      },
      severity: 'warning'
    })

    return new Response(
      JSON.stringify({ checked: true, overdue_count: overdueTasks.length, escalation_task_id: escalationTask?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('overdue-checker error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
