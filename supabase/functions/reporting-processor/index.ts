import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  })
  if (!res.ok) throw new Error(`Claude API error: ${await res.text()}`)
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

// ─── META ADS ─────────────────────────────────────────────────────────────────
async function fetchMetaData(adAccountId: string, accessToken: string, datePreset: string) {
  const fields = 'campaign_name,impressions,clicks,spend,ctr,cpm,cpp,reach,frequency,actions'
  const url = `https://graph.facebook.com/v19.0/act_${adAccountId}/insights` +
    `?fields=${fields}&date_preset=${datePreset}&level=campaign&access_token=${accessToken}`

  const res = await fetch(url)
  if (!res.ok) return { error: await res.text(), data: [] }
  const json = await res.json()
  return { data: json.data || [], error: null }
}

// ─── GA4 ──────────────────────────────────────────────────────────────────────
async function getGoogleToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson)
  const now = Math.floor(Date.now() / 1000)

  // Build JWT header + payload
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const payload = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  // Sign with RS256 using private key
  const pemContents = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '')
  const keyData = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0))
  const privateKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  )

  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', privateKey,
    new TextEncoder().encode(signingInput)
  )

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const jwt = `${signingInput}.${sig}`

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  })

  if (!tokenRes.ok) throw new Error(`Google token error: ${await tokenRes.text()}`)
  const tokenData = await tokenRes.json()
  return tokenData.access_token
}

async function fetchGA4Data(propertyId: string, serviceAccountJson: string, startDate: string, endDate: string) {
  try {
    const token = await getGoogleToken(serviceAccountJson)
    const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
        metrics: [
          { name: 'sessions' }, { name: 'activeUsers' }, { name: 'newUsers' },
          { name: 'bounceRate' }, { name: 'averageSessionDuration' },
          { name: 'screenPageViews' }, { name: 'conversions' }
        ],
        limit: 20
      })
    })
    if (!res.ok) return { error: await res.text(), rows: [] }
    const json = await res.json()
    return { rows: json.rows || [], error: null }
  } catch (e) {
    return { error: (e as Error).message, rows: [] }
  }
}

// ─── MAILCHIMP ────────────────────────────────────────────────────────────────
async function fetchMailchimpData(listId: string, sinceDate: string) {
  const apiKey = Deno.env.get('MAILCHIMP_API_KEY')
  if (!apiKey) return { error: 'MAILCHIMP_API_KEY not configured', campaigns: [] }

  const dc = apiKey.split('-').pop()
  const res = await fetch(
    `https://${dc}.api.mailchimp.com/3.0/campaigns?list_id=${listId}&since_send_time=${sinceDate}&status=sent&count=10`,
    { headers: { Authorization: `Basic ${btoa(`anystring:${apiKey}`)}` } }
  )
  if (!res.ok) return { error: await res.text(), campaigns: [] }
  const data = await res.json()

  const campaigns = await Promise.all((data.campaigns || []).slice(0, 5).map(async (c: { id: string; settings: { subject_line: string }; send_time: string }) => {
    const statsRes = await fetch(
      `https://${dc}.api.mailchimp.com/3.0/reports/${c.id}`,
      { headers: { Authorization: `Basic ${btoa(`anystring:${apiKey}`)}` } }
    )
    const stats = statsRes.ok ? await statsRes.json() : {}
    return {
      subject: c.settings?.subject_line,
      send_time: c.send_time,
      emails_sent: stats.emails_sent,
      open_rate: stats.opens?.open_rate,
      click_rate: stats.clicks?.click_rate,
      unsubscribed: stats.unsubscribes?.unsubscribe_count
    }
  }))

  return { campaigns, error: null }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function parseClaudeJSON(text: string): unknown {
  let json = text.trim()
  if (json.startsWith('```')) {
    const nl = String.fromCharCode(10)
    const firstNewline = json.indexOf(nl)
    json = firstNewline !== -1 ? json.slice(firstNewline + 1) : json.slice(3)
    const end = json.lastIndexOf('```')
    if (end !== -1) json = json.slice(0, end)
    json = json.trim()
  }
  return JSON.parse(json)
}

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { project_id, report_type, period_start, period_end } = await req.json()

    if (!project_id || !report_type) throw new Error('project_id and report_type are required')

    const start = period_start || new Date(Date.now() - (report_type === '7_day_snapshot' ? 7 : 30) * 86400000).toISOString().split('T')[0]
    const end = period_end || new Date().toISOString().split('T')[0]

    // Load client config
    const { data: config } = await supabase
      .from('client_configs')
      .select('*')
      .eq('project_id', project_id)
      .single()

    if (!config) throw new Error(`No client config found for ${project_id}`)

    const { data: bot } = await supabase
      .from('bots')
      .select('system_prompt, id')
      .eq('name', 'Reporting')
      .single()

    const { data: instance } = await supabase
      .from('bot_instances')
      .select('id')
      .eq('project_id', project_id)
      .eq('bot_id', bot?.id)
      .single()

    // Fetch all data sources in parallel
    const datePreset = report_type === '7_day_snapshot' ? 'last_7d' : 'last_30d'

    const [metaResult, ga4Result, mailchimpResult] = await Promise.all([
      config.meta_ad_account_id && config.meta_access_token
        ? fetchMetaData(config.meta_ad_account_id, config.meta_access_token, datePreset)
        : Promise.resolve({ data: [], error: 'Meta not configured' }),
      config.ga4_property_id && config.ga4_service_account_json
        ? fetchGA4Data(config.ga4_property_id, config.ga4_service_account_json, start, end)
        : Promise.resolve({ rows: [], error: 'GA4 not configured' }),
      config.mailchimp_list_id
        ? fetchMailchimpData(config.mailchimp_list_id, start)
        : Promise.resolve({ campaigns: [], error: 'Mailchimp not configured' })
    ])

    // Build data summary for Claude
    const dataSummary = [
      `## Client: ${config.client_name}`,
      `## Report Type: ${report_type}`,
      `## Period: ${start} to ${end}`,
      '',
      '## Meta Ads Data',
      metaResult.error ? `Not available: ${metaResult.error}` : JSON.stringify(metaResult.data, null, 2),
      '',
      '## GA4 Website Data',
      ga4Result.error ? `Not available: ${ga4Result.error}` : JSON.stringify(ga4Result.rows, null, 2),
      '',
      '## Mailchimp Email Data',
      mailchimpResult.error ? `Not available: ${mailchimpResult.error}` : JSON.stringify(mailchimpResult.campaigns, null, 2)
    ].join('\n')

    const userMessage = `${dataSummary}\n\nGenerate the ${report_type.replace(/_/g, ' ')} for ${config.client_name}.`

    const claudeResponse = await callClaude(bot?.system_prompt || '', userMessage)

    let parsed: {
      report_title: string
      period: string
      headline_metric: string
      report_content: string
      key_insights: string[]
      recommendations: string[]
      task_title: string
    }

    try {
      parsed = parseClaudeJSON(claudeResponse) as typeof parsed
    } catch {
      throw new Error(`Claude returned invalid JSON: ${claudeResponse.substring(0, 200)}`)
    }

    // Store report
    const { data: report } = await supabase
      .from('reports')
      .insert({
        project_id,
        client_name: config.client_name,
        report_type,
        period_start: start,
        period_end: end,
        meta_data: metaResult.data || null,
        ga4_data: ga4Result.rows || null,
        mailchimp_data: mailchimpResult.campaigns || null,
        report_content: parsed.report_content,
        status: 'draft'
      })
      .select()
      .single()

    // Create approval task
    const { data: task } = await supabase
      .from('tasks')
      .insert({
        project_id,
        title: parsed.task_title,
        description: `${config.client_name} | ${report_type.replace(/_/g, ' ')} | ${start} – ${end}\n\nHeadline: ${parsed.headline_metric}`,
        assignee: 'mark',
        priority: 'medium',
        status: 'action_required',
        source: 'agent'
      })
      .select()
      .single()

    await supabase.from('task_outputs').insert({
      task_id: task?.id,
      bot_instance_id: instance?.id,
      prompt_sent: `Report request: ${report_type} for ${config.client_name} (${start}–${end})`,
      response: parsed.report_content,
      parsed_output: { ...parsed, report_id: report?.id },
      approval_status: 'pending'
    })

    // Update report with task reference
    await supabase.from('reports').update({ task_id: task?.id }).eq('id', report?.id)

    await supabase.from('audit_log').insert({
      event_type: 'report_generated',
      bot_id: bot?.id,
      task_id: task?.id,
      description: `Reporting Bot generated ${report_type} for ${config.client_name}`,
      metadata: {
        project_id, report_type, period: `${start}–${end}`,
        meta_configured: !metaResult.error,
        ga4_configured: !ga4Result.error,
        mailchimp_configured: !mailchimpResult.error
      },
      severity: 'info'
    })

    return new Response(
      JSON.stringify({ processed: true, report_id: report?.id, task_id: task?.id }),
      { status: 200 }
    )

  } catch (error) {
    console.error('reporting-processor error:', error)
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }
})
