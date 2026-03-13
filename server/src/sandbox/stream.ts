/** Shared helpers for consuming AsyncIterable<string> streams from sandbox commands. */

/** Consume a stream, discarding all output. */
export async function drain(stream: AsyncIterable<string>): Promise<void> {
  for await (const _ of stream) { /* consume */ }
}

/** Collect all chunks from a stream into an array of strings. */
export async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of stream) { lines.push(line); }
  return lines;
}

/** Collect all chunks from a stream into a single joined string. */
export async function collectOutput(stream: AsyncIterable<string>): Promise<string> {
  const lines = await collect(stream);
  return lines.join('\n');
}
