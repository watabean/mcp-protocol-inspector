import { StdioTransport } from "../transport/stdio.js";

export interface ToolInputSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema: ToolInputSchema;
}

export interface ToolContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolCallResult {
  content: ToolContent[];
  isError?: boolean;
}

let nextId = 2; // initialize が id:1 を使うので 2 から

function nextRequestId(): number {
  return nextId++;
}

/**
 * tools/list — サーバーが提供するツール一覧を取得
 */
export function listTools(transport: StdioTransport): Promise<Tool[]> {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId();

    const onMessage = (message: Record<string, unknown>) => {
      if (message.id === requestId) {
        transport.off("message", onMessage);

        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }

        const result = message.result as { tools: Tool[] };
        resolve(result.tools ?? []);
      }
    };

    transport.on("message", onMessage);

    transport.send({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/list",
    });
  });
}

/**
 * tools/call — ツールを呼び出す
 */
export function callTool(
  transport: StdioTransport,
  toolName: string,
  toolArguments: Record<string, unknown>
): Promise<ToolCallResult> {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId();

    const onMessage = (message: Record<string, unknown>) => {
      if (message.id === requestId) {
        transport.off("message", onMessage);

        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }

        resolve(message.result as ToolCallResult);
      }
    };

    transport.on("message", onMessage);

    transport.send({
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArguments,
      },
    });
  });
}

/**
 * 生のJSON-RPCメッセージを送信（rawコマンド用）
 */
export function sendRaw(transport: StdioTransport, json: string): void {
  const message = JSON.parse(json) as unknown;
  transport.send(message);
}
