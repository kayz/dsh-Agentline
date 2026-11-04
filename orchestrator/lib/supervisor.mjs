/**
 * supervisor.mjs — 运行期看门狗（纯规则，不用模型）
 *
 * 为什么不请一个模型：这类失败是确定性字符串（"at capacity"、429、401…），
 * 正则比模型更快更准；模型监控要 token、有延迟，且二元决策会摇摆。
 *
 * 两次误判的教训（2026-10-28）：
 *   1) 第一版扫描全部 stdout —— agent 读文件时，**文件内容里出现 429/"rate limit"**
 *      就被判成限流，把正常任务杀了。
 *   2) 第二版要求"错误词 + 规则词"同一行 —— 仍然误伤：Rust 代码里满是
 *      `map_err(|error| ...)`，加上文件行号 429，就凑成一条"错误行"。
 *   3) 第三版（2026-11-02）：网络规则带 /i 的 `ENOTFOUND` 命中了 Python 的
 *      `FileNotFoundError`（"fil**eNotFound**error"），把普通脚本报错当成
 *      DNS 故障杀掉。系统错误码必须大小写敏感 + 词边界，短语才可忽略大小写。
 *
 * 现在的判据：
 *   - stderr：全量匹配（真正的错误几乎都在这里）；
 *   - stdout：只看「自己声明是错误」的行 —— JSON error 事件、
 *     is_error=true 的结果、或以 Error:/fatal:/panic: 开头的行；
 *   - 纯数字 429 不再单独作为证据。
 */

export const RULES = [
  { id: 'capacity', re: /at capacity|no available capacity|capacity is (full|exhausted)|overloaded|模型.{0,6}(繁忙|容量不足|过载)/i },
  { id: 'rate_limit', re: /rate.?limit(ed)?|too many requests|quota exceeded|请求过于频繁|频率限制|限流|使用量.{0,12}(?:频率|限制)|额度.{0,8}(?:用尽|超出)|(?:^|\n)\s*429\b|(?:status|http|错误)\s*[:=]?\s*429/i },
  { id: 'auth', re: /\b(401|403)\b|unauthorized|invalid api key|not logged in|please log ?in|authentication failed|未登录|认证失败/i },
  { id: 'context', re: /context (length|window) (exceeded|too long)|maximum context|too many tokens|上下文.{0,8}(超出|过长)/i },
  // 网络证据分两类，必须分开匹配（2026-11-02 第三次误判的教训）：
  //   1) 操作系统/Node 的错误码是大写 token，必须加词边界。
  //      此前用 /i 匹配 ENOTFOUND，会命中 Python 的 `FileNotFoundError`
  //      （"fil**eNotFound**error"），把普通脚本报错误判成网络中断并杀进程。
  //   2) 人类可读短语保持大小写不敏感（"Connection reset by peer" 等）。
  { id: 'network', re: /(?<![A-Za-z])(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)(?![A-Za-z])|socket hang up|connection reset|network (?:error|unreachable)|连接被重置/i },
]

/** 一条 stdout 行是否"自己声明是错误" */
function isErrorLine(line) {
  const s = line.trim()
  if (!s) return false
  if (/^\{"type"\s*:\s*"(error|turn\.failed|stream_error)"/.test(s)) return true
  if (/"is_error"\s*:\s*true/.test(s)) return true
  if (/^(error|fatal|panic|exception)\b\s*[:：]/i.test(s)) return true
  if (/^(Error|FATAL|PANIC):/.test(s)) return true
  return false
}

/** 命中第一条规则就返回 id；否则 null */
export function matchChunk(text) {
  if (!text) return null
  const t = String(text)
  for (const r of RULES) { if (r.re.test(t)) return r.id }
  return null
}

/** 只对"自声明错误"的 stdout 行做规则匹配 */
export function matchStdout(text) {
  if (!text) return null
  for (const line of String(text).split(/\r?\n/)) {
    if (!isErrorLine(line)) continue
    const hit = matchChunk(line)
    if (hit) return hit
  }
  return null
}

export function createWatchdog({ stallMs = 10 * 60_000, now = () => Date.now() } = {}) {
  let hit = null
  let lastAt = now()
  return {
    onData(chunk, { channel = 'stdout' } = {}) {
      lastAt = now()
      if (hit) return hit
      const m = channel === 'stderr' ? matchChunk(chunk) : matchStdout(chunk)
      if (m) hit = m
      return hit
    },
    checkStall() {
      if (hit) return hit
      if (now() - lastAt > stallMs) hit = 'stall'
      return hit
    },
    get reason() { return hit },
    get lastActivityAt() { return lastAt },
  }
}
