import chalk from "chalk";
import { StdioTransport } from "./transport/stdio.js";
import { SseTransport } from "./transport/http.js";
import { McpTransport } from "./transport/types.js";
import { initialize } from "./protocol/initialize.js";
import { listTools } from "./protocol/tools.js";
import { buildTokenReport } from "./protocol/tokens.js";
import { splitCommand } from "./util/shellwords.js";
import { attachServerRequestHandler } from "./protocol/serverRequests.js";

// Anthropic 料金表 (input tokens, USD / 1M tokens)
// 2026-04-07 時点の https://www.anthropic.com/pricing を基準にしている。
const MODELS = [
  { id: "claude-sonnet-4",   label: "claude-sonnet-4  ", pricePerM: 3.0 },
  { id: "claude-opus-4-1",   label: "claude-opus-4.1  ", pricePerM: 15.0 },
  { id: "claude-haiku-3-5",  label: "claude-haiku-3.5 ", pricePerM: 0.8 },
];

interface ServerSpec {
  type: "stdio" | "sse";
  value: string; // コマンド文字列 or URL
}

interface BenchmarkResult {
  serverName: string;
  toolCount: number;
  tokens: number;
  error?: string;
}

// ────────────────────────────────────────────
// 引数パース
// ────────────────────────────────────────────

function parseArgs(): ServerSpec[] {
  const argv = process.argv.slice(2);
  const specs: ServerSpec[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--server" && argv[i + 1]) {
      specs.push({ type: "stdio", value: argv[++i] });
    } else if (argv[i] === "--url" && argv[i + 1]) {
      specs.push({ type: "sse", value: argv[++i] });
    }
  }

  if (specs.length === 0) {
    console.log(chalk.bold("MCP Token Benchmark"));
    console.log(chalk.gray("\n使い方:"));
    console.log(chalk.cyan('  npm run benchmark -- --server "npx @modelcontextprotocol/server-filesystem /tmp"'));
    console.log(chalk.cyan("  npm run benchmark -- --url http://localhost:3845"));
    console.log(chalk.cyan('  npm run benchmark -- --server "cmd1" --url http://localhost:3845 --server "cmd2"'));
    process.exit(0);
  }

  return specs;
}

// ────────────────────────────────────────────
// 1サーバーの計測
// ────────────────────────────────────────────

async function measureServer(spec: ServerSpec): Promise<BenchmarkResult> {
  let transport: McpTransport | null = null;

  try {
    if (spec.type === "stdio") {
      const parts = splitCommand(spec.value);
      const t = new StdioTransport({ verbose: false, silent: true });
      t.connect(parts[0], parts.slice(1));
      transport = t;
    } else {
      const t = new SseTransport({ verbose: false, silent: true });
      await t.connect(spec.value);
      transport = t;
    }

    let unhandledMethod: string | null = null;
    attachServerRequestHandler(transport, {
      rootPaths: ["/tmp"],
      onUnhandledRequest: (method) => {
        unhandledMethod = method;
      },
    });

    const serverInfo = await initialize(transport);
    const tools = await listTools(transport);
    const report = buildTokenReport(tools);

    if (unhandledMethod) {
      throw new Error(`unsupported server request during benchmark: ${unhandledMethod}`);
    }

    return {
      serverName: serverInfo.serverInfo.name,
      toolCount: tools.length,
      tokens: report.total,
    };
  } catch (err) {
    return {
      serverName: spec.value,
      toolCount: 0,
      tokens: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    transport?.close();
  }
}

// ────────────────────────────────────────────
// レポート表示
// ────────────────────────────────────────────

function printReport(results: BenchmarkResult[], conversationsPerMonth: number): void {
  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const totalTools = results.reduce((s, r) => s + r.toolCount, 0);

  const nameWidth = Math.max(...results.map((r) => r.serverName.length), 30);
  const sep = "─".repeat(nameWidth + 26);
  const dbl = "═".repeat(nameWidth + 26);

  console.log("\n" + chalk.bold("MCP Token Benchmark"));
  console.log(chalk.gray(dbl));
  console.log(
    chalk.bold(
      `${"Server".padEnd(nameWidth)}  ${"Tools".padStart(5)}  ${"Tokens".padStart(8)}`
    )
  );
  console.log(chalk.gray(sep));

  for (const r of results) {
    if (r.error) {
      console.log(
        `${chalk.red(r.serverName.padEnd(nameWidth))}  ${"-".padStart(5)}  ${chalk.red("ERROR: " + r.error)}`
      );
    } else {
      console.log(
        `${chalk.white(r.serverName.padEnd(nameWidth))}  ${String(r.toolCount).padStart(5)}  ${chalk.yellow(r.tokens.toLocaleString().padStart(8))}`
      );
    }
  }

  console.log(chalk.gray(sep));
  console.log(
    `${"合計 (" + results.length + "サーバー接続時)".padEnd(nameWidth)}  ${String(totalTools).padStart(5)}  ${chalk.yellow(chalk.bold(totalTokens.toLocaleString().padStart(8)))}`
  );

  console.log("\n" + chalk.bold(`コスト試算 (${conversationsPerMonth.toLocaleString()}会話/月)`));
  console.log(chalk.gray(sep));

  for (const model of MODELS) {
    const monthlyTokens = totalTokens * conversationsPerMonth;
    const cost = (monthlyTokens / 1_000_000) * model.pricePerM;
    const costStr = `$${cost.toFixed(2)}/月`;
    console.log(
      `  ${chalk.cyan(model.label)}  $${model.pricePerM.toFixed(1)}/1M tokens  →  ${chalk.green(costStr)}`
    );
  }

  console.log(chalk.gray(dbl) + "\n");
}

// ────────────────────────────────────────────
// main
// ────────────────────────────────────────────

async function main(): Promise<void> {
  const specs = parseArgs();
  const CONVERSATIONS_PER_MONTH = 1000;

  console.log(chalk.gray(`\n${specs.length}サーバーを計測中...\n`));

  const results: BenchmarkResult[] = [];
  for (const spec of specs) {
    const label = spec.type === "stdio" ? spec.value.split(" ")[0] : spec.value;
    process.stdout.write(chalk.gray(`  measuring ${label} ... `));
    const result = await measureServer(spec);
    process.stdout.write(
      result.error ? chalk.red("failed\n") : chalk.green(`${result.tokens} tokens\n`)
    );
    results.push(result);
  }

  printReport(results, CONVERSATIONS_PER_MONTH);
}

main().catch((err) => {
  console.error(chalk.red(`[FATAL] ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
