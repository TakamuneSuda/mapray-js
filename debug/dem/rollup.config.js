import terser from '@rollup/plugin-terser';
import postcss from 'rollup-plugin-postcss';
import pluginNodeResolve from '@rollup/plugin-node-resolve';
import injectProcessEnv from 'rollup-plugin-inject-process-env';
import sourcemaps from 'rollup-plugin-sourcemaps';

const outdir = "dist/";

const env = {
    MAPRAY_ACCESS_TOKEN: process.env.MAPRAY_ACCESS_TOKEN || "",
    MAPRAY_DEM_PROVIDER: process.env.MAPRAY_DEM_PROVIDER || "",
};

const { BUILD } = process.env;
const production = BUILD === 'production';


export default function() {

    const bundle = {
        input: 'src/App.js',
        output: {
            file: outdir + 'bundle.js',
            format: 'iife',
            indent: false,
            sourcemap:  production ? true : 'inline',
            name: "App",
        },
        plugins: [
            postcss(),
            injectProcessEnv( env, {
                    include: ["./src/**/*.js"],
            }),
            sourcemaps(),
            pluginNodeResolve(),
            (production ?
                terser({
                    compress: {
                        unused: false,
                        collapse_vars: false,
                    },
                    output: {
                        comments: false,
                    },
                }):
                null
            ),
        ],
    }

    return bundle;
}
