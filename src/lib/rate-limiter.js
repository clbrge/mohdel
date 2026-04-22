// Lightweight per-minute rate limiter.
// Tracks RPM and TPM with minute-bucket granularity.
// Throttles (delays) rather than rejects — returns ms to wait.

const createRateLimiter = () => {
  // key → { count, tokens, minute }
  const buckets = new Map()

  const currentMinute = () => Math.floor(Date.now() / 60000)

  const getBucket = (key) => {
    const minute = currentMinute()
    const bucket = buckets.get(key)
    if (bucket && bucket.minute === minute) return bucket
    const fresh = { count: 0, tokens: 0, minute }
    buckets.set(key, fresh)
    return fresh
  }

  const msUntilNextMinute = (minute) => Math.max(0, (minute + 1) * 60000 - Date.now())

  // Returns ms to wait before sending (0 = go ahead)
  const check = (key, { rpmLimit, tpmLimit } = {}) => {
    if (!rpmLimit && !tpmLimit) return 0
    const bucket = getBucket(key)
    if (rpmLimit && bucket.count >= rpmLimit) {
      return msUntilNextMinute(bucket.minute)
    }
    if (tpmLimit && bucket.tokens >= tpmLimit) {
      return msUntilNextMinute(bucket.minute)
    }
    return 0
  }

  // Record a request count (call before sending — RPM tracking)
  const recordRequest = (key) => {
    const bucket = getBucket(key)
    bucket.count++
  }

  // Record token usage (call after response — TPM tracking)
  const recordTokens = (key, tokens) => {
    const bucket = getBucket(key)
    bucket.tokens += tokens
  }

  return { check, recordRequest, recordTokens }
}

export default createRateLimiter
