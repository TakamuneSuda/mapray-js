import fs from 'node:fs';
import path from 'node:path';

import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';
import pluginNodeResolve from '@rollup/plugin-node-resolve';
import injectProcessEnv from 'rollup-plugin-inject-process-env';
import typescript from 'rollup-plugin-typescript2';
import sourcemaps from 'rollup-plugin-sourcemaps';

const outdir = 'dist/';
const dracoVendorSourceDir = path.resolve( '../../packages/mapray/dist/es/vendor' );
const dracoWorkerSourcePath = path.resolve( '../../packages/mapray/dist/es/workers/ThreeDTilesDracoDecoderWorker.js' );
const dracoVendorOutputDir = path.resolve( outdir, 'vendor' );
const dracoWorkerOutputPath = path.resolve( outdir, 'vendor/ThreeDTilesDracoDecoderWorker.js' );

function loadDotEnv( filePath ) {
    if ( !fs.existsSync( filePath ) ) {
        return {};
    }

    const source = fs.readFileSync( filePath, 'utf8' );
    const result = {};

    for ( const rawLine of source.split( /\r?\n/ ) ) {
        const line = rawLine.trim();
        if ( !line || line.startsWith( '#' ) ) {
            continue;
        }

        const separator = line.indexOf( '=' );
        if ( separator < 0 ) {
            continue;
        }

        const key = line.slice( 0, separator ).trim();
        const value = line.slice( separator + 1 ).trim().replace( /^['"]|['"]$/g, '' );
        result[key] = value;
    }

    return result;
}

const dotenv = loadDotEnv( path.resolve( '.env' ) );
const env = {
    MAPRAY_ACCESS_TOKEN: process.env.MAPRAY_ACCESS_TOKEN ?? dotenv.MAPRAY_ACCESS_TOKEN,
};

const { BUILD } = process.env;
const production = BUILD === 'production';

[
    'MAPRAY_ACCESS_TOKEN',
]
.forEach( key => { if ( !env[key] ) throw new Error( `${key} is missing` ); });


export default function() {

    const bundle = {
        input: 'src/index.ts',
        output: {
            file: outdir + 'bundle.js',
            format: 'iife',
            indent: false,
            sourcemap: production ? true : 'inline',
        },
        plugins: [
            postcss(),
            injectProcessEnv( env, {
                include: ['./src/**/*.ts'],
            }),
            pluginNodeResolve({
                extensions: ['.js', '.ts'],
            }),
            typescript({
                tsconfig: './tsconfig.json',
            }),
            sourcemaps(),
            (production ?
                terser({
                    compress: {
                        unused: false,
                        collapse_vars: false,
                    },
                    output: {
                        comments: false,
                    },
                }) :
                null
            ),
            {
                name: 'copy-draco-assets',
                writeBundle() {
                    if ( !fs.existsSync( dracoVendorSourceDir ) ) {
                        throw new Error(
                            `Missing built Draco vendor dir: ${dracoVendorSourceDir}\n` +
                            'Run `yarn --cwd packages/mapray build-devel` before building debug/3dtiles.'
                        );
                    }
                    if ( !fs.existsSync( dracoWorkerSourcePath ) ) {
                        throw new Error(
                            `Missing built Draco worker: ${dracoWorkerSourcePath}\n` +
                            'Run `yarn --cwd packages/mapray build-devel` before building debug/3dtiles.'
                        );
                    }

                    fs.mkdirSync( dracoVendorOutputDir, { recursive: true } );
                    for ( const entry of fs.readdirSync( dracoVendorSourceDir ) ) {
                        fs.copyFileSync(
                            path.join( dracoVendorSourceDir, entry ),
                            path.join( dracoVendorOutputDir, entry )
                        );
                    }
                    fs.copyFileSync( dracoWorkerSourcePath, dracoWorkerOutputPath );
                },
            },
        ],
    };

    return bundle;
}
