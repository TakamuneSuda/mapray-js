import mapray from "@mapray/mapray-js";
import maprayui from "@mapray/ui";
import * as THREE from "three";


export default class App extends maprayui.StandardUIViewer {

    constructor( container, options = {} )
    {
        super( container, process.env.MAPRAY_ACCESS_TOKEN, {
            debug_stats: new mapray.DebugStats(),
        } );

        this._status = options.status || undefined;
        this._three_renderer = undefined;
        this._view_to_clip = mapray.GeoMath.createMatrix();

        this.setCameraPosition( {
            longitude: 139.7671,
            latitude: 35.6812 - 0.03,
            height: 1800,
        } );
        this.setLookAtPosition( {
            longitude: 139.7671,
            latitude: 35.6812,
            height: 250,
        } );

        this._three_scene = new THREE.Scene();
        this._three_camera = new THREE.Camera();
        this._three_camera.matrixAutoUpdate = false;
        this._three_camera.matrixWorldAutoUpdate = false;

        this._anchor_group = new THREE.Group();
        this._anchor_group.matrixAutoUpdate = false;

        const anchor_geo_point = new mapray.GeoPoint( 139.7671, 35.6812, 180 );
        const anchor_matrix = mapray.GeoMath.createMatrix();
        anchor_geo_point.getMlocsToGocsMatrix( anchor_matrix );
        this._anchor_group.matrix.fromArray( Array.from( anchor_matrix ) );

        const cube_geometry = new THREE.BoxGeometry( 120, 120, 120 );
        const cube_material = new THREE.MeshNormalMaterial();
        this._cube = new THREE.Mesh( cube_geometry, cube_material );
        this._cube.position.set( 0, 0, 120 );
        this._cube.frustumCulled = false;

        this._axes = new THREE.AxesHelper( 220 );
        this._axes.frustumCulled = false;

        this._anchor_group.add( this._cube );
        this._anchor_group.add( this._axes );
        this._three_scene.add( this._anchor_group );

        this._custom_scene = this.viewer.custom_scene_collection.createScene( {
            draw: stage => this._draw_three_scene( stage ),
            destroy: () => this._dispose_three_scene(),
        } );

        this._update_status();
    }


    onUpdateFrame( delta_time )
    {
        super.onUpdateFrame( delta_time );

        const rotate_step = delta_time * 0.001;
        this._cube.rotation.x += rotate_step * 0.6;
        this._cube.rotation.y += rotate_step * 1.0;
        this._cube.rotation.z += rotate_step * 0.3;

        this._update_status();
    }


    _draw_three_scene( stage )
    {
        if ( stage.getRenderTarget() !== "SCENE" ) {
            return;
        }

        const renderer = this._ensure_three_renderer();

        mapray.GeoMath.mul_GA( stage.gocs_to_clip, stage.view_to_gocs, this._view_to_clip );

        this._three_camera.matrixWorld.fromArray( Array.from( stage.view_to_gocs ) );
        this._three_camera.matrixWorldInverse.fromArray( Array.from( stage.gocs_to_view ) );
        this._three_camera.projectionMatrix.fromArray( Array.from( this._view_to_clip ) );
        this._three_camera.projectionMatrixInverse.copy( this._three_camera.projectionMatrix ).invert();
        this._three_camera.updateMatrixWorld( true );

        renderer.resetState();
        renderer.autoClear = false;
        renderer.setViewport( 0, 0, stage.width, stage.height );
        renderer.render( this._three_scene, this._three_camera );
        renderer.resetState();
    }


    _ensure_three_renderer()
    {
        if ( this._three_renderer ) {
            return this._three_renderer;
        }

        const canvas = this.viewer.canvas_element;
        const context = canvas.getContext( "webgl2" );
        if ( !context ) {
            throw new Error( "webgl2 context is unavailable" );
        }

        this._three_renderer = new THREE.WebGLRenderer( {
            canvas,
            context,
            alpha: true,
            antialias: true,
        } );
        this._three_renderer.autoClear = false;
        this._three_renderer.sortObjects = false;

        return this._three_renderer;
    }


    _dispose_three_scene()
    {
        this._cube.geometry.dispose();
        this._cube.material.dispose();
        this._axes.geometry.dispose();

        const axes_material = this._axes.material;
        if ( Array.isArray( axes_material ) ) {
            axes_material.forEach( material => material.dispose() );
        }
        else {
            axes_material.dispose();
        }

        this._three_renderer?.dispose();
        this._three_renderer = undefined;
    }


    _update_status()
    {
        if ( !this._status ) {
            return;
        }

        const camera_position = this.getCameraPosition();
        const camera_angle = this.getCameraAngle();

        this._status.textContent =
            "CustomScene: enabled\n" +
            "Renderer: three.js on shared WebGL2 context\n" +
            "Object: spinning cube above Tokyo Station\n\n" +
            `Camera: ${camera_position.longitude.toFixed(5)}, ${camera_position.latitude.toFixed(5)}, ${camera_position.height.toFixed(1)}m\n` +
            `Angle: pitch ${camera_angle.pitch.toFixed(1)} / yaw ${camera_angle.yaw.toFixed(1)} / roll ${camera_angle.roll.toFixed(1)}\n` +
            `Scene count: ${this.viewer.custom_scene_collection.num_scenes}\n` +
            `Visible: ${this._custom_scene.visibility}`;
    }
}
