# 3D Tiles Draco Worker Plan

## Background

`ThreeDTileset` の `KHR_draco_mesh_compression` 対応では、worker 上の Draco decode で
`memory access out of bounds` が発生するケースがある。

同じ payload は main thread fallback では decode できるため、3D Tiles データ破損よりも
`worker 上の Draco runtime / 初期化方式 / worker lifecycle` が不安定な可能性が高い。

検証用の固定データは以下を使う。

- `https://d2i4mp1qrenve.cloudfront.net/data/admin/3d_model/BIM%EF%BC%8FCIM/onga_kakoseki/tileset.json`


## Cesium Comparison

Cesium は以下の構成になっている。

- `packages/engine/Source/Workers/decodeDraco.js`
  - Draco decode 専用 worker
- `packages/engine/Source/Scene/DracoLoader.js`
  - worker を直接触らず `TaskProcessor` 経由で task を投げる
- `packages/engine/Source/Core/TaskProcessor.js`
  - worker の生成、WASM 初期化、task の多重化を管理する

重要なのは、Cesium では Draco decode を「専用 worker モジュール」として分離し、
初期化 (`initWebAssemblyModule`) と decode task を分けている点である。


## Current Hypothesis

現状の mapray は `ThreeDTileset.ts` の中で Draco mesh worker を blob worker として動的生成している。
この方式は次の点で Cesium より不利である。

- worker 初期化と decode 実行が密結合
- Draco runtime の再利用/破棄の境界が曖昧
- fatal trap 後の worker 再利用を防ぎにくい
- build / packaging 上の worker path 管理が ad-hoc


## Goal

以下を満たす構成へ寄せる。

- Draco decode を専用 worker に隔離する
- worker 初期化と decode task を分離する
- fatal trap 後は worker を再利用しない
- worker が使えない環境では main thread fallback を維持する
- 固定 tileset で反復検証できる


## Implemented In This Branch

このブランチでは、まず安全性を優先して以下を実装済み。

1. worker decode が失敗した primitive は main thread decode に自動フォールバックする
2. worker へ transfer した payload と fallback 用 payload を分離し、二次破損を防ぐ
3. `memory access out of bounds` を起こした Draco mesh worker pool は無効化し、以後は fallback を使う
4. `debug/3dtiles` の smoke test で固定 tileset を使って反復検証できる
5. blob worker をやめ、`src/workers/ThreeDTilesDracoDecoderWorker.ts` の専用 worker ファイルを使う構成へ移行した
6. worker 初期化 (`init`) と decode task (`decodePrimitive`) を分離した
7. `debug/3dtiles` build で専用 worker を `vendor/ThreeDTilesDracoDecoderWorker.js` へ自動配置するようにした

この時点で「表示が止まらない」ことに加えて、Cesium に近い dedicated worker 構成へ移行できている。


## Next Steps

### Phase 1: Dedicated Worker Module

Status: Completed

Cesium に寄せる本命対応。

- `ThreeDTileset` 内の blob worker 実装をやめる
- Draco decode 専用 worker ファイルを追加する
- worker は初回メッセージで Draco runtime を初期化する
- decode task は初期化完了後のみ受け付ける


### Phase 2: Worker URL / Packaging

Status: Completed

- worker script URL を `ThreeDTileset` 本体から安定して解決できるようにする
- browser build / debug build で同じ worker を使えるようにする
- Google Draco browser runtime (`draco_wasm_wrapper.js` / `draco_decoder.wasm`) の参照を整理する


### Phase 3: Verification

Status: In progress

- smoke test で `ready` だけでなく `worker path / fallback count / fatal trap count` を確認できるようにする
- `onga_kakoseki` を固定ケースとして使う
- Cesium と同じ payload で decode 成否を比較できるログを残す


## Acceptance Criteria

- `onga_kakoseki` で `status: ready` になる
- worker で trap が出ても表示は継続する
- 同じ trap を何度も繰り返さない
- worker 使用時と fallback 使用時を debug 上で区別できる


## Current Result

以下はこのブランチで確認済み。

- `yarn --cwd packages/mapray build-devel`
- `yarn --cwd debug/3dtiles build`
- `yarn --cwd debug/3dtiles smoke`

固定検証データ `onga_kakoseki` では `status: ready` を確認済み。


## Commands

```bash
yarn --cwd packages/mapray build-devel
yarn --cwd debug/3dtiles build
yarn --cwd debug/3dtiles smoke
```
