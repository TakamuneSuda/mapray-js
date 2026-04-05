import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";

import { chromium } from "@playwright/test";


const DEFAULT_TILESET_URL =
    "https://d2i4mp1qrenve.cloudfront.net/data/admin/3d_model/BIM%EF%BC%8FCIM/onga_kakoseki/tileset.json";
const PORT = Number( process.env.PORT ?? 7776 );
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}/`;
const TILESET_URL = process.env.TILESET_URL ?? DEFAULT_TILESET_URL;
const TIMEOUT_MS = Number( process.env.SMOKE_TIMEOUT_MS ?? 180000 );


async function main()
{
    await assertBuildOutputsExist();

    const server = startServer();
    const server_logs = [];
    const console_errors = [];
    const console_warnings = [];
    const page_errors = [];
    const request_failures = [];

    pipeStream( server.stdout, line => server_logs.push( `[server] ${line}` ) );
    pipeStream( server.stderr, line => server_logs.push( `[server] ${line}` ) );

    try {
        await waitForServer();

        const browser = await chromium.launch( {
            headless: process.env.HEADFUL !== "1",
        } );

        try {
            const page = await browser.newPage( {
                viewport: { width: 1440, height: 900 },
            } );

            page.on( "console", message => {
                if ( message.type() === "error" ) {
                    console_errors.push( message.text() );
                }
                if ( message.type() === "warning" ) {
                    console_warnings.push( message.text() );
                }
            } );
            page.on( "pageerror", error => {
                page_errors.push( error.stack || error.message );
            } );
            page.on( "requestfailed", request => {
                request_failures.push( `${request.method()} ${request.url()} :: ${request.failure()?.errorText || "unknown error"}` );
            } );

            const page_url = `${BASE_URL}?smoke=1&tileset=${encodeURIComponent( TILESET_URL )}`;
            console.log( `Opening ${page_url}` );
            await page.goto( page_url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS } );

            await page.waitForFunction( () => {
                const state = window.__threeDTilesDebugState;
                return !!state && (
                    state.loadStatus === "ready" ||
                    state.loadStatus.startsWith( "error:" ) ||
                    state.statusText.includes( "bundle.js is missing" )
                );
            }, { timeout: TIMEOUT_MS } );

            await delay( 1500 );

            const state = await page.evaluate( () => window.__threeDTilesDebugState || null );
            if ( !state ) {
                throw new Error( "Debug state was not published." );
            }

            console.log( "Final debug state:" );
            console.log( JSON.stringify( state, null, 2 ) );

            const output = [
                `Tileset: ${TILESET_URL}`,
                `Load status: ${state.loadStatus}`,
                `Focus: ${state.focusStatus}`,
                `Render mode: ${state.renderMode}`,
            ];

            const relevant_console_errors = console_errors.filter( line => !isIgnorableSmokeError( line ) );
            const relevant_console_warnings = console_warnings.filter( line => !isIgnorableSmokeWarning( line ) );
            const relevant_page_errors = page_errors.filter( line => !isIgnorableSmokeError( line ) );

            if ( state.loadStatus !== "ready" ) {
                throw new Error( output.join( "\n" ) );
            }

            if ( relevant_page_errors.length > 0 || relevant_console_errors.length > 0 || relevant_console_warnings.length > 0 ) {
                throw new Error(
                    [
                        ...output,
                        "",
                        "Console/Page issues were reported.",
                        ...relevant_page_errors.map( line => `pageerror: ${line}` ),
                        ...relevant_console_errors.map( line => `console: ${line}` ),
                        ...relevant_console_warnings.map( line => `warning: ${line}` ),
                    ].join( "\n" )
                );
            }

            console.log( output.join( "\n" ) );
            console.log( "Smoke test passed." );
        }
        finally {
            await browser.close();
        }
    }
    catch ( error ) {
        console.error( "Smoke test failed." );
        if ( error instanceof Error ) {
            console.error( error.message );
        }
        else {
            console.error( String( error ) );
        }

        if ( console_errors.length > 0 ) {
            console.error( "\nConsole errors:" );
            for ( const line of console_errors ) {
                console.error( `- ${line}` );
            }
        }

        if ( console_warnings.length > 0 ) {
            console.error( "\nConsole warnings:" );
            for ( const line of console_warnings ) {
                console.error( `- ${line}` );
            }
        }

        if ( page_errors.length > 0 ) {
            console.error( "\nPage errors:" );
            for ( const line of page_errors ) {
                console.error( `- ${line}` );
            }
        }

        if ( request_failures.length > 0 ) {
            console.error( "\nRequest failures:" );
            for ( const line of request_failures ) {
                console.error( `- ${line}` );
            }
        }

        if ( server_logs.length > 0 ) {
            console.error( "\nServer logs:" );
            for ( const line of server_logs.slice( -20 ) ) {
                console.error( line );
            }
        }

        process.exitCode = 1;
    }
    finally {
        stopServer( server );
    }
}


function isIgnorableSmokeError( line )
{
    return (
        line.includes( "sdfield WASM module is not available" ) ||
        line.includes( "WasmTool._createArrayBuffer" ) ||
        line.includes( "net::ERR_INVALID_URL" )
    );
}


function isIgnorableSmokeWarning( line )
{
    return !(
        line.includes( "Draco mesh worker decode failed" ) ||
        line.includes( "Disabling Draco mesh worker pool after fatal decode error" )
    );
}


async function assertBuildOutputsExist()
{
    await access( new URL( "../index.html", import.meta.url ), fsConstants.R_OK );
    await access( new URL( "../dist/bundle.js", import.meta.url ), fsConstants.R_OK );
}


function startServer()
{
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    return spawn(
        command,
        [ "st", "--no-cache", "-H", HOST, "--port", String( PORT ), "--index", "index.html", "--dir", "." ],
        {
            cwd: new URL( "..", import.meta.url ),
            stdio: [ "ignore", "pipe", "pipe" ],
        }
    );
}


function stopServer( server )
{
    if ( server.exitCode === null && !server.killed ) {
        server.kill( "SIGTERM" );
    }
}


function pipeStream( stream, onLine )
{
    if ( !stream ) {
        return;
    }

    let buffer = "";
    stream.setEncoding( "utf8" );
    stream.on( "data", chunk => {
        buffer += chunk;
        const lines = buffer.split( /\r?\n/u );
        buffer = lines.pop() ?? "";
        for ( const line of lines ) {
            if ( line ) {
                onLine( line );
            }
        }
    } );
}


async function waitForServer()
{
    const deadline = Date.now() + TIMEOUT_MS;

    while ( Date.now() < deadline ) {
        const ok = await pingServer();
        if ( ok ) {
            return;
        }
        await delay( 500 );
    }

    throw new Error( `Timed out waiting for ${BASE_URL}` );
}


function pingServer()
{
    return new Promise( resolve => {
        const request = httpRequest( BASE_URL, response => {
            response.resume();
            resolve( response.statusCode === 200 );
        } );

        request.on( "error", () => resolve( false ) );
        request.setTimeout( 2000, () => {
            request.destroy();
            resolve( false );
        } );
        request.end();
    } );
}


void main();
