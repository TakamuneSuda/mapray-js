import RasterDemProvider from "../dist/es/RasterDemProvider";
import DemBinary from "../dist/es/DemBinary";


function makeImageData( width, height, pixels )
{
    return {
        width,
        height,
        data: new Uint8ClampedArray( pixels ),
    };
}


function makeImageDataByPixel( width, height, getPixel )
{
    const pixels = new Uint8ClampedArray( width * height * 4 );
    for ( let y = 0; y < height; ++y ) {
        for ( let x = 0; x < width; ++x ) {
            const p = 4 * ( y * width + x );
            const pixel = getPixel( x, y );
            pixels[p] = pixel[0];
            pixels[p + 1] = pixel[1];
            pixels[p + 2] = pixel[2];
            pixels[p + 3] = pixel[3];
        }
    }
    return makeImageData( width, height, pixels );
}


function encodeTerrainRgbHeight( height, scale = 0.1, offset = 0, alpha = 255 )
{
    const value = Math.round( ( height - offset ) / scale );
    return [
        ( value >> 16 ) & 0xFF,
        ( value >> 8 ) & 0xFF,
        value & 0xFF,
        alpha,
    ];
}


function makeConstantTerrainRgbTile( height, scale = 0.1 )
{
    const pixel = encodeTerrainRgbHeight( height, scale );
    return makeImageDataByPixel( DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE, () => pixel );
}


function makeConstantCustomTile( height )
{
    return makeImageData( 1, 1, [height, 0, 0, 255] );
}


function decodeConstantCustomTile( image )
{
    const heights = new Float32Array( DEFAULT_DEM_SIZE * DEFAULT_DEM_SIZE );
    heights.fill( image.data[0] );
    return {
        width: DEFAULT_DEM_SIZE,
        height: DEFAULT_DEM_SIZE,
        heights,
    };
}


function expectArrayCloseTo( actual, expected )
{
    expect( actual.length ).toBe( expected.length );
    for ( let i = 0; i < actual.length; ++i ) {
        expect( actual[i] ).toBeCloseTo( expected[i], 3 );
    }
}


const DEFAULT_RHO = 8;
const DEFAULT_TILE_SIZE = 1 << DEFAULT_RHO;
const DEFAULT_DEM_SIZE = DEFAULT_TILE_SIZE + 1;


describe( "RasterDemProvider.decodeImageData", () => {

    test( "decodes Terrain-RGB and duplicates DEM borders", () => {
        const image = makeImageData( 2, 2, [
            0, 0, 0, 255,     0, 0, 1, 255,
            0, 1, 0, 255,     1, 0, 0, 0,
        ] );

        const grid = RasterDemProvider.decodeImageData( image, { type: "terrain-rgb", invalid_height: 0 }, {
            z: 0,
            x: 0,
            y: 0,
            resolution_power: 1,
        } );

        expect( grid.width ).toBe( 3 );
        expect( grid.height ).toBe( 3 );
        expectArrayCloseTo( Array.from( grid.heights ), [
            -10000, -9999.9, -9999.9,
            -9974.4, 0, 0,
            -9974.4, 0, 0,
        ] );
    } );


    test( "decodes Terrarium", () => {
        const image = makeImageData( 2, 2, [
            128, 0, 0, 255,     128, 1, 0, 255,
            127, 255, 0, 255,   128, 0, 128, 0,
        ] );

        const grid = RasterDemProvider.decodeImageData( image, { type: "terrarium", invalid_height: 0 }, {
            z: 0,
            x: 0,
            y: 0,
            resolution_power: 1,
        } );

        expectArrayCloseTo( Array.from( grid.heights ), [
            0, 1, 1,
            -1, 0, 0,
            -1, 0, 0,
        ] );
    } );


    test( "decodes signed RGB PNG elevation tiles", () => {
        const image = makeImageData( 2, 2, [
            0, 0, 0, 255,       0, 0, 1, 255,
            255, 255, 255, 255, 0, 100, 0, 0,
        ] );

        const grid = RasterDemProvider.decodeImageData( image, { type: "signed-rgb", invalid_height: -9999 }, {
            z: 0,
            x: 0,
            y: 0,
            resolution_power: 1,
        } );

        expectArrayCloseTo( Array.from( grid.heights ), [
            0, 0.01, 0.01,
            -0.01, -9999, -9999,
            -0.01, -9999, -9999,
        ] );
    } );


    test( "fills transparent no-data pixels from nearest valid heights", () => {
        const image = makeImageData( 3, 3, [
            0, 0, 10, 255,   0, 0, 20, 255,   0, 0, 30, 255,
            0, 0, 40, 255,   0, 0, 0, 0,      0, 0, 60, 255,
            0, 0, 70, 255,   0, 0, 80, 255,   0, 0, 90, 255,
        ] );

        const grid = RasterDemProvider.decodeImageData( image, {
            type: "terrain-rgb",
            offset: 0,
            invalid_height: -9999,
            invalid_fill: "nearest",
        }, {
            z: 0,
            x: 0,
            y: 0,
            resolution_power: 1,
        } );

        expectArrayCloseTo( Array.from( grid.heights ), [
            1, 2, 3,
            4, 2, 6,
            7, 8, 9,
        ] );
    } );


    test( "rejects unexpected image size", () => {
        const image = makeImageData( 4, 4, new Array( 4 * 4 * 4 ).fill( 0 ) );

        expect( () => RasterDemProvider.decodeImageData( image, { type: "terrain-rgb" }, {
            z: 0,
            x: 0,
            y: 0,
            resolution_power: 1,
        } ) ).toThrow( /image size/ );
    } );

} );


describe( "RasterDemProvider.createDemBinary", () => {

    test( "creates a DemBinary-compatible buffer", () => {
        const heights = new Float32Array( [
            1, 2, 3,
            4, 5, 6,
            7, 8, 9,
        ] );

        const buffer = RasterDemProvider.createDemBinary( heights, {
            z: 2,
            resolution_power: 1,
            max_zoom: 5,
        } );

        const view = new DataView( buffer );
        expect( view.getUint8( 0 ) ).toBe( 3 );
        expect( view.getUint8( 1 ) ).toBe( 3 );
        expect( view.getUint8( 2 ) ).toBe( 3 );
        expect( view.getUint8( 3 ) ).toBe( 3 );
        expect( view.getFloat32( 4, true ) ).toBe( 1 );
        expect( view.getFloat32( 8, true ) ).toBe( 9 );
        expect( view.getFloat32( 12, true ) ).toBeGreaterThan( 0 );
        expect( view.getFloat32( 96, true ) ).toBe( 1 );
        expect( view.getFloat32( 96 + 8 * 4, true ) ).toBe( 9 );

        const dem = new DemBinary( 2, 0, 0, 1, buffer );
        expect( dem.height_min ).toBe( 1 );
        expect( dem.height_max ).toBe( 9 );
        expect( dem.getHeights( 0, 0 ) ).toEqual( [1, 2, 4, 5] );
    } );


    test( "rejects mismatched height count", () => {
        expect( () => RasterDemProvider.createDemBinary( new Float32Array( [1, 2, 3, 4] ), {
            z: 0,
            resolution_power: 1,
            max_zoom: 1,
        } ) ).toThrow( /heights length/ );
    } );

} );


describe( "RasterDemProvider", () => {

    test( "uses custom ImageData source and returns DEM binary", async () => {
        const image = makeImageDataByPixel( DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE, ( x, y ) => {
            if ( x === 1 && y === 0 ) return [0, 0, 1, 255];
            if ( x === 0 && y === 1 ) return [0, 1, 0, 255];
            if ( x === 1 && y === 1 ) return [1, 0, 0, 255];
            return [0, 0, 0, 255];
        } );

        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async () => image,
            },
            encoding: {
                type: "terrain-rgb",
            },
            max_zoom: 4,
            request_limit: 24,
        } );

        await expect( provider.init() ).resolves.toEqual( {
            resolution_power: DEFAULT_RHO,
            request_limit: 24,
        } );

        const buffer = await provider.requestTile( 1, 0, 0 );
        const view = new DataView( buffer );
        expect( view.getUint8( 0 ) ).toBe( 3 );

        const dem = new DemBinary( 1, 0, 0, DEFAULT_RHO, buffer );
        expectArrayCloseTo( dem.getHeights( 0, 0 ), [-10000, -9999.9, -9974.4, -3446.4] );
    } );


    test( "fills missing source tile with flat height when configured", async () => {
        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async () => {
                    throw new Error( "missing tile" );
                },
            },
            encoding: {
                type: "terrain-rgb",
            },
            max_zoom: 4,
            missing_tile_height: 0,
        } );

        const buffer = await provider.requestTile( 1, 0, 0 );
        const dem = new DemBinary( 1, 0, 0, DEFAULT_RHO, buffer );

        expect( dem.height_min ).toBe( 0 );
        expect( dem.height_max ).toBe( 0 );
        expect( dem.getHeights( 0, 0 ) ).toEqual( [0, 0, 0, 0] );
    } );


    test( "fills transparent no-data pixels from an ancestor tile", async () => {
        const current = makeImageDataByPixel( DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE, ( x, y ) => {
            if ( x === 0 && y === 0 ) return [0, 0, 0, 0];
            return encodeTerrainRgbHeight( 4 );
        } );
        const parent = makeConstantTerrainRgbTile( 4 );
        const tiles = new Map( [
            ["1/1/1", current],
            ["0/0/0", parent],
        ] );

        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async ( z, x, y ) => {
                    const tile = tiles.get( `${z}/${x}/${y}` );
                    if ( !tile ) throw new Error( "missing tile" );
                    return tile;
                },
            },
            encoding: {
                type: "terrain-rgb",
                offset: 0,
                invalid_fill: "ancestor",
            },
            max_zoom: 4,
        } );

        const buffer = await provider.requestTile( 1, 1, 1 );
        const dem = new DemBinary( 1, 1, 1, DEFAULT_RHO, buffer );

        expect( dem.getHeights( 0, 0 )[0] ).toBe( 4 );
    } );


    test( "fills a missing source tile from an ancestor tile", async () => {
        const parent = makeConstantTerrainRgbTile( 4 );

        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async ( z, x, y ) => {
                    if ( z === 0 && x === 0 && y === 0 ) return parent;
                    throw new Error( "missing tile" );
                },
            },
            encoding: {
                type: "terrain-rgb",
                offset: 0,
                invalid_fill: "ancestor",
            },
            max_zoom: 4,
            missing_tile_height: 0,
        } );

        const buffer = await provider.requestTile( 1, 1, 1 );
        const dem = new DemBinary( 1, 1, 1, DEFAULT_RHO, buffer );

        expectArrayCloseTo( dem.getHeights( 0, 0 ), [4, 4, 4, 4] );
    } );


    test( "backfills DEM borders from neighboring tiles", async () => {
        const tiles = new Map( [
            ["1/0/0", makeConstantCustomTile( 1 )],
            ["1/1/0", makeConstantCustomTile( 10 )],
            ["1/0/1", makeConstantCustomTile( 20 )],
            ["1/1/1", makeConstantCustomTile( 30 )],
        ] );

        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async ( z, x, y ) => tiles.get( `${z}/${x}/${y}` ),
            },
            encoding: {
                type: "custom",
                decode: decodeConstantCustomTile,
            },
            max_zoom: 4,
        } );

        const buffer = await provider.requestTile( 1, 0, 0 );
        const dem = new DemBinary( 1, 0, 0, DEFAULT_RHO, buffer );

        expect( dem.getHeights( DEFAULT_TILE_SIZE - 1, 0 ) ).toEqual( [1, 10, 1, 10] );
        expect( dem.getHeights( 0, DEFAULT_TILE_SIZE - 1 ) ).toEqual( [1, 1, 20, 20] );
        expect( dem.getHeights( DEFAULT_TILE_SIZE - 1, DEFAULT_TILE_SIZE - 1 ) ).toEqual( [1, 10, 20, 30] );
    } );


    test( "caches fetched image tiles for neighboring DEM borders", async () => {
        const tiles = new Map( [
            ["1/0/0", makeConstantCustomTile( 1 )],
            ["1/1/0", makeConstantCustomTile( 2 )],
            ["1/0/1", makeConstantCustomTile( 3 )],
            ["1/1/1", makeConstantCustomTile( 4 )],
        ] );
        const fetchCounts = new Map();

        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async ( z, x, y ) => {
                    const key = `${z}/${x}/${y}`;
                    fetchCounts.set( key, ( fetchCounts.get( key ) ?? 0 ) + 1 );
                    return tiles.get( key );
                },
            },
            encoding: {
                type: "custom",
                decode: decodeConstantCustomTile,
            },
            max_zoom: 4,
        } );

        await provider.requestTile( 1, 0, 0 );
        await provider.requestTile( 1, 1, 0 );

        expect( fetchCounts.get( "1/1/0" ) ).toBe( 1 );
    } );


    test( "uses neighboring tile values for ancestor-filled border samples", async () => {
        const current = makeImageDataByPixel( DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE, ( x, y ) => {
            if ( x === DEFAULT_TILE_SIZE - 1 && y === 0 ) return [0, 0, 0, 0];
            return encodeTerrainRgbHeight( 4, 1 );
        } );
        const parent = makeConstantTerrainRgbTile( 15, 1 );
        const right = makeConstantTerrainRgbTile( 100, 1 );
        const tiles = new Map( [
            ["1/0/0", current],
            ["1/1/0", right],
            ["0/0/0", parent],
        ] );

        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async ( z, x, y ) => {
                    const tile = tiles.get( `${z}/${x}/${y}` );
                    if ( !tile ) throw new Error( "missing tile" );
                    return tile;
                },
            },
            encoding: {
                type: "terrain-rgb",
                scale: 1,
                offset: 0,
                invalid_fill: "ancestor",
            },
            max_zoom: 4,
        } );

        const buffer = await provider.requestTile( 1, 0, 0 );
        const dem = new DemBinary( 1, 0, 0, DEFAULT_RHO, buffer );

        expect( dem.getHeights( DEFAULT_TILE_SIZE - 1, 0 )[1] ).toBe( 100 );
    } );


    test( "feathers ancestor-filled samples toward nearby high zoom heights", async () => {
        const current = makeImageDataByPixel( DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE, x => {
            return x === 100 || x === 101 ? [0, 0, 0, 0] : encodeTerrainRgbHeight( 100, 1 );
        } );
        const parent = makeConstantTerrainRgbTile( 20, 1 );
        const tiles = new Map( [
            ["1/0/0", current],
            ["0/0/0", parent],
        ] );

        const provider = new RasterDemProvider( {
            source: {
                type: "custom",
                fetchTile: async ( z, x, y ) => {
                    const tile = tiles.get( `${z}/${x}/${y}` );
                    if ( !tile ) throw new Error( "missing tile" );
                    return tile;
                },
            },
            encoding: {
                type: "terrain-rgb",
                scale: 1,
                offset: 0,
                invalid_fill: "ancestor",
            },
            max_zoom: 4,
        } );

        const buffer = await provider.requestTile( 1, 0, 0 );
        const dem = new DemBinary( 1, 0, 0, DEFAULT_RHO, buffer );

        expect( dem.getHeights( 100, 100 )[0] ).toBeGreaterThan( 20 );
        expect( dem.getHeights( 100, 100 )[0] ).toBeLessThan( 100 );
    } );


    test( "expands zxy URL and reverseY", async () => {
        const fetchMock = jest.fn( async () => ( {
            ok: false,
            statusText: "Not Found",
        } ) );
        const originalFetch = global.fetch;
        global.fetch = fetchMock;

        try {
            const provider = new RasterDemProvider( {
                source: {
                    type: "zxy",
                    url: "https://example.com/{z}/{x}/{y}/{reverseY}.png",
                    y_origin: "tms",
                },
                encoding: {
                    type: "terrain-rgb",
                },
            } );

            await expect( provider.requestTile( 3, 2, 5 ) ).rejects.toThrow( "Not Found" );
            expect( fetchMock ).toHaveBeenCalledTimes( 1 );
            expect( fetchMock.mock.calls[0][0] ).toBe( "https://example.com/3/2/2/2.png" );
        }
        finally {
            global.fetch = originalFetch;
        }
    } );


    test( "expands z/y/x URL order", async () => {
        const fetchMock = jest.fn( async () => ( {
            ok: false,
            statusText: "Not Found",
        } ) );
        const originalFetch = global.fetch;
        global.fetch = fetchMock;

        try {
            const provider = new RasterDemProvider( {
                source: {
                    type: "zxy",
                    url: "https://tiles.gsj.jp/tiles/elev/mixed/{z}/{y}/{x}.png",
                },
                encoding: {
                    type: "signed-rgb",
                },
            } );

            await expect( provider.requestTile( 7, 113, 50 ) ).rejects.toThrow( "Not Found" );
            expect( fetchMock ).toHaveBeenCalledTimes( 1 );
            expect( fetchMock.mock.calls[0][0] ).toBe( "https://tiles.gsj.jp/tiles/elev/mixed/7/50/113.png" );
        }
        finally {
            global.fetch = originalFetch;
        }
    } );

} );
