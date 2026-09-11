/**
 * Where recorded lines go. The engine package is pure, so the recorder writes through this
 * interface and never imports `node:fs`; tests use `memorySink`, the server (ALE-13) uses the
 * `node:fs` implementation in fs-sink.ts. One method, so a caller can pass a closure.
 */
export interface LineSink {
  /** Append one line. The sink adds the newline; the line itself never contains one. */
  write(line: string): void;
  /** Release any resource the sink holds. Optional: a memory sink has nothing to close. */
  close?(): void;
}

export interface MemorySink extends LineSink {
  readonly lines: readonly string[];
  /** The whole recording as JSONL text, exactly as a file sink would have written it. */
  text(): string;
}

/** Collects lines in memory. The default sink, and the one every engine test uses. */
export function memorySink(): MemorySink {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => void lines.push(line),
    text: () => (lines.length ? `${lines.join('\n')}\n` : ''),
  };
}
