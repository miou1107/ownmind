import http from 'node:http';
import { FETCH_BLOCKED_PORTS } from './app-server.js';

/**
 * A stand-in for the OpenAI-compatible endpoint `callLLMSwitch` posts to.
 *
 * It exists so that a test of anything built on that helper talks to the real helper rather
 * than to a fake of it. The compliance judge was first written against an assumption about
 * what `callLLMSwitch` returns — a string — and every test of the route injected a
 * string-returning stub, so the assumption was never touched. The real function ends in
 * `return parseLLMJson(content)`: it hands back the parsed object and throws on anything
 * that is not JSON. Had that route shipped, every check would have recorded `failed` and no
 * violation could ever have been reported, with the suite green throughout.
 *
 * So: one end of this seam may be a stub, never both. The stub is the upstream model, which
 * nothing in this repo controls. The helper under test stays real.
 *
 * The blocked-port draw is the same problem `app-server.js` documents — `listen(0)` can hand
 * back a port `fetch` refuses to dial — so the same list is consulted here.
 */

/**
 * @param {string | ((body: object) => string)} reply
 *   what the model should answer with, as the raw `content` string; a function receives the
 *   parsed request body so a test can assert on what was actually sent
 * @returns {Promise<{base: string, requests: object[], close: () => void}>}
 *   `base` is the apiBase to pass to callLLMSwitch; `requests` accumulates every parsed body
 */
export async function startStubLlm(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* a malformed body is itself worth recording */ }
      requests.push(body);
      const content = typeof reply === 'function' ? reply(body) : reply;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });

  let port;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    port = server.address()?.port;
    if (port && !FETCH_BLOCKED_PORTS.has(port)) break;
    await new Promise((resolve) => server.close(resolve));
    port = undefined;
  }
  if (!port) throw new Error('stub LLM: could not obtain a port fetch will dial');

  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => server.close(),
  };
}
