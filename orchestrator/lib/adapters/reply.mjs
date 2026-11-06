/**
 * 从各 CLI 已经返回的 stdout 里取出模型回复和实际模型身份。
 *
 * 身份只来自这次调用写进 stdout 的结构化字段。函数不接收请求的模型名，
 * 因此不能把 `-m` / `--model` 的入参回显成已验证身份。
 * 字段缺失，或同一次调用出现多个不同的模型，都返回 null。
 */
import { lastJson, parseEventLines } from './shared.mjs'

function sole(ids) {
  const uniq = []
  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || uniq.includes(id)) continue
    uniq.push(id)
  }
  return uniq.length === 1 ? uniq[0] : null
}

function assistantText(events) {
  const chunks = []
  for (const event of events) {
    const content = event && event.type === 'assistant' && event.message && event.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text) chunks.push(block.text)
    }
  }
  return chunks.join('')
}

/** Claude stream-json：正文在最终 result.result，身份只取唯一的 modelUsage 键。 */
export function claudeReply(stdout) {
  const events = parseEventLines(stdout)
  const results = events.filter((event) => event && event.type === 'result')
  const final = results.length ? results[results.length - 1] : null
  const text = final && typeof final.result === 'string' ? final.result : assistantText(events)
  const models = final && final.modelUsage && typeof final.modelUsage === 'object'
    ? Object.keys(final.modelUsage)
    : []
  return { text, modelResolved: sole(models) }
}

/** CodeBuddy 与 Claude 同为 stream-json；身份只取结果事件上的 model。 */
export function codebuddyReply(stdout) {
  const events = parseEventLines(stdout)
  const results = events.filter((event) => event && event.type === 'result')
  const final = results.length ? results[results.length - 1] : null
  const text = final && typeof final.result === 'string' ? final.result : ''
  const model = final && typeof final.model === 'string' ? final.model : null
  return { text, modelResolved: sole(model ? [model] : []) }
}

/**
 * Codex `--json`：正文是 agent_message。
 * 公开事件通常没有模型字段，此时身份为 null。
 * 只有 thread.started / turn.started / turn.completed 自己带了 model 才采纳。
 */
export function codexReply(stdout) {
  const events = parseEventLines(stdout)
  const texts = []
  const models = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'thread.started' || event.type === 'turn.started' || event.type === 'turn.completed') {
      if (typeof event.model === 'string') models.push(event.model)
    }
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message' && typeof event.item.text === 'string') {
      texts.push(event.item.text)
    }
  }
  return { text: texts.join('\n'), modelResolved: sole(models) }
}

/** Gemini `-o json`：正文是 response。身份只取 stats.models 里唯一的键，不看请求参数。 */
export function geminiReply(stdout) {
  const parsed = lastJson(stdout)
  const text = parsed && typeof parsed.response === 'string' ? parsed.response : ''
  const table = parsed && parsed.stats && parsed.stats.models
  const models = table && typeof table === 'object' && !Array.isArray(table) ? Object.keys(table) : []
  return { text, modelResolved: sole(models) }
}

/** Cursor / Cursor WSL stream-json：正文优先用 result.result，身份只取事件里唯一的 model。 */
export function cursorReply(stdout) {
  const events = parseEventLines(stdout)
  const models = []
  let resultText = ''
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (typeof event.model === 'string') models.push(event.model)
    if (event.message && typeof event.message.model === 'string') models.push(event.message.model)
    if (event.type === 'result' && typeof event.result === 'string') resultText = event.result
  }
  return { text: resultText || assistantText(events), modelResolved: sole(models) }
}

export function replyFromAdapter(adapterId, stdout) {
  switch (adapterId) {
    case 'claude-cli': return claudeReply(stdout)
    case 'codebuddy-cli': return codebuddyReply(stdout)
    case 'codex-cli': return codexReply(stdout)
    case 'gemini-cli': return geminiReply(stdout)
    case 'cursor-agent':
    case 'cursor-wsl': return cursorReply(stdout)
    default: return { text: '', modelResolved: null }
  }
}

/**
 * 测试夹具用的 stdout。model 为空时不写入任何模型字段，用来证明解析器不会自己补上请求名。
 * 生产 adapter 不调用这里。
 */
export function fixtureStdout(adapterId, model, text) {
  const body = String(text ?? '')
  const id = typeof model === 'string' && model.trim() ? model.trim() : ''
  if (adapterId === 'claude-cli') {
    const event = { type: 'result', subtype: 'success', is_error: false, result: body }
    if (id) event.modelUsage = { [id]: { inputTokens: 1, outputTokens: 1 } }
    return JSON.stringify(event)
  }
  if (adapterId === 'codebuddy-cli') {
    const event = { type: 'result', is_error: false, result: body }
    if (id) event.model = id
    return JSON.stringify(event)
  }
  if (adapterId === 'codex-cli') {
    const started = { type: 'thread.started', thread_id: 'thread-1' }
    if (id) started.model = id
    return [
      JSON.stringify(started),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: body } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n')
  }
  if (adapterId === 'gemini-cli') {
    const event = { response: body }
    if (id) event.stats = { models: { [id]: { tokens: { total: 1 } } } }
    return JSON.stringify(event)
  }
  if (adapterId === 'cursor-agent' || adapterId === 'cursor-wsl') {
    const lines = []
    if (id) lines.push(JSON.stringify({ type: 'system', subtype: 'init', model: id }))
    lines.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: body }))
    return lines.join('\n')
  }
  return ''
}
