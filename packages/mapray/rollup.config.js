import terser from '@rollup/plugin-terser'
import babel from '@rollup/plugin-babel'
import { string } from 'rollup-plugin-string'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import strip from '@rollup/plugin-strip';
import { base64 } from 'rollup-plugin-base64';
import typescript from 'rollup-plugin-typescript2';
import fs from 'node:fs';
import path from 'node:path';


const {BUILD, MINIFY} = process.env;
const production = BUILD === 'production';
const minified = MINIFY === 'true';
const extensions = ['**/*.vert', '**/*.frag', '**/*.glsl', '**/*.svg'];
const outdir = "dist/";
const outputFileUMD= umdBuildType(production, minified);
const dracoVendorDir = path.resolve('vendor');
const dracoVendorFiles = [
  'draco_decoder.js',
  'draco_wasm_wrapper.js',
  'draco_decoder.wasm',
];

const strip_option = (
    production ?
    {
        include: '**/*.(ts|js)',
        debugger: false,
        functions: [ 'console.assert', 'cfa_assert' ],
        labels: [ 'ASSERT', 'DEBUG' ],
        sourceMap: true,
    }:
    {
        include: '**/*.(ts|js)',
        debugger: false,
        functions: [],
        labels: [],
        sourceMap: false,
    }
);

function umdBuildType(isProd, minified) {
  if (isProd) {
    if (minified) {
      return outdir + 'umd/mapray.min.js';
    }
    return outdir + 'umd/mapray.js';
  }

  return outdir + 'umd/mapray-dev.js'
}

console.log("production:" + production);
console.log("minify:" + minified);

function copyDracoVendorFiles(targetDir) {
  return {
    name: `copy-draco-vendor:${targetDir}`,
    writeBundle() {
      const destinationDir = path.resolve(targetDir, 'vendor');
      fs.mkdirSync(destinationDir, { recursive: true });
      for (const filename of dracoVendorFiles) {
        fs.copyFileSync(
          path.join(dracoVendorDir, filename),
          path.join(destinationDir, filename)
        );
      }
    }
  };
}

export default [
  // ES
  {
    input: 'src/mapray.ts',
    output: {
      dir: outdir + 'es/',
      format: 'es',
      indent: false,
      sourcemap: production ? true : 'inline',
      preserveModules: true,
      preserveModulesRoot: 'src'
    },
    external: [
      'mapbox-gl/dist/style-spec/index.es.js',
      'tslib',
    ],
    plugins: [
      resolve(),
      commonjs(),
      base64({
        include: '**/*.wasm'
      }),
      string({
        include: extensions
      }),
      typescript({
        useTsconfigDeclarationDir: true,
        tsconfig: './tsconfig.json',
        tsconfigOverride: {
          compilerOptions: {
            outDir: outdir + 'es/',
            declarationDir: outdir + 'es/@types',
          }
        }
      }),
      strip(strip_option),
      copyDracoVendorFiles(outdir + 'es/'),
      minified ? terser() : false
    ]
  },
  // Dedicated Draco worker
  {
    input: 'src/workers/ThreeDTilesDracoDecoderWorker.ts',
    output: {
      file: outdir + 'es/workers/ThreeDTilesDracoDecoderWorker.js',
      format: 'iife',
      indent: false,
      sourcemap: production ? true : 'inline'
    },
    plugins: [
      resolve(),
      commonjs(),
      base64({
        include: '**/*.wasm'
      }),
      string({
        include: extensions
      }),
      typescript({
        tsconfig: './tsconfig.json',
        useTsconfigDeclarationDir: false,
        tsconfigOverride: {
          compilerOptions: {
            outDir: outdir + 'es/workers/',
            declaration: false,
            declarationMap: false,
            declarationDir: undefined,
          }
        }
      }),
      strip(strip_option),
      copyDracoVendorFiles(outdir + 'es/'),
      minified ? terser() : false
    ]
  },
  // UMD
  {
    input: 'src/index.ts',
    output: {
      file: outputFileUMD,
      format: 'umd',
      name: 'mapray',
      exports: 'named',
      indent: false,
      sourcemap: production ? true : 'inline'
    },
    plugins: [
      resolve(),
      commonjs(),
      base64({
        include: '**/*.wasm'
      }),
      string({
        include: extensions
      }),
      typescript({
        tsconfig: './tsconfig.json',
        useTsconfigDeclarationDir: true,
        tsconfigOverride: {
          compilerOptions: {
            outDir: outdir + 'umd/',
            declarationDir: outdir + 'umd/@types',
            target: 'es5',
            module: 'es2015',
          }
        }
      }),
      strip(strip_option),
      babel({ // this is for js file in src dir
        exclude: 'node_modules/**'
      }),
      copyDracoVendorFiles(outdir + 'umd/'),
      minified ? terser() : false
    ]
  }
]
