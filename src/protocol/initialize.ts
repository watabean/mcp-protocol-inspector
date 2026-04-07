import { McpTransport } from "../transport/types.js";

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  logging?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: ServerInfo;
  capabilities: ServerCapabilities;
}

/**
 * MCPの初期化シーケンスを実行する
 *
 * 1. initialize リクエスト送信
 * 2. initialize レスポンス受信
 * 3. notifications/initialized 通知送信
 */
export function initialize(transport: McpTransport): Promise<InitializeResult> {
  return new Promise((resolve, reject) => {
    const requestId = 1;

    const onMessage = (message: Record<string, unknown>) => {
      if (message.id === requestId) {
        transport.off("message", onMessage);

        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
          return;
        }

        const result = message.result as InitializeResult;

        // 初期化完了を示すため initialized 通知を送る。
        // 仕様上、通常操作に入る前に必要。
        transport.send({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });

        resolve(result);
      }
    };

    transport.on("message", onMessage);

    transport.send({
      jsonrpc: "2.0",
      id: requestId,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        clientInfo: {
          name: "mcp-inspector",
          version: "0.1.0",
        },
        capabilities: {
          // roots を宣言すると、サーバーから roots/list を求められることがある。
          roots: { listChanged: false },
          sampling: {},
        },
      },
    });
  });
}
