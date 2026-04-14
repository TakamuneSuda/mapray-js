import mapray from "@mapray/mapray-js";
import maprayui from "@mapray/ui";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";


const SHADER_NAME = "customSceneSolid";

Effect.ShadersStore[`${SHADER_NAME}VertexShader`] = `
precision highp float;

attribute vec3 position;

uniform mat4 u_local_to_clip;

void main( void )
{
    gl_Position = u_local_to_clip * vec4( position, 1.0 );
}
`;

Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] = `
precision highp float;

uniform vec4 u_base_color;

void main( void )
{
    gl_FragColor = u_base_color;
}
`;


export default class App extends maprayui.StandardUIViewer {

    constructor( container, options = {} )
    {
        super( container, process.env.MAPRAY_ACCESS_TOKEN, {
            debug_stats: new mapray.DebugStats(),
        } );

        this._status = options.status || undefined;
        this._anchor_to_gocs = mapray.GeoMath.createMatrix();
        this._anchor_to_clip = mapray.GeoMath.createMatrix();
        this._mesh_world = mapray.GeoMath.createMatrix();
        this._mesh_to_clip = mapray.GeoMath.createMatrix();
        this._babylon_engine = undefined;
        this._babylon_scene = undefined;
        this._babylon_camera = undefined;
        this._box = undefined;
        this._meshes = [];

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

        const anchor_geo_point = new mapray.GeoPoint( 139.7671, 35.6812, 180 );
        anchor_geo_point.getMlocsToGocsMatrix( this._anchor_to_gocs );

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
        mapray.GeoMath.mul_GA( stage.gocs_to_clip, this._anchor_to_gocs, this._anchor_to_clip );

        this._update_mesh_materials();

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
        this._babylon_scene.detachControl();
        this._babylon_scene.autoClear = false;
        this._babylon_scene.autoClearDepthAndStencil = false;
        this._babylon_scene.useRightHandedSystem = true;
        this._babylon_scene.preventDefaultOnPointerDown = false;
        this._babylon_scene.preventDefaultOnPointerUp = false;

        this._babylon_camera = new Camera( "mapray-camera", Vector3.Zero(), this._babylon_scene, true );
        this._babylon_camera.viewport = new Viewport( 0, 0, 1, 1 );
        this._babylon_scene.activeCamera = this._babylon_camera;

        this._box = CreateBox( "custom-box", {
            width: 90,
            height: 140,
            depth: 200,
        }, this._babylon_scene );
        this._box.position = new Vector3( 0, 0, 120 );
        this._box.material = this._createSolidMaterial( "box-material", new Color4( 0.18, 0.72, 1.0, 1.0 ) );
        this._box.alwaysSelectAsActiveMesh = true;
        this._box.isPickable = false;

        this._meshes = [
            this._box,
            this._createAxisMesh( "x-axis", { width: 220, height: 5, depth: 5 }, new Vector3( 110, 0, 0 ), new Color4( 1.0, 0.25, 0.25, 1.0 ) ),
            this._createAxisMesh( "y-axis", { width: 5, height: 220, depth: 5 }, new Vector3( 0, 110, 0 ), new Color4( 0.25, 1.0, 0.25, 1.0 ) ),
            this._createAxisMesh( "z-axis", { width: 5, height: 5, depth: 220 }, new Vector3( 0, 0, 110 ), new Color4( 0.25, 0.6, 1.0, 1.0 ) ),
        ];
    }


    _dispose_babylon_scene()
    {
        this._babylon_scene?.dispose();
        this._babylon_engine?.dispose();
        this._babylon_scene = undefined;
        this._babylon_engine = undefined;
        this._babylon_camera = undefined;
        this._box = undefined;
        this._meshes = [];
    }


    _createSolidMaterial( name, color )
    {
        const material = new ShaderMaterial( name, this._babylon_scene, {
            vertex: SHADER_NAME,
            fragment: SHADER_NAME,
        }, {
            attributes: [ "position" ],
            uniforms: [ "u_local_to_clip", "u_base_color" ],
        } );

        material.backFaceCulling = false;
        material.setColor4( "u_base_color", color );

        return material;
    }


    _createAxisMesh( name, size, position, color )
    {
        const axis = CreateBox( name, size, this._babylon_scene );
        axis.position = position;
        axis.material = this._createSolidMaterial( `${name}-material`, color );
        axis.alwaysSelectAsActiveMesh = true;
        axis.isPickable = false;
        return axis;
    }


    _update_mesh_materials()
    {
        for ( const mesh of this._meshes ) {
            const world_matrix = mesh.computeWorldMatrix( true );
            world_matrix.toArray( this._mesh_world );
            mapray.GeoMath.mul_GA( this._anchor_to_clip, this._mesh_world, this._mesh_to_clip );
            mesh.material.setMatrix( "u_local_to_clip", Matrix.FromArray( this._mesh_to_clip ) );
        }
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
