import mapray from "@mapray/mapray-js";
import maprayui from "@mapray/ui";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateLines } from "@babylonjs/core/Meshes/Builders/linesBuilder";


export default class App extends maprayui.StandardUIViewer {

    constructor( container, options = {} )
    {
        super( container, process.env.MAPRAY_ACCESS_TOKEN, {
            debug_stats: new mapray.DebugStats(),
        } );

        this._status = options.status || undefined;
        this._view_to_clip = mapray.GeoMath.createMatrix();
        this._babylon_engine = undefined;
        this._babylon_scene = undefined;
        this._babylon_camera = undefined;
        this._babylon_view = new Matrix();
        this._babylon_projection = new Matrix();
        this._babylon_anchor = undefined;
        this._box = undefined;
        this._axes = [];

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

        this._custom_scene = this.viewer.custom_scene_collection.createScene( {
            draw: stage => this._draw_babylon_scene( stage ),
            destroy: () => this._dispose_babylon_scene(),
        } );

        this._update_status();
    }


    onUpdateFrame( delta_time )
    {
        super.onUpdateFrame( delta_time );

        if ( this._box ) {
            const rotate_step = delta_time * 0.001;
            this._box.rotation.x += rotate_step * 0.6;
            this._box.rotation.y += rotate_step * 1.0;
            this._box.rotation.z += rotate_step * 0.3;
        }

        this._update_status();
    }


    _draw_babylon_scene( stage )
    {
        if ( stage.getRenderTarget() !== "SCENE" ) {
            return;
        }

        this._ensure_babylon_scene();

        Matrix.FromArrayToRef( stage.gocs_to_view, 0, this._babylon_view );
        mapray.GeoMath.mul_GA( stage.gocs_to_clip, stage.view_to_gocs, this._view_to_clip );
        Matrix.FromArrayToRef( this._view_to_clip, 0, this._babylon_projection );

        this._babylon_camera.freezeProjectionMatrix( this._babylon_projection );

        const engine = this._babylon_engine;
        const scene = this._babylon_scene;

        engine.wipeCaches( true );
        engine.setViewport( this._babylon_camera.viewport, stage.width, stage.height );
        scene.render( false, false );
        engine.restoreDefaultFramebuffer();
        engine.wipeCaches( true );
    }


    _ensure_babylon_scene()
    {
        if ( this._babylon_scene ) {
            return;
        }

        const canvas = this.viewer.canvas_element;
        const context = canvas.getContext( "webgl2" );
        if ( !context ) {
            throw new Error( "webgl2 context is unavailable" );
        }

        this._babylon_engine = new Engine( context, true, {
            doNotHandleContextLost: true,
            doNotHandleTouchAction: true,
            disableWebGL2Support: false,
        }, false );

        this._babylon_scene = new Scene( this._babylon_engine );
        this._babylon_scene.autoClear = false;
        this._babylon_scene.autoClearDepthAndStencil = false;
        this._babylon_scene.useRightHandedSystem = true;

        this._babylon_camera = new Camera( "mapray-camera", Vector3.Zero(), this._babylon_scene, true );
        this._babylon_camera.viewport = new Viewport( 0, 0, 1, 1 );
        this._babylon_camera.minZ = 0.01;
        this._babylon_camera.maxZ = 1000000000;
        this._babylon_camera._getViewMatrix = () => this._babylon_view;
        this._babylon_camera._isSynchronizedViewMatrix = () => false;
        this._babylon_scene.activeCamera = this._babylon_camera;

        this._babylon_anchor = new TransformNode( "anchor", this._babylon_scene );
        const anchor_geo_point = new mapray.GeoPoint( 139.7671, 35.6812, 180 );
        const anchor_matrix = mapray.GeoMath.createMatrix();
        anchor_geo_point.getMlocsToGocsMatrix( anchor_matrix );
        this._babylon_anchor.freezeWorldMatrix( Matrix.FromArray( anchor_matrix ) );

        const material = new StandardMaterial( "box-material", this._babylon_scene );
        material.diffuseColor = new Color3( 0.15, 0.65, 1.0 );
        material.emissiveColor = new Color3( 0.08, 0.16, 0.24 );

        this._box = CreateBox( "custom-box", { size: 120 }, this._babylon_scene );
        this._box.parent = this._babylon_anchor;
        this._box.position = new Vector3( 0, 0, 120 );
        this._box.material = material;
        this._box.alwaysSelectAsActiveMesh = true;

        this._axes = [
            CreateLines( "x-axis", { points: [ Vector3.Zero(), new Vector3( 220, 0, 0 ) ] }, this._babylon_scene ),
            CreateLines( "y-axis", { points: [ Vector3.Zero(), new Vector3( 0, 220, 0 ) ] }, this._babylon_scene ),
            CreateLines( "z-axis", { points: [ Vector3.Zero(), new Vector3( 0, 0, 220 ) ] }, this._babylon_scene ),
        ];

        this._axes[0].color = new Color3( 1, 0.25, 0.25 );
        this._axes[1].color = new Color3( 0.25, 1, 0.25 );
        this._axes[2].color = new Color3( 0.25, 0.6, 1 );

        this._axes.forEach( axis => {
            axis.parent = this._babylon_anchor;
            axis.alwaysSelectAsActiveMesh = true;
        } );
    }


    _dispose_babylon_scene()
    {
        this._babylon_scene?.dispose();
        this._babylon_engine?.dispose();
        this._babylon_scene = undefined;
        this._babylon_engine = undefined;
        this._babylon_camera = undefined;
        this._babylon_anchor = undefined;
        this._box = undefined;
        this._axes = [];
    }


    _update_status()
    {
        if ( !this._status ) {
            return;
        }

        const camera_position = this.getCameraPosition();
        const camera_angle = this.getCameraAngle();
        const webgl_version = this._babylon_engine ? this._babylon_engine.webGLVersion : "(not initialized)";

        this._status.textContent =
            "CustomScene: enabled\n" +
            `Renderer: Babylon.js on shared WebGL${webgl_version} context\n` +
            "Object: spinning box above Tokyo Station\n\n" +
            `Camera: ${camera_position.longitude.toFixed(5)}, ${camera_position.latitude.toFixed(5)}, ${camera_position.height.toFixed(1)}m\n` +
            `Angle: pitch ${camera_angle.pitch.toFixed(1)} / yaw ${camera_angle.yaw.toFixed(1)} / roll ${camera_angle.roll.toFixed(1)}\n` +
            `Scene count: ${this.viewer.custom_scene_collection.num_scenes}\n` +
            `Visible: ${this._custom_scene.visibility}`;
    }
}
