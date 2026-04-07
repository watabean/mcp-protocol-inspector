import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import chalk from "chalk";

export interface TransportOptions {
  verbose: boolean;
  silent?: boolean; // true にするとすべてのログを抑制（benchmark用）
}

export class StdioTransport extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lineBuffer = "";
  private verbose: boolean;
  private silent: boolean;

  constructor(options: TransportOptions = { verbose: true }) {
    super();
    this.verbose = options.verbose;
    this.silent = options.silent ?? false;
  }

  connect(command: string, args: string[]): void {
    if (!this.silent) console.log(chalk.gray(`[CONNECT] ${command} ${args.join(" ")}`));

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.lineBuffer += chunk;
      this.parseLines();
    });

    this.process.stderr.on("data", (data: Buffer) => {
      if (this.silent) return;
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        if (line) console.log(chalk.gray(`[SERVER LOG] ${line}`));
      }
    });

    this.process.on("exit", (code) => {
      if (!this.silent) console.log(chalk.yellow(`[DISCONNECT] process exited with code ${code}`));
      this.emit("disconnect");
    });

    this.process.on("error", (err) => {
      console.error(chalk.red(`[ERROR] ${err.message}`));
      this.emit("error", err);
    });
  }

  /**
   * MCPのstdioトランスポートは改行区切りJSON
   * 各行が独立したJSONメッセージ
   */
  private parseLines(): void {
    const lines = this.lineBuffer.split("\n");
    // 最後の要素は未完成の行かもしれないので保持
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed);
        this.logMessage("←", message);
        this.emit("message", message);
      } catch {
        console.error(chalk.red(`[PARSE ERROR] ${trimmed}`));
      }
    }
  }

  send(message: unknown): void {
    if (!this.process) throw new Error("Not connected");

    this.logMessage("→", message);

    // MCPのstdioトランスポートは改行区切りJSON
    const frame = JSON.stringify(message) + "\n";
    this.process.stdin.write(frame, "utf8");
  }

  private logMessage(direction: "→" | "←", message: unknown): void {
    if (this.silent) return;
    const json = JSON.stringify(message, null, this.verbose ? 2 : undefined);
    if (direction === "→") {
      console.log(chalk.cyan(`\n[SEND ${direction}] `) + chalk.white(json));
    } else {
      console.log(chalk.green(`[RECV ${direction}] `) + chalk.white(json));
    }
  }

  close(): void {
    this.process?.kill();
    this.process = null;
  }
}
