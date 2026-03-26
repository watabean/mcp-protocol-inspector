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

## コマンド

| コマンド | 説明 |
|---------|------|
| `list tools` | ツール一覧を取得 |
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

起動直後、サーバーから `roots/list` リクエストが飛んでくることがある。
MCPはクライアント→サーバーだけでなく、サーバー→クライアントへのリクエストも発生する双方向プロトコル。

```
[RECV ←] {"method":"roots/list","jsonrpc":"2.0","id":0}
```
