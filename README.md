# mapray-js fork

この fork では npm registry には公開せず、GitHub Release に添付した固定名の package tarball を使います。

## Install

`package.json` に書く場合:

```json
{
  "dependencies": {
    "@mapray/mapray-js": "https://github.com/TakamuneSuda/mapray-js/releases/download/v0.9.6-fork.3/mapray-mapray-js.tgz",
    "@mapray/ui": "https://github.com/TakamuneSuda/mapray-js/releases/download/v0.9.6-fork.3/mapray-ui.tgz"
  }
}
```

core のみを `npm install` する場合:

```bash
npm install https://github.com/TakamuneSuda/mapray-js/releases/download/v0.9.6-fork.3/mapray-mapray-js.tgz
```

ui も使う場合:

```bash
npm install \
  https://github.com/TakamuneSuda/mapray-js/releases/download/v0.9.6-fork.3/mapray-mapray-js.tgz \
  https://github.com/TakamuneSuda/mapray-js/releases/download/v0.9.6-fork.3/mapray-ui.tgz
```

## Release

1. `packages/mapray/package.json` と `packages/ui/package.json` の `version` を揃える
2. その version に対応する tag を `v0.9.6-fork.3` のように作る
3. GitHub Release を作成する

Release 作成時に [release_package_assets.yml](/Users/takamunesuda/develop/mapray-js-fork/.github/workflows/release_package_assets.yml) が動いて、`mapray-mapray-js.tgz` と `mapray-ui.tgz` を添付します。

## Local Build

```bash
yarn install
yarn mapray
yarn ui
yarn css
```
