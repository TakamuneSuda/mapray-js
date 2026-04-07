import * as THREE from "three";

import ExternalRendererScene, { ExternalRenderFrame } from "./ExternalRendererScene";
import GeoMath, { GeoPointData } from "./GeoMath";
import type Viewer from "./Viewer";
import type CustomScene from "./CustomScene";


export interface ThreeCustomSceneOption {
    visibility?: boolean;
    anchor_geo_point?: GeoPointData;
    setup?: ( scene: ThreeCustomScene ) => void;
    beforeRender?: ( scene: ThreeCustomScene, frame: ExternalRenderFrame ) => void;
    dispose?: ( scene: ThreeCustomScene ) => void;
}


class ThreeCustomScene {

    private _external_scene: ExternalRendererScene;

    private _scene: THREE.Scene;

    private _camera: THREE.Camera;

    private _renderer!: THREE.WebGLRenderer;

    private _root: THREE.Group;

    private _identity: Matrix4Like;

    private _view_to_local: Matrix4Like;

    private _before_render?: ( scene: ThreeCustomScene, frame: ExternalRenderFrame ) => void;

    private _on_dispose?: ( scene: ThreeCustomScene ) => void;


    constructor( viewer: Viewer, option: ThreeCustomSceneOption = {} )
    {
        this._scene = new THREE.Scene();
        this._camera = new THREE.Camera();
        this._camera.matrixAutoUpdate = false;
        this._camera.matrixWorldAutoUpdate = false;

        this._root = new THREE.Group();
        this._root.matrixAutoUpdate = false;
        this._scene.add( this._root );

        this._identity = new Float64Array( 16 );
        GeoMath.setIdentity( this._identity );
        this._view_to_local = new Float64Array( 16 );

        this._before_render = option.beforeRender;
        this._on_dispose = option.dispose;

        this._external_scene = new ExternalRendererScene( viewer, {
            visibility: option.visibility,
            anchor_geo_point: option.anchor_geo_point,
            adapter: {
                initialize: init => this._initializeRenderer( init.canvas, init.context ),
                render: frame => this._render( frame ),
                dispose: () => this._dispose(),
            },
        } );

        option.setup?.( this );
    }


    get scene(): THREE.Scene { return this._scene; }

    get camera(): THREE.Camera { return this._camera; }

    get renderer(): THREE.WebGLRenderer { return this._renderer; }

    get root(): THREE.Group { return this._root; }

    get custom_scene(): CustomScene { return this._external_scene.custom_scene; }

    get external_scene(): ExternalRendererScene { return this._external_scene; }


    setVisibility( visibility: boolean ): void
    {
        this._external_scene.setVisibility( visibility );
    }


    setAnchorGeoPoint( anchor_geo_point?: GeoPointData ): void
    {
        this._external_scene.setAnchorGeoPoint( anchor_geo_point );
    }


    destroy(): void
    {
        this._external_scene.destroy();
    }


    private _initializeRenderer( canvas: HTMLCanvasElement, context: WebGL2RenderingContext ): void
    {
        this._renderer = new THREE.WebGLRenderer( {
            canvas,
            context,
            alpha: true,
            antialias: true,
        } );
        this._renderer.autoClear = false;
        this._renderer.sortObjects = false;
    }


    private _render( frame: ExternalRenderFrame ): void
    {
        const root_matrix = frame.anchor_to_gocs ? this._identity : this._identity;
        this._root.matrix.fromArray( root_matrix );
        this._root.matrixWorldNeedsUpdate = true;
        this._root.updateMatrixWorld( true );

        if ( frame.gocs_to_anchor && frame.anchor_to_view ) {
            GeoMath.mul_AA( frame.gocs_to_anchor, frame.view_to_gocs, this._view_to_local );
            this._camera.matrixWorld.fromArray( this._view_to_local );
            this._camera.matrixWorldInverse.fromArray( frame.anchor_to_view );
        }
        else {
            this._camera.matrixWorld.fromArray( frame.view_to_gocs );
            this._camera.matrixWorldInverse.fromArray( frame.gocs_to_view );
        }
        this._camera.projectionMatrix.fromArray( frame.view_to_clip );
        this._camera.projectionMatrixInverse.copy( this._camera.projectionMatrix ).invert();
        this._camera.updateMatrixWorld( true );

        this._before_render?.( this, frame );

        this._renderer.resetState();
        this._renderer.autoClear = false;
        this._renderer.setViewport( 0, 0, frame.width, frame.height );
        this._renderer.render( this._scene, this._camera );
        this._renderer.resetState();
    }


    private _dispose(): void
    {
        this._on_dispose?.( this );
        this._renderer?.dispose();
    }
}


type Matrix4Like = Float64Array | Float32Array;


export default ThreeCustomScene;
