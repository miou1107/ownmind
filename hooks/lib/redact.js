/**
 * Strip credential-shaped text before anything leaves the machine, or lands on disk.
 *
 * The reply and the recent prompts go to the user's own server, which decides which rules
 * apply to them. That is a path out for conversation text, and an AI reply quoting a config
 * file or a curl command carries whatever the user was working on — so it goes through the
 * same redaction the session route already applies rather than a second, subtly different one.
 * Two sanitisers is how one of them ends up weaker than the other.
 *
 * WHY IT LIVES HERE. It used to be a function inside hooks/lib/compliance-client.js, which
 * was the only thing that sent conversation text to the server. When the judge moved onto the
 * user's own machine that file became unreachable and was deleted — and the redaction went
 * with it, silently, because the new sender was written from scratch and nothing named this
 * as a control it had to keep. Review caught it before release. Its own module now, so the
 * next thing that sends text out has something to import rather than something to reinvent.
 */

/** Enough of a surprise to diagnose it, not enough for one to land on disk wholesale. */
export const MAX_REASON_CHARS = 200;

export function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  return text
    .replace(/(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, (match) => {
      const separator = match.includes('=') ? '=' : ':';
      return `${match.split(/[:=]/)[0]}${separator}[REDACTED]`;
    })
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

/**
 * A failure reason, safe to keep for weeks.
 *
 * These end up in ~/.ownmind/logs/check-failures.jsonl. A proxy answering HTML to a request
 * expecting JSON puts the first characters of that HTML into the parser's error message, so
 * the cap bounds what a surprise can write, and the redaction covers the case where what came
 * back quotes the request that produced it.
 */
export function toReason(text) {
  return redact(String(text ?? 'error')).slice(0, MAX_REASON_CHARS);
}
