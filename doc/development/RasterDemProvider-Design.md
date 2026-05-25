# RasterDemProvider 設計書

## 1. 目的

`RasterDemProvider` は、画像タイルやラスター標高データを mapray の DEM パイプラインで利用できる `DemProvider` として提供する。

初期実装は Z/X/Y URL で配信される PNG タイルを対象とし、Terrain-RGB、Terrarium、Signed RGB 形式でエンコードされた標高値を mapray DEM バイナリ互換の `ArrayBuffer` に変換する。PMTiles は初期実装に含めず、後続で取得元ラッパーとして追加できる設計にする。

## 2. 背景

現在の mapray は `Viewer.Option.dem_provider` に任意の `DemProvider` を指定できる。Mapray Cloud の地形データは `CloudDemProvider` が `.bin` を取得し、`DemBinary` がそのバイナリを読み取る。地形メッシュ生成では `DemBinary.newSampler()` から標高をサンプリングし、`FlakeMesh` が頂点位置と `a_height` を生成する。

既存の `StandardDemProvider` は `/{z}/{x}/{y}.bin` のような mapray DEM バイナリ配信には対応するが、Terrain-RGB、Terrarium、Signed RGB などの画像標高ソースは直接扱えない。

画像標高タイルは、ブラウザで `ImageData` に変換し、RGB から標高 `Float32Array` を生成できる。mapray では、生成した標高グリッドを mapray DEM バイナリに詰めれば既存の地形描画経路を再利用できる。

## 3. 対象範囲

### 3.1 In Scope

- `RasterDemProvider` の公開 API 設計
- Z/X/Y URL PNG タイルの取得
- ブラウザ画像デコードによる `ImageData` 取得
- Terrain-RGB、Terrarium、Signed RGB の標高デコード
- `Float32Array` 高さグリッドから mapray DEM バイナリ互換 `ArrayBuffer` への変換
- 欠損タイルのフラット標高フォールバック
- `CloudDemProvider`、`StandardDemProvider`、`FlatDemProvider` との互換性維持
- PMTiles を後続で追加できる内部責務分離

### 3.2 Out of Scope

- PMTiles からの読み取り実装
- DEM データのサーバーサイド変換ツール
- 地形シェーダー差し替え API

## 4. 命名方針

クラス名は `RasterDemProvider` とする。

| 候補 | 採否 | 理由 |
| --- | --- | --- |
| `RasterDemProvider` | 採用 | PNG タイルや PMTiles 内の画像標高タイルを含む拡張に耐える。取得元とエンコード方式を名前に固定しない。 |
| `TerrainRgbDemProvider` | 不採用 | Terrain-RGB 固定に見える。Terrarium や float 系に拡張しづらい。 |
| `PngDemProvider` / `StandardPngDemProvider` | 不採用 | PNG 固定に見える。PMTiles など取得元の拡張に弱い。 |
| `ImageDemProvider` | 不採用 | PNG には合うが、PMTiles コンテナを含めると狭い。 |
| `EncodedDemProvider` | 不採用 | エンコード方式に寄りすぎ、取得元の抽象を表しにくい。 |

## 5. 基本方針

`RasterDemProvider` は取得元、標高デコード、mapray DEM バイナリ生成を分離する。

```text
RasterDemProvider
  -> RasterDemSource
      -> ZxyImageSource
      -> future: PmtilesSource
  -> RasterDemDecoder
      -> TerrainRgbDecoder
      -> TerrariumDecoder
      -> SignedRgbDecoder
      -> future: Gray16Decoder
      -> future: Float32Decoder
  -> MaprayDemBinaryBuilder
```

初期実装では `RasterDemProvider` が `DemProvider` を継承し、内部 `Hook` が `source.fetchTile()`、`decoder.decode()`、`MaprayDemBinaryBuilder.build()` を順に実行する。

## 6. 公開 API

### 6.1 最小利用例

```ts
const demProvider = new mapray.RasterDemProvider({
    source: {
        type: "zxy",
        url: "https://example.com/terrain/{z}/{x}/{y}.png"
    },
    encoding: {
        type: "terrain-rgb"
    }
});

const viewer = new mapray.Viewer( container, {
    dem_provider: demProvider
});
```

### 6.2 Terrarium 利用例

```ts
const demProvider = new mapray.RasterDemProvider({
    source: {
        type: "zxy",
        url: "https://example.com/terrarium/{z}/{x}/{y}.png",
        y_origin: "xyz"
    },
    encoding: {
        type: "terrarium"
    }
});
```

### 6.3 Signed RGB PNG 利用例

```ts
const demProvider = new mapray.RasterDemProvider({
    source: {
        type: "zxy",
        url: "https://tiles.gsj.jp/tiles/elev/mixed/{z}/{y}/{x}.png"
    },
    encoding: {
        type: "signed-rgb"
    },
    max_zoom: 17
});
```

### 6.4 型定義案

```ts
namespace RasterDemProvider {

export interface Option {
    source: SourceOption;
    encoding: EncodingOption;
    max_zoom?: number;
    request_limit?: number;
    missing_tile_height?: number;
    headers?: HeadersInit;
    credentials?: CredentialMode;
}

export type SourceOption =
    | ZxySourceOption
    | CustomSourceOption;

export interface ZxySourceOption {
    type: "zxy";
    url: string;
    y_origin?: "xyz" | "tms";
}

export interface CustomSourceOption {
    type: "custom";
    fetchTile: ( z: number, x: number, y: number, options?: { signal?: AbortSignal } ) => Promise<RasterTileData>;
}

export type RasterTileData =
    | ImageBitmap
    | HTMLImageElement
    | HTMLCanvasElement
    | ImageData
    | ArrayBuffer;

export type EncodingOption =
    | { type: "terrain-rgb"; scale?: number; offset?: number; invalid_height?: number; invalid_fill?: InvalidFillMode; }
    | { type: "terrarium"; invalid_height?: number; invalid_fill?: InvalidFillMode; }
    | { type: "signed-rgb"; invalid_height?: number; invalid_fill?: InvalidFillMode; }
    | { type: "custom"; decode: RasterDecodeFunction; };

export type InvalidFillMode = "height" | "nearest" | "ancestor";

export type RasterDecodeFunction = ( image: ImageData, context: DecodeContext ) => Float32Array | HeightGrid;

export interface HeightGrid {
    width: number;
    height: number;
    heights: Float32Array;
}

export interface DecodeContext {
    z: number;
    x: number;
    y: number;
    resolution_power: number;
}

}
```

初期実装では `source.type = "zxy"` と `source.type = "custom"` のみを扱う。`pmtiles` は `SourceOption` の後続追加とし、初期 API には含めない。

## 7. 処理フロー

### 7.1 初期化

1. `RasterDemProvider.Hook.init()` は `resolution_power` を確定する。
2. `resolution_power` は `8` 固定とし、mapray の DEM サンプル数 `(2^rho + 1)^2` に使う。
3. `max_zoom` の既定値は `15` とする。
4. `request_limit` の既定値は `16` とし、`DemProvider.Info` を通じて `Globe` の DEM 取得並列数に反映する。
5. `max_zoom` は qlevel の上限計算に使う。
6. `missing_tile_height` が未指定の場合、タイルが存在しないときは `requestTile()` を reject する。
7. `missing_tile_height` が指定されている場合、タイル取得失敗時は指定標高で埋めたフラット DEM バイナリを返す。

### 7.2 タイル取得

1. `requestTile(z, x, y, options)` は `source.fetchTile(z, x, y, options)` を呼ぶ。
2. `zxy` source は URL 内の `{z}`、`{x}`、`{y}`、`{reverseY}` を置換する。
3. `y_origin = "xyz"` の場合、`{y}` は入力 `y` を使用する。
4. `y_origin = "tms"` の場合、`{y}` は `2^z - y - 1` を使用する。
5. `{reverseY}` は常に `2^z - y - 1` とする。
6. 取得に成功した画像タイルは内部 LRU に `z/x/y` キーでキャッシュし、隣接境界補完で取得済みのタイルを次回の current tile として再利用する。
7. HTTP エラー、ネットワークエラー、abort は `requestTile()` の reject として扱う。失敗や abort はキャッシュしない。

### 7.3 画像デコード

1. `ArrayBuffer` で取得した PNG は `Blob` と `createImageBitmap()`、または `HTMLImageElement` と canvas を使って `ImageData` に変換する。
2. `ImageBitmap`、`HTMLImageElement`、`HTMLCanvasElement` は canvas に描画して `ImageData` を取得する。
3. `ImageData` が入力された場合、canvas 変換は行わない。
4. canvas のサイズは画像の実サイズを使う。
5. CORS により canvas が tainted になった場合はデコード失敗として reject する。

### 7.4 標高デコード

Terrain-RGB は次の式で標高メートルに変換する。

```ts
height = ( r * 256 * 256 + g * 256 + b ) * scale + offset
```

`terrain-rgb` の既定値は `scale = 0.1`、`offset = -10000` とする。

Terrarium は次の式で標高メートルに変換する。

```ts
height = r * 256 + g + b / 256 - 32768
```

Signed RGB は次の式で標高メートルに変換する。

```ts
signedR = r < 128 ? r : r - 256
height = ( 65536 * signedR + 256 * g + b ) * 0.01
```

`alpha = 0` の画素は狭域の no-data として扱う。この扱いは Terrain-RGB、Terrarium、Signed RGB に共通とする。既定では `invalid_height` が指定されていればその値、未指定なら `0` に変換する。`invalid_fill = "nearest"` が指定された場合は、透明画素を周囲の有効標高で埋める。`invalid_fill = "ancestor"` が指定された場合は、まず低ズーム親タイルから対応する標高をサンプリングし、親タイルでも埋められない場合に周囲の有効標高または `invalid_height` を使う。

JPEG と WebP は初期実装の対象外とする。Terrain-RGB や Terrarium のように RGB 値そのものを標高として使うエンコードでは、非可逆圧縮による標高誤差が発生するため、初期実装では PNG のみをサポートする。

### 7.5 mapray DEM バイナリ生成

`MaprayDemBinaryBuilder` は、`Float32Array` の標高グリッドから `DemBinary` が読める `ArrayBuffer` を生成する。

| 項目 | 値 |
| --- | --- |
| ヘッダーサイズ | 96 bytes |
| qlevel offset | 0, 1, 2, 3 |
| min height offset | 4, little endian float32 |
| max height offset | 8, little endian float32 |
| omega offset | 12, little endian float32 配列 |
| body offset | 96 |
| body 型 | little endian float32 |
| body サンプル数 | `(2^resolution_power + 1)^2` |

qlevel は `max(0, min(255, max_zoom - z))` を 4 象限に設定する。

omega は標高グリッドの範囲から 21 要素を推定する。全体、2 x 2、4 x 4 の各領域ごとに `log2(height_range + 1)` を計算し、`0 ... 6` に clamp する。これは Mapray Cloud の bin と完全同一の複雑度計算ではないが、固定値よりも地形起伏に応じた分割判断ができる。

## 8. 入力サイズと境界処理

mapray DEM は `rho = 8` の場合、257 x 257 の標高グリッドを期待する。一般的な画像タイルは 256 x 256 であるため、初期実装は次の規則で 257 x 257 を生成する。

| 入力画像サイズ | 生成規則 |
| --- | --- |
| `N x N` かつ `N = 2^rho` | 右端列と下端行を補完して `(N + 1) x (N + 1)` にする |
| `(2^rho + 1) x (2^rho + 1)` | そのまま使用する |
| その他 | エラー |

境界は常に右隣・下隣・右下タイルから補完し、DEM の右端列・下端行・右下角を上書きする。隣接タイルが取得できない場合は、該当境界だけ自タイルの端コピーにフォールバックする。

## 9. 既存コンポーネントとの関係

| コンポーネント | 変更方針 |
| --- | --- |
| `DemProvider` | `Info.request_limit` を追加し、provider ごとの DEM 取得並列数を指定できるようにする。 |
| `DemBinary` | 変更しない。互換 `ArrayBuffer` を生成して既存実装に渡す。 |
| `Globe` | `request_limit` を利用し、provider ごとの並列取得数を反映する。dispose 済み flake への非同期完了でも assertion にならないようにする。 |
| `FlakeMesh` | 変更しない。標高サンプリングとメッシュ生成は既存実装を使う。 |
| `CloudDemProvider` | 変更しない。Mapray Cloud 利用者への挙動変更はない。 |
| `StandardDemProvider` | 変更しない。mapray DEM `.bin` 配信向けとして残す。 |
| `FlatDemProvider` | 変更しない。DEM バイナリ生成時の参考実装として扱う。 |

## 10. エラー処理

| 失敗条件 | システム応答 | リトライ | ログ |
| --- | --- | --- | --- |
| HTTP 404 / 410 | `requestTile()` を reject する | provider 内では行わない | `console.warn` は初期実装では行わない。呼び出し側の既存 DEM 失敗処理に委ねる。 |
| HTTP 5xx | `requestTile()` を reject する | provider 内では行わない | 同上 |
| ネットワークタイムアウト | fetch が reject する | provider 内では行わない | 同上 |
| AbortSignal abort | fetch または decode を中断し reject する | 行わない | ログ出力しない |
| 画像デコード失敗 | `requestTile()` を reject する | 行わない | 同上 |
| CORS による canvas taint | `requestTile()` を reject する | 行わない | 同上 |
| 未対応画像サイズ | `requestTile()` を reject する | 行わない | 同上 |
| 未対応 encoding | constructor または `init()` で例外 | 行わない | 同上 |

既存の `Globe` は DEM タイル取得失敗時に該当 flake の DEM 状態を failed にする。`RasterDemProvider` は既存の失敗経路を変えない。

## 11. セキュリティと権限

- `headers` と `credentials` は `StandardDemProvider` と同様に source の fetch に渡す。
- API キーを URL に含める場合、`RasterDemProvider` は秘匿処理を行わない。
- canvas で画像を読むため、クロスオリジン画像は適切な CORS ヘッダーを返す必要がある。
- `custom` source は任意コードを実行できるため、信頼済みアプリケーションコードからのみ指定する。

## 12. パフォーマンス方針

- 画像タイル 256 x 256、`rho = 8` の場合、標高 body は 257 x 257 x 4 bytes、約 264 KiB になる。
- `requestTile()` ごとに canvas 描画、`ImageData` 取得、`Float32Array` 作成、`ArrayBuffer` 作成が発生する。
- 隣接境界補完で取得した画像タイルは内部 LRU キャッシュで再利用し、同じ画像タイルの再取得を抑える。

## 13. テスト計画

### 13.1 Unit

- Terrain-RGB デコード式が既知 RGB 値から期待標高を返すこと。
- Terrarium デコード式が既知 RGB 値から期待標高を返すこと。
- Signed RGB デコード式が既知 RGBA 値から期待標高を返すこと。
- `alpha = 0` の画素が `invalid_height` に変換されること。
- `invalid_fill = "nearest"` の場合、`alpha = 0` の画素が周辺の有効標高で補完されること。
- `invalid_fill = "ancestor"` の場合、`alpha = 0` の画素または欠損タイルが低ズーム親タイルで補完されること。
- 256 x 256 入力から 257 x 257 グリッドが生成されること。
- 右端列と下端行が複製されること。
- 右端列・下端行・右下角が隣接タイル由来の標高で補完されること。
- min/max height が DEM ヘッダーに little endian float32 で書き込まれること。
- qlevel が `max_zoom - z` で書き込まれること。
- `missing_tile_height` 指定時、取得失敗タイルがフラット DEM として返ること。
- omega が標高範囲から `0 ... 6` の値として書き込まれること。
- body が row-major で little endian float32 として書き込まれること。
- 未対応画像サイズで reject すること。
- abort 時に `requestTile()` が reject すること。

### 13.2 Integration

- `Viewer` に `RasterDemProvider` を指定して地形が表示されること。
- `Viewer.getElevation()` が Terrain-RGB から変換された標高に近い値を返すこと。
- `ContourLayer` が `RasterDemProvider` 由来の `a_height` で描画されること。
- `CloudDemProvider` と `StandardDemProvider` の既存サンプルが壊れないこと。

### 13.3 Manual / E2E

- Terrain-RGB PNG タイルで地形起伏が表示されること。
- Terrarium PNG タイルで地形起伏が表示されること。
- GSJ シームレス標高タイルで地形起伏が表示されること。
- CORS 不備のタイルで明示的に失敗すること。

## 14. リリース方針

1. `RasterDemProvider` を追加し、`packages/mapray/src/index.ts` から export する。
2. 既存の `CloudDemProvider` と `StandardDemProvider` は非推奨にしない。
3. debug には Mapray Cloud、Terrain-RGB、Signed RGB、Flat を切り替えられる DEM 確認画面を追加する。
4. ドキュメントには初期実装が PNG のみを対象にすることを明記する。
5. 問題が発生した場合、利用者は `dem_provider` を既存 provider に戻せる。

## 15. 後続拡張

| 拡張 | 追加箇所 | 方針 |
| --- | --- | --- |
| PMTiles | `RasterDemSource` | `source.type = "pmtiles"` を追加し、取得した tile payload を既存 decoder に渡す。 |
| Gray16 | `RasterDemDecoder` | 16bit グレースケールを標高へ変換する decoder を追加する。 |
| Float32 raster | `RasterDemDecoder` | float32 payload から height grid を生成する decoder を追加する。 |
| WebP / JPEG | ZXY image source | lossless または品質管理されたデバッグ用途のみ候補とする。lossy は標高値が変わるため DEM には非推奨とする。 |
| qlevel/omega 推定精度向上 | builder | source の availability metadata や Cloud bin と同等の複雑度計算に近づける。 |

## 16. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| 隣接境界タイルが取得できない | 該当境界で不連続が残る可能性がある | 取得できた境界だけ隣接補完し、取得できない境界は端コピーにフォールバックする。 |
| PNG 以外の画像形式を誤って指定する | 画像デコードに失敗する、または標高値が不正確になる | 初期実装では PNG のみをサポート対象として明記する。 |
| canvas CORS 制約 | 外部タイルを読み取れない | CORS 要件をドキュメント化する。 |
| omega 推定が Cloud bin と一致しない | Mapray Cloud と分割密度が完全には一致しない | 初期実装ではレンジベースの安定した推定にし、必要なら後続で精度を上げる。 |

## 17. Open Questions

- examples に使用できる公開 Terrain-RGB / Terrarium タイルソースをどれにするか。
