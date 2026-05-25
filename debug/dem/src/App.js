import mapray from "@mapray/mapray-js";
import maprayui from "@mapray/ui";

import { createDebugDemProvider } from "./DemProviderFactory";


export default class App extends maprayui.StandardUIViewer {

    constructor( container, options = {} ) {
        const demProvider = createDebugDemProvider( options.dem_provider || getProviderName() );

        super( container, process.env.MAPRAY_ACCESS_TOKEN, {
            debug_stats: new mapray.DebugStats(),
            dem_provider: demProvider.dem_provider,
        } );

        this._render_mode = mapray.Viewer.RenderMode.SURFACE;

        this.setCameraPosition( {
            longitude: 138.73,
            latitude: 35.36,
            height: 15000,
        } );
        this.setLookAtPosition( {
            longitude: 138.73,
            latitude: 35.36,
            height: 0,
        } );

        this._initTools( options.tools, demProvider.name, demProvider.label );

        console.info( `DEM provider: ${demProvider.label}` );
    }


    onKeyDown( event )
    {
        switch ( event.key ) {
            case "m":
            case "M":
                this._render_mode = (
                    this._render_mode === mapray.Viewer.RenderMode.SURFACE ?
                    mapray.Viewer.RenderMode.WIREFRAME :
                    mapray.Viewer.RenderMode.SURFACE
                );
                break;

            default:
                super.onKeyDown( event );
        }
    }


    onUpdateFrame( delta_time )
    {
        super.onUpdateFrame( delta_time );

        if ( this.viewer.render_mode !== this._render_mode ) {
            this.viewer.render_mode = this._render_mode;
        }
    }


    _initTools( tools, name, label )
    {
        if ( !tools ) {
            return;
        }

        const select = tools.querySelector( "#dem-provider" );
        if ( select ) {
            select.value = name;
        }

        const status = tools.querySelector( "#dem-status" );
        if ( status ) {
            status.textContent = `Provider: ${label}`;
        }
    }
}


function getProviderName()
{
    const params = new URLSearchParams( window.location.search );
    return params.get( "dem_provider" ) || process.env.MAPRAY_DEM_PROVIDER || "";
}
