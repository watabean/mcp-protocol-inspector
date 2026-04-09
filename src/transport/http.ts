import { EventEmitter } from "node:events";
import chalk from "chalk";

export interface TransportOptions {
  verbose: boolean;
  silent?: boolean;
  headers?: Record<string, string>;
}

/**
 * SSE Transport (旧仕様 2024-11-05)
 *
 * 仕様: https://modelcontextprotocol.io/specification/2024-11-05/basic/transports#http-with-sse
 *
 * 接続フロー:
 * 1. GET /sse → SSE ストリーム確立
 * 2. Server が "endpoint" イベントで POST 先 URL を通知
 * 3. Client は POST <endpoint> でメッセージ送信
 * 4. Server の応答は SSE ストリームで届く
 *
 * 採用例: Figma Desktop MCP (localhost:3845), 多くの既存 MCP サーバー
 */
export class SseTransport extends EventEmitter {
  private postUrl: string | null = null;
  private abortController: AbortController | null = null;
  private verbose: boolean;
  private silent: boolean;
  private baseUrl: string = "";
  private headers: Record<string, string>;

  constructor(options: TransportOptions = { verbose: true }) {
    super();
    this.verbose = options.verbose;
    this.silent = options.silent ?? false;
    this.headers = options.headers ?? {};
  }

  async connect(baseUrl: string): Promise<void> {
    this.baseUrl = baseUrl;
    const sseUrl = this.buildSseUrl(baseUrl);
    if (!this.silent) console.log(chalk.gray(`[CONNECT] SSE ${sseUrl}`));

    this.abortController = new AbortController();

    const response = await fetch(sseUrl, {
      headers: { Accept: "text/event-stream", ...this.headers },
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE接続失敗: ${response.status} ${response.statusText}`);
    }

    // SSE ストリームを非同期で読み続ける
    this.readSseStream(response.body);

    // endpoint イベントが来るまで待つ
    await new Promise<void>((resolve, reject) => {
      const onEndpoint = () => { resolve(); };
      const onError = (err: Error) => { reject(err); };
      this.once("_endpoint", onEndpoint);
      this.once("error", onError);
      setTimeout(() => {
        this.off("_endpoint", onEndpoint);
        this.off("error", onError);
        reject(new Error("endpoint イベントのタイムアウト (5s)"));
      }, 5000);
    });
  }

  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!this.silent) console.log(chalk.yellow("[DISCONNECT] SSE ストリーム終了"));
          this.emit("disconnect");
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const eventBlock of events) {
          this.parseSseEvent(eventBlock);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.emit("error", err);
      }
    }
  }

  private parseSseEvent(block: string): void {
    let eventType = "message";
    let data = "";

    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data = line.slice(5).trim();
      }
    }

    if (!data) return;

    if (eventType === "endpoint") {
      // サーバーが POST 先 URL を通知してくる
      // data が絶対URL の場合でもポートが欠落していることがある (Figma等)
      // → baseUrl を基準に解決してポートを引き継ぐ
      const base = new URL(this.baseUrl);
      const resolved = new URL(data, base);
      // 同一ホストならベースURLのポートを使う（Figmaがポートなし絶対URLを返す問題の対処）
      if (resolved.hostname === base.hostname && resolved.port === "") {
        resolved.port = base.port;
      }
      this.postUrl = resolved.toString();
      if (!this.silent) console.log(chalk.gray(`[SSE] endpoint: ${this.postUrl}`));
      this.emit("_endpoint");
      return;
    }

    if (eventType === "message") {
      try {
        const message = JSON.parse(data);
        this.logMessage("←", message);
        this.emit("message", message);
      } catch {
        console.error(chalk.red(`[PARSE ERROR] ${data}`));
      }
    }
  }

  send(message: unknown): void {
    if (!this.postUrl) throw new Error("未接続 (endpoint URLが未取得)");

    this.logMessage("→", message);

    fetch(this.postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.headers },
      body: JSON.stringify(message),
    }).then((res) => {
      if (!res.ok) {
        console.error(chalk.red(`[POST ERROR] ${res.status} ${res.statusText}`));
      }
    }).catch((err: Error) => {
      console.error(chalk.red(`[POST ERROR] ${err.message}`));
    });
  }

  private buildSseUrl(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/sse")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/sse`;
    }
    return url.toString();
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
    this.abortController?.abort();
    this.abortController = null;
  }
}

/**
 * Streamable HTTP Transport (新仕様 2025-03-26)
 *
 * 仕様: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
 *
 * 旧SSEとの主な違い:
 * - コネクション1本で双方向通信 (旧SSEは受信用GET + 送信用POSTの2本)
 * - POST /mcp 単一エンドポイント
 * - レスポンスは Content-Type によって使い分け:
 *     application/json        → 単一レスポンス
 *     text/event-stream       → ストリーミングレスポンス (複数メッセージ)
 *     202 Accepted            → 通知など応答不要の場合
 * - Mcp-Session-Id ヘッダーでセッション管理
 * - サーバー起点の通知は GET /mcp + SSE で受け取れる (オプション)
 *
 * 採用例: Claude Desktop (2025〜), 新規実装の MCP サーバー
 */
export class StreamableHttpTransport extends EventEmitter {
  private baseUrl: string;
  private sessionId: string | null = null;
  private verbose: boolean;
  private silent: boolean;
  private headers: Record<string, string>;

  constructor(baseUrl: string, options: TransportOptions = { verbose: true }) {
    super();
    this.baseUrl = this.normalizeEndpoint(baseUrl);
    this.verbose = options.verbose;
    this.silent = options.silent ?? false;
    this.headers = options.headers ?? {};
  }

  async connect(): Promise<void> {
    if (!this.silent) console.log(chalk.gray(`[CONNECT] Streamable HTTP ${this.baseUrl}`));
    // Streamable HTTP は単一 endpoint を使う。
    // セッションは initialize のレスポンスヘッダーで始まることがある。
  }

  async send(message: unknown): Promise<void> {
    const url = this.baseUrl;
    this.logMessage("→", message);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });

    // セッションIDを保存
    const newSessionId = response.headers.get("Mcp-Session-Id");
    if (newSessionId) this.sessionId = newSessionId;

    const contentType = response.headers.get("Content-Type") ?? "";

    if (contentType.includes("text/event-stream") && response.body) {
      // SSE ストリームとして読む
      await this.readSseResponse(response.body);
    } else if (contentType.includes("application/json")) {
      // 単一JSONレスポンス
      const json = await response.json() as unknown;
      this.logMessage("←", json);
      this.emit("message", json);
    } else if (response.status === 202) {
      // Accepted (応答なし)
    } else {
      console.error(chalk.red(`[ERROR] 予期しないレスポンス: ${response.status} ${contentType}`));
    }
  }

  private normalizeEndpoint(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (!url.pathname.endsWith("/mcp")) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/mcp`;
    }
    return url.toString();
  }

  private async readSseResponse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const block of events) {
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("data:")) {
            data = line.slice(5).trim();
          }
        }
        if (!data) continue;
        try {
          const message = JSON.parse(data);
          this.logMessage("←", message);
          this.emit("message", message);
        } catch {
          console.error(chalk.red(`[PARSE ERROR] ${data}`));
        }
      }
    }
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
    // セッション終了 (DELETE /mcp) を送るのが仕様だが省略
    this.sessionId = null;
  }
}
