import mapray from "@mapray/mapray-js";
import maprayui from "@mapray/ui";


const TARGET_POSITION = new mapray.GeoPoint( 139.7670, 35.6814, 0 );
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_SEMI_MAJOR_AXIS = 6378137.0;
const WGS84_SEMI_MINOR_AXIS = WGS84_SEMI_MAJOR_AXIS * (1 - WGS84_FLATTENING);
const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const WGS84_SECOND_ECCENTRICITY_SQUARED =
    (WGS84_SEMI_MAJOR_AXIS * WGS84_SEMI_MAJOR_AXIS - WGS84_SEMI_MINOR_AXIS * WGS84_SEMI_MINOR_AXIS) /
    (WGS84_SEMI_MINOR_AXIS * WGS84_SEMI_MINOR_AXIS);
const DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR = 16;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_MAX_CACHED_TILES = 256;
const DEFAULT_POINT_SIZE = 5;
const DEFAULT_POINT_SHAPE = "gradient_circle";


function publishDebugState( state )
{
    window["__threeDTilesDebugState"] = state;
    window.dispatchEvent( new CustomEvent( "mapray-3dtiles-debug-status", { detail: state } ) );
}


function getInitialTilesetUrl()
{
    return new URLSearchParams( window.location.search ).get( "tileset" ) ?? "";
}


function getInitialFlag( key )
{
    const value = new URLSearchParams( window.location.search ).get( key );
    return value === "1" || value === "true";
}


function getInitialNumberValue( key, fallback, minimum = Number.NEGATIVE_INFINITY )
{
    const value = Number( new URLSearchParams( window.location.search ).get( key ) );
    return Number.isFinite( value ) ? Math.max( minimum, value ) : fallback;
}


function getInitialPointShape()
{
    const value = new URLSearchParams( window.location.search ).get( "pointShape" );
    switch ( value ) {
        case "rectangle":
        case "circle":
        case "circle_with_border":
        case "gradient_circle":
            return value;
        default:
            return DEFAULT_POINT_SHAPE;
    }
}


function createViewerOptions()
{
    const smoke_mode = getInitialFlag( "smoke" );
    const options = {
        debug_stats: new mapray.DebugStats(),
    };

    if ( !smoke_mode ) {
        options.atmosphere = new mapray.Atmosphere();
        options.sun_visualizer = new mapray.SunVisualizer( 32 );
    }

    return options;
}


class ThreeDTilesViewer extends maprayui.StandardUIViewer {

    constructor( container )
    {
        super( container, process.env.MAPRAY_ACCESS_TOKEN, createViewerOptions() );

        this._smoke_mode = getInitialFlag( "smoke" );
        this._tileset_url = getInitialTilesetUrl();
        this._visibility = true;
        this._maximum_screen_space_error = getInitialNumberValue( "sse", DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR, 0.1 );
        this._max_concurrent_requests = getInitialNumberValue( "concurrency", DEFAULT_MAX_CONCURRENT_REQUESTS, 1 );
        this._max_cached_tiles = getInitialNumberValue( "cache", DEFAULT_MAX_CACHED_TILES, 1 );
        this._point_size = getInitialNumberValue( "pointSize", DEFAULT_POINT_SIZE, 1 );
        this._point_shape = getInitialPointShape();
        this._focus_target = undefined;
        this._focus_status = "not focused";
        this._last_status_text = "";

        const tools = document.getElementById( "tools" );
        if ( !tools ) {
            throw new Error( "Couldn't find #tools" );
        }
        this._tools = tools;

        this._initializeCamera();
        this._buildTools();
        this._updateStatus();

        if ( this._tileset_url ) {
            this._loadTileset();
        }
    }


    destroyViewer()
    {
        this._clearTileset();
        this.destroy();
    }


    onKeyDown( event )
    {
        super.onKeyDown( event );

        if ( event.key === "m" || event.key === "M" ) {
            this.viewer.render_mode = (
                this.viewer.render_mode === mapray.Viewer.RenderMode.SURFACE ?
                    mapray.Viewer.RenderMode.WIREFRAME :
                    mapray.Viewer.RenderMode.SURFACE
            );
            this._updateStatus();
        }
        else if ( event.key === "r" || event.key === "R" ) {
            this._loadTileset();
        }
    }


    onUpdateFrame( delta_time )
    {
        super.onUpdateFrame( delta_time );
        this._updateStatus();
    }


    _initializeCamera()
    {
        this.setCameraPosition( {
            latitude: TARGET_POSITION.latitude,
            longitude: TARGET_POSITION.longitude,
            height: 2500,
        } );

        this.setLookAtPosition( {
            latitude: TARGET_POSITION.latitude,
            longitude: TARGET_POSITION.longitude,
            height: TARGET_POSITION.altitude,
        } );

        this.setCameraParameter( {
            fov: 46.0,
        } );

        this.enableURLUpdate( true );
    }


    _buildTools()
    {
        const body = document.createElement( "div" );
        body.setAttribute( "class", "tools-body" );
        this._tools.appendChild( body );

        const title = document.createElement( "h1" );
        title.setAttribute( "class", "tools-title" );
        title.textContent = "3D Tiles Debug";
        body.appendChild( title );

        const url_row = document.createElement( "div" );
        url_row.setAttribute( "class", "tools-row" );
        body.appendChild( url_row );

        const url_label = document.createElement( "label" );
        url_label.textContent = "tileset.json";
        url_row.appendChild( url_label );

        this._url_input = document.createElement( "input" );
        this._url_input.type = "url";
        this._url_input.placeholder = "https://example.com/tileset.json";
        this._url_input.value = this._tileset_url;
        this._url_input.addEventListener( "keydown", event => {
            if ( event.key === "Enter" ) {
                this._loadTilesetFromInput();
            }
        } );
        url_row.appendChild( this._url_input );

        const load_button = document.createElement( "button" );
        load_button.textContent = "Load";
        load_button.addEventListener( "click", () => this._loadTilesetFromInput() );
        url_row.appendChild( load_button );

        const clear_button = document.createElement( "button" );
        clear_button.textContent = "Clear";
        clear_button.setAttribute( "class", "secondary" );
        clear_button.addEventListener( "click", () => this._clearTilesetFromInput() );
        url_row.appendChild( clear_button );

        const option_row = document.createElement( "div" );
        option_row.setAttribute( "class", "tools-row" );
        body.appendChild( option_row );

        this._visibility_input = document.createElement( "input" );
        this._visibility_input.type = "checkbox";
        this._visibility_input.checked = this._visibility;
        this._visibility_input.addEventListener( "change", () => {
            this._visibility = this._visibility_input.checked;
            this._tileset?.setVisibility( this._visibility );
            this._updateStatus();
        } );
        option_row.appendChild( this._visibility_input );

        const visibility_label = document.createElement( "label" );
        visibility_label.textContent = "visible";
        option_row.appendChild( visibility_label );

        const focus_button = document.createElement( "button" );
        focus_button.textContent = "Focus";
        focus_button.setAttribute( "class", "secondary" );
        focus_button.addEventListener( "click", () => this._applyFocusTarget() );
        option_row.appendChild( focus_button );

        const tuning_row = document.createElement( "div" );
        tuning_row.setAttribute( "class", "tools-row tools-grid" );
        body.appendChild( tuning_row );

        this._maximum_screen_space_error_input = this._createNumberInput( this._maximum_screen_space_error, 0.1, 0.1 );
        tuning_row.appendChild( this._createLabeledInput( "SSE", this._maximum_screen_space_error_input ) );

        this._max_concurrent_requests_input = this._createNumberInput( this._max_concurrent_requests, 1, 1 );
        tuning_row.appendChild( this._createLabeledInput( "Concurrent", this._max_concurrent_requests_input ) );

        this._max_cached_tiles_input = this._createNumberInput( this._max_cached_tiles, 1, 1 );
        tuning_row.appendChild( this._createLabeledInput( "Cache", this._max_cached_tiles_input ) );

        this._point_size_input = this._createNumberInput( this._point_size, 1, 0.5 );
        tuning_row.appendChild( this._createLabeledInput( "Point Size", this._point_size_input ) );

        this._point_shape_input = document.createElement( "select" );
        this._appendOption( this._point_shape_input, "gradient_circle", "Gradient" );
        this._appendOption( this._point_shape_input, "circle_with_border", "Border" );
        this._appendOption( this._point_shape_input, "circle", "Circle" );
        this._appendOption( this._point_shape_input, "rectangle", "Square" );
        this._point_shape_input.value = this._point_shape;
        tuning_row.appendChild( this._createLabeledInput( "Point Shape", this._point_shape_input ) );

        const apply_button = document.createElement( "button" );
        apply_button.textContent = "Apply";
        apply_button.addEventListener( "click", () => this._applyTuningFromInputs() );
        tuning_row.appendChild( apply_button );

        this._status_area = document.createElement( "pre" );
        this._status_area.setAttribute( "class", "tools-status" );
        body.appendChild( this._status_area );
    }


    _createNumberInput( value, minimum, step )
    {
        const input = document.createElement( "input" );
        input.type = "number";
        input.min = String( minimum );
        input.step = String( step );
        input.value = String( value );
        input.addEventListener( "keydown", event => {
            if ( event.key === "Enter" ) {
                this._applyTuningFromInputs();
            }
        } );
        return input;
    }


    _createLabeledInput( label, input )
    {
        const wrapper = document.createElement( "label" );
        wrapper.setAttribute( "class", "tools-field" );

        const caption = document.createElement( "span" );
        caption.textContent = label;
        wrapper.appendChild( caption );
        wrapper.appendChild( input );

        return wrapper;
    }


    _appendOption( select, value, label )
    {
        const option = document.createElement( "option" );
        option.value = value;
        option.textContent = label;
        select.appendChild( option );
    }


    _loadTilesetFromInput()
    {
        this._tileset_url = this._url_input.value.trim();
        this._syncQuery();
        this._loadTileset();
    }


    _clearTilesetFromInput()
    {
        this._url_input.value = "";
        this._tileset_url = "";
        this._syncQuery();
        this._clearTileset();
        this._updateStatus();
    }


    _loadTileset()
    {
        this._clearTileset();
        this._focus_target = undefined;
        this._focus_status = "not focused";

        if ( !this._tileset_url ) {
            this._updateStatus();
            return;
        }

        const draco_worker_param = new URL( window.location.href ).searchParams.get( "dracoWorker" );
        const enable_draco_worker = draco_worker_param !== "0" && draco_worker_param !== "false";

        this._tileset = new mapray.ThreeDTileset( this.viewer, this._tileset_url, {
            visibility: this._visibility,
            maximumScreenSpaceError: this._maximum_screen_space_error,
            maxConcurrentRequests: this._max_concurrent_requests,
            maxCachedTiles: this._max_cached_tiles,
            pointSize: this._point_size,
            pointShape: this._point_shape,
            dracoDecoderScriptUrl: "./dist/vendor/draco_wasm_wrapper.js",
            dracoDecoderWasmUrl: "./dist/vendor/draco_decoder.wasm",
            dracoDecoderWorkerUrl: enable_draco_worker ? "./dist/vendor/ThreeDTilesDracoDecoderWorker.js" : "",
        } );

        void this._updateFocusTarget();
        this._updateStatus();
    }


    _clearTileset()
    {
        this._tileset?.destroy();
        this._tileset = undefined;
    }


    _syncQuery()
    {
        const url = new URL( window.location.href );

        if ( this._tileset_url ) {
            url.searchParams.set( "tileset", this._tileset_url );
        }
        else {
            url.searchParams.delete( "tileset" );
        }

        url.searchParams.set( "sse", String( this._maximum_screen_space_error ) );
        url.searchParams.set( "concurrency", String( this._max_concurrent_requests ) );
        url.searchParams.set( "cache", String( this._max_cached_tiles ) );
        url.searchParams.set( "pointSize", String( this._point_size ) );
        url.searchParams.set( "pointShape", this._point_shape );

        window.history.replaceState( null, "", url.toString() );
    }


    _applyTuningFromInputs()
    {
        this._maximum_screen_space_error = this._readNumberInput( this._maximum_screen_space_error_input, DEFAULT_MAXIMUM_SCREEN_SPACE_ERROR, 0.1 );
        this._max_concurrent_requests = this._readNumberInput( this._max_concurrent_requests_input, DEFAULT_MAX_CONCURRENT_REQUESTS, 1 );
        this._max_cached_tiles = this._readNumberInput( this._max_cached_tiles_input, DEFAULT_MAX_CACHED_TILES, 1 );
        this._point_size = this._readNumberInput( this._point_size_input, DEFAULT_POINT_SIZE, 1 );
        this._point_shape = this._point_shape_input.value || DEFAULT_POINT_SHAPE;

        this._maximum_screen_space_error_input.value = String( this._maximum_screen_space_error );
        this._max_concurrent_requests_input.value = String( this._max_concurrent_requests );
        this._max_cached_tiles_input.value = String( this._max_cached_tiles );
        this._point_size_input.value = String( this._point_size );
        this._point_shape_input.value = this._point_shape;

        this._syncQuery();

        if ( this._tileset_url ) {
            this._loadTileset();
        }
        else {
            this._updateStatus();
        }
    }


    _readNumberInput( input, fallback, minimum )
    {
        const value = Number( input.value );
        return Number.isFinite( value ) ? Math.max( minimum, value ) : fallback;
    }


    _updateStatus()
    {
        const render_mode = this.viewer.render_mode === mapray.Viewer.RenderMode.SURFACE ? "surface" : "wireframe";
        const load_status = this._getLoadStatusText();
        const status_lines = [
            `tileset: ${this._tileset_url || "(not set)"}`,
            `visibility: ${this._visibility ? "on" : "off"}`,
            `render mode: ${render_mode}`,
            `tuning: sse=${this._maximum_screen_space_error}, concurrency=${this._max_concurrent_requests}, cache=${this._max_cached_tiles}, pointSize=${this._point_size}, pointShape=${this._point_shape}`,
            `status: ${load_status}`,
            `focus: ${this._focus_status}`,
            "keys: m = wireframe, r = reload",
        ];

        const status_text = status_lines.join( "\n" );
        publishDebugState( {
            tilesetUrl: this._tileset_url,
            visibility: this._visibility,
            renderMode: render_mode,
            tuning: {
                maximumScreenSpaceError: this._maximum_screen_space_error,
                maxConcurrentRequests: this._max_concurrent_requests,
                maxCachedTiles: this._max_cached_tiles,
                pointSize: this._point_size,
                pointShape: this._point_shape,
            },
            loadStatus: load_status,
            focusStatus: this._focus_status,
            viewerLoadStatus: { ...this.viewer.load_status },
            statusText: status_text,
            updatedAt: Date.now(),
        } );

        if ( status_text === this._last_status_text ) {
            return;
        }

        this._status_area.textContent = status_text;
        this._last_status_text = status_text;
    }


    _getLoadStatusText()
    {
        if ( !this._tileset_url ) {
            return "idle";
        }

        if ( !this._tileset ) {
            return "not loaded";
        }

        if ( this._tileset.load_error ) {
            return `error: ${this._tileset.load_error.message}`;
        }

        return this._tileset.ready ? "ready" : "loading";
    }


    async _updateFocusTarget()
    {
        const url = this._tileset_url;

        try {
            const response = await fetch( url );
            if ( !response.ok ) {
                throw new Error( response.statusText );
            }

            const json = await response.json();
            if ( url !== this._tileset_url ) {
                return;
            }

            const target = this._createFocusTargetFromTilesetJson( json );
            if ( !this._isValidFocusTarget( target ) ) {
                this._focus_status = "focus target unavailable";
                this._updateStatus();
                return;
            }

            this._focus_target = target;
            this._applyFocusTarget();
        }
        catch ( error ) {
            this._focus_status = `focus error: ${this._formatError( error )}`;
            this._updateStatus();
        }
    }


    _createFocusTargetFromTilesetJson( json )
    {
        const root = json?.root;
        if ( !root?.boundingVolume ) {
            return undefined;
        }

        const transform = Array.isArray( root.transform ) ?
            mapray.GeoMath.createMatrix( root.transform ) :
            mapray.GeoMath.setIdentity( mapray.GeoMath.createMatrix() );

        const summary = this._createBoundingVolumeSummary( root.boundingVolume, transform );
        if ( !summary ) {
            return undefined;
        }

        const geo_point = this._convertEcefToGeoPoint( summary.center );
        const camera_height = Math.max(
            geo_point.altitude + Math.max( summary.extent * 2.0, 250 ),
            250
        );

        return {
            longitude: geo_point.longitude,
            latitude: geo_point.latitude,
            height: geo_point.altitude,
            cameraHeight: camera_height,
        };
    }


    _createBoundingVolumeSummary( bounding_volume, transform )
    {
        if ( Array.isArray( bounding_volume.box ) ) {
            return this._createBoxSummary( bounding_volume.box, transform );
        }

        if ( Array.isArray( bounding_volume.sphere ) ) {
            return this._createSphereSummary( bounding_volume.sphere, transform );
        }

        if ( Array.isArray( bounding_volume.region ) ) {
            return this._createRegionSummary( bounding_volume.region );
        }

        return undefined;
    }


    _createBoxSummary( box, transform )
    {
        const center = mapray.GeoMath.transformPosition_A(
            transform,
            mapray.GeoMath.createVector3( [box[0], box[1], box[2]] ),
            mapray.GeoMath.createVector3()
        );
        const half_axes = [
            mapray.GeoMath.transformDirection_A( transform, mapray.GeoMath.createVector3( [box[3],  box[4],  box[5]] ), mapray.GeoMath.createVector3() ),
            mapray.GeoMath.transformDirection_A( transform, mapray.GeoMath.createVector3( [box[6],  box[7],  box[8]] ), mapray.GeoMath.createVector3() ),
            mapray.GeoMath.transformDirection_A( transform, mapray.GeoMath.createVector3( [box[9], box[10], box[11]] ), mapray.GeoMath.createVector3() ),
        ];
        const radius = Math.sqrt( half_axes.reduce( ( sum, axis ) => sum + mapray.GeoMath.lengthSquared3( axis ), 0 ) );

        return { center, extent: radius };
    }


    _createSphereSummary( sphere, transform )
    {
        const center = mapray.GeoMath.transformPosition_A(
            transform,
            mapray.GeoMath.createVector3( [sphere[0], sphere[1], sphere[2]] ),
            mapray.GeoMath.createVector3()
        );
        const sx = mapray.GeoMath.length3( mapray.GeoMath.createVector3( [transform[0], transform[1], transform[2]] ) );
        const sy = mapray.GeoMath.length3( mapray.GeoMath.createVector3( [transform[4], transform[5], transform[6]] ) );
        const sz = mapray.GeoMath.length3( mapray.GeoMath.createVector3( [transform[8], transform[9], transform[10]] ) );
        const radius = sphere[3] * Math.max( sx, sy, sz );

        return { center, extent: radius };
    }


    _createRegionSummary( region )
    {
        const west = region[0] / mapray.GeoMath.DEGREE;
        const south = region[1] / mapray.GeoMath.DEGREE;
        const east = region[2] / mapray.GeoMath.DEGREE;
        const north = region[3] / mapray.GeoMath.DEGREE;
        const min_height = region[4];
        const max_height = region[5];

        const center_longitude = ( west + east ) * 0.5;
        const center_latitude = ( south + north ) * 0.5;
        const center_height = ( min_height + max_height ) * 0.5;
        const center_geo_point = new mapray.GeoPoint( center_longitude, center_latitude, center_height );
        const extent = Math.max(
            max_height - min_height,
            new mapray.GeoPoint( west, south, 0 ).getGeographicalDistance( new mapray.GeoPoint( east, north, 0 ) )
        );

        return {
            center: center_geo_point.getAsGocs( mapray.GeoMath.createVector3() ),
            extent,
        };
    }


    _convertEcefToGeoPoint( position )
    {
        const x = position[0];
        const y = position[1];
        const z = position[2];
        const xy = Math.sqrt( x*x + y*y );

        let latitude;
        let altitude;

        if ( xy < 1e-9 ) {
            latitude = z >= 0 ? 90 : -90;
            altitude = Math.abs( z ) - WGS84_SEMI_MINOR_AXIS;
        }
        else {
            const theta = Math.atan2( WGS84_SEMI_MAJOR_AXIS * z, WGS84_SEMI_MINOR_AXIS * xy );
            const sin_theta = Math.sin( theta );
            const cos_theta = Math.cos( theta );
            const latitude_rad = Math.atan2(
                z + WGS84_SECOND_ECCENTRICITY_SQUARED * WGS84_SEMI_MINOR_AXIS * sin_theta*sin_theta*sin_theta,
                xy - WGS84_ECCENTRICITY_SQUARED * WGS84_SEMI_MAJOR_AXIS * cos_theta*cos_theta*cos_theta
            );
            const sin_latitude = Math.sin( latitude_rad );
            const prime_vertical_radius = WGS84_SEMI_MAJOR_AXIS / Math.sqrt( 1 - WGS84_ECCENTRICITY_SQUARED * sin_latitude*sin_latitude );

            latitude = latitude_rad / mapray.GeoMath.DEGREE;
            altitude = xy / Math.cos( latitude_rad ) - prime_vertical_radius;
        }

        return new mapray.GeoPoint(
            Math.atan2( y, x ) / mapray.GeoMath.DEGREE,
            latitude,
            altitude
        );
    }


    _applyFocusTarget()
    {
        if ( !this._isValidFocusTarget( this._focus_target ) ) {
            this._focus_status = "focus target unavailable";
            this._updateStatus();
            return;
        }

        this.setCameraPosition( {
            longitude: this._focus_target.longitude,
            latitude: this._focus_target.latitude,
            height: this._focus_target.cameraHeight,
        } );
        this.setLookAtPosition( {
            longitude: this._focus_target.longitude,
            latitude: this._focus_target.latitude,
            height: this._focus_target.height,
        } );
        this.updateCamera();

        this._focus_status = `${this._focus_target.longitude.toFixed( 5 )}, ${this._focus_target.latitude.toFixed( 5 )}`;
        this._updateStatus();
    }


    _isValidFocusTarget( target )
    {
        if ( !target ) {
            return false;
        }

        if (
            !Number.isFinite( target.longitude ) ||
            !Number.isFinite( target.latitude ) ||
            !Number.isFinite( target.height ) ||
            !Number.isFinite( target.cameraHeight )
        ) {
            return false;
        }

        if ( target.longitude < -180 || target.longitude > 180 || target.latitude < -90 || target.latitude > 90 ) {
            return false;
        }

        return !( Math.abs( target.longitude ) < 1e-9 && Math.abs( target.latitude ) < 1e-9 );
    }


    _formatError( error )
    {
        return error instanceof Error ? error.message : String( error );
    }
}


export default ThreeDTilesViewer;
