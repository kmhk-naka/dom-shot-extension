# DOM Shot Extension

Inspector風にDOM要素を選択し、選択要素のフルサイズ画像（要素内スクロールを含む）をPNGで保存するChrome拡張です。

この拡張はキャプチャ画像をローカルで生成し、Chrome のダウンロード機能で保存します。外部サーバーへの送信は行いません。

## Requirements

- `mise`
- `node` / `pnpm`（`mise.toml` で固定）

## Setup

```bash
git clone <your-fork-or-repo-url>
cd dom-shot-extension
mise install
mise run install
mise run build
mise run package
```

`mise run package` 実行後、プロジェクトルートに `dom-shot-extension.zip` が生成されます。

`mise` を使わない場合:

```bash
pnpm install
pnpm build
pnpm package
```

## Load Extension (Chrome / Vivaldi)

1. `chrome://extensions` または `vivaldi://extensions` を開く
2. `デベロッパーモード` をONにする
3. `パッケージ化されていない拡張機能を読み込む` を選択
4. このリポジトリの `dist/` ディレクトリを指定

## Usage

1. ツールバーの拡張アイコンをクリック
2. ページ上で要素にマウスを合わせるとハイライトとヒントが表示
3. 対象要素をクリックしてキャプチャ開始
4. PNGが自動ダウンロードされる
5. `Esc` で選択モードを中止

## Permissions / Data Handling

- `activeTab`: ユーザーが拡張アイコンを押した現在のタブだけを対象にします
- `host_permissions: <all_urls>`: `chrome.tabs.captureVisibleTab()` を安定して実行するために使用します
- `scripting`: 対象ページへ選択UIとキャプチャ処理を注入します
- `downloads`: 生成したPNGをローカルへ保存します
- 外部通信: なし
- 保存先: ブラウザの通常のダウンロード先

## Notes / Limitations (v1)

- `iframe` と `Shadow DOM` は対象外
- `chrome://` などの保護ページでは実行不可
- `file://` で `example_target.html` を開いて試す場合は、拡張詳細画面で `ファイルの URL へのアクセスを許可する` を有効にする必要があります
- 極端に大きい要素はキャンバス制限で失敗する場合あり
