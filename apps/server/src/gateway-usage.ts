import { Logger } from '@nestjs/common'
import type { ServerResponse } from 'node:http'
import { pool } from './database.js'

type Attribution = { workspace_id:string; alias:string; user_id:string|null; use_case:string }
type Tokens = { input:number; output:number; total:number }
const logger = new Logger('GatewayUsage')
const sampleLimit = 2 * 1024 * 1024

function tokenCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : undefined
}

export function trackGatewayUsage(response: ServerResponse, route: Attribution, abort: AbortController) {
  const started = new Date()
  let usage: Tokens | undefined
  let failed = false
  let settled = false

  function inspect(json: string) {
    try {
      const parsed = JSON.parse(json)
      if (parsed?.error) failed = true
      const report = parsed?.usage
      if (!report) return
      const input = tokenCount(report.prompt_tokens) ?? tokenCount(report.input_tokens)
      const output = tokenCount(report.completion_tokens) ?? tokenCount(report.output_tokens)
      const total = tokenCount(report.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined)
      if (total !== undefined) usage = { input: input ?? 0, output: output ?? 0, total }
    } catch {
      // Ignore unknown envelopes and SSE markers such as [DONE].
    }
  }

  function record(cancelled: boolean) {
    if (settled) return
    settled = true
    void pool.query(`
      INSERT INTO vacp_gateway_usage_hourly AS usage
        (workspace_id,bucket,model,user_id,use_case,requests,failed,cancelled,reported,input_tokens,output_tokens,total_tokens)
      VALUES($1,date_trunc('hour',$2::timestamptz,'UTC'),$3,$4,$5,1,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(workspace_id,bucket,model,user_id,use_case) DO UPDATE SET
        requests=usage.requests+1, failed=usage.failed+EXCLUDED.failed, cancelled=usage.cancelled+EXCLUDED.cancelled,
        reported=usage.reported+EXCLUDED.reported,input_tokens=usage.input_tokens+EXCLUDED.input_tokens,
        output_tokens=usage.output_tokens+EXCLUDED.output_tokens,total_tokens=usage.total_tokens+EXCLUDED.total_tokens
    `, [route.workspace_id,started,route.alias,route.user_id,route.use_case,
      Number(failed || (!cancelled && response.statusCode >= 400)),Number(cancelled && !failed),
      Number(Boolean(usage)),usage?.input ?? 0,usage?.output ?? 0,usage?.total ?? 0])
      .catch(error => logger.warn('Could not record model gateway usage (' + (error?.code ?? 'unknown') + ')'))
  }

  function close() {
    record(!response.writableFinished)
    abort.abort()
  }
  response.once('finish', () => record(false))
  response.once('close', close)
  if (response.destroyed) close()

  return async function* relay(body: ReadableStream<Uint8Array>, streaming: boolean) {
    const decoder = new TextDecoder()
    let text = ''
    let event = ''
    let tooLarge = false
    let longLine = false

    function line(value: string, truncated: boolean) {
      if (truncated) { tooLarge = true; event = ''; return }
      const raw = value.endsWith('\r') ? value.slice(0,-1) : value
      if (!raw) {
        if (event && !tooLarge) inspect(event)
        event = ''
        tooLarge = false
      } else if (!tooLarge && raw.startsWith('data:')) {
        const data = raw.slice(raw[5] === ' ' ? 6 : 5)
        if (event.length + data.length + 1 > sampleLimit) { event = ''; tooLarge = true }
        else event += (event ? '\n' : '') + data
      }
    }

    function sample(chunk: string) {
      if (!streaming) {
        if (tooLarge) return
        if (text.length + chunk.length > sampleLimit) { text = ''; tooLarge = true }
        else text += chunk
        return
      }
      const lines = chunk.split('\n')
      for (const value of lines.slice(0,-1)) {
        line(!longLine && text.length + value.length <= sampleLimit ? text + value : '', longLine || text.length + value.length > sampleLimit)
        text = ''
        longLine = false
      }
      const rest = lines.at(-1)!
      if (!longLine && text.length + rest.length <= sampleLimit) text += rest
      else { text = ''; longLine = true }
    }

    try {
      for await (const chunk of body) {
        sample(decoder.decode(chunk,{stream:true}))
        yield chunk
      }
      sample(decoder.decode())
      if (streaming) {
        if (text || longLine) line(text,longLine)
        line('',false)
      } else if (!tooLarge) inspect(text)
    } catch (error) {
      if (!abort.signal.aborted) failed = true
      throw error
    }
  }
}

export async function gatewayUsage(workspace: string, hours: number, model: string | null) {
  const {rows} = await pool.query(`
    SELECT CASE WHEN GROUPING(s.user_id)=0 THEN 'user'
                WHEN GROUPING(s.use_case)=0 THEN 'useCase' ELSE 'total' END AS dimension,
      s.user_id AS "userId",u.email,s.use_case AS "useCase",
      COALESCE(sum(s.requests),0)::float8 AS requests,COALESCE(sum(s.failed),0)::float8 AS failed,
      COALESCE(sum(s.cancelled),0)::float8 AS cancelled,COALESCE(sum(s.reported),0)::float8 AS reported,
      COALESCE(sum(s.input_tokens),0)::float8 AS "inputTokens",COALESCE(sum(s.output_tokens),0)::float8 AS "outputTokens",
      COALESCE(sum(s.total_tokens),0)::float8 AS "totalTokens"
    FROM vacp_gateway_usage_hourly s LEFT JOIN vacp_users u ON u.id=s.user_id
    WHERE s.workspace_id=$1 AND s.bucket>=date_trunc('hour',statement_timestamp(),'UTC')
      - ($2::int-1)*interval '1 hour' AND ($3::text IS NULL OR s.model=$3)
    GROUP BY GROUPING SETS ((),(s.user_id,u.email),(s.use_case))
    ORDER BY requests DESC, s.user_id, s.use_case
  `, [workspace,hours,model])
  return {
    total: rows.find(row => row.dimension === 'total'),
    users: rows.filter(row => row.dimension === 'user'),
    useCases: rows.filter(row => row.dimension === 'useCase'),
  }
}
