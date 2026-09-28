import { addressFault } from './fetch-failure.js';

/**
 * The sentences an offline response puts in front of the caller.
 *
 * These used to live inline in mcp/index.js, one string literal per call site, which is how
 * the queue notice came to say something the search notice had already stopped saying. They
 * are here so a test can read them without starting an MCP server, and so the next notice
 * added has one obvious place to be added to.
 *
 * @param {{ apiUrl?: string, apiUrlConfigured?: boolean }} config the address this process
 *   dials and whether anything actually set it
 */
export function makeNoticeHelpers({ apiUrl, apiUrlConfigured } = {}) {
  const fault = (err) => addressFault(err, apiUrl, { configured: apiUrlConfigured !== false });

  /**
   * The address line to put in front of an offline notice, or '' when the address is not in
   * question. Every notice that says "offline" is a place somebody has to decide whether to
   * wait or go and fix something, and the address is what tells those two apart.
   */
  function faultPrefix(err) {
    const { line } = fault(err);
    return line ? `${line} ` : '';
  }

  /**
   * What a queued write tells the caller.
   *
   * "Once back online" is the sentence that let eight writes pile up for five weeks against a
   * placeholder address: the machine was online the whole time, so the promise could never
   * come true and nobody went looking. Against a placeholder the notice now says so outright.
   *
   * It does NOT say so against an address that merely failed to resolve this minute. That
   * person is far more often on a dropped VPN than on a wrong setting, their queue really
   * does flush by itself when the connection returns, and sending them to edit a correct
   * setting is the same fault this file exists to remove, pointed the other way.
   */
  function queueNotice(err, pending) {
    const { line, permanent } = fault(err);
    if (permanent) {
      return `${line} Operation queued (queue: ${pending} pending) — nothing will send it until the address is fixed.`;
    }
    if (line) {
      // States the condition rather than promising delivery. An unset address has two
      // outcomes, not one: the local server starting sends the queue, a server that lives
      // somewhere else never will. "It is sent when this tool reaches that address, and not
      // before" is true of both, which is the most that can be said here.
      return `${line} Operation queued (queue: ${pending} pending) — it is sent when this tool reaches that `
        + `address, and not before, so check the address rather than assuming it is on its way.`;
    }
    return `[OwnMind offline mode] Operation queued — will be sent automatically once back online (queue: ${pending} pending)`;
  }

  /**
   * How an offline search opens and closes.
   *
   * The closing sentence is dropped whenever the address is in question: "only a new session
   * restores it" is false when the next session inherits the same address, and equally false
   * when the name simply did not resolve, because the next call in this same process resolves
   * it again as soon as the connection is back.
   *
   * @param {string} source where the hits actually came from, already in words
   */
  function searchNoticeParts(err, source) {
    const { line, permanent } = fault(err);
    if (permanent) return { opening: `${line} Until it is fixed, these hits come from ${source}. `, closing: '' };
    if (line) return { opening: `${line} Meanwhile these hits come from ${source}. `, closing: '' };
    return {
      opening: `[OwnMind offline mode] This session could not reach the OwnMind server (tried twice), so these hits come from ${source}. `,
      closing: 'If searches keep failing this way, the connection is stuck for the rest of this process and only a new session restores it.',
    };
  }

  return { faultPrefix, queueNotice, searchNoticeParts };
}
