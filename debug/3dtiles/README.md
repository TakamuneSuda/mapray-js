# mapray-3dtiles

`tileset.json` を指定して 3D Tiles runtime を確認するための最小 debug アプリです。

## 方針

- 既存の `debug/b3dtile` とは分ける
- `tileset.json` は URL 入力欄か query string で指定する
- API トークンはソースに書かない
- `.env` かシェルの環境変数から設定を読む

## 使う環境変数

`.env.example` を `.env` にコピーして値を入れてください。

```bash
cp .env.example .env
```

必要な値は次です。

```bash
MAPRAY_ACCESS_TOKEN=
```

補足:

- `MAPRAY_ACCESS_TOKEN`
  地形 DEM の表示に使います。

## 起動

リポジトリルートで `mapray` と `ui` を build してから、debug アプリを起動します。

```bash
yarn mapray-devel
yarn ui-devel
yarn workspace @mapray/ui css
yarn --cwd debug/3dtiles install
yarn --cwd debug/3dtiles build
yarn --cwd debug/3dtiles start
```

ブラウザで `http://localhost:7776/` を開きます。

## Smoke Test

headless Chromium で `3dtiles` debug を起動して、`ready / error / console error` を自動確認できます。

初回だけ browser を入れます。

```bash
yarn --cwd debug/3dtiles smoke:setup
```

既定では、検証用の `onga_kakoseki` tileset を読みます。

```bash
yarn --cwd debug/3dtiles smoke
```

別の tileset を使う場合は `TILESET_URL` を指定します。

```bash
TILESET_URL=https://example.com/tileset.json yarn --cwd debug/3dtiles smoke
```

smoke test は `?smoke=1` 付きで debug ページを開き、headless 環境で不安定になりやすい atmosphere / sun visualizer を無効化して、3D Tiles のロード確認に集中します。

## 使い方

- 上部入力欄に `tileset.json` の URL を入れて `Load`
- または query string で指定

```text
http://localhost:7776/?tileset=https%3A%2F%2Fexample.com%2Ftileset.json
```

`pnts` で Draco decode が必要な場合は、現在の debug build では明示的にエラーになります。

## Key binding

- `m`
  wireframe の切り替え
- `r`
  現在の `tileset.json` を再読み込み
