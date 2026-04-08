# MCP Inspector CLI

MCPサーバーとの通信を生のJSON-RPCレベルで可視化する対話型CLIツール。

```
[SEND →] {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
[RECV ←] {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}

mcp> list tools
[SEND →] {"jsonrpc":"2.0","id":2,"method":"tools/list"}
[RECV ←] {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
```

## セットアップ

```bash
npm install
```

## 起動

```bash
npm run inspect -- --server "<MCPサーバーの起動コマンド>"
```

### 例: filesystemサーバー（/tmp を公開）

```bash
npm run inspect -- --server "npx @modelcontextprotocol/server-filesystem /tmp"
```

初回は `npx` がパッケージをダウンロードするため少し時間がかかります。

### 例: 起動済みのHTTPサーバーに接続 (SSE)

Figma Desktop など、ローカルで動いている MCP サーバーへ接続できます。

```bash
# Figma Desktop MCP (デフォルトポート 3845)
npm run inspect -- --url http://localhost:3845

# その他の SSE サーバー
npm run inspect -- --url http://localhost:3000
```

### 例: Streamable HTTP サーバーに接続 (新仕様)

```bash
npm run inspect -- --url http://localhost:3000 --streamable
```

### 例: Atlassian MCP に接続 (OAuth 2.1)

Atlassian はブラウザ認証を使います。最初の接続時に認可 URL を開き、`localhost` callback で code を受け取って token を保存します。

事前に Atlassian OAuth app の client 情報を環境変数で設定してください。

```bash
export ATLASSIAN_OAUTH_CLIENT_ID="<client-id>"
export ATLASSIAN_OAUTH_CLIENT_SECRET="<client-secret>"
# 必要なら scope も指定
export ATLASSIAN_OAUTH_SCOPES="offline_access"

npm run inspect -- --url https://mcp.atlassian.com/v1/mcp --streamable
```

現在の Streamable HTTP 実装は、`POST /mcp` の JSON / SSE レスポンスと `Mcp-Session-Id` を扱います。
仕様上オプションの `GET /mcp` によるサーバー起点 SSE ストリームは未実装です。

## ベンチマーク

```bash
npm run benchmark -- --server "<MCPサーバーの起動コマンド>"
```

### 例: filesystem サーバーの tool 定義を計測

```bash
npm run benchmark -- --server "node /path/to/server-filesystem/dist/index.js /tmp"
```

`roots/list` にも応答するため、filesystem サーバーのようにクライアント側 capability を使うサーバーでもそのまま計測できます。

### 例: Figma Desktop MCP を計測

```bash
npm run benchmark -- --url http://127.0.0.1:3845
```

### 例: Atlassian MCP を計測

```bash
export ATLASSIAN_OAUTH_CLIENT_ID="<client-id>"
export ATLASSIAN_OAUTH_CLIENT_SECRET="<client-secret>"
export ATLASSIAN_OAUTH_SCOPES="offline_access"

npm run benchmark -- --url https://mcp.atlassian.com/v1/mcp --streamable
```

## コマンド

| コマンド | 説明 |
|---------|------|
| `list tools` | ツール一覧を取得 |
| `count tokens` | Claude 向け tools 定義 JSON の概算トークン数を表示 |
| `call <tool> [json]` | ツールを呼び出す |
| `raw <json>` | 生のJSON-RPCを直接送信 |
| `help` | コマンド一覧を表示 |
| `exit` | 終了 |

### call の例

```
mcp> call list_directory {"path":"/tmp"}
mcp> call read_text_file {"path":"/tmp/test.txt"}
mcp> call list_allowed_directories
```

### raw の例（任意のJSON-RPCを送れる）

```
mcp> raw {"jsonrpc":"2.0","id":99,"method":"tools/list"}
mcp> raw {"jsonrpc":"2.0","id":100,"method":"resources/list"}
```

## 注目ポイント

`roots` capability を宣言すると、起動直後にサーバーから `roots/list` リクエストが飛んでくることがある。
MCPはクライアント→サーバーだけでなく、サーバー→クライアントへのリクエストも発生する双方向プロトコル。

```
[RECV ←] {"method":"roots/list","jsonrpc":"2.0","id":0}
```

## 注意事項

- `count tokens` は Claude に渡す `tools` 定義 JSON の概算です。Anthropic 側の固定 tool-use system prompt 分は含みません。
- `--server` はクォート付き引数を扱えるようにしてありますが、複雑なシェル展開やパイプはサポートしません。
- Atlassian MCP の OAuth 2.1 は、現時点では手元で用意した OAuth client (`ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET`) を前提にしています。
- OAuth token は `~/.config/mcp-inspector/auth.json` に保存され、次回以降は再利用されます。
