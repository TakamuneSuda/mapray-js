import GeoMath, { GeoPointData, Matrix } from "./GeoMath";
import GeoPoint from "./GeoPoint";
import type Viewer from "./Viewer";
import RenderStage from "./RenderStage";
import type CustomScene from "./CustomScene";


export interface ExternalRendererInit {
    viewer: Viewer;
    scene: ExternalRendererScene;
    canvas: HTMLCanvasElement;
    context: WebGL2RenderingContext;
}


export interface ExternalRenderFrame {
    viewer: Viewer;
    scene: ExternalRendererScene;
    canvas: HTMLCanvasElement;
    context: WebGL2RenderingContext;
    stage: RenderStage;
    width: number;
    height: number;
    gocs_to_view: Matrix;
    view_to_gocs: Matrix;
    gocs_to_clip: Matrix;
    view_to_clip: Matrix;
    anchor_geo_point?: GeoPointData;
    anchor_to_gocs?: Matrix;
    gocs_to_anchor?: Matrix;
    anchor_to_view?: Matrix;
    anchor_to_clip?: Matrix;
}


export interface ExternalRendererAdapter {
    initialize?( init: ExternalRendererInit ): void;
    render( frame: ExternalRenderFrame ): void;
    endFrame?( frame: ExternalRenderFrame ): void;
    dispose?(): void;
}


export interface ExternalRendererSceneOption {
    adapter: ExternalRendererAdapter;
    visibility?: boolean;
    anchor_geo_point?: GeoPointData;
}


class ExternalRendererScene {

    private _viewer: Viewer;

    private _adapter: ExternalRendererAdapter;

    private _canvas: HTMLCanvasElement;

    private _context: WebGL2RenderingContext;

    private _custom_scene: CustomScene;

    private _geo_point: GeoPoint;

    private _anchor_geo_point?: GeoPointData;

    private _gocs_to_view: Matrix;

    private _view_to_gocs: Matrix;

    private _gocs_to_clip: Matrix;

    private _view_to_clip: Matrix;

    private _anchor_to_gocs: Matrix;

    private _gocs_to_anchor: Matrix;

    private _anchor_to_view: Matrix;

    private _anchor_to_clip: Matrix;

    private _frame: ExternalRenderFrame;


    constructor( viewer: Viewer, option: ExternalRendererSceneOption )
    {
        this._viewer = viewer;
        this._adapter = option.adapter;
        this._canvas = viewer.canvas_element;
        this._context = viewer.glenv.context;
        this._geo_point = new GeoPoint();
        this._gocs_to_view = GeoMath.createMatrix();
        this._view_to_gocs = GeoMath.createMatrix();
        this._gocs_to_clip = GeoMath.createMatrix();
        this._view_to_clip = GeoMath.createMatrix();
        this._anchor_to_gocs = GeoMath.createMatrix();
        this._gocs_to_anchor = GeoMath.createMatrix();
        this._anchor_to_view = GeoMath.createMatrix();
        this._anchor_to_clip = GeoMath.createMatrix();

        this._frame = {
            viewer: this._viewer,
            scene: this,
            canvas: this._canvas,
            context: this._context,
            stage: undefined as unknown as RenderStage,
            width: 0,
            height: 0,
            gocs_to_view: this._gocs_to_view,
            view_to_gocs: this._view_to_gocs,
            gocs_to_clip: this._gocs_to_clip,
            view_to_clip: this._view_to_clip,
        };

        if ( option.anchor_geo_point ) {
            this.setAnchorGeoPoint( option.anchor_geo_point );
        }

        this._custom_scene = this._viewer.custom_scene_collection.createScene( {
            visibility: option.visibility,
            draw: stage => this._draw( stage ),
            endFrame: () => this._endFrame(),
            destroy: () => this._dispose(),
        } );

        this._adapter.initialize?.( {
            viewer: this._viewer,
            scene: this,
            canvas: this._canvas,
            context: this._context,
        } );
    }


    get viewer(): Viewer { return this._viewer; }

    get canvas(): HTMLCanvasElement { return this._canvas; }

    get context(): WebGL2RenderingContext { return this._context; }

    get custom_scene(): CustomScene { return this._custom_scene; }

    get anchor_geo_point(): GeoPointData | undefined { return this._anchor_geo_point; }


    setVisibility( visibility: boolean ): void
    {
        this._custom_scene.setVisibility( visibility );
    }


    setAnchorGeoPoint( anchor_geo_point?: GeoPointData ): void
    {
        if ( !anchor_geo_point ) {
            this._anchor_geo_point = undefined;
            delete this._frame.anchor_geo_point;
            delete this._frame.anchor_to_gocs;
            delete this._frame.gocs_to_anchor;
            delete this._frame.anchor_to_view;
            delete this._frame.anchor_to_clip;
            return;
        }

        this._anchor_geo_point = { ...anchor_geo_point };
        this._geo_point.longitude = anchor_geo_point.longitude;
        this._geo_point.latitude = anchor_geo_point.latitude;
        this._geo_point.altitude = anchor_geo_point.height;
        this._geo_point.getMlocsToGocsMatrix( this._anchor_to_gocs );
        GeoMath.inverse_A( this._anchor_to_gocs, this._gocs_to_anchor );

        this._frame.anchor_geo_point = this._anchor_geo_point;
        this._frame.anchor_to_gocs = this._anchor_to_gocs;
        this._frame.gocs_to_anchor = this._gocs_to_anchor;
        this._frame.anchor_to_view = this._anchor_to_view;
        this._frame.anchor_to_clip = this._anchor_to_clip;
    }


    destroy(): void
    {
        this._custom_scene.destroy();
    }


    private _draw( stage: RenderStage ): void
    {
        if ( stage.getRenderTarget() !== RenderStage.RenderTarget.SCENE ) {
            return;
        }

        this._frame.stage = stage;
        this._frame.width = stage.width;
        this._frame.height = stage.height;

        GeoMath.copyMatrix( stage.gocs_to_view, this._gocs_to_view );
        GeoMath.copyMatrix( stage.view_to_gocs, this._view_to_gocs );
        GeoMath.copyMatrix( stage.gocs_to_clip, this._gocs_to_clip );
        GeoMath.mul_GA( stage.gocs_to_clip, stage.view_to_gocs, this._view_to_clip );

        if ( this._anchor_geo_point ) {
            GeoMath.mul_GA( stage.gocs_to_view, this._anchor_to_gocs, this._anchor_to_view );
            GeoMath.mul_GA( stage.gocs_to_clip, this._anchor_to_gocs, this._anchor_to_clip );
        }

        this._adapter.render( this._frame );
    }


    private _endFrame(): void
    {
        if ( this._frame.stage ) {
            this._adapter.endFrame?.( this._frame );
        }
    }


    private _dispose(): void
    {
        this._adapter.dispose?.();
    }
}


export default ExternalRendererScene;
