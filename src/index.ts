import chalk from "chalk";
import { StdioTransport } from "./transport/stdio.js";
import { initialize } from "./protocol/initialize.js";
import { runCli } from "./cli.js";

function parseArgs(): { command: string; args: string[] } {
  const argv = process.argv.slice(2);

  // --server "cmd arg1 arg2" 形式をパース
  const serverIdx = argv.indexOf("--server");
  if (serverIdx !== -1 && argv[serverIdx + 1]) {
    const serverCmd = argv[serverIdx + 1];
    const parts = serverCmd.split(" ");
    return { command: parts[0], args: parts.slice(1) };
  }

  // 引数なし → ヘルプ表示
  console.log(chalk.bold("MCP Inspector CLI"));
  console.log(chalk.gray("使い方:"));
  console.log(
    chalk.cyan('  npm run inspect -- --server "node /path/to/server.js"')
  );
  console.log(
    chalk.cyan(
      '  npm run inspect -- --server "npx @modelcontextprotocol/server-filesystem /tmp"'
    )
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const { command, args } = parseArgs();

  const transport = new StdioTransport({ verbose: true });

  transport.on("error", (err: Error) => {
    console.error(chalk.red(`[FATAL] ${err.message}`));
    process.exit(1);
  });

  transport.connect(command, args);

  try {
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
