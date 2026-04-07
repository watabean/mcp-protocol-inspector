export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }

      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i];
        continue;
      }

      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < command.length) {
        current += command[++i];
      }
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw new Error(`Unterminated ${quote} quote in command: ${command}`);
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}
