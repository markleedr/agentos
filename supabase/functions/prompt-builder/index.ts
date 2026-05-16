import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { task } = await req.json()

    let systemPrompt = 'You are an AgentOS assistant for Project Profile, a digital marketing agency.'
    let contextDoc = ''
    let botId = null

    if (task.bot_instance_id) {
      const { data: instance } = await supabase
        .from('bot_instances')
        .select('*, bots(name, system_prompt, id)')
        .eq('id', task.bot_instance_id)
        .single()

      if (instance) {
        systemPrompt = instance.bots.system_prompt || systemPrompt
        contextDoc = instance.context_doc || ''
        botId = instance.bots.id

        const { data: knowledge } = await supabase
          .from('bot_knowledge')
          .select('content, category')
          .eq('bot_type', instance.bots.name)
          .order('version', { ascending: false })
          .limit(10)

        if (knowledge && knowledge.length > 0) {
          const knowledgeText = knowledge
            .map(k => `[${k.category}]: ${k.content}`)
            .join('\n')
          systemPrompt += `\n\n## Universal Learnings\n${knowledgeText}`
        }
      }
    }

    const userMessage = [
      contextDoc ? `## Project Context\n${contextDoc}` : '',
      `## Task\nTitle: ${task.title}`,
      task.description ? `Description: ${task.description}` : '',
      `Priority: ${task.priority}`,
      task.due_date ? `Due: ${task.due_date}` : '',
    ].filter(Boolean).join('\n\n')

    const prompt = {
      task_id: task.id,
      bot_id: botId,
      system_prompt: systemPrompt,
      user_message: userMessage
    }

    const claudeRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/claude-caller`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
      },
      body: JSON.stringify(prompt)
    })

    if (!claudeRes.ok) {
      throw new Error(`claude-caller failed: ${await claudeRes.text()}`)
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 })

  } catch (error) {
    console.error('prompt-builder error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
