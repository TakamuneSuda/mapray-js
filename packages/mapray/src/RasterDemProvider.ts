import DemProvider from "./DemProvider";
import CredentialMode from "./CredentialMode";


/**
 * ラスター DEM プロバイダ
 *
 * Z/X/Y 形式で配信される PNG 標高タイルを読み込み、mapray DEM バイナリに
 * 変換してレンダラーに供給する。
 */
class RasterDemProvider extends DemProvider {

    constructor( option: RasterDemProvider.Option )
    {
        super( new RasterDemProvider.Hook( option ) );
    }

}



namespace RasterDemProvider {



export class Hook implements DemProvider.Hook {

    private readonly _source: Source;

    private readonly _encoding: EncodingOption;

    private readonly _resolution_power: number;

    private readonly _max_zoom: number;

    private readonly _request_limit: number;

    private readonly _missing_tile_height?: number;

    private readonly _tile_cache: RasterTileCache;


    constructor( option: Option )
    {
        this._resolution_power = DEFAULT_RESOLUTION_POWER;
        this._max_zoom         = option.max_zoom ?? DEFAULT_MAX_ZOOM;
        this._request_limit    = option.request_limit ?? DEFAULT_REQUEST_LIMIT;
        this._missing_tile_height = option.missing_tile_height;
        this._encoding         = option.encoding;

        if ( this._max_zoom < 0 ) {
            throw new Error( "max_zoom must be greater than or equal to 0" );
        }
        if ( this._request_limit < 1 ) {
            throw new Error( "request_limit must be greater than or equal to 1" );
        }
        this._tile_cache = new RasterTileCache();
        if ( option.source.type === "zxy" ) {
            this._source = new ZxySource( option.source, {
                headers:     option.headers,
                credentials: option.credentials ?? CredentialMode.OMIT,
            } );
        }
        else {
            this._source = new CustomSource( option.source );
        }
    }


    init(): Promise<DemProvider.Info>
    {
        return Promise.resolve( {
            resolution_power: this._resolution_power,
            request_limit:    this._request_limit,
        } );
    }


    async requestTile( z: number, x: number, y: number, options?: { signal?: AbortSignal } ): Promise<ArrayBuffer>
    {
        let tile: RasterTileData;
        try {
            tile = await this._fetchTile( z, x, y, options );
        }
        catch ( err ) {
            if ( options?.signal?.aborted ) {
                throw err;
            }
            const ancestorHeights = await this._createHeightsFromAncestors( z, x, y, options );
            if ( ancestorHeights ) {
                return this._createDemBinary( ancestorHeights, z );
            }
            if ( this._missing_tile_height === undefined ) throw err;
            return this._createDemBinary( createFlatHeights( this._resolution_power, this._missing_tile_height ), z );
        }

        return await this._createNeighborBorderDem( tile, z, x, y, options );
    }


    private async _createNeighborBorderDem( tile: RasterTileData,
                                            z: number,
                                            x: number,
                                            y: number,
                                            options?: { signal?: AbortSignal } ): Promise<ArrayBuffer>
    {
        const tileCount = 1 << z;
        const hasRightTile = x + 1 < tileCount;
        const hasBottomTile = y + 1 < tileCount;
        const [image, rightTile, bottomTile, cornerTile] = await Promise.all( [
            toImageData( tile ),
            hasRightTile ? this._fetchOptionalTile( z, x + 1, y, options ) : undefined,
            hasBottomTile ? this._fetchOptionalTile( z, x, y + 1, options ) : undefined,
            hasRightTile && hasBottomTile ? this._fetchOptionalTile( z, x + 1, y + 1, options ) : undefined,
        ] );
        const heights = this._decodeTileImage( image, z, x, y );
        const ancestorFilled = new Uint8Array( heights.heights.length );
        await this._fillInvalidFromAncestors( heights, z, x, y, options, ancestorFilled );
        const right = await this._decodeOptionalTile( rightTile, z, x + 1, y );
        const bottom = await this._decodeOptionalTile( bottomTile, z, x, y + 1 );
        const corner = await this._decodeOptionalTile( cornerTile, z, x + 1, y + 1 );

        applyNeighborBorders( heights, right, bottom, corner, this._resolution_power );
        featherAncestorFilledHeights( heights.heights, heights.width, heights.height, ancestorFilled, ANCESTOR_FEATHER_PIXELS );
        if ( hasInvalidHeights( heights.heights ) ) {
            fillInvalidHeights( heights.heights, heights.width, heights.height, getInvalidHeight( this._encoding ) );
        }

        return this._createDemBinary( heights.heights, z );
    }


    private async _createHeightsFromAncestors( z: number,
                                               x: number,
                                               y: number,
                                               options?: { signal?: AbortSignal } ): Promise<Float32Array | undefined>
    {
        const size = ( 1 << this._resolution_power ) + 1;
        const heights = new Float32Array( size * size );
        heights.fill( NaN );

        await this._fillInvalidFromAncestors( {
            width: size,
            height: size,
            heights,
        }, z, x, y, options );

        if ( hasInvalidHeights( heights ) ) {
            if ( this._missing_tile_height === undefined ) return undefined;
            fillInvalidHeights( heights, size, size, this._missing_tile_height );
        }

        return heights;
    }


    private async _fillInvalidFromAncestors( target: HeightGrid,
                                             z: number,
                                             x: number,
                                             y: number,
                                             options?: { signal?: AbortSignal },
                                             ancestorFilled?: Uint8Array ): Promise<void>
    {
        if ( getInvalidFillMode( this._encoding ) !== "ancestor" || !hasInvalidHeights( target.heights ) ) {
            return;
        }

        for ( let ancestorZ = z - 1; ancestorZ >= 0 && hasInvalidHeights( target.heights ); --ancestorZ ) {
            const dz = z - ancestorZ;
            const ancestorX = x >> dz;
            const ancestorY = y >> dz;
            const tile = await this._fetchOptionalTile( ancestorZ, ancestorX, ancestorY, options );
            if ( !tile ) continue;

            const ancestor = this._decodeTileImage( await toImageData( tile ), ancestorZ, ancestorX, ancestorY );
            fillInvalidFromAncestor( target, ancestor, z, x, y, ancestorZ, ancestorX, ancestorY, this._resolution_power, ancestorFilled );
        }

        if ( hasInvalidHeights( target.heights ) ) {
            fillInvalidHeights( target.heights, target.width, target.height, getInvalidHeight( this._encoding ) );
        }
    }


    private _decodeTileImage( image: ImageData, z: number, x: number, y: number ): HeightGrid
    {
        return decodeImageData( image, this._encoding, {
            z,
            x,
            y,
            resolution_power: this._resolution_power,
        } );
    }


    private async _decodeOptionalTile( tile: RasterTileData | undefined,
                                       z: number,
                                       x: number,
                                       y: number ): Promise<HeightGrid | undefined>
    {
        if ( !tile ) return undefined;
        return this._decodeTileImage( await toImageData( tile ), z, x, y );
    }


    private _createDemBinary( heights: Float32Array, z: number ): ArrayBuffer
    {
        return createDemBinary( heights, {
            z,
            resolution_power: this._resolution_power,
            max_zoom: this._max_zoom,
        } );
    }


    private async _fetchOptionalTile( z: number,
                                      x: number,
                                      y: number,
                                      options?: { signal?: AbortSignal } ): Promise<RasterTileData | undefined>
    {
        try {
            return await this._fetchTile( z, x, y, options );
        }
        catch ( err ) {
            if ( options?.signal?.aborted ) {
                throw err;
            }
            return undefined;
        }
    }


    private async _fetchTile( z: number,
                              x: number,
                              y: number,
                              options?: { signal?: AbortSignal } ): Promise<RasterTileData>
    {
        if ( options?.signal?.aborted ) {
            throw createAbortError( options.signal.reason );
        }

        const key = createTileCacheKey( z, x, y );
        const cached = this._tile_cache.get( key );
        if ( cached !== undefined ) return cached;

        const tile = await this._source.fetchTile( z, x, y, options );
        this._tile_cache.set( key, tile );
        return tile;
    }

}



class ZxySource implements Source {

    private readonly _url: string;

    private readonly _y_origin: YOrigin;

    private readonly _headers: HeadersInit;

    private readonly _credentials: CredentialMode;


    constructor( option: ZxySourceOption,
                 request: RequestOption )
    {
        this._url         = option.url;
        this._y_origin    = option.y_origin ?? "xyz";
        this._headers     = Object.assign( {}, request.headers );
        this._credentials = request.credentials;
    }


    async fetchTile( z: number, x: number, y: number, options?: { signal?: AbortSignal } ): Promise<RasterTileData>
    {
        const response = await fetch( this._makeURL( z, x, y ), {
            headers:     this._headers,
            credentials: this._credentials,
            signal:      options?.signal,
        } );
        if ( !response.ok ) throw new Error( response.statusText );
        return await response.arrayBuffer();
    }


    private _makeURL( z: number, x: number, y: number ): string
    {
        const reverseY = Math.pow( 2, z ) - y - 1;
        const sourceY = this._y_origin === "tms" ? reverseY : y;

        return this._url
            .replace( /\{z\}/g, z.toString() )
            .replace( /\{x\}/g, x.toString() )
            .replace( /\{y\}/g, sourceY.toString() )
            .replace( /\{reverseY\}/g, reverseY.toString() );
    }

}



class CustomSource implements Source {

    private readonly _source: CustomSourceOption;


    constructor( source: CustomSourceOption )
    {
        this._source = source;
    }


    fetchTile( z: number, x: number, y: number, options?: { signal?: AbortSignal } ): Promise<RasterTileData>
    {
        return this._source.fetchTile( z, x, y, options );
    }

}


class RasterTileCache {

    private readonly _tiles = new Map<string, RasterTileData>();


    get( key: string ): RasterTileData | undefined
    {
        const tile = this._tiles.get( key );
        if ( tile === undefined ) return undefined;

        this._tiles.delete( key );
        this._tiles.set( key, tile );
        return tile;
    }


    set( key: string, tile: RasterTileData ): void
    {
        this._tiles.delete( key );
        this._tiles.set( key, tile );
        while ( this._tiles.size > TILE_CACHE_SIZE ) {
            const oldestKey = this._tiles.keys().next().value;
            if ( oldestKey === undefined ) break;
            this._tiles.delete( oldestKey );
        }
    }

}


function createTileCacheKey( z: number, x: number, y: number ): string
{
    return `${z}/${x}/${y}`;
}


type PixelDecoder = ( r: number, g: number, b: number, a: number ) => number;


function createAbortError( reason?: unknown ): Error
{
    if ( reason instanceof Error ) {
        return reason;
    }
    return new Error( typeof reason === "string" ? reason : "Raster DEM decode aborted" );
}



/**
 * 画像データを標高グリッドに変換する。
 *
 * @internal
 */
export function decodeImageData( image: ImageData,
                                 encoding: EncodingOption,
                                 context: DecodeContext ): HeightGrid
{
    if ( encoding.type === "custom" ) {
        const result = encoding.decode( image, context );
        return result instanceof Float32Array ?
            normalizeHeightGrid( result, image.width, image.height, context ) :
            normalizeHeightGrid( result.heights, result.width, result.height, context );
    }

    const invalidFillMode = getInvalidFillMode( encoding );
    const invalidHeight = getInvalidHeight( encoding );
    const decode = createPixelDecoder( encoding, invalidFillMode, invalidHeight );

    const width = image.width;
    const height = image.height;
    const pixels = image.data;
    const size = width * height;
    const heights = new Float32Array( size );

    for ( let i = 0; i < size; ++i ) {
        const p = 4 * i;
        heights[i] = decode( pixels[p], pixels[p + 1], pixels[p + 2], pixels[p + 3] );
    }

    if ( invalidFillMode === "nearest" ) {
        fillInvalidHeights( heights, width, height, invalidHeight );
    }

    return normalizeHeightGrid( heights, width, height, context );
}


function createPixelDecoder( encoding: StandardEncodingOption,
                             invalidFillMode: InvalidFillMode,
                             invalidHeight: number ): PixelDecoder
{
    switch ( encoding.type ) {
    case "terrain-rgb":
        return ( r, g, b, a ) => {
            if ( isTransparentInvalidPixel( a, invalidFillMode ) ) return NaN;
            if ( a === 0 ) return invalidHeight;

            const scale  = encoding.scale ?? 0.1;
            const offset = encoding.offset ?? -10000;
            return ( r * 256 * 256 + g * 256 + b ) * scale + offset;
        };

    case "terrarium":
        return ( r, g, b, a ) => {
            if ( isTransparentInvalidPixel( a, invalidFillMode ) ) return NaN;
            if ( a === 0 ) return invalidHeight;

            return r * 256 + g + b / 256 - 32768;
        };

    case "signed-rgb":
        return ( r, g, b, a ) => {
            if ( isTransparentInvalidPixel( a, invalidFillMode ) ) return NaN;
            if ( a === 0 ) return invalidHeight;

            const signedR = r < 128 ? r : r - 256;
            return ( 65536 * signedR + 256 * g + b ) * 0.01;
        };
    }
}


function isTransparentInvalidPixel( alpha: number, invalidFillMode: InvalidFillMode ): boolean
{
    return alpha === 0 && ( invalidFillMode === "nearest" || invalidFillMode === "ancestor" );
}


function getInvalidFillMode( encoding: EncodingOption ): InvalidFillMode
{
    return encoding.type === "custom" ? "height" : encoding.invalid_fill ?? "height";
}


function getInvalidHeight( encoding: EncodingOption ): number
{
    return encoding.type === "custom" ? 0 : encoding.invalid_height ?? 0;
}


function hasInvalidHeights( heights: Float32Array ): boolean
{
    for ( let i = 0; i < heights.length; ++i ) {
        if ( Number.isNaN( heights[i] ) ) return true;
    }
    return false;
}


function fillInvalidHeights( heights: Float32Array,
                             width: number,
                             height: number,
                             fallbackHeight: number ): void
{
    const queue: number[] = [];
    let invalidCount = 0;

    for ( let i = 0; i < heights.length; ++i ) {
        if ( Number.isNaN( heights[i] ) ) {
            ++invalidCount;
        }
        else {
            queue.push( i );
        }
    }

    if ( invalidCount === 0 ) return;
    if ( queue.length === 0 ) {
        heights.fill( fallbackHeight );
        return;
    }

    let head = 0;
    while ( head < queue.length && invalidCount > 0 ) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor( index / width );
        const value = heights[index];

        invalidCount -= fillInvalidNeighbor( heights, queue, index - 1, x > 0, value );
        invalidCount -= fillInvalidNeighbor( heights, queue, index + 1, x + 1 < width, value );
        invalidCount -= fillInvalidNeighbor( heights, queue, index - width, y > 0, value );
        invalidCount -= fillInvalidNeighbor( heights, queue, index + width, y + 1 < height, value );
    }
}


function fillInvalidNeighbor( heights: Float32Array,
                              queue: number[],
                              index: number,
                              isValidIndex: boolean,
                              value: number ): number
{
    if ( !isValidIndex || !Number.isNaN( heights[index] ) ) return 0;

    heights[index] = value;
    queue.push( index );
    return 1;
}


function fillInvalidFromAncestor( target: HeightGrid,
                                  ancestor: HeightGrid,
                                  z: number,
                                  x: number,
                                  y: number,
                                  ancestorZ: number,
                                  ancestorX: number,
                                  ancestorY: number,
                                  resolutionPower: number,
                                  ancestorFilled?: Uint8Array ): void
{
    const tileSize = 1 << resolutionPower;
    const targetSize = tileSize + 1;
    const ancestorScale = 1 << ( z - ancestorZ );
    const ancestorOriginX = ancestorX << ( z - ancestorZ );
    const ancestorOriginY = ancestorY << ( z - ancestorZ );

    validateNeighborGrid( target, targetSize );
    validateNeighborGrid( ancestor, targetSize );

    for ( let py = 0; py < targetSize; ++py ) {
        for ( let px = 0; px < targetSize; ++px ) {
            const index = py * targetSize + px;
            if ( !Number.isNaN( target.heights[index] ) ) continue;

            const ancestorU = ( ( x - ancestorOriginX ) + px / tileSize ) / ancestorScale;
            const ancestorV = ( ( y - ancestorOriginY ) + py / tileSize ) / ancestorScale;
            const height = sampleHeightGrid( ancestor, ancestorU * tileSize, ancestorV * tileSize );
            if ( !Number.isNaN( height ) ) {
                target.heights[index] = height;
                if ( ancestorFilled ) {
                    ancestorFilled[index] = 1;
                }
            }
        }
    }
}


function featherAncestorFilledHeights( heights: Float32Array,
                                       width: number,
                                       height: number,
                                       ancestorFilled: Uint8Array,
                                       radius: number ): void
{
    if ( radius <= 0 ) return;

    const original = new Float32Array( heights );

    for ( let y = 0; y < height; ++y ) {
        for ( let x = 0; x < width; ++x ) {
            const index = y * width + x;
            if ( !ancestorFilled[index] || Number.isNaN( original[index] ) ) continue;
            if ( x === 0 || y === 0 || x + 1 === width || y + 1 === height ) continue;

            let sum = 0;
            let weightSum = 0;
            for ( let dy = -radius; dy <= radius; ++dy ) {
                const ny = y + dy;
                if ( ny < 0 || ny >= height ) continue;

                for ( let dx = -radius; dx <= radius; ++dx ) {
                    const nx = x + dx;
                    if ( nx < 0 || nx >= width ) continue;

                    const dist = Math.max( Math.abs( dx ), Math.abs( dy ) );
                    if ( dist === 0 || dist > radius ) continue;

                    const neighborIndex = ny * width + nx;
                    if ( ancestorFilled[neighborIndex] || Number.isNaN( original[neighborIndex] ) ) continue;

                    const weight = radius + 1 - dist;
                    sum += original[neighborIndex] * weight;
                    weightSum += weight;
                }
            }

            if ( weightSum > 0 ) {
                const highZoomHeight = sum / weightSum;
                const blend = 1 / ( radius + 1 );
                heights[index] = original[index] * ( 1 - blend ) + highZoomHeight * blend;
            }
        }
    }
}


function sampleHeightGrid( grid: HeightGrid, x: number, y: number ): number
{
    const maxX = grid.width - 1;
    const maxY = grid.height - 1;
    const x0 = Math.max( 0, Math.min( maxX, Math.floor( x ) ) );
    const y0 = Math.max( 0, Math.min( maxY, Math.floor( y ) ) );
    const x1 = Math.min( x0 + 1, maxX );
    const y1 = Math.min( y0 + 1, maxY );
    const tx = x - x0;
    const ty = y - y0;
    const h00 = grid.heights[y0 * grid.width + x0];
    const h10 = grid.heights[y0 * grid.width + x1];
    const h01 = grid.heights[y1 * grid.width + x0];
    const h11 = grid.heights[y1 * grid.width + x1];

    if ( Number.isNaN( h00 ) || Number.isNaN( h10 ) || Number.isNaN( h01 ) || Number.isNaN( h11 ) ) {
        return NaN;
    }

    const h0 = h00 * ( 1 - tx ) + h10 * tx;
    const h1 = h01 * ( 1 - tx ) + h11 * tx;
    return h0 * ( 1 - ty ) + h1 * ty;
}


function applyNeighborBorders( target: HeightGrid,
                               right: HeightGrid | undefined,
                               bottom: HeightGrid | undefined,
                               corner: HeightGrid | undefined,
                               resolutionPower: number ): void
{
    const tileSize = 1 << resolutionPower;
    const demSize = tileSize + 1;

    if ( target.width !== demSize || target.height !== demSize ) {
        throw new Error( "height grid length does not match resolution_power" );
    }

    if ( right ) {
        validateNeighborGrid( right, demSize );
        for ( let y = 0; y < tileSize; ++y ) {
            applyNeighborHeight( target.heights, y * demSize + tileSize, right.heights[y * demSize] );
        }
    }

    if ( bottom ) {
        validateNeighborGrid( bottom, demSize );
        for ( let x = 0; x < tileSize; ++x ) {
            applyNeighborHeight( target.heights, tileSize * demSize + x, bottom.heights[x] );
        }
    }

    if ( corner ) {
        validateNeighborGrid( corner, demSize );
        applyNeighborHeight( target.heights, tileSize * demSize + tileSize, corner.heights[0] );
    }
    else if ( right ) {
        applyNeighborHeight( target.heights, tileSize * demSize + tileSize, right.heights[tileSize * demSize] );
    }
    else if ( bottom ) {
        applyNeighborHeight( target.heights, tileSize * demSize + tileSize, bottom.heights[tileSize] );
    }
}


function applyNeighborHeight( heights: Float32Array,
                              index: number,
                              height: number ): void
{
    if ( Number.isNaN( height ) ) return;

    heights[index] = height;
}


function validateNeighborGrid( grid: HeightGrid, demSize: number ): void
{
    if ( grid.width !== demSize || grid.height !== demSize ) {
        throw new Error( "neighbor height grid size does not match target" );
    }
}


function normalizeHeightGrid( heights: Float32Array,
                              width: number,
                              height: number,
                              context: DecodeContext ): HeightGrid
{
    if ( width !== height ) {
        throw new Error( "height grid must be square" );
    }

    const demSize = ( 1 << context.resolution_power ) + 1;
    if ( width === demSize && height === demSize ) {
        if ( heights.length !== demSize * demSize ) {
            throw new Error( "height grid length does not match its size" );
        }
        return {
            width:  demSize,
            height: demSize,
            heights,
        };
    }

    const tileSize = 1 << context.resolution_power;
    if ( width !== tileSize || height !== tileSize ) {
        throw new Error( "image size must be 2^resolution_power or 2^resolution_power + 1" );
    }

    const result = new Float32Array( demSize * demSize );

    for ( let y = 0; y < tileSize; ++y ) {
        for ( let x = 0; x < tileSize; ++x ) {
            result[y * demSize + x] = heights[y * tileSize + x];
        }
    }

    // 右端列と下端行を複製して mapray DEM の境界サンプルを作る。
    for ( let x = 0; x < tileSize; ++x ) {
        result[tileSize * demSize + x] = result[( tileSize - 1 ) * demSize + x];
    }
    for ( let y = 0; y < demSize; ++y ) {
        result[y * demSize + tileSize] = result[y * demSize + tileSize - 1];
    }

    return {
        width:  demSize,
        height: demSize,
        heights: result,
    };
}


function createFlatHeights( resolutionPower: number, height: number ): Float32Array
{
    const size = ( 1 << resolutionPower ) + 1;
    const heights = new Float32Array( size * size );
    heights.fill( height );
    return heights;
}


/**
 * mapray DEM バイナリを生成する。
 *
 * @internal
 */
export function createDemBinary( heights: Float32Array,
                                 option: DemBinaryOption ): ArrayBuffer
{
    const resolutionPower = option.resolution_power;
    const size = ( 1 << resolutionPower ) + 1;
    const numSamples = size * size;
    if ( heights.length !== numSamples ) {
        throw new Error( "heights length does not match resolution_power" );
    }

    let heightMin = Number.POSITIVE_INFINITY;
    let heightMax = Number.NEGATIVE_INFINITY;
    for ( let i = 0; i < heights.length; ++i ) {
        const height = heights[i];
        if ( Number.isNaN( height ) ) {
            throw new Error( "heights must not include NaN" );
        }
        if ( height < heightMin ) heightMin = height;
        if ( height > heightMax ) heightMax = height;
    }

    const buffer = new ArrayBuffer( HEADER_BYTES + FLOAT_BYTES * numSamples );
    const view = new DataView( buffer );

    const qlevel = normalizeQLevel( option.max_zoom - option.z );
    view.setUint8( OFFSET_QLEVEL_00, qlevel );
    view.setUint8( OFFSET_QLEVEL_10, qlevel );
    view.setUint8( OFFSET_QLEVEL_01, qlevel );
    view.setUint8( OFFSET_QLEVEL_11, qlevel );
    view.setFloat32( OFFSET_HMIN, heightMin, true );
    view.setFloat32( OFFSET_HMAX, heightMax, true );

    const omegas = createOmegaValues( heights, resolutionPower );
    let offset = OFFSET_OMEGA;
    for ( let i = 0; i < omegas.length; ++i ) {
        view.setFloat32( offset, omegas[i], true );
        offset += FLOAT_BYTES;
    }

    offset = HEADER_BYTES;
    for ( let i = 0; i < heights.length; ++i ) {
        view.setFloat32( offset, heights[i], true );
        offset += FLOAT_BYTES;
    }

    return buffer;
}


function normalizeQLevel( qlevel: number ): number
{
    return Math.max( 0, Math.min( 255, Math.floor( qlevel ) ) );
}


function createOmegaValues( heights: Float32Array,
                            resolutionPower: number ): Float32Array
{
    const values = new Float32Array( OMEGA_COUNT );
    const cells = 1 << resolutionPower;
    const size = cells + 1;
    let valueIndex = 0;

    for ( let down = 0; down < 3; ++down ) {
        const regions = 1 << down;
        for ( let regionY = 0; regionY < regions; ++regionY ) {
            const yBegin = Math.floor( regionY * cells / regions );
            const yEnd = Math.floor( ( regionY + 1 ) * cells / regions );
            for ( let regionX = 0; regionX < regions; ++regionX ) {
                const xBegin = Math.floor( regionX * cells / regions );
                const xEnd = Math.floor( ( regionX + 1 ) * cells / regions );
                values[valueIndex++] = createOmegaValue( heights, size, xBegin, yBegin, xEnd, yEnd );
            }
        }
    }

    return values;
}


function createOmegaValue( heights: Float32Array,
                           size: number,
                           xBegin: number,
                           yBegin: number,
                           xEnd: number,
                           yEnd: number ): number
{
    let heightMin = Number.POSITIVE_INFINITY;
    let heightMax = Number.NEGATIVE_INFINITY;

    for ( let y = yBegin; y <= yEnd; ++y ) {
        const row = y * size;
        for ( let x = xBegin; x <= xEnd; ++x ) {
            const height = heights[row + x];
            if ( Number.isNaN( height ) ) continue;
            if ( height < heightMin ) heightMin = height;
            if ( height > heightMax ) heightMax = height;
        }
    }

    if ( heightMin === Number.POSITIVE_INFINITY ) return 0;
    const range = Math.max( 0, heightMax - heightMin );
    return Math.max( 0, Math.min( OMEGA_LIMIT, Math.log2( range + 1 ) ) );
}


async function toImageData( tile: RasterTileData ): Promise<ImageData>
{
    if ( isImageData( tile ) ) {
        return tile;
    }

    if ( tile instanceof ArrayBuffer ) {
        const blob = new Blob( [tile], { type: "image/png" } );
        if ( typeof createImageBitmap === "function" ) {
            const image = await createImageBitmap( blob );
            try {
                return imageToImageData( image );
            }
            finally {
                image.close();
            }
        }

        return await blobToImageData( blob );
    }

    return imageToImageData( tile );
}


function isImageData( value: RasterTileData ): value is ImageData
{
    return (
        "data" in value &&
        "width" in value &&
        "height" in value &&
        value.data instanceof Uint8ClampedArray
    );
}


function imageToImageData( image: CanvasImageSource ): ImageData
{
    const width = "width" in image ? Number( image.width ) : 0;
    const height = "height" in image ? Number( image.height ) : 0;
    if ( width <= 0 || height <= 0 ) {
        throw new Error( "invalid image size" );
    }

    const canvas = document.createElement( "canvas" );
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext( "2d" );
    if ( context === null ) {
        throw new Error( "failed to create 2D canvas context" );
    }
    context.drawImage( image, 0, 0, width, height );
    return context.getImageData( 0, 0, width, height );
}


function blobToImageData( blob: Blob ): Promise<ImageData>
{
    return new Promise( ( resolve, reject ) => {
        const url = URL.createObjectURL( blob );
        const image = new Image();
        image.onload = () => {
            try {
                resolve( imageToImageData( image ) );
            }
            catch ( err ) {
                reject( err );
            }
            finally {
                URL.revokeObjectURL( url );
            }
        };
        image.onerror = () => {
            URL.revokeObjectURL( url );
            reject( new Error( "failed to decode image" ) );
        };
        image.src = url;
    } );
}


interface Source {
    fetchTile( z: number, x: number, y: number, options?: { signal?: AbortSignal } ): Promise<RasterTileData>;
}


interface RequestOption {
    headers?: HeadersInit;
    credentials: CredentialMode;
}


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
    y_origin?: YOrigin;
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
    | StandardEncodingOption
    | CustomEncodingOption;


export type StandardEncodingOption =
    | TerrainRgbEncodingOption
    | TerrariumEncodingOption
    | SignedRgbEncodingOption;


export interface TerrainRgbEncodingOption {
    type: "terrain-rgb";
    scale?: number;
    offset?: number;
    invalid_height?: number;
    invalid_fill?: InvalidFillMode;
}


export interface TerrariumEncodingOption {
    type: "terrarium";
    invalid_height?: number;
    invalid_fill?: InvalidFillMode;
}


export interface SignedRgbEncodingOption {
    type: "signed-rgb";
    invalid_height?: number;
    invalid_fill?: InvalidFillMode;
}


export interface CustomEncodingOption {
    type: "custom";
    decode: RasterDecodeFunction;
}


export type RasterDecodeFunction = ( image: ImageData, context: DecodeContext ) => Float32Array | HeightGrid;


export interface DecodeContext {
    z: number;
    x: number;
    y: number;
    resolution_power: number;
}


export interface HeightGrid {
    width: number;
    height: number;
    heights: Float32Array;
}


export interface DemBinaryOption {
    z: number;
    resolution_power: number;
    max_zoom: number;
}


export type YOrigin = "xyz" | "tms";


export type InvalidFillMode = "height" | "nearest" | "ancestor";


const DEFAULT_RESOLUTION_POWER = 8;
const DEFAULT_MAX_ZOOM = 15;
const DEFAULT_REQUEST_LIMIT = 16;
const TILE_CACHE_SIZE = 256;

const FLOAT_BYTES = 4;
const OFFSET_QLEVEL_00 = 0;
const OFFSET_QLEVEL_10 = 1;
const OFFSET_QLEVEL_01 = 2;
const OFFSET_QLEVEL_11 = 3;
const OFFSET_HMIN = 4;
const OFFSET_HMAX = 8;
const OFFSET_OMEGA = 12;
const HEADER_BYTES = 96;
const OMEGA_COUNT = 21;
const OMEGA_LIMIT = 6;
const ANCESTOR_FEATHER_PIXELS = 4;



} // namespace RasterDemProvider



export default RasterDemProvider;
