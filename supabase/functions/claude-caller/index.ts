import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const MAX_RETRIES = 3
const BACKOFF = [2000, 4000, 8000]

serve(async (req) => {
  const { task_id, bot_id, system_prompt, user_message } = await req.json()

  let lastError: Error | null = null

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, BACKOFF[attempt - 1]))
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: system_prompt,
          messages: [{ role: 'user', content: user_message }]
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Anthropic API error ${response.status}: ${errorText}`)
      }

      const data = await response.json()
      const responseText = data.content?.[0]?.text || ''

      const writerRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/output-writer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({
          task_id,
          bot_id,
          prompt_sent: user_message,
          response: responseText
        })
      })

      if (!writerRes.ok) {
        throw new Error(`output-writer failed: ${await writerRes.text()}`)
      }

      return new Response(JSON.stringify({ success: true, attempt: attempt + 1 }), { status: 200 })

    } catch (error) {
      lastError = error
      console.error(`claude-caller attempt ${attempt + 1} failed:`, error.message)
    }
  }

  // All retries exhausted — escalate
  await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/approval-router`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
    },
    body: JSON.stringify({
      task_id,
      reason: `Claude API failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
      severity: 'error'
    })
  })

  return new Response(JSON.stringify({ error: lastError?.message }), { status: 500 })
})
