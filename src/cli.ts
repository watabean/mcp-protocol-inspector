import * as readline from "node:readline";
import chalk from "chalk";
import { McpTransport } from "./transport/types.js";
import { initialize, type InitializeResult } from "./protocol/initialize.js";
import { listTools, callTool, sendRaw, type Tool } from "./protocol/tools.js";

const HELP_TEXT = `
${chalk.bold("コマンド一覧:")}
  ${chalk.cyan("list tools")}              ツール一覧を取得
  ${chalk.cyan("call <tool> [json]")}      ツールを呼び出す (例: call echo {"message":"hi"})
  ${chalk.cyan("raw <json>")}              生のJSON-RPCを送信 (例: raw {"jsonrpc":"2.0","id":99,"method":"tools/list"})
  ${chalk.cyan("help")}                    このヘルプを表示
  ${chalk.cyan("exit")} / ${chalk.cyan("quit")}             終了
`;

export async function runCli(
  transport: McpTransport,
  serverInfo: InitializeResult
): Promise<void> {
  console.log("\n" + chalk.bold.green("=== MCP Inspector ==="));
  console.log(
    chalk.gray(`Server: ${serverInfo.serverInfo.name} v${serverInfo.serverInfo.version}`)
  );
  console.log(chalk.gray(`Protocol: ${serverInfo.protocolVersion}`));
  const caps = Object.keys(serverInfo.capabilities).join(", ") || "(none)";
  console.log(chalk.gray(`Capabilities: ${caps}`));
  console.log(chalk.gray('Type "help" for commands\n'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.blue("mcp> "),
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    try {
      await handleCommand(input, transport);
    } catch (err) {
      console.error(chalk.red(`[ERROR] ${err instanceof Error ? err.message : String(err)}`));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log(chalk.gray("\n[DISCONNECT] 終了します"));
    transport.close();
    process.exit(0);
  });

  // サーバーが切断したら終了
  transport.on("disconnect", () => {
    rl.close();
  });
}

async function handleCommand(input: string, transport: McpTransport): Promise<void> {
  if (input === "help") {
    console.log(HELP_TEXT);
    return;
  }

  if (input === "exit" || input === "quit") {
    transport.close();
    process.exit(0);
  }

  if (input === "list tools") {
    const tools = await listTools(transport);
    printTools(tools);
    return;
  }

  if (input.startsWith("call ")) {
    const rest = input.slice(5).trim();
    const spaceIdx = rest.indexOf(" ");
    let toolName: string;
    let argsJson: string;

    if (spaceIdx === -1) {
      toolName = rest;
      argsJson = "{}";
    } else {
      toolName = rest.slice(0, spaceIdx);
      argsJson = rest.slice(spaceIdx + 1).trim();
    }

    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      console.error(chalk.red(`[ERROR] 引数のJSONが不正です: ${argsJson}`));
      return;
    }

    const result = await callTool(transport, toolName, toolArgs);
    printToolResult(result);
    return;
  }

  if (input.startsWith("raw ")) {
    const json = input.slice(4).trim();
    try {
      sendRaw(transport, json);
    } catch {
      console.error(chalk.red(`[ERROR] JSONが不正です: ${json}`));
    }
    return;
  }

  console.log(chalk.yellow(`不明なコマンド: "${input}" (helpで一覧表示)`));
}

function printTools(tools: Tool[]): void {
  if (tools.length === 0) {
    console.log(chalk.yellow("  ツールがありません"));
    return;
  }

  console.log(chalk.bold(`\n  ${tools.length}個のツール:`));
  for (const tool of tools) {
    console.log(`  ${chalk.cyan("•")} ${chalk.bold(tool.name)}`);
    if (tool.description) {
      console.log(`    ${chalk.gray(tool.description)}`);
    }
    if (tool.inputSchema?.properties) {
      const params = Object.keys(tool.inputSchema.properties);
      const required = tool.inputSchema.required ?? [];
      const paramStr = params
        .map((p) => (required.includes(p) ? chalk.white(p) : chalk.gray(`[${p}]`)))
        .join(", ");
      console.log(`    ${chalk.gray("params:")} ${paramStr}`);
    }
  }
  console.log();
}

function printToolResult(result: {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): void {
  const label = result.isError ? chalk.red("[TOOL ERROR]") : chalk.green("[TOOL RESULT]");
  console.log(`\n${label}`);

  for (const item of result.content) {
    if (item.type === "text" && item.text) {
      console.log(chalk.white(item.text));
    } else {
      console.log(chalk.gray(JSON.stringify(item, null, 2)));
    }
  }
  console.log();
}

/**
 * HTTP/SSE トランスポートのプレースホルダー（今後実装）
 */
export function connectHttp(_url: string): never {
  throw new Error("HTTP/SSE transport is not yet implemented");
}

export { initialize };
