/**
 * Low-level unix-socket HTTP transport for mohdel client.
 *
 * Stateless — each request opens and closes its own socket. Pooling/
 * keep-alive can be added later if measurement shows a bottleneck;
 * unix-socket overhead is typically negligible.
 *
 * @module client/transport
 */

import http from 'node:http'

/**
 * @typedef {object} RequestOptions
 * @property {string} socketPath
 * @property {string} path
 * @property {string} method
 * @property {object} [body]
 * @property {AbortSignal} [signal]
 * @property {Record<string,string>} [headers]
 */

/**
 * @param {RequestOptions} options
 * @returns {Promise<http.IncomingMessage>}
 */
export function requestUnix ({ socketPath, path, method, body, signal, headers }) {
  return new Promise((resolve, reject) => {
    /** @type {Record<string,string>} */
    const h = { ...(headers || {}) }
    if (body !== undefined) h['content-type'] = 'application/json'

    const req = http.request({ socketPath, path, method, headers: h }, resolve)
    req.on('error', reject)

    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('aborted'))
        reject(new Error('aborted'))
        return
      }
      const onAbort = () => req.destroy(new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      // Released on `close` rather than on resolve: the promise
      // resolves at response headers, and cancellation has to stay
      // live for the streaming body that follows.
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }

    if (body !== undefined) req.end(JSON.stringify(body))
    else req.end()
  })
}
