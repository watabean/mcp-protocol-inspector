import { pathToFileURL } from "node:url";
import { McpTransport } from "../transport/types.js";

export interface ServerRequestOptions {
  rootPaths?: string[];
  onUnhandledRequest?: (method: string) => void;
}

function buildRoots(rootPaths: string[]): Array<{ uri: string; name: string }> {
  return rootPaths.map((rootPath) => ({
    uri: pathToFileURL(rootPath).toString(),
    name: rootPath.split("/").filter(Boolean).pop() ?? rootPath,
  }));
}

export function attachServerRequestHandler(
  transport: McpTransport,
  options: ServerRequestOptions = {}
): () => void {
  const rootPaths = options.rootPaths ?? ["/tmp"];

  const onMessage = (message: Record<string, unknown>) => {
    if (typeof message.method !== "string" || typeof message.id !== "number") {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "result")) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      return;
    }

    if (message.method === "roots/list") {
      transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          roots: buildRoots(rootPaths),
        },
      });
      return;
    }

    options.onUnhandledRequest?.(message.method);
    transport.send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${message.method}`,
      },
    });
  };

  transport.on("message", onMessage);
  return () => {
    transport.off("message", onMessage);
  };
}
