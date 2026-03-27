import { EventEmitter } from "node:events";

/**
 * stdio / SSE / Streamable HTTP 共通のトランスポートインターフェース
 */
export interface McpTransport extends EventEmitter {
  send(message: unknown): void | Promise<void>;
  close(): void;
}
