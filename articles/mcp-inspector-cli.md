---
title: "MCPの仕様理解のためにInspectorを自作してみた"
emoji: "🔍"
type: "tech"
topics: ["mcp", "claude", "typescript", "llm"]
published: true
---

## はじめに

Claude Desktop や Claude Code に MCP サーバーをつないで使っていると、内部で何が起きているのか気になることがあります。公式の `@modelcontextprotocol/inspector` を使えば GUI で挙動を確認できますが、SDK が多くを吸収してくれるぶん、プロトコルそのものを意識する場面はあまりありません。

そこで今回は、**MCP の通信を JSON-RPC レベルで可視化する CLI ツールを自作しました**。最初は「MCP はツールを呼び出すための共通インターフェース」くらいの理解でしたが、実装してみると、実際にはクライアント側にも capability ごとの実装責務があることが見えてきました。この記事では、その点を中心に整理します。

## 作ったもの

今回作ったのは、MCP サーバーとの通信を生の JSON-RPC レベルで見られる対話型 CLI ツールです。公式の Inspector が GUI での確認に向いているのに対して、こちらは「実際にどんなメッセージが流れているか」をそのまま追えることを重視しています。

### MCP Inspector CLI

```bash
# stdioサーバーに接続
npm run inspect -- --server "npx @modelcontextprotocol/server-filesystem /tmp"

# HTTPサーバーに接続（Figmaなど）
npm run inspect -- --url http://localhost:3845
```

```
[SEND →] {"jsonrpc":"2.0","id":1,"method":"initialize",...}
[RECV ←] {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}

mcp> list tools
mcp> call read_text_file {"path":"/tmp/test.txt"}
mcp> raw {"jsonrpc":"2.0","id":99,"method":"tools/list"}
mcp> count tokens
```

### MCPトークンベンチマーク

複数サーバーをまとめて計測して、概算コストを見られるスクリプトも追加しました。`roots/list` にも応答するので、filesystem サーバーのようにクライアント側 capability を使うサーバーでもそのまま計測できます。

```bash
npm run benchmark -- \
  --server "npx @modelcontextprotocol/server-filesystem /tmp" \
  --url http://localhost:3845
```

## MCPとは何か

MCP（Model Context Protocol）は、見た目としては **JSON-RPC 2.0 over stdio / HTTP** です。

```
Claude Desktop
    ↕ JSON-RPC 2.0
MCP Server（ファイルシステム、Figma、GitHubなど）
```

つまり、JSON でリクエストとレスポンスをやり取りするシンプルな RPC を、stdio や HTTP の上で流していると考えるとイメージしやすいです。

### stdioトランスポートのフレーミング

最初に確認したかったのは、stdio でどのようにメッセージが流れるかでした。MCP の stdio は **改行区切りの JSON** で、メッセージごとに改行で区切られます。

```
# 実際のフォーマット（1行1メッセージ）
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n
{"jsonrpc":"2.0","id":1,"result":{...}}\n
```

### 初期化シーケンス

接続直後には、次のハンドシェイクが走ります。

```
Client → Server: initialize（protocolVersion, clientInfo, capabilities）
Server → Client: initialize response（serverInfo, capabilities）
Client → Server: notifications/initialized
```

この `notifications/initialized` を送って初期化完了になります。CLI を自作してみると、このへんは SDK がいい感じにやってくれていたんだな、というのが分かります。

## 実装して最初に詰まったところ

### MCPは「ツールを呼ぶだけ」の仕組みではない

MCP は、クライアントがサーバーのツールを呼ぶだけの片方向プロトコルではなく、サーバーからクライアントへリクエストが送られることもあります。

たとえば、ローカルファイルを扱う公式 MCP サーバー `@modelcontextprotocol/server-filesystem` に接続すると、初期化後にサーバー側から `roots/list` リクエストが送られてくることがあります。

```json
← [RECV] {"method":"roots/list","jsonrpc":"2.0","id":0}
```

MCP では初期化時に `capabilities` をやり取りして、「このクライアント／サーバーはどの機能を扱えますか」を互いに宣言します。`roots` もそのひとつで、クライアントが roots 関連の問い合わせを受け取り、ルートディレクトリ情報を返せることを表します。

filesystem 系のサーバーは必要に応じて `roots/list` を送り、クライアント側に許可されたルート一覧を問い合わせます。

今回の CLI でも、最初は `roots/list` を受信するだけで止まっていました。その後、`roots/list` に応答を返す処理を入れたことで、filesystem サーバーでもそのまま `tools/list` まで進めるようになりました。ここで分かったのは、MCP クライアントは一度作れば何でもそのまま扱えるわけではない、ということです。`tools/list` や `tools/call` のような共通部分だけなら扱えても、サーバーが `roots` などの capability を使う場合は、それに応答するクライアント側の実装が必要になります。

この点は、MCP を「単なるツール呼び出し API」と見ていたときにはあまり意識していませんでした。SDK を外してプロトコルを直接見ると、MCP はクライアントとサーバーの両方に状態と責務を持つ仕組みだと分かります。

## HTTPトランスポートはまだ実装上の考慮が多い

HTTP トランスポートは、現時点では旧仕様と新仕様が混在しています。

### 旧仕様（2024-11-05）: SSE Transport

- [仕様](https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports/#http-with-sse)
- **2 本のコネクション**を使います
- `GET /sse` で受信用の SSE ストリームを確立します
- `POST /message` でメッセージを送信します
- サーバーは `endpoint` イベントで POST 先 URL を通知します
- Figma Desktop MCP など、既存実装の一部はこちらを使っています

### 新仕様（2025-03-26）: Streamable HTTP

- [仕様](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/#streamable-http)
- 単一の MCP endpoint を中心に扱う設計です
- `POST /mcp` で JSON-RPC メッセージを送信します
- レスポンスは `Content-Type` に応じて変わります
  - `application/json` なら単一レスポンス
  - `text/event-stream` ならストリーミングレスポンス
- `Mcp-Session-Id` ヘッダーでセッションを管理します
- 必要に応じて `GET /mcp` の SSE でサーバー起点メッセージを受け取れます

## 副産物として見えた、ツール定義のトークンコスト

ここまではプロトコル実装の話でしたが、ベンチマークを作る過程で、**チャットツールやコーディングエージェントのような MCP クライアントが、ツール定義を LLM に渡すときのコスト**も見えてきました。ツールの `name`、`description`、`inputSchema` は入力トークンとして効いてきます。

今回は `@anthropic-ai/tokenizer` を使って、Claude API に渡す `tools` 定義 JSON の概算トークン数を測りました。Anthropic 側の固定 tool-use system prompt 分はこの数字には含めていません。

### filesystemサーバー（14ツール）

| ツール         | トークン  |
| -------------- | --------- |
| read_text_file | 192       |
| edit_file      | 172       |
| search_files   | 157       |
| ...            | ...       |
| **合計**       | **1,735** |

今回は実測できたものだけを並べると、次のようになりました。

```
@modelcontextprotocol/server-filesystem   14ツール   1,735 tokens
Figma Dev Mode MCP Server                 10ツール   4,702 tokens
```

2026年4月7日時点の公開価格を前提に、たとえば Figma の 4,702 tokens が毎回入力に乗るとすると、月 1,000 会話で単純計算したコストは次のようになります。

| モデル           | 料金             | 月コスト |
| ---------------- | ---------------- | -------- |
| claude-sonnet-4  | $3 / 1M tokens   | ~$14.1   |
| claude-opus-4.1  | $15 / 1M tokens  | ~$70.5   |
| claude-haiku-3.5 | $0.8 / 1M tokens | ~$3.8    |

つまり、MCP サーバーを有効にしているだけで、そのサーバーが持つツール定義ぶんの入力トークンが会話ごとに増えます。ツール数の多いサーバーを複数つなぐほど、見えにくい形でコストが積み上がっていきます。

## 公式Inspectorとの違い

|                | 公式Inspector   | このツール   |
| -------------- | --------------- | ------------ |
| UI             | ブラウザ（GUI） | CLI          |
| 生JSON-RPC表示 | 一部            | 全メッセージ |
| `raw` コマンド | ❌              | ✅           |
| トークン計測   | ❌              | ✅           |
| SDK非依存実装  | ❌              | ✅           |

普通に公開されているMCPServerの検証などであれば、公式 Inspector で十分ですが、プロトコルの流れや、クライアント側に何が求められているかを理解したい場面では、自作したツールのほうが見えやすい部分がありました。

## まとめ

- MCP の見た目はシンプルですが、クライアント側にも実装責務があります
- `tools/call` だけ見ていると分かりにくいですが、`roots/list` のようにサーバーからクライアントへ来るリクエストもあります
- HTTP トランスポートは旧 SSE と新 Streamable HTTP が混在していて、実装上の考慮点がまだ多いです
- チャットツールやコーディングエージェントのように、MCP クライアントがツール定義を LLM に渡す場合は、その定義自体が入力トークンコストになります

コードはこちら: https://github.com/watabean/mcp-protocol-inspector
