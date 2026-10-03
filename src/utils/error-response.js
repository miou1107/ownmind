/**
 * What the last-resort error handler sends back for an error nothing else caught.
 *
 * A 4xx is about the request (malformed JSON, body too large) and its message says what to
 * fix. Anything else is the server's own failure, and its message can carry SQL, file paths
 * or library internals: the caller logs it, the client gets a generic sentence.
 *
 * @param {any} err
 * @returns {{ status: number, body: { error: string } }}
 */
export function errorResponse(err) {
  const raw = err && Number.isInteger(err.status) ? err.status : 500;
  const status = raw >= 400 && raw < 500 ? raw : 500;
  const ownMessage = status < 500 && err.expose !== false && typeof err.message === 'string' && err.message;
  return { status, body: { error: ownMessage || '伺服器內部錯誤' } };
}
