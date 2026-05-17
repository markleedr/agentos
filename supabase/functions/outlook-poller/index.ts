import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const ERIC_EMAIL = 'eric@projectprofile.agency'

async function getMicrosoftToken(): Promise<string> {
  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID')!
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID')!
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET')!

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Microsoft token fetch failed: ${err}`)
  }

  const data = await res.json()
  return data.access_token
}

serve(async () => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const token = await getMicrosoftToken()

    // Fetch unread emails from Eric's inbox
    const mailRes = await fetch(
      `${GRAPH_BASE}/users/${ERIC_EMAIL}/mailFolders/inbox/messages` +
      `?$filter=isRead eq false&$orderby=receivedDateTime asc&$top=20` +
      `&$select=id,subject,from,bodyPreview,body,receivedDateTime`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    )

    if (!mailRes.ok) {
      throw new Error(`Graph API mail fetch failed: ${await mailRes.text()}`)
    }

    const mailData = await mailRes.json()
    const messages = mailData.value || []

    if (messages.length === 0) {
      return new Response(JSON.stringify({ polled: true, new_emails: 0 }), { status: 200 })
    }

    let queued = 0
    for (const msg of messages) {
      // Skip if already in queue
      const { data: existing } = await supabase
        .from('email_queue')
        .select('id')
        .eq('message_id', msg.id)
        .single()

      if (existing) continue

      // Insert into queue
      const { data: queued_email } = await supabase
        .from('email_queue')
        .insert({
          message_id: msg.id,
          from_email: msg.from?.emailAddress?.address || '',
          from_name: msg.from?.emailAddress?.name || '',
          subject: msg.subject || '(no subject)',
          body_preview: msg.bodyPreview || '',
          body_full: msg.body?.content || '',
          received_at: msg.receivedDateTime
        })
        .select()
        .single()

      // Mark as read in Outlook so we don't re-process
      await fetch(`${GRAPH_BASE}/users/${ERIC_EMAIL}/messages/${msg.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isRead: true })
      })

      // Trigger email-processor for this email
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/email-processor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({ email_queue_id: queued_email?.id })
      })

      queued++
    }

    await supabase.from('audit_log').insert({
      event_type: 'outlook_polled',
      description: `Eric polled Outlook inbox — ${queued} new emails queued`,
      metadata: { new_emails: queued, total_unread: messages.length },
      severity: 'info'
    })

    return new Response(JSON.stringify({ polled: true, new_emails: queued }), { status: 200 })

  } catch (error) {
    console.error('outlook-poller error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
