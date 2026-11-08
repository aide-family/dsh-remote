/** Collect only fresh bounded output, and wait for an explicit protocol predicate. */
export async function runVerifiedPty({ send, command, signal, timeoutMs = 120_000, maxBytes = 200_000, isComplete, onData: tap } = {}) {
  if (typeof send !== 'function' || typeof isComplete !== 'function') throw Object.assign(new Error('Verified PTY requires send and an explicit protocol completion predicate'), { code: 'PROTOCOL_REQUIRED' });
  if (typeof command !== 'string' || !command || /[\r\n]/u.test(command)) throw Object.assign(new Error('Verified PTY requires a single-line command'), { code: 'VERIFIED_INPUT_INVALID' });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Verified PTY bounds must be positive integers');
  let output = '';
  let bytes = 0;
  let truncated = false;
  let complete = false;
  const onData = (event) => {
    const chunk = String(event?.chunk ?? '');
    const data = Buffer.from(chunk);
    const remaining = Math.max(0, maxBytes - bytes);
    const previousLength = output.length;
    output += data.subarray(0, remaining).toString('utf8');
    // A cut multibyte codepoint decodes as U+FFFD (three bytes); remove any
    // replacement suffix that would itself exceed the exact UTF-8 byte cap.
    while (Buffer.byteLength(output) > maxBytes) output = output.slice(0, -1);
    bytes += Math.min(remaining, data.length);
    if (data.length > remaining) truncated = true;
    // Once truncated, proof is irrecoverably unknown even if a later end marker arrives.
    complete = !truncated && isComplete(output) === true;
    const accepted = output.slice(previousLength);
    if (accepted && typeof tap === 'function') {
      try { tap({ stream: 'stdout', chunk: accepted }); } catch { /* stream mirrors cannot change proof */ }
    }
  };
  const result = await send(command, { signal, timeoutMs, maxBytes, onData, isComplete: () => complete });
  if (signal?.aborted) throw Object.assign(new Error('Verified PTY lease cancelled'), { name: 'AbortError', code: 'CANCELLED' });
  const proven = complete && !truncated && result?.truncated !== true && result?.waitReason === 'protocol_complete';
  return { output, viewport: output, complete: proven, truncated: truncated || result?.truncated === true,
    waitReason: result?.waitReason ?? 'unknown', timedOut: result?.waitReason === 'timeout', sessionStatus: result?.sessionStatus };
}
