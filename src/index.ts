import chalk from "chalk";
import { StdioTransport } from "./transport/stdio.js";
import { SseTransport, StreamableHttpTransport } from "./transport/http.js";
import { McpTransport } from "./transport/types.js";
import { initialize } from "./protocol/initialize.js";
import { runCli } from "./cli.js";
import { splitCommand } from "./util/shellwords.js";
import { attachServerRequestHandler } from "./protocol/serverRequests.js";

interface Args {
  mode: "stdio" | "sse" | "streamable";
  command?: string;
  cmdArgs?: string[];
  url?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);

  // --url で既存のHTTPサーバーに接続
  const urlIdx = argv.indexOf("--url");
  if (urlIdx !== -1 && argv[urlIdx + 1]) {
    const url = argv[urlIdx + 1];
    const mode = argv.includes("--streamable") ? "streamable" : "sse";
    return { mode, url };
  }

  // --server でサブプロセス起動 (stdio)
  const serverIdx = argv.indexOf("--server");
  if (serverIdx !== -1 && argv[serverIdx + 1]) {
    const serverCmd = argv[serverIdx + 1];
    const parts = splitCommand(serverCmd);
    return { mode: "stdio", command: parts[0], cmdArgs: parts.slice(1) };
  }

  // ヘルプ
  console.log(chalk.bold("MCP Inspector CLI"));
  console.log(chalk.gray("\n使い方:"));
  console.log(chalk.cyan('  npm run inspect -- --server "node /path/to/server.js"'));
  console.log(chalk.cyan('  npm run inspect -- --server "npx @modelcontextprotocol/server-filesystem /tmp"'));
  console.log(chalk.cyan("  npm run inspect -- --url http://localhost:3845          # SSE (Figmaなど)"));
  console.log(chalk.cyan("  npm run inspect -- --url http://localhost:3000 --streamable  # Streamable HTTP"));
  process.exit(0);
}

async function main(): Promise<void> {
  const args = parseArgs();

  let transport: McpTransport;

  if (args.mode === "stdio") {
    const t = new StdioTransport({ verbose: true });
    t.on("error", (err: Error) => {
      console.error(chalk.red(`[FATAL] ${err.message}`));
      process.exit(1);
    });
    t.connect(args.command!, args.cmdArgs!);
    transport = t;

  } else if (args.mode === "sse") {
    const t = new SseTransport({ verbose: true });
    t.on("error", (err: Error) => {
      console.error(chalk.red(`[FATAL] ${err.message}`));
      process.exit(1);
    });
    await t.connect(args.url!);
    transport = t;

  } else {
    const t = new StreamableHttpTransport(args.url!, { verbose: true });
    await t.connect();
    transport = t;
  }

  try {
    attachServerRequestHandler(transport, {
      rootPaths: [process.cwd()],
      onUnhandledRequest: (method) => {
        console.error(chalk.yellow(`[WARN] Unsupported server request: ${method}`));
      },
    });
    const serverInfo = await initialize(transport);
    await runCli(transport, serverInfo);
  } catch (err) {
    console.error(
      chalk.red(`[FATAL] ${err instanceof Error ? err.message : String(err)}`)
    );
    transport.close();
    process.exit(1);
  }
}

main();
