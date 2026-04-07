import { countTokens } from "@anthropic-ai/tokenizer";
import { type Tool } from "./tools.js";

/**
 * MCPのツール定義をAnthropicのAPI形式に変換してトークン数を計算する
 *
 * これは Claude API に渡す tools 定義 JSON そのものの概算トークン数。
 * Anthropic 側の固定 tool-use system prompt 分は含まない。
 *
 * Claude では tools 定義を以下の形式で送る:
 * { name, description, input_schema }
 */
export function countToolTokens(tool: Tool): number {
  const apiFormat = {
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.inputSchema,
  };
  return countTokens(JSON.stringify(apiFormat));
}

export interface TokenReport {
  tools: Array<{ name: string; tokens: number }>;
  total: number;
}

export function buildTokenReport(tools: Tool[]): TokenReport {
  const entries = tools.map((tool) => ({
    name: tool.name,
    tokens: countToolTokens(tool),
  }));
  const total = entries.reduce((sum, e) => sum + e.tokens, 0);
  return { tools: entries, total };
}
