import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function smokeTest() {
  console.log('AgentOS Phase 1 — Smoke Test\n')

  // 1. Insert a dummy task
  console.log('1. Creating dummy task...')
  const { data: task, error: taskError } = await supabase
    .from('tasks')
    .insert({
      project_id: 'smoke-test',
      title: 'Smoke test task',
      description: 'This is a smoke test. Respond with a short confirmation that AgentOS Phase 1 is operational.',
      priority: 'high',
      source: 'manual',
      status: 'to_do'
    })
    .select()
    .single()

  if (taskError) throw new Error(`Task creation failed: ${taskError.message}`)
  console.log(`   Task created: ${task.id}`)

  // 2. Manually trigger the pipeline
  console.log('2. Triggering agent pipeline...')
  const triggerRes = await supabase.functions.invoke('task-trigger', {
    body: { record: task, type: 'INSERT' }
  })
  if (triggerRes.error) throw new Error(`Pipeline trigger failed: ${triggerRes.error.message}`)
  console.log('   Pipeline triggered')

  // 3. Wait for processing
  console.log('3. Waiting for Claude to process...')
  await new Promise(resolve => setTimeout(resolve, 5000))

  // 4. Check task_outputs
  console.log('4. Checking output...')
  const { data: outputs } = await supabase
    .from('task_outputs')
    .select('*')
    .eq('task_id', task.id)

  if (!outputs || outputs.length === 0) throw new Error('No output written to task_outputs')
  console.log(`   Output written: "${outputs[0].response?.substring(0, 80)}..."`)

  // 5. Check task status updated
  console.log('5. Checking task status...')
  const { data: updatedTask } = await supabase
    .from('tasks')
    .select('status')
    .eq('id', task.id)
    .single()

  console.log(`   Task status: ${updatedTask?.status}`)

  // 6. Check audit log
  console.log('6. Checking audit log...')
  const { data: logs } = await supabase
    .from('audit_log')
    .select('event_type, description')
    .eq('task_id', task.id)
    .order('created_at', { ascending: true })

  console.log(`   Audit entries: ${logs?.length}`)
  logs?.forEach(l => console.log(`      — [${l.event_type}] ${l.description}`))

  // 7. Clean up
  await supabase.from('tasks').delete().eq('id', task.id)
  console.log('\nSmoke test passed. Phase 1 is operational. Phase 2 (Eric) can begin.')
}

smokeTest().catch(err => {
  console.error('\nSmoke test failed:', err.message)
  process.exit(1)
})
