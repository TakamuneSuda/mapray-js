import GeoMath, { Matrix, Vector3 } from "./GeoMath";
import GeoPoint from "./GeoPoint";
import Mesh from "./Mesh";
import MeshBuffer from "./MeshBuffer";
import Primitive from "./Primitive";
import RenderStage from "./RenderStage";
import Resource, { URLResource } from "./Resource";
import Viewer from "./Viewer";
import CustomScene from "./CustomScene";
import ModelContainer from "./ModelContainer";
import EntityMaterial from "./EntityMaterial";
import GltfTool from "./gltf/Tool";
import WasmTool from "./WasmTool";


type ContentType = "gltf" | "glb" | "b3dm" | "i3dm" | "pnts" | "cmpt" | "external_tileset";
type TileRefine = "ADD" | "REPLACE";

let dracoDecoderModulePromise: Promise<any> | null = null;
let dracoJsDecoderModulePromise: Promise<any> | null = null;
let dracoMainThreadDecodeTail: Promise<void> = Promise.resolve();
const dracoScriptLoadPromises = new Map<string, Promise<void>>();
let warnedDracoMeshWorkerFallback = false;
let warnedDracoJsFallbackDisable = false;
let dracoJsFallbackDisabled = false;
const temp_bounding_point = GeoMath.createVector3();
const temp_bounding_center = GeoMath.createVector3();
const THREE_D_TILES_MODULE_BASE_URL = (() => {
    try {
        const current_script =
            typeof document !== "undefined" && document.currentScript instanceof HTMLScriptElement ?
                document.currentScript.src :
                null;
        if ( current_script ) {
            return new URL( ".", current_script ).toString();
        }
        if ( typeof window !== "undefined" && typeof window.location?.href === "string" ) {
            return new URL( ".", window.location.href ).toString();
        }
        return null;
    }
    catch {
        return null;
    }
})();
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_SEMI_MAJOR_AXIS = 6378137.0;
const WGS84_SEMI_MINOR_AXIS = WGS84_SEMI_MAJOR_AXIS * (1 - WGS84_FLATTENING);
const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const WGS84_SECOND_ECCENTRICITY_SQUARED =
    (WGS84_SEMI_MAJOR_AXIS * WGS84_SEMI_MAJOR_AXIS - WGS84_SEMI_MINOR_AXIS * WGS84_SEMI_MINOR_AXIS) /
    (WGS84_SEMI_MINOR_AXIS * WGS84_SEMI_MINOR_AXIS);
const PNTS_TRANSFORM_WORKER_SOURCE = `
const DEGREE = Math.PI / 180.0;
const EARTH_RADIUS = 6378137.0;
const WGS84_FLATTENING = 1 / 298.257223563;
const WGS84_SEMI_MAJOR_AXIS = 6378137.0;
const WGS84_SEMI_MINOR_AXIS = WGS84_SEMI_MAJOR_AXIS * (1 - WGS84_FLATTENING);
const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING);
const WGS84_SECOND_ECCENTRICITY_SQUARED =
    (WGS84_SEMI_MAJOR_AXIS * WGS84_SEMI_MAJOR_AXIS - WGS84_SEMI_MINOR_AXIS * WGS84_SEMI_MINOR_AXIS) /
    (WGS84_SEMI_MINOR_AXIS * WGS84_SEMI_MINOR_AXIS);

function transformPosition(mat, x, y, z) {
    return [
        x*mat[0] + y*mat[4] + z*mat[8] + mat[12],
        x*mat[1] + y*mat[5] + z*mat[9] + mat[13],
        x*mat[2] + y*mat[6] + z*mat[10] + mat[14],
    ];
}

function transformDirection(mat, x, y, z) {
    return [
        x*mat[0] + y*mat[4] + z*mat[8],
        x*mat[1] + y*mat[5] + z*mat[9],
        x*mat[2] + y*mat[6] + z*mat[10],
    ];
}

function normalize(vec) {
    const length = Math.hypot(vec[0], vec[1], vec[2]);
    if ( length <= 1e-12 ) {
        return [0, 0, 1];
    }
    return [vec[0] / length, vec[1] / length, vec[2] / length];
}

function convertEcefToGeo(position) {
    const x = position[0];
    const y = position[1];
    const z = position[2];
    const xy = Math.hypot(x, y);

    let latitude;
    let altitude;

    if ( xy < 1e-9 ) {
        latitude = z >= 0 ? 90 : -90;
        altitude = Math.abs(z) - WGS84_SEMI_MINOR_AXIS;
    }
    else {
        const theta = Math.atan2(WGS84_SEMI_MAJOR_AXIS * z, WGS84_SEMI_MINOR_AXIS * xy);
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);
        const latitudeRad = Math.atan2(
            z + WGS84_SECOND_ECCENTRICITY_SQUARED * WGS84_SEMI_MINOR_AXIS * sinTheta*sinTheta*sinTheta,
            xy - WGS84_ECCENTRICITY_SQUARED * WGS84_SEMI_MAJOR_AXIS * cosTheta*cosTheta*cosTheta
        );
        const sinLatitude = Math.sin(latitudeRad);
        const primeVerticalRadius = WGS84_SEMI_MAJOR_AXIS / Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude*sinLatitude);

        latitude = latitudeRad / DEGREE;
        altitude = xy / Math.cos(latitudeRad) - primeVerticalRadius;
    }

    return {
        longitude: Math.atan2(y, x) / DEGREE,
        latitude,
        altitude,
    };
}

function geoToMaprayGocs(geo) {
    const lambda = geo.longitude * DEGREE;
    const phi = geo.latitude * DEGREE;
    const radius = EARTH_RADIUS + geo.altitude;
    const cosPhi = Math.cos(phi);
    return [
        radius * cosPhi * Math.cos(lambda),
        radius * cosPhi * Math.sin(lambda),
        radius * Math.sin(phi),
    ];
}

function getMlocsBasis(geo) {
    const lambda = geo.longitude * DEGREE;
    const phi = geo.latitude * DEGREE;
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);

    return {
        east: [ -sinLambda, cosLambda, 0 ],
        north: [ -cosLambda * sinPhi, -sinLambda * sinPhi, cosPhi ],
        up: [ cosPhi * cosLambda, cosPhi * sinLambda, sinPhi ],
    };
}

function dot3(a0, a1, a2, b) {
    return a0*b[0] + a1*b[1] + a2*b[2];
}

function packColor(value) {
    const clamped = Math.min(1, Math.max(0, value));
    return Math.round(clamped * 255);
}

function packNormal(value) {
    const clamped = Math.min(1, Math.max(-1, value));
    return Math.round(clamped * 127);
}

self.onmessage = function(event) {
    const data = event.data;

    try {
        const tileTransform = data.tileTransform;
        const rtcCenter = data.rtcCenter;
        const positions = data.positions;
        const colors = data.colors;
        const normals = data.normals;
        const count = positions.length / 3;

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;

        for ( let i = 0; i < count; ++i ) {
            const x = positions[3*i + 0];
            const y = positions[3*i + 1];
            const z = positions[3*i + 2];
            if ( x < minX ) minX = x;
            if ( y < minY ) minY = y;
            if ( z < minZ ) minZ = z;
            if ( x > maxX ) maxX = x;
            if ( y > maxY ) maxY = y;
            if ( z > maxZ ) maxZ = z;
        }

        const anchorTile = [
            rtcCenter[0] + 0.5 * (minX + maxX),
            rtcCenter[1] + 0.5 * (minY + maxY),
            rtcCenter[2] + 0.5 * (minZ + maxZ),
        ];
        const anchorEcef = transformPosition(tileTransform, anchorTile[0], anchorTile[1], anchorTile[2]);
        const anchorGeo = convertEcefToGeo(anchorEcef);
        const anchorMapray = geoToMaprayGocs(anchorGeo);
        const basis = getMlocsBasis(anchorGeo);

        const transformedPositions = new Float32Array(count * 3);
        const packedColors = new Uint8Array(count * 4);
        const packedNormals = normals ? new Int8Array(count * 4) : null;
        const bboxMin = new Float32Array([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
        const bboxMax = new Float32Array([Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]);

        for ( let i = 0; i < count; ++i ) {
            const tileX = rtcCenter[0] + positions[3*i + 0];
            const tileY = rtcCenter[1] + positions[3*i + 1];
            const tileZ = rtcCenter[2] + positions[3*i + 2];
            const worldEcef = transformPosition(tileTransform, tileX, tileY, tileZ);
            const worldMapray = geoToMaprayGocs(convertEcefToGeo(worldEcef));
            const dx = worldMapray[0] - anchorMapray[0];
            const dy = worldMapray[1] - anchorMapray[1];
            const dz = worldMapray[2] - anchorMapray[2];

            const localX = dot3(dx, dy, dz, basis.east);
            const localY = dot3(dx, dy, dz, basis.north);
            const localZ = dot3(dx, dy, dz, basis.up);

            transformedPositions[3*i + 0] = localX;
            transformedPositions[3*i + 1] = localY;
            transformedPositions[3*i + 2] = localZ;

            if ( localX < bboxMin[0] ) bboxMin[0] = localX;
            if ( localY < bboxMin[1] ) bboxMin[1] = localY;
            if ( localZ < bboxMin[2] ) bboxMin[2] = localZ;
            if ( localX > bboxMax[0] ) bboxMax[0] = localX;
            if ( localY > bboxMax[1] ) bboxMax[1] = localY;
            if ( localZ > bboxMax[2] ) bboxMax[2] = localZ;

            packedColors[4*i + 0] = packColor(colors[4*i + 0]);
            packedColors[4*i + 1] = packColor(colors[4*i + 1]);
            packedColors[4*i + 2] = packColor(colors[4*i + 2]);
            packedColors[4*i + 3] = packColor(colors[4*i + 3]);

            if ( packedNormals ) {
                const worldNormal = transformDirection(tileTransform, normals[3*i + 0], normals[3*i + 1], normals[3*i + 2]);
                const localNormal = normalize([
                    dot3(worldNormal[0], worldNormal[1], worldNormal[2], basis.east),
                    dot3(worldNormal[0], worldNormal[1], worldNormal[2], basis.north),
                    dot3(worldNormal[0], worldNormal[1], worldNormal[2], basis.up),
                ]);

                packedNormals[4*i + 0] = packNormal(localNormal[0]);
                packedNormals[4*i + 1] = packNormal(localNormal[1]);
                packedNormals[4*i + 2] = packNormal(localNormal[2]);
                packedNormals[4*i + 3] = 0;
            }
        }

        const transferables = [
            transformedPositions.buffer,
            packedColors.buffer,
            bboxMin.buffer,
            bboxMax.buffer,
        ];
        if ( packedNormals ) {
            transferables.push(packedNormals.buffer);
        }

        self.postMessage({
            taskId: data.taskId,
            result: {
                positions: transformedPositions,
                colors: packedColors,
                normals: packedNormals,
                bboxMin,
                bboxMax,
                anchorGeo,
            },
        }, transferables);
    }
    catch (error) {
        self.postMessage({
            taskId: data.taskId,
            error: error && error.message ? error.message : String(error),
        });
    }
};
`;


interface PntsTransformWorkerResult {
    positions: Float32Array;
    colors: Uint8Array;
    normals: Int8Array | null;
    bboxMin: Vector3;
    bboxMax: Vector3;
    anchorGeo: {
        longitude: number;
        latitude: number;
        altitude: number;
    };
}


interface DracoMeshWorkerResult {
    vertexCount: number;
    attributes: DracoMeshDecodeWorkerPool.WorkerAttributeResult[];
    indices: DracoMeshDecodeWorkerPool.WorkerIndicesResult | null;
}


class PntsTransformWorkerPool {

    private readonly _workers: PntsTransformWorkerPool.Slot[];

    private readonly _queue: PntsTransformWorkerPool.Pending[];

    private _next_task_id: number;

    private constructor( workers: PntsTransformWorkerPool.Slot[] )
    {
        this._workers = workers;
        this._queue = [];
        this._next_task_id = 1;
    }


    static create( worker_count: number ): PntsTransformWorkerPool | null
    {
        if (
            typeof window === "undefined" ||
            typeof window.Worker === "undefined" ||
            typeof window.Blob === "undefined" ||
            typeof window.URL?.createObjectURL !== "function"
        ) {
            return null;
        }

        const worker_url = window.URL.createObjectURL(
            new window.Blob( [PNTS_TRANSFORM_WORKER_SOURCE], { type: "text/javascript" } )
        );

        try {
            const workers: PntsTransformWorkerPool.Slot[] = [];
            for ( let i = 0; i < worker_count; ++i ) {
                workers.push( { worker: new window.Worker( worker_url ), busy: false } );
            }

            return new PntsTransformWorkerPool( workers );
        }
        catch ( error ) {
            console.warn( "Failed to create pnts worker pool", error );
            return null;
        }
        finally {
            window.URL.revokeObjectURL( worker_url );
        }
    }


    run(
        payload: Omit<PntsTransformWorkerPool.WorkerRequest, "taskId">,
        transferables: Transferable[]
    ): Promise<PntsTransformWorkerResult>
    {
        return new Promise( ( resolve, reject ) => {
            this._queue.push( {
                task_id: this._next_task_id++,
                payload,
                transferables,
                resolve,
                reject,
            } );
            this._dispatch();
        } );
    }


    destroy(): void
    {
        for ( const slot of this._workers ) {
            slot.worker.terminate();
            if ( slot.pending ) {
                slot.pending.reject( new Error( "pnts worker pool was destroyed" ) );
                slot.pending = undefined;
            }
        }

        while ( this._queue.length > 0 ) {
            this._queue.shift()!.reject( new Error( "pnts worker pool was destroyed" ) );
        }
    }


    private _dispatch(): void
    {
        for ( const slot of this._workers ) {
            if ( slot.busy || this._queue.length === 0 ) {
                continue;
            }

            const pending = this._queue.shift()!;
            slot.busy = true;
            slot.pending = pending;

            slot.worker.onmessage = event => {
                slot.busy = false;
                const current = slot.pending;
                slot.pending = undefined;

                if ( current ) {
                    if ( event.data?.error ) {
                        current.reject( new Error( String( event.data.error ) ) );
                    }
                    else {
                        current.resolve( event.data.result as PntsTransformWorkerResult );
                    }
                }

                this._dispatch();
            };

            slot.worker.onerror = event => {
                slot.busy = false;
                const current = slot.pending;
                slot.pending = undefined;
                if ( current ) {
                    current.reject( event.error instanceof Error ? event.error : new Error( event.message || "Worker error" ) );
                }
                this._dispatch();
            };

            slot.worker.postMessage(
                {
                    taskId: pending.task_id,
                    ...pending.payload,
                },
                pending.transferables
            );
        }
    }

}


namespace PntsTransformWorkerPool {

export interface WorkerRequest {
    taskId: number;
    tileTransform: Matrix;
    rtcCenter: Vector3;
    positions: Float32Array;
    colors: Float32Array;
    normals: Float32Array | null;
}


export interface Pending {
    task_id: number;
    payload: Omit<WorkerRequest, "taskId">;
    transferables: Transferable[];
    resolve: ( value: PntsTransformWorkerResult ) => void;
    reject: ( error: Error ) => void;
}


export interface Slot {
    worker: Worker;
    busy: boolean;
    pending?: Pending;
}


}


class DracoMeshDecodeWorkerPool {

    private readonly _workers: DracoMeshDecodeWorkerPool.Slot[];

    private readonly _queue: DracoMeshDecodeWorkerPool.Pending[];

    private _next_task_id: number;

    private _broken: boolean;

    private constructor( workers: DracoMeshDecodeWorkerPool.Slot[] )
    {
        this._workers = workers;
        this._queue = [];
        this._next_task_id = 1;
        this._broken = false;
    }


    static create( worker_url: string | null, script_url: string | null, wasm_url: string | null, worker_count: number ): DracoMeshDecodeWorkerPool | null
    {
        if (
            !worker_url ||
            !script_url ||
            !wasm_url ||
            typeof window === "undefined" ||
            typeof window.Worker === "undefined"
        ) {
            return null;
        }

        try {
            const workers: DracoMeshDecodeWorkerPool.Slot[] = [];
            const pool = new DracoMeshDecodeWorkerPool( workers );
            for ( let i = 0; i < worker_count; ++i ) {
                const worker = new window.Worker( worker_url );
                const slot: DracoMeshDecodeWorkerPool.Slot = {
                    worker,
                    busy: true,
                    ready: false,
                };
                worker.onmessage = event => pool._handleWorkerMessage( slot, event );
                worker.onerror = event => pool._handleWorkerError( slot, event );
                worker.postMessage( {
                    type: "init",
                    scriptUrl: script_url,
                    wasmUrl: wasm_url,
                } );
                workers.push( slot );
            }

            return pool;
        }
        catch ( error ) {
            console.warn( "Failed to create Draco mesh worker pool", error );
            return null;
        }
    }


    run(
        payload: Omit<DracoMeshDecodeWorkerPool.WorkerRequest, "taskId">,
        transferables: Transferable[]
    ): Promise<DracoMeshWorkerResult>
    {
        return new Promise( ( resolve, reject ) => {
            if ( this._broken ) {
                reject( new Error( "Draco mesh worker pool is disabled after a fatal decode error" ) );
                return;
            }

            this._queue.push( {
                task_id: this._next_task_id++,
                payload,
                transferables,
                resolve,
                reject,
            } );
            this._dispatch();
        } );
    }


    destroy(): void
    {
        this._broken = true;
        for ( const slot of this._workers ) {
            slot.worker.terminate();
            if ( slot.pending ) {
                slot.pending.reject( new Error( "Draco mesh worker pool was destroyed" ) );
                slot.pending = undefined;
            }
        }

        while ( this._queue.length > 0 ) {
            this._queue.shift()!.reject( new Error( "Draco mesh worker pool was destroyed" ) );
        }
    }


    private _dispatch(): void
    {
        if ( this._broken ) {
            return;
        }

        for ( const slot of this._workers ) {
            if ( !slot.ready || slot.busy || this._queue.length === 0 ) {
                continue;
            }

            const pending = this._queue.shift()!;
            slot.busy = true;
            slot.pending = pending;

            slot.worker.postMessage(
                {
                    type: "decodePrimitive",
                    taskId: pending.task_id,
                    ...pending.payload,
                },
                pending.transferables
            );
        }
    }


    private static _isFatalWorkerErrorMessage( message: string ): boolean
    {
        return /memory access out of bounds|table index is out of bounds/u.test( message );
    }


    private _handleWorkerMessage( slot: DracoMeshDecodeWorkerPool.Slot, event: MessageEvent<any> ): void
    {
        const data = event.data ?? {};

        if ( data.type === "initResult" ) {
            slot.busy = false;
            if ( data.ok ) {
                slot.ready = true;
                this._dispatch();
            }
            else {
                this._break( new Error( String( data.error || "Failed to initialize Draco mesh worker" ) ) );
            }
            return;
        }

        slot.busy = false;
        const current = slot.pending;
        slot.pending = undefined;

        if ( !current ) {
            this._dispatch();
            return;
        }

        if ( data?.error ) {
            const error = new Error( String( data.error ) );
            if ( data?.fatal === true || DracoMeshDecodeWorkerPool._isFatalWorkerErrorMessage( error.message ) ) {
                this._break( error );
            }
            current.reject( error );
        }
        else {
            current.resolve( data.result as DracoMeshWorkerResult );
        }

        this._dispatch();
    }


    private _handleWorkerError( slot: DracoMeshDecodeWorkerPool.Slot, event: ErrorEvent ): void
    {
        slot.busy = false;
        const error = event.error instanceof Error ? event.error : new Error( event.message || "Worker error" );
        const current = slot.pending;
        slot.pending = undefined;

        if ( DracoMeshDecodeWorkerPool._isFatalWorkerErrorMessage( error.message ) ) {
            this._break( error );
        }

        if ( current ) {
            current.reject( error );
        }

        if ( !slot.ready ) {
            this._break( error );
        }

        this._dispatch();
    }


    private _break( error: Error ): void
    {
        if ( this._broken ) {
            return;
        }

        this._broken = true;
        console.warn( "Disabling Draco mesh worker pool after fatal decode error", error );
        for ( const slot of this._workers ) {
            slot.worker.terminate();
            slot.busy = false;
            if ( slot.pending ) {
                slot.pending = undefined;
            }
        }
        while ( this._queue.length > 0 ) {
            this._queue.shift()!.reject( new Error( "Draco mesh worker pool is disabled after a fatal decode error" ) );
        }
    }

}


namespace DracoMeshDecodeWorkerPool {

export interface WorkerAttributeSpec {
    semantic: string;
    uniqueId: number;
    accessorIndex: number;
    accessorType: string;
    componentType: number;
    normalized: boolean;
}


export interface WorkerAttributeResult {
    accessorIndex: number;
    values: ThreeDTileset.NumericArray;
    type: string;
    componentType: number;
    normalized: boolean;
    min: number[] | null;
    max: number[] | null;
}


export interface WorkerIndicesResult {
    accessorIndex: number | null;
    componentType: number;
    values: Uint8Array | Uint16Array | Uint32Array;
}


export interface WorkerRequest {
    taskId: number;
    payload: ArrayBuffer;
    bufferViewIndex: number;
    primitiveMode: number;
    attributes: WorkerAttributeSpec[];
    indexAccessorIndex: number | null;
    indexComponentType: number | null;
}


export interface Pending {
    task_id: number;
    payload: Omit<WorkerRequest, "taskId">;
    transferables: Transferable[];
    resolve: ( value: DracoMeshWorkerResult ) => void;
    reject: ( error: Error ) => void;
}


export interface Slot {
    worker: Worker;
    busy: boolean;
    ready: boolean;
    pending?: Pending;
}


}


/**
 * 3D Tiles tileset を描画するランタイム。
 *
 * B3dScene と同様に、描画フレームでは必要タイルを選別し、
 * 実リクエストはフレーム終端で優先度順に処理する。
 */
class ThreeDTileset {

    private readonly _viewer: Viewer;

    private readonly _resource: Resource;

    private readonly _custom_scene: CustomScene;

    private readonly _maximum_screen_space_error: number;

    private readonly _max_concurrent_requests: number;

    private readonly _max_cached_tiles: number;

    private readonly _cache_hold_frames: number;

    private readonly _point_size: number;

    private readonly _point_shape: ThreeDTileset.PointShape;

    private readonly _model_matrix: Matrix;

    private readonly _point_material: ThreeDTilesPointMaterial;

    private readonly _model_primitive_cache: Map<string, Promise<Primitive[]>>;

    private readonly _cache_retained_meshes: Map<string, Mesh[]>;

    private readonly _mesh_ref_counts: Map<Mesh, number>;

    private readonly _pnts_worker_pool: PntsTransformWorkerPool | null;

    private readonly _draco_mesh_worker_pool: DracoMeshDecodeWorkerPool | null;

    private readonly _draco_decoder_script_url: string | null;

    private readonly _draco_decoder_js_url: string | null;

    private readonly _draco_decoder_wasm_url: string | null;

    private readonly _opaque_primitives: Primitive[];

    private readonly _translucent_primitives: Primitive[];

    private readonly _cached_touched_tiles: ThreeDTileset.Tile[];

    private readonly _cached_gocs_to_view: Matrix;

    private readonly _cached_gocs_to_clip: Matrix;

    private _root_tile: ThreeDTileset.Tile | null;

    private _active_requests: number;

    private _frame_counter: number;

    private _request_queue: ThreeDTileset.LoadRequest[];

    private _loaded_tiles: Set<ThreeDTileset.Tile>;

    private _destroyed: boolean;

    private _ready: boolean;

    private _load_error: Error | null;

    private _frame_cache_valid: boolean;

    private _frame_cache_dirty: boolean;

    private _frame_has_unresolved_tiles: boolean;

    private _cached_pixel_step: number;


    constructor( viewer: Viewer, resource: Resource | string | ThreeDTileset.ResourceInfo, options: ThreeDTileset.Option = {} )
    {
        this._viewer = viewer;
        this._resource = ThreeDTileset._normalizeResource( resource, options );
        this._maximum_screen_space_error = options.maximumScreenSpaceError ?? 16.0;
        this._max_concurrent_requests = Math.max( 1, Math.floor( options.maxConcurrentRequests ?? 8 ) );
        this._max_cached_tiles = Math.max( this._max_concurrent_requests, Math.floor( options.maxCachedTiles ?? 256 ) );
        this._cache_hold_frames = Math.max( 1, Math.floor( options.cacheHoldFrames ?? 60 ) );
        this._point_size = Math.max( 1, Number( options.pointSize ?? 5.0 ) );
        this._point_shape = ThreeDTileset._normalizePointShape( options.pointShape );
        this._model_matrix = GeoMath.createMatrix( options.model_matrix ?? GeoMath.setIdentity( GeoMath.createMatrix() ) );
        this._point_material = new ThreeDTilesPointMaterial( viewer.glenv, this._point_shape );
        this._model_primitive_cache = new Map();
        this._cache_retained_meshes = new Map();
        this._mesh_ref_counts = new Map();
        const draco_decoder_script_url = ThreeDTileset._resolveBrowserUrl(
            options.dracoDecoderScriptUrl ??
            ThreeDTileset._getGlobalString( "dracoDecoderScriptUrl" ) ??
            ThreeDTileset._getGlobalString( "dracoDecoderScript" ) ??
            ThreeDTileset._getDefaultBrowserAssetUrl( "vendor/draco_wasm_wrapper.js" )
        );
        this._draco_decoder_script_url = draco_decoder_script_url;
        const draco_decoder_wasm_url = ThreeDTileset._resolveBrowserUrl(
            options.dracoDecoderWasmUrl ??
            ThreeDTileset._getGlobalString( "dracoDecoderWasmUrl" ) ??
            ThreeDTileset._getGlobalString( "dracoDecoderWasm" ) ??
            ThreeDTileset._getDefaultBrowserAssetUrl( "vendor/draco_decoder.wasm" )
        );
        this._draco_decoder_wasm_url = draco_decoder_wasm_url;
        const draco_decoder_worker_url = ThreeDTileset._resolveBrowserUrl(
            options.dracoDecoderWorkerUrl ?? ThreeDTileset._getGlobalString( "dracoDecoderWorkerUrl" )
        );
        this._draco_decoder_js_url = ThreeDTileset._resolveBrowserUrl(
            options.dracoDecoderJsUrl ??
            ThreeDTileset._getGlobalString( "dracoDecoderJsUrl" )
        );
        this._pnts_worker_pool = PntsTransformWorkerPool.create(
            Math.max(
                1,
                Math.min(
                    this._max_concurrent_requests,
                    Math.min(
                        4,
                        typeof navigator !== "undefined" && Number.isFinite( navigator.hardwareConcurrency ) ?
                            Math.max( 1, navigator.hardwareConcurrency - 1 ) :
                            1
                    )
                )
            )
        );
        this._draco_mesh_worker_pool = DracoMeshDecodeWorkerPool.create(
            draco_decoder_worker_url,
            draco_decoder_script_url,
            draco_decoder_wasm_url,
            Math.max(
                1,
                Math.min(
                    2,
                    this._max_concurrent_requests,
                    typeof navigator !== "undefined" && Number.isFinite( navigator.hardwareConcurrency ) ?
                        Math.max( 1, navigator.hardwareConcurrency - 1 ) :
                        1
                )
            )
        );
        this._opaque_primitives = [];
        this._translucent_primitives = [];
        this._cached_touched_tiles = [];
        this._cached_gocs_to_view = GeoMath.createMatrix();
        this._cached_gocs_to_clip = GeoMath.createMatrix();

        this._root_tile = null;
        this._active_requests = 0;
        this._frame_counter = 0;
        this._request_queue = [];
        this._loaded_tiles = new Set();
        this._destroyed = false;
        this._ready = false;
        this._load_error = null;
        this._frame_cache_valid = false;
        this._frame_cache_dirty = true;
        this._frame_has_unresolved_tiles = true;
        this._cached_pixel_step = Number.NaN;

        this._custom_scene = viewer.custom_scene_collection.createScene( {
            visibility: options.visibility ?? true,
            draw: stage => this._draw( stage ),
            endFrame: () => this._endFrame(),
            destroy: () => this._dispose(),
        } );

        void this._loadRootTileset();
    }


    get viewer(): Viewer { return this._viewer; }

    get ready(): boolean { return this._ready; }

    get load_error(): Error | null { return this._load_error; }

    get visibility(): boolean { return this._custom_scene.visibility; }


    setVisibility( visibility: boolean ): void
    {
        this._custom_scene.setVisibility( visibility );
    }


    destroy(): void
    {
        if ( this._destroyed ) {
            return;
        }

        this._custom_scene.destroy();
    }


    private static _normalizeResource( resource: Resource | string | ThreeDTileset.ResourceInfo, options: ThreeDTileset.Option ): Resource
    {
        if ( resource instanceof Resource ) {
            return resource;
        }
        else if ( typeof resource === "string" ) {
            return new URLResource( resource, { transform: options.transform } );
        }
        else {
            return new URLResource( resource.url, { transform: options.transform } );
        }
    }


    private static _normalizePointShape( point_shape: ThreeDTileset.PointShape | undefined ): ThreeDTileset.PointShape
    {
        switch ( point_shape ) {
            case "rectangle":
            case "circle":
            case "circle_with_border":
            case "gradient_circle":
                return point_shape;
            default:
                return "gradient_circle";
        }
    }


    private async _loadRootTileset(): Promise<void>
    {
        try {
            const json = await this._resource.loadAsJson();
            if ( this._destroyed ) {
                return;
            }

            const parsed = this._parseTilesetJson(
                json,
                this._resource,
                undefined,
                this._model_matrix,
                this._model_matrix
            );
            this._root_tile = parsed.root;
            this._ready = true;
            this._markFrameCacheDirty();
        }
        catch ( error ) {
            const err = error instanceof Error ? error : new Error( String( error ) );
            this._load_error = err;
            console.error( err );
        }
    }


    private _parseTilesetJson(
        json: any,
        base_resource: Resource,
        parent: ThreeDTileset.Tile | undefined,
        parent_transform: Matrix,
        runtime_transform: Matrix
    ): ThreeDTileset.ParsedTileset
    {
        if ( typeof json !== "object" || json === null || typeof json.root !== "object" || json.root === null ) {
            throw new Error( "Invalid 3D Tiles tileset JSON" );
        }

        const tileset_geometric_error = Number( json.geometricError ?? 0 );
        const root = this._buildTile(
            json.root,
            base_resource,
            parent,
            parent_transform,
            runtime_transform,
            tileset_geometric_error
        );

        return { root };
    }


    private _buildTile(
        header: any,
        base_resource: Resource,
        parent: ThreeDTileset.Tile | undefined,
        parent_transform: Matrix,
        runtime_transform: Matrix,
        inherited_geometric_error: number
    ): ThreeDTileset.Tile
    {
        const local_transform = header.transform ? GeoMath.createMatrix( header.transform ) : GeoMath.setIdentity( GeoMath.createMatrix() );
        const computed_transform = GeoMath.createMatrix();
        GeoMath.mul_AA( parent_transform, local_transform, computed_transform );

        const geometric_error = Number(
            header.geometricError ??
            parent?.geometric_error ??
            inherited_geometric_error ??
            0
        );

        const refine = (
            header.refine !== undefined ?
                String( header.refine ).toUpperCase() :
                parent?.refine ?? "REPLACE"
        ) as TileRefine;

        const content_entries = ThreeDTileset._createTileContentEntries(
            base_resource,
            ThreeDTileset._getContentHeaders( header ),
            computed_transform,
            runtime_transform
        );

        const tile: ThreeDTileset.Tile = {
            parent,
            refine,
            local_transform,
            computed_transform,
            geometric_error,
            bounding_volume: ThreeDTileset._parseBoundingVolume( header.boundingVolume, computed_transform, runtime_transform ),
            content_bounding_volume: ThreeDTileset._mergeBoundingVolumes( content_entries.map( entry => entry.bounding_volume ).filter( Boolean ) as ThreeDTileset.BoundingVolume[] ),
            children: [],
            external_tiles: [],
            content_entries,
            content_state: content_entries.length > 0 ? ThreeDTileset.ContentState.UNLOADED : ThreeDTileset.ContentState.READY,
            primitives: null,
            last_distance_to_camera: Number.POSITIVE_INFINITY,
            last_screen_space_error: 0,
            last_touched_frame: -1,
            last_enqueued_frame: -1,
        };

        for ( const child_header of header.children ?? [] ) {
            tile.children.push(
                this._buildTile(
                    child_header,
                    base_resource,
                    tile,
                    computed_transform,
                    runtime_transform,
                    geometric_error
                )
            );
        }

        return tile;
    }


    private static _getContentHeaders( header: any ): any[]
    {
        if ( header?.content ) {
            return [header.content];
        }
        if ( Array.isArray( header?.contents ) ) {
            return header.contents.filter( (content: any) => typeof content === "object" && content !== null );
        }
        return [];
    }


    private static _createTileContentEntries(
        base_resource: Resource,
        content_headers: any[],
        computed_transform: Matrix,
        runtime_transform: Matrix
    ): ThreeDTileset.TileContentEntry[]
    {
        const entries: ThreeDTileset.TileContentEntry[] = [];

        for ( const content_header of content_headers ) {
            const uri = ThreeDTileset._getContentUri( content_header );
            if ( !uri ) {
                continue;
            }

            entries.push( {
                uri,
                type: ThreeDTileset._inferContentType( uri ),
                resource: base_resource.resolveResourceSupported() ? base_resource.resolveResource( uri ) : null,
                bounding_volume: content_header.boundingVolume ?
                    ThreeDTileset._parseBoundingVolume( content_header.boundingVolume, computed_transform, runtime_transform ) :
                    null,
            } );
        }

        return entries;
    }


    private static _getContentUri( content_header: any ): string | null
    {
        if ( !content_header || typeof content_header !== "object" ) {
            return null;
        }

        const uri = content_header.uri ?? content_header.url;
        return typeof uri === "string" ? uri : null;
    }


    private static _inferContentType( uri: string ): ContentType
    {
        if ( uri.startsWith( "data:" ) ) {
            if ( uri.startsWith( "data:model/gltf+json" ) || uri.startsWith( "data:application/json" ) ) {
                return "gltf";
            }
            return "glb";
        }

        const normalized = uri.split( "?" )[0].split( "#" )[0].toLowerCase();
        if ( normalized.endsWith( ".gltf" ) ) return "gltf";
        if ( normalized.endsWith( ".glb" ) ) return "glb";
        if ( normalized.endsWith( ".b3dm" ) ) return "b3dm";
        if ( normalized.endsWith( ".i3dm" ) ) return "i3dm";
        if ( normalized.endsWith( ".pnts" ) ) return "pnts";
        if ( normalized.endsWith( ".cmpt" ) ) return "cmpt";
        if ( normalized.endsWith( ".json" ) ) return "external_tileset";

        return "glb";
    }


    private static _mergeBoundingVolumes( volumes: ThreeDTileset.BoundingVolume[] ): ThreeDTileset.BoundingVolume | null
    {
        if ( volumes.length === 0 ) {
            return null;
        }
        if ( volumes.length === 1 ) {
            return volumes[0];
        }

        const center = GeoMath.createVector3();
        for ( const volume of volumes ) {
            center[0] += volume.center[0];
            center[1] += volume.center[1];
            center[2] += volume.center[2];
        }
        center[0] /= volumes.length;
        center[1] /= volumes.length;
        center[2] /= volumes.length;

        let radius = 0;
        const corners: Vector3[] = [];
        let has_non_corner_volume = false;

        for ( const volume of volumes ) {
            radius = Math.max( radius, Math.sqrt( ThreeDTileset._squaredDistance( center, volume.center ) ) + volume.radius );

            if ( volume.corners ) {
                corners.push( ...volume.corners.map( corner => GeoMath.createVector3( corner ) ) );
            }
            else {
                has_non_corner_volume = true;
            }
        }

        return {
            center,
            radius,
            corners: has_non_corner_volume ? null : corners,
        };
    }


    private static _parseBoundingVolume( header: any, computed_transform: Matrix, runtime_transform: Matrix ): ThreeDTileset.BoundingVolume
    {
        if ( !header || typeof header !== "object" ) {
            throw new Error( "Invalid boundingVolume" );
        }

        if ( Array.isArray( header.box ) ) {
            return ThreeDTileset._createBoxBoundingVolume( header.box, computed_transform );
        }
        if ( Array.isArray( header.sphere ) ) {
            return ThreeDTileset._createSphereBoundingVolume( header.sphere, computed_transform );
        }
        if ( Array.isArray( header.region ) ) {
            return ThreeDTileset._createRegionBoundingVolume( header.region, runtime_transform );
        }

        throw new Error( "Unsupported boundingVolume" );
    }


    private static _createBoxBoundingVolume( box: number[], transform: Matrix ): ThreeDTileset.BoundingVolume
    {
        const center = GeoMath.transformPosition_A( transform, GeoMath.createVector3( [box[0], box[1], box[2]] ), GeoMath.createVector3() );
        const half_axes = [
            GeoMath.transformDirection_A( transform, GeoMath.createVector3( [box[3],  box[4],  box[5]]  ), GeoMath.createVector3() ),
            GeoMath.transformDirection_A( transform, GeoMath.createVector3( [box[6],  box[7],  box[8]]  ), GeoMath.createVector3() ),
            GeoMath.transformDirection_A( transform, GeoMath.createVector3( [box[9], box[10], box[11]] ), GeoMath.createVector3() ),
        ];
        const corners = ThreeDTileset._createBoxCorners( center, half_axes ).map( corner =>
            ThreeDTileset._convertEcefToMaprayGocs( corner, GeoMath.createVector3() )
        );

        return ThreeDTileset._createBoundingVolumeFromCorners( corners );
    }


    private static _createSphereBoundingVolume( sphere: number[], transform: Matrix ): ThreeDTileset.BoundingVolume
    {
        const center = GeoMath.transformPosition_A( transform, GeoMath.createVector3( [sphere[0], sphere[1], sphere[2]] ), GeoMath.createVector3() );
        const mapray_center = ThreeDTileset._convertEcefToMaprayGocs( center, GeoMath.createVector3() );

        return {
            center: mapray_center,
            radius: sphere[3] * ThreeDTileset._maxScale( transform ),
            corners: null,
        };
    }


    private static _createRegionBoundingVolume( region: number[], runtime_transform: Matrix ): ThreeDTileset.BoundingVolume
    {
        const west = region[0] / GeoMath.DEGREE;
        const south = region[1] / GeoMath.DEGREE;
        const east = region[2] / GeoMath.DEGREE;
        const north = region[3] / GeoMath.DEGREE;
        const min_height = region[4];
        const max_height = region[5];

        const corners: Vector3[] = [];
        for ( const lon of [west, east] ) {
            for ( const lat of [south, north] ) {
                for ( const alt of [min_height, max_height] ) {
                    const gocs = new GeoPoint( lon, lat, alt ).getAsGocs( GeoMath.createVector3() );
                    corners.push( GeoMath.transformPosition_A( runtime_transform, gocs, GeoMath.createVector3() ) );
                }
            }
        }

        const center = GeoMath.createVector3();
        for ( const point of corners ) {
            center[0] += point[0];
            center[1] += point[1];
            center[2] += point[2];
        }
        center[0] /= corners.length;
        center[1] /= corners.length;
        center[2] /= corners.length;

        let radius = 0;
        for ( const point of corners ) {
            radius = Math.max( radius, Math.sqrt( ThreeDTileset._squaredDistance( center, point ) ) );
        }

        return { center, radius, corners };
    }


    private static _createBoxCorners( center: Vector3, half_axes: Vector3[] ): Vector3[]
    {
        const corners: Vector3[] = [];
        for ( let ix = -1; ix <= 1; ix += 2 ) {
            for ( let iy = -1; iy <= 1; iy += 2 ) {
                for ( let iz = -1; iz <= 1; iz += 2 ) {
                    corners.push( GeoMath.createVector3( [
                        center[0] + ix * half_axes[0][0] + iy * half_axes[1][0] + iz * half_axes[2][0],
                        center[1] + ix * half_axes[0][1] + iy * half_axes[1][1] + iz * half_axes[2][1],
                        center[2] + ix * half_axes[0][2] + iy * half_axes[1][2] + iz * half_axes[2][2],
                    ] ) );
                }
            }
        }
        return corners;
    }


    private static _squaredLength( vector: Vector3 ): number
    {
        return vector[0]*vector[0] + vector[1]*vector[1] + vector[2]*vector[2];
    }


    private static _squaredDistance( a: Vector3, b: Vector3 ): number
    {
        const dx = a[0] - b[0];
        const dy = a[1] - b[1];
        const dz = a[2] - b[2];
        return dx*dx + dy*dy + dz*dz;
    }


    private static _maxScale( matrix: Matrix ): number
    {
        const sx = Math.sqrt( matrix[0]*matrix[0] + matrix[1]*matrix[1] + matrix[2]*matrix[2] );
        const sy = Math.sqrt( matrix[4]*matrix[4] + matrix[5]*matrix[5] + matrix[6]*matrix[6] );
        const sz = Math.sqrt( matrix[8]*matrix[8] + matrix[9]*matrix[9] + matrix[10]*matrix[10] );
        return Math.max( sx, sy, sz );
    }


    private static _convertEcefToGeoPoint( position: Vector3 ): GeoPoint
    {
        const x = position[0];
        const y = position[1];
        const z = position[2];
        const xy = Math.sqrt( x*x + y*y );

        let latitude: number;
        let altitude: number;

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

            latitude = latitude_rad / GeoMath.DEGREE;
            altitude = xy / Math.cos( latitude_rad ) - prime_vertical_radius;
        }

        return new GeoPoint(
            Math.atan2( y, x ) / GeoMath.DEGREE,
            latitude,
            altitude
        );
    }


    private static _convertEcefToMaprayGocs( position: Vector3, dst: Vector3 ): Vector3
    {
        return ThreeDTileset._convertEcefToGeoPoint( position ).getAsGocs( dst );
    }


    private static _createBoundingVolumeFromCorners( corners: Vector3[] ): ThreeDTileset.BoundingVolume
    {
        const center = GeoMath.createVector3();
        for ( const corner of corners ) {
            center[0] += corner[0];
            center[1] += corner[1];
            center[2] += corner[2];
        }
        center[0] /= corners.length;
        center[1] /= corners.length;
        center[2] /= corners.length;

        let radius = 0;
        for ( const corner of corners ) {
            radius = Math.max( radius, Math.sqrt( ThreeDTileset._squaredDistance( center, corner ) ) );
        }

        return { center, radius, corners };
    }


    private static _transformWorldDeltaToMlocs( mlocs_to_gocs: Matrix, delta: Vector3, dst: Vector3 ): Vector3
    {
        dst[0] = delta[0] * mlocs_to_gocs[0] + delta[1] * mlocs_to_gocs[1] + delta[2] * mlocs_to_gocs[2];
        dst[1] = delta[0] * mlocs_to_gocs[4] + delta[1] * mlocs_to_gocs[5] + delta[2] * mlocs_to_gocs[6];
        dst[2] = delta[0] * mlocs_to_gocs[8] + delta[1] * mlocs_to_gocs[9] + delta[2] * mlocs_to_gocs[10];
        return dst;
    }


    private static _transformWorldPositionToMlocs( mlocs_to_gocs: Matrix, origin: Vector3, position: Vector3, dst: Vector3 ): Vector3
    {
        dst[0] = (position[0] - origin[0]) * mlocs_to_gocs[0] + (position[1] - origin[1]) * mlocs_to_gocs[1] + (position[2] - origin[2]) * mlocs_to_gocs[2];
        dst[1] = (position[0] - origin[0]) * mlocs_to_gocs[4] + (position[1] - origin[1]) * mlocs_to_gocs[5] + (position[2] - origin[2]) * mlocs_to_gocs[6];
        dst[2] = (position[0] - origin[0]) * mlocs_to_gocs[8] + (position[1] - origin[1]) * mlocs_to_gocs[9] + (position[2] - origin[2]) * mlocs_to_gocs[10];
        return dst;
    }


    private _draw( stage: RenderStage ): void
    {
        if ( this._destroyed || stage.getRenderTarget() !== RenderStage.RenderTarget.SCENE ) {
            return;
        }

        const root = this._root_tile;
        if ( root === null ) {
            return;
        }

        if ( this._shouldReuseFrameCache( stage ) ) {
            this._touchCachedTiles();
        }
        else {
            this._opaque_primitives.length = 0;
            this._translucent_primitives.length = 0;
            this._cached_touched_tiles.length = 0;
            this._frame_has_unresolved_tiles = false;

            this._collectTilePrimitives( root, stage, this._opaque_primitives, this._translucent_primitives );
            this._updateFrameCacheSnapshot( stage );
        }

        this._drawOpaquePrimitives( stage, this._opaque_primitives );
        this._drawTranslucentPrimitives( stage, this._translucent_primitives );
    }


    private _collectTilePrimitives(
        tile: ThreeDTileset.Tile,
        stage: RenderStage,
        opaque_primitives: Primitive[],
        translucent_primitives: Primitive[]
    ): boolean
    {
        tile.last_touched_frame = this._frame_counter;
        this._cached_touched_tiles.push( tile );

        const traversal_bv = tile.bounding_volume;
        if ( !ThreeDTileset._isBoundingVolumeVisible( traversal_bv, stage ) ) {
            return false;
        }

        const distance = ThreeDTileset._distanceToBoundingVolume( traversal_bv, stage );
        const screen_space_error = ThreeDTileset._getScreenSpaceError( tile.geometric_error, distance, stage.pixel_step );
        tile.last_distance_to_camera = distance;
        tile.last_screen_space_error = screen_space_error;

        if ( tile.content_state === ThreeDTileset.ContentState.UNLOADED ) {
            this._pushRequestQueue( tile, screen_space_error, distance );
        }
        if ( tile.content_entries.length > 0 && tile.content_state !== ThreeDTileset.ContentState.READY ) {
            this._frame_has_unresolved_tiles = true;
        }

        const can_draw_self = tile.content_state === ThreeDTileset.ContentState.READY && tile.primitives !== null;
        const needs_refine = (
            tile.children.length > 0 &&
            tile.geometric_error > 0 &&
            screen_space_error > this._maximum_screen_space_error
        );
        const should_traverse_children = (
            tile.external_tiles.length > 0 ||
            tile.refine === "ADD" ||
            needs_refine ||
            !can_draw_self
        );

        let drew_child = false;
        if ( should_traverse_children ) {
            for ( const child of tile.children ) {
                drew_child = this._collectTilePrimitives( child, stage, opaque_primitives, translucent_primitives ) || drew_child;
            }
        }

        for ( const external_tile of tile.external_tiles ) {
            drew_child = this._collectTilePrimitives( external_tile, stage, opaque_primitives, translucent_primitives ) || drew_child;
        }

        const draw_bv = tile.content_bounding_volume ?? traversal_bv;
        const should_draw_self = (
            can_draw_self &&
            ( draw_bv === traversal_bv || ThreeDTileset._isBoundingVolumeVisible( draw_bv, stage ) ) &&
            (
                tile.refine === "ADD" ||
                !needs_refine ||
                !drew_child
            )
        );

        if ( should_draw_self ) {
            for ( const primitive of tile.primitives! ) {
                if ( primitive.isVisible( stage ) ) {
                    if ( primitive.isTranslucent( stage ) ) {
                        translucent_primitives.push( primitive );
                    }
                    else {
                        opaque_primitives.push( primitive );
                    }
                }
            }
        }

        return drew_child || should_draw_self;
    }


    private static _isBoundingVolumeVisible( bounding_volume: ThreeDTileset.BoundingVolume, stage: RenderStage ): boolean
    {
        if ( bounding_volume.corners ) {
            for ( const plane of stage.getVolumePlanes() ) {
                let all_outside = true;
                for ( const corner of bounding_volume.corners ) {
                    const point = GeoMath.transformPosition_A( stage.gocs_to_view, corner, temp_bounding_point );
                    const dist = point[0]*plane[0] + point[1]*plane[1] + point[2]*plane[2] + plane[3];
                    if ( dist >= 0 ) {
                        all_outside = false;
                        break;
                    }
                }
                if ( all_outside ) {
                    return false;
                }
            }

            return true;
        }

        const center = GeoMath.transformPosition_A( stage.gocs_to_view, bounding_volume.center, GeoMath.createVector3() );
        for ( const plane of stage.getVolumePlanes() ) {
            const dist = center[0]*plane[0] + center[1]*plane[1] + center[2]*plane[2] + plane[3];
            if ( dist < -bounding_volume.radius ) {
                return false;
            }
        }

        return true;
    }


    private static _distanceToBoundingVolume( bounding_volume: ThreeDTileset.BoundingVolume, stage: RenderStage ): number
    {
        const view_center = GeoMath.transformPosition_A( stage.gocs_to_view, bounding_volume.center, temp_bounding_center );
        return Math.max( 0, Math.sqrt( ThreeDTileset._squaredLength( view_center ) ) - bounding_volume.radius );
    }


    private static _getScreenSpaceError( geometric_error: number, distance: number, pixel_step: number ): number
    {
        if ( geometric_error <= 0 ) {
            return 0;
        }

        return geometric_error / (pixel_step * Math.max( distance, 1e-6 ));
    }


    private _pushRequestQueue( tile: ThreeDTileset.Tile, screen_space_error: number, distance: number ): void
    {
        if ( tile.content_entries.length === 0 ) {
            return;
        }
        if ( tile.content_state !== ThreeDTileset.ContentState.UNLOADED ) {
            return;
        }
        if ( tile.last_enqueued_frame === this._frame_counter ) {
            return;
        }

        tile.last_enqueued_frame = this._frame_counter;
        this._request_queue.push( { tile, screen_space_error, distance } );
    }


    private _flushRequestQueue(): void
    {
        this._request_queue.sort( ( a, b ) => (
            b.screen_space_error !== a.screen_space_error ?
                b.screen_space_error - a.screen_space_error :
                a.distance - b.distance
        ) );

        for ( const request of this._request_queue ) {
            if ( this._active_requests >= this._max_concurrent_requests ) {
                break;
            }
            this._requestTileContent( request.tile );
        }
    }


    private _requestTileContent( tile: ThreeDTileset.Tile ): void
    {
        if ( this._active_requests >= this._max_concurrent_requests || tile.content_entries.length === 0 ) {
            return;
        }

        tile.content_state = ThreeDTileset.ContentState.LOADING;
        this._active_requests += 1;

        void (async () => {
            try {
                await this._loadTileContent( tile );
            }
            catch ( error ) {
                const err = error instanceof Error ? error : new Error( String( error ) );
                console.error( err );
                if ( this._load_error === null ) {
                    this._load_error = err;
                }
                tile.content_state = ThreeDTileset.ContentState.FAILED;
                this._markFrameCacheDirty();
            }
            finally {
                this._active_requests -= 1;
            }
        })();
    }


    private async _loadTileContent( tile: ThreeDTileset.Tile ): Promise<void>
    {
        const results = await Promise.all( tile.content_entries.map( async content_entry => {
            try {
                return { loaded: await this._loadTileEntryContent( tile, content_entry ), error: null as Error | null };
            }
            catch ( error ) {
                return { loaded: null as ThreeDTileset.LoadedContent | null, error: error instanceof Error ? error : new Error( String( error ) ) };
            }
        } ) );
        const primitives: Primitive[] = [];
        const external_tiles: ThreeDTileset.Tile[] = [];
        let first_error: Error | null = null;

        for ( const result of results ) {
            if ( result.error ) {
                if ( first_error === null ) {
                    first_error = result.error;
                }
                continue;
            }

            if ( result.loaded && result.loaded.primitives ) {
                primitives.push( ...result.loaded.primitives );
            }
            if ( result.loaded && result.loaded.external_tiles.length > 0 ) {
                external_tiles.push( ...result.loaded.external_tiles );
            }
        }

        if ( first_error ) {
            this._releasePrimitiveMeshes( primitives );
            for ( const external_tile of external_tiles ) {
                this._releaseTileTree( external_tile );
            }
            throw first_error;
        }

        if ( this._destroyed ) {
            this._releasePrimitiveMeshes( primitives );
            for ( const external_tile of external_tiles ) {
                this._releaseTileTree( external_tile );
            }
            return;
        }

        tile.primitives = primitives;
        tile.external_tiles = external_tiles;
        tile.content_state = ThreeDTileset.ContentState.READY;
        this._loaded_tiles.add( tile );
        this._markFrameCacheDirty();
    }


    private async _loadTileEntryContent(
        tile: ThreeDTileset.Tile,
        content_entry: ThreeDTileset.TileContentEntry
    ): Promise<ThreeDTileset.LoadedContent>
    {
        switch ( content_entry.type ) {
        case "external_tileset":
            return await this._loadExternalTilesetContent( tile, content_entry );
        case "gltf":
            return await this._loadGltfTileContent( tile, content_entry );
        case "glb":
        case "b3dm":
        case "i3dm":
        case "pnts":
        case "cmpt":
            return await this._loadBinaryTileContent( tile, content_entry );
        default:
            throw new Error( "Unsupported tile content type" );
        }
    }


    private async _loadExternalTilesetContent(
        tile: ThreeDTileset.Tile,
        content_entry: ThreeDTileset.TileContentEntry
    ): Promise<ThreeDTileset.LoadedContent>
    {
        if ( content_entry.resource === null ) {
            throw new Error( "Sub resource is not supported for external tileset content" );
        }

        const json = await content_entry.resource.loadAsJson();
        if ( this._destroyed ) {
            return { primitives: [], external_tiles: [] };
        }

        const parsed = this._parseTilesetJson(
            json,
            content_entry.resource,
            tile,
            tile.computed_transform,
            this._model_matrix
        );

        return { primitives: [], external_tiles: [parsed.root] };
    }


    private async _loadGltfTileContent(
        tile: ThreeDTileset.Tile,
        content_entry: ThreeDTileset.TileContentEntry
    ): Promise<ThreeDTileset.LoadedContent>
    {
        if ( content_entry.resource === null ) {
            throw new Error( "Sub resource is not supported for glTF tile content" );
        }

        const gltf_json = await content_entry.resource.loadAsJson();
        const primitives = await this._createModelPrimitives( gltf_json, content_entry.resource, undefined, content_entry.resource.toString() );
        ThreeDTileset._applyTransformToPrimitives( primitives, tile.computed_transform );
        return { primitives, external_tiles: [] };
    }


    private async _loadBinaryTileContent(
        tile: ThreeDTileset.Tile,
        content_entry: ThreeDTileset.TileContentEntry
    ): Promise<ThreeDTileset.LoadedContent>
    {
        if ( content_entry.resource === null ) {
            throw new Error( "Sub resource is not supported for binary tile content" );
        }

        const binary = await content_entry.resource.loadAsBinary();
        const content_type = ThreeDTileset._detectBinaryContentType( binary, content_entry.type );
        return await this._loadBinaryTileContentData( tile, content_type, binary, content_entry.resource, content_entry.resource.toString() );
    }


    private async _loadBinaryTileContentData(
        tile: ThreeDTileset.Tile,
        content_type: ThreeDTileset.BinaryContentType,
        binary: ArrayBuffer,
        base_resource: Resource,
        cache_key?: string
    ): Promise<ThreeDTileset.LoadedContent>
    {
        switch ( content_type ) {
        case "glb": {
            const parsed_glb = ThreeDTileset._parseGlb( binary );
            const primitives = await this._createModelPrimitives( parsed_glb.json, base_resource, parsed_glb.binary_chunk, cache_key );
            ThreeDTileset._applyTransformToPrimitives( primitives, tile.computed_transform );
            return { primitives, external_tiles: [] };
        }

        case "b3dm": {
            const glb = ThreeDTileset._extractGlbFromB3dm( binary );
            return this._loadBinaryTileContentData( tile, "glb", glb, base_resource );
        }

        case "i3dm":
            return await this._loadI3dmContent( tile, binary, base_resource );

        case "pnts":
            return await this._loadPntsContent( tile, binary );

        case "cmpt":
            return await this._loadCompositeTileContent( tile, binary, base_resource );
        }

        throw new Error( "Unsupported binary tile content type" );
    }


    private async _createModelPrimitives(
        gltf_json: object,
        base_resource: Resource,
        binary_chunk?: Uint8Array,
        cache_key?: string
    ): Promise<Primitive[]>
    {
        const templates = await this._getModelPrimitiveTemplates( gltf_json, base_resource, binary_chunk, cache_key );
        const primitives = templates.map( primitive => primitive.fastClone() );
        this._retainPrimitiveMeshes( primitives );
        return primitives;
    }


    private async _getModelPrimitiveTemplates(
        gltf_json: object,
        base_resource: Resource,
        binary_chunk?: Uint8Array,
        cache_key?: string
    ): Promise<Primitive[]>
    {
        if ( cache_key === undefined ) {
            return await this._buildModelPrimitiveTemplates( gltf_json, base_resource, binary_chunk );
        }

        let promise = this._model_primitive_cache.get( cache_key );
        if ( promise === undefined ) {
            promise = this._buildModelPrimitiveTemplates( gltf_json, base_resource, binary_chunk )
                .then( primitives => {
                    const unique_meshes = ThreeDTileset._collectUniquePrimitiveMeshes( primitives );
                    this._retainMeshes( unique_meshes );
                    this._cache_retained_meshes.set( cache_key, unique_meshes );
                    return primitives;
                } )
                .catch( error => {
                    this._model_primitive_cache.delete( cache_key );
                    throw error;
                } );

            this._model_primitive_cache.set( cache_key, promise );
        }

        return await promise;
    }


    private async _buildModelPrimitiveTemplates(
        gltf_json: object,
        base_resource: Resource,
        binary_chunk?: Uint8Array
    ): Promise<Primitive[]>
    {
        const resolved_rtc = ThreeDTileset._resolveCesiumRtcExtension( gltf_json );
        const resolved_gltf = await ThreeDTileset._resolveDracoMeshCompression(
            resolved_rtc.json,
            base_resource,
            binary_chunk,
            this._draco_mesh_worker_pool,
            this._draco_decoder_js_url,
            this._draco_decoder_script_url,
            this._draco_decoder_wasm_url
        );
        const content = await GltfTool.load( resolved_gltf.json, {
            base_resource,
            binary_type: Resource.Type.BINARY,
            image_type: Resource.Type.IMAGE,
            binary_chunk: resolved_gltf.binary_chunk,
            supported_extensions: ModelContainer.getSupportedExtensions_glTF(),
        } as any );

        if ( this._destroyed ) {
            return [];
        }

        const container = new ModelContainer( this._viewer.scene, content );
        const primitives = container.createPrimitives( undefined, { ridMaterial: false } ) ?? [];

        if ( resolved_rtc.rtc_transform ) {
            ThreeDTileset._applyTransformToPrimitives( primitives, resolved_rtc.rtc_transform );
        }

        return primitives;
    }


    private static _resolveCesiumRtcExtension( gltf_json: object ): { json: object; rtc_transform: Matrix | null }
    {
        const source = gltf_json as any;
        const rtc_center = source?.extensions?.CESIUM_RTC?.center;

        if (
            !Array.isArray( rtc_center ) ||
            rtc_center.length < 3 ||
            !rtc_center.every( ( value: unknown ) => Number.isFinite( Number( value ) ) )
        ) {
            return { json: gltf_json, rtc_transform: null };
        }

        const cloned = JSON.parse( JSON.stringify( gltf_json ) );
        if ( Array.isArray( cloned.extensionsUsed ) ) {
            cloned.extensionsUsed = cloned.extensionsUsed.filter( (name: string) => name !== "CESIUM_RTC" );
            if ( cloned.extensionsUsed.length === 0 ) {
                delete cloned.extensionsUsed;
            }
        }
        if ( Array.isArray( cloned.extensionsRequired ) ) {
            cloned.extensionsRequired = cloned.extensionsRequired.filter( (name: string) => name !== "CESIUM_RTC" );
            if ( cloned.extensionsRequired.length === 0 ) {
                delete cloned.extensionsRequired;
            }
        }
        if ( cloned.extensions && typeof cloned.extensions === "object" ) {
            delete cloned.extensions.CESIUM_RTC;
            if ( Object.keys( cloned.extensions ).length === 0 ) {
                delete cloned.extensions;
            }
        }

        const rtc_transform = GeoMath.setIdentity( GeoMath.createMatrix() );
        rtc_transform[12] = Number( rtc_center[0] );
        rtc_transform[13] = Number( rtc_center[1] );
        rtc_transform[14] = Number( rtc_center[2] );

        return { json: cloned, rtc_transform };
    }


    private static async _resolveDracoMeshCompression(
        gltf_json: object,
        base_resource: Resource,
        binary_chunk?: Uint8Array,
        worker_pool?: DracoMeshDecodeWorkerPool | null,
        js_decoder_url?: string | null,
        wasm_script_url?: string | null,
        wasm_decoder_url?: string | null
    ): Promise<{ json: object; binary_chunk?: Uint8Array }>
    {
        const source = gltf_json as any;
        if ( !Array.isArray( source.meshes ) ) {
            return { json: gltf_json, binary_chunk };
        }

        const has_draco_mesh = source.meshes.some( (mesh: any) => (
            Array.isArray( mesh?.primitives ) &&
            mesh.primitives.some( (primitive: any) => primitive?.extensions?.KHR_draco_mesh_compression )
        ) );
        if ( !has_draco_mesh ) {
            return { json: gltf_json, binary_chunk };
        }

        const cloned = JSON.parse( JSON.stringify( gltf_json ) );
        cloned.buffers = Array.isArray( cloned.buffers ) ? cloned.buffers : [];
        cloned.bufferViews = Array.isArray( cloned.bufferViews ) ? cloned.bufferViews : [];
        cloned.accessors = Array.isArray( cloned.accessors ) ? cloned.accessors : [];

        const buffer_cache = new Map<number, Promise<Uint8Array>>();
        const storage = ThreeDTileset._createDracoDecodedBufferStorage( cloned, binary_chunk );

        for ( const mesh of cloned.meshes ) {
            if ( !Array.isArray( mesh?.primitives ) ) {
                continue;
            }

            for ( const primitive of mesh.primitives ) {
                if ( !primitive?.extensions?.KHR_draco_mesh_compression ) {
                    continue;
                }

                const decoded = await ThreeDTileset._decodeDracoMeshPrimitive(
                    cloned,
                    primitive,
                    base_resource,
                    binary_chunk,
                    buffer_cache,
                    worker_pool,
                    js_decoder_url,
                    wasm_script_url,
                    wasm_decoder_url
                );

                for ( const attribute of decoded.attributes ) {
                    const buffer_view = ThreeDTileset._appendDecodedBufferView(
                        cloned,
                        storage,
                        attribute.values,
                        MeshBuffer.Target.ATTRIBUTE
                    );
                    const accessor = cloned.accessors[attribute.accessor_index];
                    accessor.bufferView = buffer_view;
                    accessor.byteOffset = 0;
                    accessor.count = decoded.vertex_count;
                    accessor.type = attribute.type;
                    accessor.componentType = attribute.component_type;

                    if ( attribute.normalized ) accessor.normalized = true;
                    else delete accessor.normalized;

                    if ( attribute.min && attribute.max ) {
                        accessor.min = attribute.min;
                        accessor.max = attribute.max;
                    }
                    else {
                        delete accessor.min;
                        delete accessor.max;
                    }
                }

                if ( decoded.indices ) {
                    const buffer_view = ThreeDTileset._appendDecodedBufferView(
                        cloned,
                        storage,
                        decoded.indices.values,
                        MeshBuffer.Target.INDEX
                    );
                    const accessor_index =
                        decoded.indices.accessor_index ?? cloned.accessors.push( {} ) - 1;
                    const accessor = cloned.accessors[accessor_index];

                    accessor.bufferView = buffer_view;
                    accessor.byteOffset = 0;
                    accessor.count = decoded.indices.values.length;
                    accessor.type = "SCALAR";
                    accessor.componentType = decoded.indices.component_type;
                    delete accessor.normalized;
                    delete accessor.min;
                    delete accessor.max;

                    primitive.indices = accessor_index;
                }
                else {
                    delete primitive.indices;
                    primitive.mode = 0;
                }

                if ( decoded.indices && primitive.mode === 5 ) {
                    // Draco decodes mesh connectivity as triangles, so normalize the primitive mode.
                    primitive.mode = 4;
                }

                ThreeDTileset._removePrimitiveExtension( primitive, "KHR_draco_mesh_compression" );
            }
        }

        ThreeDTileset._removeGlobalExtension( cloned, "KHR_draco_mesh_compression" );

        const resolved_binary_chunk = ThreeDTileset._finalizeDracoDecodedBufferStorage( cloned, storage, binary_chunk );
        return {
            json: cloned,
            binary_chunk: resolved_binary_chunk,
        };
    }


    private static _createDracoDecodedBufferStorage(
        gltf_json: any,
        binary_chunk?: Uint8Array
    ): ThreeDTileset.GltfBufferStorage
    {
        let buffer_index = -1;
        let use_binary_chunk = false;
        let current_offset = 0;

        if ( binary_chunk ) {
            buffer_index = gltf_json.buffers.findIndex( (buffer: any) => buffer && buffer.uri === undefined );
            if ( buffer_index >= 0 ) {
                use_binary_chunk = true;
                current_offset = binary_chunk.byteLength;
                gltf_json.buffers[buffer_index].byteLength = Math.max(
                    Number( gltf_json.buffers[buffer_index].byteLength ) || 0,
                    binary_chunk.byteLength
                );
            }
        }

        if ( buffer_index < 0 ) {
            buffer_index = gltf_json.buffers.length;
            gltf_json.buffers.push( { byteLength: 0, uri: "" } );
        }

        return {
            buffer_index,
            current_offset,
            use_binary_chunk,
            parts: [],
        };
    }


    private static _appendDecodedBufferView(
        gltf_json: any,
        storage: ThreeDTileset.GltfBufferStorage,
        values: ArrayBufferView,
        target: MeshBuffer.Target
    ): number
    {
        const padding = (4 - (storage.current_offset % 4)) % 4;
        if ( padding > 0 ) {
            storage.parts.push( new Uint8Array( padding ) );
            storage.current_offset += padding;
        }

        const bytes = ThreeDTileset._toUint8Array( values );
        const byte_offset = storage.current_offset;

        storage.parts.push( bytes );
        storage.current_offset += bytes.byteLength;

        gltf_json.bufferViews.push( {
            buffer: storage.buffer_index,
            byteOffset: byte_offset,
            byteLength: bytes.byteLength,
            target,
        } );

        return gltf_json.bufferViews.length - 1;
    }


    private static _finalizeDracoDecodedBufferStorage(
        gltf_json: any,
        storage: ThreeDTileset.GltfBufferStorage,
        binary_chunk?: Uint8Array
    ): Uint8Array | undefined
    {
        const tail_padding = (4 - (storage.current_offset % 4)) % 4;
        if ( tail_padding > 0 ) {
            storage.parts.push( new Uint8Array( tail_padding ) );
            storage.current_offset += tail_padding;
        }

        if ( storage.use_binary_chunk ) {
            const original = binary_chunk ?? new Uint8Array();
            const merged = new Uint8Array( storage.current_offset );
            merged.set( original, 0 );

            let write_offset = original.byteLength;
            for ( const part of storage.parts ) {
                merged.set( part, write_offset );
                write_offset += part.byteLength;
            }

            const buffer = gltf_json.buffers[storage.buffer_index];
            buffer.byteLength = merged.byteLength;
            delete buffer.uri;
            return merged;
        }

        let packed_length = 0;
        for ( const part of storage.parts ) {
            packed_length += part.byteLength;
        }

        const packed = new Uint8Array( packed_length );
        let write_offset = 0;
        for ( const part of storage.parts ) {
            packed.set( part, write_offset );
            write_offset += part.byteLength;
        }

        const buffer = gltf_json.buffers[storage.buffer_index];
        buffer.byteLength = packed.byteLength;
        buffer.uri = ThreeDTileset._createBinaryDataUri( packed );
        return binary_chunk;
    }


    private static _removePrimitiveExtension( primitive: any, extension_name: string ): void
    {
        if ( primitive?.extensions && typeof primitive.extensions === "object" ) {
            delete primitive.extensions[extension_name];
            if ( Object.keys( primitive.extensions ).length === 0 ) {
                delete primitive.extensions;
            }
        }
    }


    private static _removeGlobalExtension( gltf_json: any, extension_name: string ): void
    {
        if ( Array.isArray( gltf_json.extensionsUsed ) ) {
            gltf_json.extensionsUsed = gltf_json.extensionsUsed.filter( (name: string) => name !== extension_name );
            if ( gltf_json.extensionsUsed.length === 0 ) {
                delete gltf_json.extensionsUsed;
            }
        }

        if ( Array.isArray( gltf_json.extensionsRequired ) ) {
            gltf_json.extensionsRequired = gltf_json.extensionsRequired.filter( (name: string) => name !== extension_name );
            if ( gltf_json.extensionsRequired.length === 0 ) {
                delete gltf_json.extensionsRequired;
            }
        }
    }


    private static async _decodeDracoMeshPrimitive(
        gltf_json: any,
        primitive: any,
        base_resource: Resource,
        binary_chunk: Uint8Array | undefined,
        buffer_cache: Map<number, Promise<Uint8Array>>,
        worker_pool?: DracoMeshDecodeWorkerPool | null,
        js_decoder_url?: string | null,
        wasm_script_url?: string | null,
        wasm_decoder_url?: string | null
    ): Promise<ThreeDTileset.DecodedDracoMeshPrimitive>
    {
        const extension = primitive?.extensions?.KHR_draco_mesh_compression;
        if ( typeof extension !== "object" || extension === null ) {
            throw new Error( "Invalid KHR_draco_mesh_compression extension" );
        }

        const buffer_view_index = Number( extension.bufferView );
        if ( !Number.isFinite( buffer_view_index ) || buffer_view_index < 0 ) {
            throw new Error( "Invalid Draco mesh bufferView" );
        }

        const payload = await ThreeDTileset._loadGltfBufferView(
            gltf_json,
            buffer_view_index,
            base_resource,
            binary_chunk,
            buffer_cache
        );
        const payload_bytes = new Uint8Array( payload.byteLength );
        payload_bytes.set( payload );
        const primitive_mode = Number.isFinite( Number( primitive?.mode ) ) ? Number( primitive.mode ) : 4;

        if ( worker_pool ) {
            const worker_attribute_specs = ThreeDTileset._createDracoMeshWorkerAttributeSpecs( gltf_json, primitive, extension.attributes );
            const index_accessor_index = typeof primitive.indices === "number" ? primitive.indices : null;
            const index_accessor =
                index_accessor_index !== null ?
                    gltf_json.accessors[index_accessor_index] :
                    null;
            try {
                const worker_payload = new Uint8Array( payload_bytes );
                const decoded = await worker_pool.run(
                    {
                        payload: worker_payload.buffer,
                        bufferViewIndex: buffer_view_index,
                        primitiveMode: primitive_mode,
                        attributes: worker_attribute_specs,
                        indexAccessorIndex: index_accessor_index,
                        indexComponentType: index_accessor?.componentType ?? null,
                    },
                    [worker_payload.buffer]
                );

                return {
                    vertex_count: decoded.vertexCount,
                    attributes: decoded.attributes.map( attribute => ( {
                        accessor_index: attribute.accessorIndex,
                        values: attribute.values,
                        type: attribute.type,
                        component_type: attribute.componentType,
                        normalized: attribute.normalized,
                        min: attribute.min,
                        max: attribute.max,
                    } ) ),
                    indices: decoded.indices ? {
                        accessor_index: decoded.indices.accessorIndex,
                        component_type: decoded.indices.componentType,
                        values: decoded.indices.values,
                    } : null,
                };
            }
            catch ( error ) {
                if ( !warnedDracoMeshWorkerFallback ) {
                    warnedDracoMeshWorkerFallback = true;
                    console.warn( "Draco mesh worker decode failed; falling back to main-thread decode", error );
                }
            }
        }

        const wasm_error = await ThreeDTileset._runMainThreadDracoDecode( async () => {
            let last_error: unknown = null;

            for ( let attempt = 0; attempt < 2; ++attempt ) {
                try {
                    const module = await ThreeDTileset._getDracoDecoderModule( "wasm", wasm_script_url, wasm_decoder_url );
                    return await ThreeDTileset._decodeDracoMeshPrimitiveWithModule(
                        module,
                        gltf_json,
                        primitive,
                        buffer_view_index,
                        primitive_mode,
                        payload_bytes,
                        extension
                    );
                }
                catch ( error ) {
                    last_error = error;
                    if ( attempt === 0 && ThreeDTileset._shouldResetDracoDecoderModule( error ) ) {
                        ThreeDTileset._resetDracoDecoderModule( "wasm" );
                        continue;
                    }
                    break;
                }
            }

            throw last_error;
        } ).catch( error => error );

        if ( !(wasm_error instanceof Error) && !(wasm_error instanceof WebAssembly.RuntimeError) ) {
            return wasm_error as ThreeDTileset.DecodedDracoMeshPrimitive;
        }

        if ( ThreeDTileset._isFatalDracoRuntimeError( wasm_error ) && js_decoder_url && !dracoJsFallbackDisabled ) {
            try {
                const module = await ThreeDTileset._getDracoDecoderModule( "js", js_decoder_url, wasm_decoder_url );
                return await ThreeDTileset._decodeDracoMeshPrimitiveWithModule(
                    module,
                    gltf_json,
                    primitive,
                    buffer_view_index,
                    primitive_mode,
                    payload_bytes,
                    extension
                );
            }
            catch ( js_error ) {
                if ( ThreeDTileset._isBrokenDracoJsFallbackError( js_error ) ) {
                    dracoJsFallbackDisabled = true;
                    ThreeDTileset._resetDracoDecoderModule( "js" );
                    if ( !warnedDracoJsFallbackDisable ) {
                        warnedDracoJsFallbackDisable = true;
                        console.warn( "Disabling Draco JS fallback after decoder failure", js_error );
                    }
                }
                throw wasm_error ?? js_error;
            }
        }

        throw wasm_error;
    }


    private static async _decodeDracoMeshPrimitiveWithModule(
        module: any,
        gltf_json: any,
        primitive: any,
        buffer_view_index: number,
        primitive_mode: number,
        payload_bytes: Uint8Array,
        extension: any
    ): Promise<ThreeDTileset.DecodedDracoMeshPrimitive>
    {
        const decoder = new module.Decoder();
        const buffer = new module.DecoderBuffer();
        let status: any = null;
        let buffer_initialized = false;
        let geometry: any = null;
        let geometry_type: number | null = null;
        let geometry_destroyable = false;
        let fatal_decode_error = false;

        try {
            buffer.Init( payload_bytes, payload_bytes.byteLength );
            buffer_initialized = true;

            geometry_type = decoder.GetEncodedGeometryType( buffer );
            if ( geometry_type === module.TRIANGULAR_MESH ) {
                geometry = new module.Mesh();
                status = decoder.DecodeBufferToMesh( buffer, geometry );
            }
            else if ( geometry_type === module.POINT_CLOUD ) {
                geometry = new module.PointCloud();
                status = decoder.DecodeBufferToPointCloud( buffer, geometry );
            }
            else {
                throw new Error( "Unsupported Draco glTF geometry type" );
            }

            if ( !status.ok() || geometry.ptr === 0 ) {
                const error_message = typeof status.error_msg === "function" ? status.error_msg() : "unknown error";
                const geometry_label =
                    geometry_type === module.TRIANGULAR_MESH ? "TRIANGULAR_MESH" :
                    geometry_type === module.POINT_CLOUD ? "POINT_CLOUD" :
                    String( geometry_type );
                throw new Error(
                    `Failed to decode Draco mesh payload: ${error_message} ` +
                    `(bufferView=${buffer_view_index}, primitiveMode=${primitive_mode}, geometryType=${geometry_label})`
                );
            }
            geometry_destroyable = true;

            const vertex_count = geometry.num_points();
            const attributes: ThreeDTileset.DecodedDracoMeshAttribute[] = [];
            const extension_attributes = extension.attributes;
            if ( typeof extension_attributes !== "object" || extension_attributes === null ) {
                throw new Error( "Invalid Draco mesh attributes" );
            }

            for ( const semantic of Object.keys( extension_attributes ) ) {
                const accessor_index = primitive?.attributes?.[semantic];
                if ( !Number.isFinite( Number( accessor_index ) ) || accessor_index < 0 ) {
                    throw new Error( "Missing accessor for Draco mesh attribute: " + semantic );
                }

                const accessor = gltf_json.accessors[accessor_index];
                if ( typeof accessor !== "object" || accessor === null ) {
                    throw new Error( "Invalid accessor for Draco mesh attribute: " + semantic );
                }

                const values = ThreeDTileset._decodeDracoMeshAttribute(
                    module,
                    decoder,
                    geometry,
                    ThreeDTileset._getDracoPropertyUniqueId( extension_attributes, semantic ) as number,
                    accessor,
                    semantic
                );

                const min_max = semantic === "POSITION" ?
                    ThreeDTileset._calculateAccessorMinMax( values, vertex_count, ThreeDTileset._getAccessorComponentCount( accessor.type ) ) :
                    null;

                attributes.push( {
                    accessor_index,
                    values,
                    type: accessor.type,
                    component_type: accessor.componentType,
                    normalized: accessor.normalized === true,
                    min: min_max?.min ?? null,
                    max: min_max?.max ?? null,
                } );
            }

            const indices = geometry_type === module.TRIANGULAR_MESH ?
                (() => {
                    const index_accessor_index = typeof primitive.indices === "number" ? primitive.indices : undefined;
                    const index_accessor =
                        index_accessor_index !== undefined ?
                            gltf_json.accessors[index_accessor_index] :
                            null;
                    return ThreeDTileset._decodeDracoMeshIndices(
                        module,
                        decoder,
                        geometry,
                        index_accessor_index,
                        index_accessor?.componentType
                    );
                })() :
                null;

            return {
                vertex_count,
                attributes,
                indices,
            };
        }
        catch ( error ) {
            fatal_decode_error = error instanceof WebAssembly.RuntimeError;
            throw error;
        }
        finally {
            void status;
            if ( buffer_initialized ) {
                try {
                    module.destroy( buffer );
                }
                catch ( error ) {
                    if ( !ThreeDTileset._isFatalDracoRuntimeError( error ) ) {
                        console.warn( "Failed to destroy Draco buffer object", error );
                    }
                }
            }
            if ( geometry && geometry_destroyable && !fatal_decode_error ) {
                try {
                    module.destroy( geometry );
                }
                catch ( error ) {
                    if ( !ThreeDTileset._isFatalDracoRuntimeError( error ) ) {
                        console.warn( "Failed to destroy Draco geometry object", error );
                    }
                }
            }
            if ( !fatal_decode_error ) {
                try {
                    module.destroy( decoder );
                }
                catch ( error ) {
                    if ( !ThreeDTileset._isFatalDracoRuntimeError( error ) ) {
                        console.warn( "Failed to destroy Draco decoder object", error );
                    }
                }
            }
        }
    }


    private static async _loadGltfBufferView(
        gltf_json: any,
        buffer_view_index: number,
        base_resource: Resource,
        binary_chunk: Uint8Array | undefined,
        buffer_cache: Map<number, Promise<Uint8Array>>
    ): Promise<Uint8Array>
    {
        const buffer_view = gltf_json?.bufferViews?.[buffer_view_index];
        if ( typeof buffer_view !== "object" || buffer_view === null ) {
            throw new Error( "Invalid glTF bufferView index: " + buffer_view_index );
        }

        const buffer_index = Number( buffer_view.buffer );
        const byte_offset = Number( buffer_view.byteOffset ?? 0 );
        const byte_length = Number( buffer_view.byteLength );
        if (
            !Number.isFinite( buffer_index ) ||
            !Number.isFinite( byte_offset ) ||
            !Number.isFinite( byte_length ) ||
            buffer_index < 0 ||
            byte_offset < 0 ||
            byte_length < 0
        ) {
            throw new Error( "Invalid glTF bufferView layout for Draco mesh" );
        }

        const buffer = await ThreeDTileset._loadGltfBuffer(
            gltf_json,
            buffer_index,
            base_resource,
            binary_chunk,
            buffer_cache
        );

        if ( byte_offset + byte_length > buffer.byteLength ) {
            throw new Error( "Invalid glTF Draco bufferView range" );
        }

        const view = buffer.subarray( byte_offset, byte_offset + byte_length );
        const copied = new Uint8Array( view.byteLength );
        copied.set( view );
        return copied;
    }


    private static async _loadGltfBuffer(
        gltf_json: any,
        buffer_index: number,
        base_resource: Resource,
        binary_chunk: Uint8Array | undefined,
        buffer_cache: Map<number, Promise<Uint8Array>>
    ): Promise<Uint8Array>
    {
        let promise = buffer_cache.get( buffer_index );
        if ( promise !== undefined ) {
            return await promise;
        }

        promise = (async() => {
            const buffer = gltf_json?.buffers?.[buffer_index];
            if ( typeof buffer !== "object" || buffer === null ) {
                throw new Error( "Invalid glTF buffer index: " + buffer_index );
            }

            const byte_length = Number( buffer.byteLength );
            if ( !Number.isFinite( byte_length ) || byte_length < 0 ) {
                throw new Error( "Invalid glTF buffer byteLength: " + buffer_index );
            }

            if ( typeof buffer.uri === "string" ) {
                if ( buffer.uri.startsWith( "data:" ) ) {
                    return ThreeDTileset._decodeDataUri( buffer.uri );
                }
                if ( !base_resource.loadSubResourceSupported() ) {
                    throw new Error( "Sub resource is not supported for Draco glTF buffer" );
                }
                return new Uint8Array( await base_resource.loadSubResourceAsBinary( buffer.uri ) );
            }

            if ( !binary_chunk ) {
                throw new Error( "GLB binary chunk is missing for Draco mesh" );
            }

            if ( byte_length > binary_chunk.byteLength ) {
                throw new Error( "Invalid GLB binary chunk length for Draco mesh" );
            }

            return binary_chunk.subarray( 0, byte_length );
        })();

        buffer_cache.set( buffer_index, promise );
        return await promise;
    }


    private static _decodeDracoMeshAttribute(
        module: any,
        decoder: any,
        mesh: any,
        unique_id: number,
        accessor: any,
        name: string
    ): ThreeDTileset.NumericArray
    {
        const components = ThreeDTileset._getAccessorComponentCount( accessor.type );
        const component_info = ThreeDTileset._getComponentTypeInfo( module, accessor.componentType );
        const count = mesh.num_points();

        if ( typeof decoder.GetAttributeDataArrayForAllPoints === "function" && typeof module._malloc === "function" ) {
            const attribute = ThreeDTileset._getDracoAttribute( module, decoder, mesh, unique_id, components, name );
            const byte_length = count * components * component_info.bytes;
            const pointer = module._malloc( byte_length );

            try {
                if ( !decoder.GetAttributeDataArrayForAllPoints( mesh, attribute, component_info.draco_data_type, byte_length, pointer ) ) {
                    throw new Error( "Failed to decode Draco mesh attribute: " + name );
                }

                const heap_view = new component_info.typed_array( module.HEAPU8.buffer, pointer, count * components );
                const values = new component_info.typed_array( count * components );
                values.set( heap_view );
                return values;
            }
            finally {
                module._free( pointer );
                module.destroy( attribute );
            }
        }

        const decoded = ThreeDTileset._decodeDracoRawAttribute( module, decoder, mesh, unique_id, components, name );
        return ThreeDTileset._convertDracoAttributeValues(
            decoded.values,
            accessor.componentType,
            accessor.normalized === true,
            name
        );
    }


    private static _decodeDracoMeshIndices(
        module: any,
        decoder: any,
        mesh: any,
        accessor_index: number | undefined,
        requested_component_type: number | undefined
    ): ThreeDTileset.DecodedDracoMeshIndices
    {
        const face_count = mesh.num_faces();
        const index_count = face_count * 3;
        let values = new Uint32Array( index_count );

        if ( typeof decoder.GetFaceFromMesh === "function" ) {
            const face = new module.DracoInt32Array();
            try {
                for ( let i = 0; i < face_count; ++i ) {
                    if ( !decoder.GetFaceFromMesh( mesh, i, face ) ) {
                        throw new Error( "Failed to decode Draco mesh indices" );
                    }
                    values[3*i + 0] = face.GetValue( 0 );
                    values[3*i + 1] = face.GetValue( 1 );
                    values[3*i + 2] = face.GetValue( 2 );
                }
            }
            finally {
                module.destroy( face );
            }
        }
        else if ( typeof decoder.GetTrianglesUInt32Array === "function" && typeof module._malloc === "function" ) {
            const byte_length = index_count * Uint32Array.BYTES_PER_ELEMENT;
            const pointer = module._malloc( byte_length );
            try {
                if ( !decoder.GetTrianglesUInt32Array( mesh, byte_length, pointer ) ) {
                    throw new Error( "Failed to decode Draco mesh indices" );
                }

                const heap_view = new Uint32Array( module.HEAPU8.buffer, pointer, index_count );
                values.set( heap_view );
            }
            finally {
                module._free( pointer );
            }
        }
        else {
            throw new Error( "Draco decoder does not expose mesh index APIs" );
        }

        const max_index = values.length > 0 ? values.reduce( (max, value) => Math.max( max, value ), 0 ) : 0;
        let component_type = Number.isFinite( Number( requested_component_type ) ) ? Number( requested_component_type ) : 5125;

        if ( component_type !== 5121 && component_type !== 5123 && component_type !== 5125 ) {
            component_type = 5125;
        }

        if ( component_type === 5121 && max_index > 255 ) {
            component_type = max_index <= 65535 ? 5123 : 5125;
        }
        else if ( component_type === 5123 && max_index > 65535 ) {
            component_type = 5125;
        }
        else if ( component_type === 5125 ) {
            if ( max_index <= 255 ) component_type = 5121;
            else if ( max_index <= 65535 ) component_type = 5123;
        }

        return {
            accessor_index: typeof accessor_index === "number" ? accessor_index : null,
            component_type,
            values: ThreeDTileset._convertDracoAttributeValues( values, component_type, false, "indices" ) as Uint8Array | Uint16Array | Uint32Array,
        };
    }


    private static _getAccessorComponentCount( accessor_type: string ): number
    {
        switch ( accessor_type ) {
        case "SCALAR": return 1;
        case "VEC2": return 2;
        case "VEC3": return 3;
        case "VEC4": return 4;
        case "MAT2": return 4;
        case "MAT3": return 9;
        case "MAT4": return 16;
        default:
            throw new Error( "Unsupported accessor type: " + accessor_type );
        }
    }


    private static _getComponentTypeInfo( module: any, component_type: number ): ThreeDTileset.ComponentTypeInfo
    {
        switch ( component_type ) {
        case 5120: return { bytes: 1, draco_data_type: module.DT_INT8, typed_array: Int8Array, min: -128, max: 127, is_float: false, is_unsigned: false };
        case 5121: return { bytes: 1, draco_data_type: module.DT_UINT8, typed_array: Uint8Array, min: 0, max: 255, is_float: false, is_unsigned: true };
        case 5122: return { bytes: 2, draco_data_type: module.DT_INT16, typed_array: Int16Array, min: -32768, max: 32767, is_float: false, is_unsigned: false };
        case 5123: return { bytes: 2, draco_data_type: module.DT_UINT16, typed_array: Uint16Array, min: 0, max: 65535, is_float: false, is_unsigned: true };
        case 5125: return { bytes: 4, draco_data_type: module.DT_UINT32, typed_array: Uint32Array, min: 0, max: 4294967295, is_float: false, is_unsigned: true };
        case 5126: return { bytes: 4, draco_data_type: module.DT_FLOAT32, typed_array: Float32Array, min: -Infinity, max: Infinity, is_float: true, is_unsigned: false };
        default:
            throw new Error( "Unsupported glTF component type: " + component_type );
        }
    }


    private static _convertDracoAttributeValues(
        values: ThreeDTileset.NumericArray,
        component_type: number,
        normalized: boolean,
        name: string
    ): ThreeDTileset.NumericArray
    {
        const info = ThreeDTileset._getComponentTypeInfo( {
            DT_INT8: 0,
            DT_UINT8: 0,
            DT_INT16: 0,
            DT_UINT16: 0,
            DT_UINT32: 0,
            DT_FLOAT32: 0,
        }, component_type );

        if ( values instanceof info.typed_array ) {
            return values;
        }

        const converted = new info.typed_array( values.length ) as ThreeDTileset.NumericArray;
        for ( let i = 0; i < values.length; ++i ) {
            const value = Number( values[i] );
            if ( !Number.isFinite( value ) ) {
                throw new Error( "Invalid Draco value: " + name );
            }

            if ( info.is_float ) {
                converted[i] = value;
            }
            else if ( normalized && values instanceof Float32Array ) {
                converted[i] = ThreeDTileset._convertNormalizedFloatToInteger( value, info.min, info.max, info.is_unsigned );
            }
            else {
                const rounded = Math.round( value );
                if ( rounded < info.min || rounded > info.max ) {
                    throw new Error( "Draco value is out of range for accessor: " + name );
                }
                converted[i] = rounded;
            }
        }

        return converted;
    }


    private static _convertNormalizedFloatToInteger(
        value: number,
        min: number,
        max: number,
        is_unsigned: boolean
    ): number
    {
        if ( is_unsigned ) {
            return Math.round( Math.max( 0, Math.min( 1, value ) ) * max );
        }

        const clamped = Math.max( -1, Math.min( 1, value ) );
        const scale = clamped < 0 ? -min : max;
        return Math.round( clamped * scale );
    }


    private static _calculateAccessorMinMax(
        values: ThreeDTileset.NumericArray,
        count: number,
        components: number
    ): { min: number[]; max: number[] } | null
    {
        if ( count <= 0 || components <= 0 ) {
            return null;
        }

        const min = new Array<number>( components ).fill( Number.POSITIVE_INFINITY );
        const max = new Array<number>( components ).fill( Number.NEGATIVE_INFINITY );

        for ( let i = 0; i < count; ++i ) {
            for ( let c = 0; c < components; ++c ) {
                const value = Number( values[components*i + c] );
                if ( value < min[c] ) min[c] = value;
                if ( value > max[c] ) max[c] = value;
            }
        }

        return { min, max };
    }


    private static _toUint8Array( values: ArrayBufferView ): Uint8Array
    {
        return new Uint8Array( values.buffer.slice( values.byteOffset, values.byteOffset + values.byteLength ) );
    }


    private static _createBinaryDataUri( bytes: Uint8Array ): string
    {
        if ( typeof Buffer !== "undefined" ) {
            return "data:application/octet-stream;base64," + Buffer.from( bytes ).toString( "base64" );
        }

        let binary = "";
        for ( let i = 0; i < bytes.length; ++i ) {
            binary += String.fromCharCode( bytes[i] );
        }
        return "data:application/octet-stream;base64," + btoa( binary );
    }


    private static _decodeDataUri( uri: string ): Uint8Array
    {
        const match = /^data:.*?(;base64)?,(.*)$/u.exec( uri );
        if ( !match ) {
            throw new Error( "Invalid data URI in glTF buffer" );
        }

        const payload = match[2];
        if ( match[1] ) {
            if ( typeof Buffer !== "undefined" ) {
                return new Uint8Array( Buffer.from( payload, "base64" ) );
            }

            const binary = atob( payload );
            const decoded = new Uint8Array( binary.length );
            for ( let i = 0; i < binary.length; ++i ) {
                decoded[i] = binary.charCodeAt( i );
            }
            return decoded;
        }

        const text = decodeURIComponent( payload );
        const decoded = new Uint8Array( text.length );
        for ( let i = 0; i < text.length; ++i ) {
            decoded[i] = text.charCodeAt( i ) & 0xff;
        }
        return decoded;
    }

    private static _parseGlb( glb: ArrayBuffer ): ThreeDTileset.ParsedGlb
    {
        const dview = new DataView( glb );
        if ( dview.byteLength < 20 || dview.getUint32( 0, true ) !== 0x46546c67 ) {
            throw new Error( "Invalid GLB header" );
        }

        const version = dview.getUint32( 4, true );
        if ( version !== 2 ) {
            throw new Error( "Unsupported GLB version: " + version );
        }

        let offset = 12;
        let json_chunk: Uint8Array | null = null;
        let bin_chunk: Uint8Array | null = null;

        while ( offset + 8 <= dview.byteLength ) {
            const chunk_length = dview.getUint32( offset, true );
            const chunk_type = dview.getUint32( offset + 4, true );
            const chunk_start = offset + 8;
            const chunk_end = chunk_start + chunk_length;
            if ( chunk_end > dview.byteLength ) {
                throw new Error( "Invalid GLB chunk" );
            }

            const chunk = new Uint8Array( glb, chunk_start, chunk_length );
            if ( chunk_type === 0x4E4F534A ) {
                json_chunk = chunk;
            }
            else if ( chunk_type === 0x004E4942 ) {
                bin_chunk = chunk;
            }

            offset = chunk_end;
        }

        if ( json_chunk === null ) {
            throw new Error( "GLB JSON chunk not found" );
        }

        return {
            json: JSON.parse( new TextDecoder().decode( json_chunk ).replace( /\0+$/u, "" ) ),
            binary_chunk: bin_chunk ?? undefined,
        };
    }


    private static _extractGlbFromB3dm( b3dm: ArrayBuffer ): ArrayBuffer
    {
        const dview = new DataView( b3dm );
        if ( dview.byteLength < 28 || dview.getUint32( 0, true ) !== 0x6d643362 ) {
            throw new Error( "Invalid b3dm header" );
        }

        const version = dview.getUint32( 4, true );
        if ( version !== 1 ) {
            throw new Error( "Unsupported b3dm version: " + version );
        }

        const byte_length = dview.getUint32( 8, true );
        let feature_json_length = dview.getUint32( 12, true );
        let feature_binary_length = dview.getUint32( 16, true );
        let batch_json_length = dview.getUint32( 20, true );
        let batch_binary_length = dview.getUint32( 24, true );
        let glb_offset = 28;

        if ( batch_json_length >= 570425344 ) {
            glb_offset -= 8;
            batch_json_length = feature_binary_length;
            batch_binary_length = 0;
            feature_json_length = 0;
            feature_binary_length = 0;
        }
        else if ( batch_binary_length >= 570425344 ) {
            glb_offset -= 4;
            batch_json_length = feature_json_length;
            batch_binary_length = feature_binary_length;
            feature_json_length = 0;
            feature_binary_length = 0;
        }

        glb_offset += feature_json_length + feature_binary_length + batch_json_length + batch_binary_length;

        if ( byte_length > dview.byteLength || glb_offset >= byte_length ) {
            throw new Error( "Invalid b3dm layout" );
        }

        const glb_byte_length = byte_length - glb_offset;
        if ( glb_offset % 4 === 0 ) {
            return b3dm.slice( glb_offset, byte_length );
        }

        const copied = new Uint8Array( glb_byte_length );
        copied.set( new Uint8Array( b3dm, glb_offset, glb_byte_length ) );
        return copied.buffer;
    }


    private async _loadCompositeTileContent(
        tile: ThreeDTileset.Tile,
        composite: ArrayBuffer,
        base_resource: Resource
    ): Promise<ThreeDTileset.LoadedContent>
    {
        const entries = ThreeDTileset._parseComposite( composite );
        const loaded_entries = await Promise.all( entries.map( entry => (
            this._loadBinaryTileContentData( tile, entry.type, entry.payload, base_resource )
        ) ) );
        const primitives: Primitive[] = [];
        const external_tiles: ThreeDTileset.Tile[] = [];

        for ( const loaded of loaded_entries ) {
            if ( loaded.primitives ) {
                primitives.push( ...loaded.primitives );
            }

            if ( loaded.external_tiles.length > 0 ) {
                external_tiles.push( ...loaded.external_tiles );
            }
        }

        return { primitives, external_tiles };
    }


    private async _loadI3dmContent(
        tile: ThreeDTileset.Tile,
        i3dm_binary: ArrayBuffer,
        base_resource: Resource
    ): Promise<ThreeDTileset.LoadedContent>
    {
        const parsed = ThreeDTileset._parseI3dm( i3dm_binary );
        const gltf_payload = await this._loadI3dmGltfPayload( parsed, base_resource );
        const base_primitives = await this._getModelPrimitiveTemplates(
            gltf_payload.json,
            gltf_payload.base_resource,
            gltf_payload.binary_chunk,
            gltf_payload.cache_key
        );

        const instances = ThreeDTileset._createI3dmInstanceTransforms( tile, parsed.feature_table_json, parsed.feature_table_binary );
        const primitives: Primitive[] = [];

        for ( const instance_transform of instances ) {
            for ( const base_primitive of base_primitives ) {
                const primitive = base_primitive.fastClone();
                GeoMath.mul_AA( instance_transform, primitive.transform, primitive.transform );
                primitive.properties = primitive.properties ? { ...primitive.properties } : {};
                primitives.push( primitive );
            }
        }

        this._retainPrimitiveMeshes( primitives );

        return { primitives, external_tiles: [] };
    }


    private async _loadI3dmGltfPayload(
        parsed: ThreeDTileset.ParsedI3dm,
        base_resource: Resource
    ): Promise<ThreeDTileset.GltfPayload>
    {
        if ( parsed.gltf_format === 1 ) {
            const glb = ThreeDTileset._cloneToArrayBuffer( parsed.gltf );
            const parsed_glb = ThreeDTileset._parseGlb( glb );
            return {
                json: parsed_glb.json,
                binary_chunk: parsed_glb.binary_chunk,
                base_resource,
            };
        }

        const gltf_uri = new TextDecoder().decode( parsed.gltf ).replace( /[\0\s]+$/u, "" );
        if ( !base_resource.resolveResourceSupported() ) {
            throw new Error( "Sub resource is not supported for i3dm glTF URI" );
        }

        const gltf_resource = base_resource.resolveResource( gltf_uri );
        const content_type = ThreeDTileset._inferContentType( gltf_uri );
        if ( content_type === "gltf" ) {
            return {
                json: await gltf_resource.loadAsJson(),
                base_resource: gltf_resource,
                cache_key: gltf_resource.toString(),
            };
        }
        else if ( content_type === "glb" ) {
            const glb = await gltf_resource.loadAsBinary();
            const parsed_glb = ThreeDTileset._parseGlb( glb );
            return {
                json: parsed_glb.json,
                binary_chunk: parsed_glb.binary_chunk,
                base_resource: gltf_resource,
                cache_key: gltf_resource.toString(),
            };
        }

        throw new Error( "Unsupported i3dm glTF URI type" );
    }


    private async _loadPntsContent( tile: ThreeDTileset.Tile, pnts_binary: ArrayBuffer ): Promise<ThreeDTileset.LoadedContent>
    {
        const parsed = await ThreeDTileset._parsePnts( pnts_binary );
        parsed.point_size = this._point_size;
        const primitive = await this._createPointPrimitive( tile, parsed );
        return { primitives: [primitive], external_tiles: [] };
    }


    private async _createPointPrimitive( tile: ThreeDTileset.Tile, parsed: ThreeDTileset.ParsedPnts ): Promise<Primitive>
    {
        if ( this._pnts_worker_pool ) {
            try {
                const transformed = await this._pnts_worker_pool.run(
                    {
                        tileTransform: tile.computed_transform,
                        rtcCenter: parsed.rtc_center,
                        positions: parsed.positions,
                        colors: parsed.colors,
                        normals: parsed.normals,
                    },
                    []
                );

                return ThreeDTileset._createPointPrimitiveFromTransformedData(
                    this._viewer,
                    this._point_material,
                    transformed,
                    parsed
                );
            }
            catch ( error ) {
                console.warn( "Falling back to main-thread pnts transform", error );
            }
        }

        return ThreeDTileset._createPointPrimitive( this._viewer, this._point_material, tile, parsed );
    }


    private static _detectBinaryContentType( binary: ArrayBuffer, hinted_type: ContentType | null ): ThreeDTileset.BinaryContentType
    {
        const magic = ThreeDTileset._getMagic( binary );
        if ( magic === "glTF" ) return "glb";
        if ( magic === "b3dm" ) return "b3dm";
        if ( magic === "i3dm" ) return "i3dm";
        if ( magic === "pnts" ) return "pnts";
        if ( magic === "cmpt" ) return "cmpt";

        if ( hinted_type === "glb" || hinted_type === "b3dm" || hinted_type === "i3dm" || hinted_type === "pnts" || hinted_type === "cmpt" ) {
            return hinted_type;
        }

        throw new Error( "Unsupported binary tile content type" );
    }


    private static _getMagic( binary: ArrayBuffer ): string
    {
        return new TextDecoder().decode( new Uint8Array( binary, 0, Math.min( 4, binary.byteLength ) ) );
    }


    private static _applyTransformToPrimitives( primitives: Primitive[], transform: Matrix ): void
    {
        for ( const primitive of primitives ) {
            GeoMath.mul_AA( transform, primitive.transform, primitive.transform );
        }
    }


    private _retainPrimitiveMeshes( primitives: Primitive[] ): void
    {
        this._retainMeshes( ThreeDTileset._collectUniquePrimitiveMeshes( primitives ) );
    }


    private _retainMeshes( meshes: Mesh[] ): void
    {
        for ( const mesh of meshes ) {
            this._mesh_ref_counts.set( mesh, (this._mesh_ref_counts.get( mesh ) ?? 0) + 1 );
        }
    }


    private _releasePrimitiveMeshes( primitives: Primitive[] ): void
    {
        this._releaseMeshes( ThreeDTileset._collectUniquePrimitiveMeshes( primitives ) );
    }


    private _releaseMeshes( meshes: Mesh[] ): void
    {
        for ( const mesh of meshes ) {
            const current = this._mesh_ref_counts.get( mesh );
            if ( current === undefined ) {
                continue;
            }

            if ( current <= 1 ) {
                this._mesh_ref_counts.delete( mesh );
                mesh.dispose();
            }
            else {
                this._mesh_ref_counts.set( mesh, current - 1 );
            }
        }
    }


    private static _collectUniquePrimitiveMeshes( primitives: Primitive[] ): Mesh[]
    {
        const meshes: Mesh[] = [];
        const seen = new Set<Mesh>();

        for ( const primitive of primitives ) {
            if ( !seen.has( primitive.mesh ) ) {
                seen.add( primitive.mesh );
                meshes.push( primitive.mesh );
            }
        }

        return meshes;
    }


    private static _cloneToArrayBuffer( data: Uint8Array ): ArrayBuffer
    {
        return data.buffer.slice( data.byteOffset, data.byteOffset + data.byteLength );
    }


    private static _parseComposite( composite: ArrayBuffer ): ThreeDTileset.ParsedCompositeEntry[]
    {
        const dview = new DataView( composite );
        if ( dview.byteLength < 16 || dview.getUint32( 0, true ) !== 0x74706d63 ) {
            throw new Error( "Invalid cmpt header" );
        }

        const version = dview.getUint32( 4, true );
        if ( version !== 1 ) {
            throw new Error( "Unsupported cmpt version: " + version );
        }

        const byte_length = dview.getUint32( 8, true );
        const tiles_length = dview.getUint32( 12, true );
        if ( byte_length > composite.byteLength ) {
            throw new Error( "Invalid cmpt byteLength" );
        }

        const entries: ThreeDTileset.ParsedCompositeEntry[] = [];
        let offset = 16;

        for ( let i = 0; i < tiles_length; ++i ) {
            if ( offset + 12 > byte_length ) {
                throw new Error( "Invalid cmpt inner tile header" );
            }

            const tile_byte_length = dview.getUint32( offset + 8, true );
            const tile_end = offset + tile_byte_length;
            if ( tile_byte_length <= 0 || tile_end > byte_length ) {
                throw new Error( "Invalid cmpt inner tile layout" );
            }

            const payload = composite.slice( offset, tile_end );
            entries.push( {
                type: ThreeDTileset._detectBinaryContentType( payload, null ),
                payload,
            } );
            offset = tile_end;
        }

        return entries;
    }


    private static _parseI3dm( i3dm: ArrayBuffer ): ThreeDTileset.ParsedI3dm
    {
        const dview = new DataView( i3dm );
        if ( dview.byteLength < 32 || dview.getUint32( 0, true ) !== 0x6d643369 ) {
            throw new Error( "Invalid i3dm header" );
        }

        const version = dview.getUint32( 4, true );
        if ( version !== 1 ) {
            throw new Error( "Unsupported i3dm version: " + version );
        }

        const byte_length = dview.getUint32( 8, true );
        const feature_json_length = dview.getUint32( 12, true );
        const feature_binary_length = dview.getUint32( 16, true );
        const batch_json_length = dview.getUint32( 20, true );
        const batch_binary_length = dview.getUint32( 24, true );
        const gltf_format = dview.getUint32( 28, true );

        if ( byte_length > dview.byteLength ) {
            throw new Error( "Invalid i3dm byteLength" );
        }
        if ( gltf_format !== 0 && gltf_format !== 1 ) {
            throw new Error( "Unsupported i3dm glTF format: " + gltf_format );
        }

        let offset = 32;
        const feature_table_json = ThreeDTileset._parseJsonChunk( i3dm, offset, feature_json_length );
        offset += feature_json_length;

        const feature_table_binary = new Uint8Array( i3dm, offset, feature_binary_length );
        offset += feature_binary_length + batch_json_length + batch_binary_length;
        if ( offset > byte_length ) {
            throw new Error( "Invalid i3dm layout" );
        }

        return {
            gltf_format,
            feature_table_json,
            feature_table_binary,
            gltf: new Uint8Array( i3dm, offset, byte_length - offset ),
        };
    }


    private static async _parsePnts( pnts: ArrayBuffer ): Promise<ThreeDTileset.ParsedPnts>
    {
        const dview = new DataView( pnts );
        if ( dview.byteLength < 28 || dview.getUint32( 0, true ) !== 0x73746e70 ) {
            throw new Error( "Invalid pnts header" );
        }

        const version = dview.getUint32( 4, true );
        if ( version !== 1 ) {
            throw new Error( "Unsupported pnts version: " + version );
        }

        const byte_length = dview.getUint32( 8, true );
        const feature_json_length = dview.getUint32( 12, true );
        const feature_binary_length = dview.getUint32( 16, true );
        const batch_json_length = dview.getUint32( 20, true );
        const batch_binary_length = dview.getUint32( 24, true );

        if ( byte_length > dview.byteLength ) {
            throw new Error( "Invalid pnts byteLength" );
        }

        let offset = 28;
        const feature_table_json = ThreeDTileset._parseJsonChunk( pnts, offset, feature_json_length );
        offset += feature_json_length;

        const feature_table_binary = new Uint8Array( pnts, offset, feature_binary_length );
        offset += feature_binary_length;

        const batch_table_json = ThreeDTileset._parseJsonChunk( pnts, offset, batch_json_length );
        offset += batch_json_length;

        const batch_table_binary = new Uint8Array( pnts, offset, batch_binary_length );
        offset += batch_binary_length;
        if ( offset > byte_length ) {
            throw new Error( "Invalid pnts layout" );
        }

        const points_length = Number( feature_table_json.POINTS_LENGTH ?? 0 );
        if ( !Number.isFinite( points_length ) || points_length < 0 ) {
            throw new Error( "Invalid POINTS_LENGTH" );
        }

        const decoded_draco = await ThreeDTileset._decodeDracoPnts( feature_table_json, feature_table_binary, points_length );
        const positions = decoded_draco?.positions ?? ThreeDTileset._decodePositions( feature_table_json, feature_table_binary, points_length );
        const colors = decoded_draco?.colors ?? ThreeDTileset._decodePntsColors( feature_table_json, feature_table_binary, points_length );
        const normals = decoded_draco?.normals ?? ThreeDTileset._decodePntsNormals( feature_table_json, feature_table_binary, points_length );
        const batch_ids = decoded_draco?.batch_ids ?? ThreeDTileset._decodePntsBatchIds( feature_table_json, feature_table_binary, points_length );
        const batch_length = batch_ids ? ThreeDTileset._getPntsBatchLength( feature_table_json ) : null;

        void batch_table_json;
        void batch_table_binary;

        if ( batch_ids && batch_length !== null ) {
            for ( let i = 0; i < batch_ids.length; ++i ) {
                if ( batch_ids[i] >= batch_length ) {
                    throw new Error( "BATCH_ID exceeds BATCH_LENGTH" );
                }
            }
        }

        return {
            positions,
            colors: colors.values,
            normals,
            has_normals: normals !== null,
            translucent: colors.translucent,
            rtc_center: ThreeDTileset._getGlobalVector3( feature_table_json, feature_table_binary, "RTC_CENTER" ) ?? GeoMath.createVector3(),
            batch_ids,
            batch_length,
            point_size: 3.0,
        };
    }


    private static _parseJsonChunk( binary: ArrayBuffer, offset: number, length: number ): any
    {
        if ( length <= 0 ) {
            return {};
        }

        return JSON.parse(
            new TextDecoder()
                .decode( new Uint8Array( binary, offset, length ) )
                .replace( /\0+$/u, "" )
                .trim()
        );
    }


    private static async _decodeDracoPnts(
        feature_table_json: any,
        feature_table_binary: Uint8Array,
        count: number
    ): Promise<ThreeDTileset.DecodedDracoPnts | null>
    {
        const extension = feature_table_json?.extensions?.["3DTILES_draco_point_compression"];
        if ( extension === undefined ) {
            return null;
        }

        const byte_offset = Number( extension.byteOffset );
        const byte_length = Number( extension.byteLength );
        const properties = extension.properties;
        if ( !Number.isFinite( byte_offset ) || !Number.isFinite( byte_length ) || typeof properties !== "object" || properties === null ) {
            throw new Error( "Invalid 3DTILES_draco_point_compression extension" );
        }
        if ( byte_offset < 0 || byte_length <= 0 || byte_offset + byte_length > feature_table_binary.byteLength ) {
            throw new Error( "Invalid Draco payload range in pnts feature table" );
        }

        const module = await ThreeDTileset._getDracoDecoderModule();
        const decoder = new module.Decoder();
        const buffer = new module.DecoderBuffer();
        const point_cloud = new module.PointCloud();
        const payload = feature_table_binary.subarray( byte_offset, byte_offset + byte_length );
        const payload_view = new Int8Array( payload.buffer, payload.byteOffset, payload.byteLength );
        let status: any = null;
        let fatal_decode_error = false;

        try {
            buffer.Init( payload_view, payload.byteLength );

            if ( decoder.GetEncodedGeometryType( buffer ) !== module.POINT_CLOUD ) {
                throw new Error( "Draco payload in pnts is not a point cloud" );
            }

            status = decoder.DecodeBufferToPointCloud( buffer, point_cloud );
            if ( !status.ok() ) {
                const error_message = typeof status.error_msg === "function" ? status.error_msg() : "unknown error";
                throw new Error( "Failed to decode Draco pnts payload: " + error_message );
            }

            if ( point_cloud.num_points() !== count ) {
                throw new Error( "POINTS_LENGTH and Draco point count do not match" );
            }

            const position_id = ThreeDTileset._getDracoPropertyUniqueId( properties, "POSITION" );
            const rgba_id = ThreeDTileset._getDracoPropertyUniqueId( properties, "RGBA" );
            const rgb_id = ThreeDTileset._getDracoPropertyUniqueId( properties, "RGB" );
            const normal_id = ThreeDTileset._getDracoPropertyUniqueId( properties, "NORMAL" );
            const batch_id = ThreeDTileset._getDracoPropertyUniqueId( properties, "BATCH_ID" );

            return {
                positions: position_id !== null ? ThreeDTileset._decodeDracoFloatAttribute( module, decoder, point_cloud, position_id, 3, "POSITION" ) : null,
                colors: rgba_id !== null ?
                    ThreeDTileset._decodeDracoColorAttribute( module, decoder, point_cloud, rgba_id, 4, "RGBA" ) :
                    (rgb_id !== null ? ThreeDTileset._decodeDracoColorAttribute( module, decoder, point_cloud, rgb_id, 3, "RGB" ) : null),
                normals: normal_id !== null ? ThreeDTileset._decodeDracoFloatAttribute( module, decoder, point_cloud, normal_id, 3, "NORMAL" ) : null,
                batch_ids: batch_id !== null ? ThreeDTileset._decodeDracoBatchIds( module, decoder, point_cloud, batch_id ) : null,
            };
        }
        catch ( error ) {
            fatal_decode_error = error instanceof WebAssembly.RuntimeError;
            throw error;
        }
        finally {
            void status;
            module.destroy( buffer );
            if ( !fatal_decode_error ) {
                module.destroy( point_cloud );
                module.destroy( decoder );
            }
        }
    }


    private static async _getDracoDecoderModule( decoder_kind: "wasm" | "js" = "wasm", script_url?: string | null, wasm_url?: string | null ): Promise<any>
    {
        if ( decoder_kind === "js" ) {
            if ( dracoJsDecoderModulePromise === null ) {
                if ( !script_url ) {
                    throw new Error( "Draco JS decoder URL is not available" );
                }

                dracoJsDecoderModulePromise = ThreeDTileset._createDracoJsDecoderModule( script_url, wasm_url );
            }
            return await dracoJsDecoderModulePromise;
        }

        if ( dracoDecoderModulePromise === null ) {
            if ( script_url ) {
                await ThreeDTileset._loadBrowserScript( script_url );
            }
            const global_object = globalThis as any;
            const module_factory =
                global_object.createDracoDecoderModule ??
                global_object.DracoDecoderModule;
            const wasm_binary_base64 = ThreeDTileset._getGlobalString( "dracoDecoderWasmBase64" );
            const resolved_wasm_url =
                wasm_url ??
                ThreeDTileset._getGlobalString( "dracoDecoderWasmUrl" ) ??
                ThreeDTileset._getGlobalString( "dracoDecoderWasm" );

            if ( typeof module_factory !== "function" ) {
                throw new Error( "Draco decoder factory is not available" );
            }

            if ( wasm_binary_base64 ) {
                dracoDecoderModulePromise = WasmTool.createEmObjectByBese64( wasm_binary_base64, module_factory as any );
            }
            else {
                dracoDecoderModulePromise = ThreeDTileset._createDracoDecoderModuleFromFactory( module_factory, resolved_wasm_url );
            }
        }
        return await dracoDecoderModulePromise;
    }


    private static async _createDracoJsDecoderModule( script_url: string, wasm_url?: string | null ): Promise<any>
    {
        await ThreeDTileset._loadBrowserScript( script_url );
        const global_object = globalThis as any;
        const module_factory = global_object.DracoDecoderModule;

        if ( typeof module_factory !== "function" ) {
            throw new Error( "Draco JS decoder factory is not available" );
        }

        const resolved_wasm_url = wasm_url ?? ThreeDTileset._deriveDracoWasmUrl( script_url );
        const wasm_binary =
            resolved_wasm_url ?
                await ThreeDTileset._fetchArrayBuffer( resolved_wasm_url ).catch( () => null ) :
                null;

        return await ThreeDTileset._createDracoDecoderModuleFromFactory( module_factory, resolved_wasm_url, wasm_binary );
    }


    private static _getGlobalString( name: string ): string | null
    {
        const value = (globalThis as any)[name];
        return typeof value === "string" && value.length > 0 ? value : null;
    }


    private static _resolveBrowserUrl( value: string | null | undefined ): string | null
    {
        if ( !value ) {
            return null;
        }

        if ( typeof window === "undefined" || typeof window.location?.href !== "string" ) {
            return value;
        }

        try {
            return new URL( value, window.location.href ).toString();
        }
        catch {
            return value;
        }
    }


    private static _getDefaultBrowserAssetUrl( relative_path: string ): string | null
    {
        if ( !THREE_D_TILES_MODULE_BASE_URL ) {
            return null;
        }

        try {
            return new URL( relative_path, THREE_D_TILES_MODULE_BASE_URL ).toString();
        }
        catch {
            return null;
        }
    }


    private static _deriveDracoJsDecoderUrl( value: string | null | undefined ): string | null
    {
        if ( !value ) {
            return null;
        }

        return value
            .replace( /draco_wasm_wrapper\.js(?=[$?]|$)/u, "draco_decoder.js" )
            .replace( /draco_decoder_nodejs\.js(?=[$?]|$)/u, "draco_decoder.js" );
    }


    private static _deriveDracoWasmUrl( value: string | null | undefined ): string | null
    {
        if ( !value ) {
            return null;
        }

        return value
            .replace( /draco_wasm_wrapper\.js(?=[$?]|$)/u, "draco_decoder.wasm" )
            .replace( /draco_decoder_nodejs\.js(?=[$?]|$)/u, "draco_decoder.wasm" )
            .replace( /draco_decoder\.js(?=[$?]|$)/u, "draco_decoder.wasm" );
    }


    private static _isFatalDracoRuntimeError( error: unknown ): boolean
    {
        return (
            error instanceof WebAssembly.RuntimeError ||
            (error instanceof Error && /memory access out of bounds|table index is out of bounds/u.test( error.message ))
        );
    }


    private static _isBrokenDracoJsFallbackError( error: unknown ): boolean
    {
        return (
            error instanceof TypeError ||
            (error instanceof Error && /is not a function|Failed to decode Draco mesh payload/u.test( error.message ))
        );
    }


    private static _shouldResetDracoDecoderModule( error: unknown ): boolean
    {
        return (
            ThreeDTileset._isFatalDracoRuntimeError( error ) ||
            (error instanceof Error && /Failed to decode Draco mesh payload/u.test( error.message ))
        );
    }


    private static _resetDracoDecoderModule( decoder_kind: "wasm" | "js" ): void
    {
        if ( decoder_kind === "js" ) {
            dracoJsDecoderModulePromise = null;
        }
        else {
            dracoDecoderModulePromise = null;
        }
    }


    private static async _runMainThreadDracoDecode<T>( task: () => Promise<T> ): Promise<T>
    {
        const previous = dracoMainThreadDecodeTail;
        let release = () => {};
        dracoMainThreadDecodeTail = new Promise<void>( resolve => {
            release = resolve;
        } );

        await previous;

        try {
            return await task();
        }
        finally {
            release();
        }
    }


    private static _loadBrowserScript( script_url: string ): Promise<void>
    {
        const existing = dracoScriptLoadPromises.get( script_url );
        if ( existing ) {
            return existing;
        }

        const promise = new Promise<void>( (resolve, reject) => {
            if ( typeof document === "undefined" ) {
                reject( new Error( "document is not available for Draco JS decoder loading" ) );
                return;
            }

            const script = document.createElement( "script" );
            script.async = true;
            script.src = script_url;
            script.onload = () => resolve();
            script.onerror = () => reject( new Error( `Failed to load Draco decoder script: ${script_url}` ) );
            document.head.appendChild( script );
        } );

        dracoScriptLoadPromises.set( script_url, promise );
        return promise;
    }


    private static _createDracoDecoderModuleFromFactory( module_factory: (config?: any) => any, wasm_url?: string | null, wasm_binary?: Uint8Array | null ): Promise<any>
    {
        return new Promise( (resolve, reject) => {
            let settled = false;
            const settle = (module: any) => {
                if ( settled ) return;
                settled = true;
                resolve( module );
            };
            const fail = (error: any) => {
                if ( settled ) return;
                settled = true;
                reject( error );
            };

            const config = {
                onModuleLoaded: ( module: any ) => settle( module ),
                locateFile: ( path: string ) => (
                    wasm_url && path.endsWith( ".wasm" ) ? wasm_url : path
                ),
                wasmBinary: wasm_binary ?? undefined,
            };

            try {
                const maybe_module = module_factory( config );

                if ( maybe_module && typeof maybe_module.then === "function" ) {
                    maybe_module.then( settle, fail );
                    return;
                }

                if ( maybe_module && maybe_module.ready && typeof maybe_module.ready.then === "function" ) {
                    maybe_module.ready.then( settle, fail );
                    return;
                }

                if ( maybe_module && typeof maybe_module.Decoder === "function" ) {
                    settle( maybe_module );
                    return;
                }

                // Some Draco builds rely only on onModuleLoaded and return a plain config object.
                setTimeout( () => {
                    if ( !settled ) {
                        fail( new Error( "Timed out while initializing Draco decoder module" ) );
                    }
                }, 10000 );
            }
            catch ( error ) {
                fail( error );
            }
        } );
    }


    private static async _fetchArrayBuffer( resource_url: string ): Promise<Uint8Array>
    {
        const response = await fetch( resource_url );
        if ( !response.ok ) {
            throw new Error( `Failed to fetch binary resource: ${resource_url}` );
        }

        return new Uint8Array( await response.arrayBuffer() );
    }


    private static _getDracoPropertyUniqueId( properties: any, name: string ): number | null
    {
        const value = properties[name];
        if ( value === undefined ) {
            return null;
        }

        const unique_id = Number( value );
        if ( !Number.isFinite( unique_id ) || unique_id < 0 ) {
            throw new Error( "Invalid Draco property unique id: " + name );
        }

        return unique_id;
    }


    private static _createDracoMeshWorkerAttributeSpecs(
        gltf_json: any,
        primitive: any,
        extension_attributes: any
    ): DracoMeshDecodeWorkerPool.WorkerAttributeSpec[]
    {
        if ( typeof extension_attributes !== "object" || extension_attributes === null ) {
            throw new Error( "Invalid Draco mesh attributes" );
        }

        const specs: DracoMeshDecodeWorkerPool.WorkerAttributeSpec[] = [];
        for ( const semantic of Object.keys( extension_attributes ) ) {
            const accessor_index = primitive?.attributes?.[semantic];
            if ( !Number.isFinite( Number( accessor_index ) ) || accessor_index < 0 ) {
                throw new Error( "Missing accessor for Draco mesh attribute: " + semantic );
            }

            const accessor = gltf_json.accessors[accessor_index];
            if ( typeof accessor !== "object" || accessor === null ) {
                throw new Error( "Invalid accessor for Draco mesh attribute: " + semantic );
            }

            const unique_id = ThreeDTileset._getDracoPropertyUniqueId( extension_attributes, semantic );
            if ( unique_id === null ) {
                throw new Error( "Draco attribute unique id was not found: " + semantic );
            }

            specs.push( {
                semantic,
                uniqueId: unique_id,
                accessorIndex: accessor_index,
                accessorType: accessor.type,
                componentType: accessor.componentType,
                normalized: accessor.normalized === true,
            } );
        }

        return specs;
    }


    private static _decodeDracoFloatAttribute(
        module: any,
        decoder: any,
        point_cloud: any,
        unique_id: number,
        components: number,
        name: string
    ): Float32Array
    {
        const attribute = ThreeDTileset._getDracoAttribute( module, decoder, point_cloud, unique_id, components, name );
        const data = new module.DracoFloat32Array();
        try {
            if ( !decoder.GetAttributeFloatForAllPoints( point_cloud, attribute, data ) ) {
                throw new Error( "Failed to decode Draco attribute: " + name );
            }

            const expected_length = point_cloud.num_points() * components;
            if ( data.size() !== expected_length ) {
                throw new Error( "Unexpected Draco attribute length: " + name );
            }

            const values = new Float32Array( expected_length );
            for ( let i = 0; i < expected_length; ++i ) {
                values[i] = data.GetValue( i );
            }
            return values;
        }
        finally {
            module.destroy( data );
            module.destroy( attribute );
        }
    }


    private static _decodeDracoColorAttribute(
        module: any,
        decoder: any,
        point_cloud: any,
        unique_id: number,
        components: number,
        name: string
    ): { values: Float32Array; translucent: boolean }
    {
        const decoded = ThreeDTileset._decodeDracoRawAttribute( module, decoder, point_cloud, unique_id, components, name );
        const count = point_cloud.num_points();
        const values = new Float32Array( count * 4 );
        const source = decoded.values;
        let translucent = false;

        for ( let i = 0; i < count; ++i ) {
            values[4*i + 0] = ThreeDTileset._normalizeDracoColorValue( source[components*i + 0], source );
            values[4*i + 1] = ThreeDTileset._normalizeDracoColorValue( source[components*i + 1], source );
            values[4*i + 2] = ThreeDTileset._normalizeDracoColorValue( source[components*i + 2], source );
            values[4*i + 3] = components >= 4 ? ThreeDTileset._normalizeDracoColorValue( source[components*i + 3], source ) : 1.0;
            translucent = translucent || values[4*i + 3] < 1.0;
        }

        return { values, translucent };
    }


    private static _normalizeDracoColorValue( value: number, source: ThreeDTileset.NumericArray ): number
    {
        if ( source instanceof Uint8Array ) return value / 255;
        if ( source instanceof Uint16Array ) return value / 65535;
        if ( source instanceof Uint32Array ) return value / 4294967295;
        if ( source instanceof Int8Array ) return Math.max( 0, Math.min( 1, value / 127 ) );
        if ( source instanceof Int16Array ) return Math.max( 0, Math.min( 1, value / 32767 ) );
        if ( source instanceof Int32Array ) return Math.max( 0, Math.min( 1, value / 2147483647 ) );
        return Math.max( 0, Math.min( 1, value ) );
    }


    private static _decodeDracoBatchIds(
        module: any,
        decoder: any,
        point_cloud: any,
        unique_id: number
    ): Uint32Array
    {
        const decoded = ThreeDTileset._decodeDracoRawAttribute( module, decoder, point_cloud, unique_id, 1, "BATCH_ID" );
        const batch_ids = new Uint32Array( decoded.values.length );

        for ( let i = 0; i < decoded.values.length; ++i ) {
            const value = Number( decoded.values[i] );
            if ( !Number.isFinite( value ) || value < 0 || !Number.isInteger( value ) ) {
                throw new Error( "Invalid Draco BATCH_ID value" );
            }
            batch_ids[i] = value;
        }

        return batch_ids;
    }


    private static _decodeDracoRawAttribute(
        module: any,
        decoder: any,
        point_cloud: any,
        unique_id: number,
        components: number,
        name: string
    ): { values: ThreeDTileset.NumericArray }
    {
        const attribute = ThreeDTileset._getDracoAttribute( module, decoder, point_cloud, unique_id, components, name );
        try {
            switch ( attribute.data_type() ) {
            case module.DT_UINT8:
                return { values: ThreeDTileset._decodeDracoTypedAttribute( module, decoder, point_cloud, attribute, new module.DracoUInt8Array(), Uint8Array, "GetAttributeUInt8ForAllPoints", components, name ) };
            case module.DT_UINT16:
                return { values: ThreeDTileset._decodeDracoTypedAttribute( module, decoder, point_cloud, attribute, new module.DracoUInt16Array(), Uint16Array, "GetAttributeUInt16ForAllPoints", components, name ) };
            case module.DT_UINT32:
                return { values: ThreeDTileset._decodeDracoTypedAttribute( module, decoder, point_cloud, attribute, new module.DracoUInt32Array(), Uint32Array, "GetAttributeUInt32ForAllPoints", components, name ) };
            case module.DT_INT8:
                return { values: ThreeDTileset._decodeDracoTypedAttribute( module, decoder, point_cloud, attribute, new module.DracoInt8Array(), Int8Array, "GetAttributeInt8ForAllPoints", components, name ) };
            case module.DT_INT16:
                return { values: ThreeDTileset._decodeDracoTypedAttribute( module, decoder, point_cloud, attribute, new module.DracoInt16Array(), Int16Array, "GetAttributeInt16ForAllPoints", components, name ) };
            case module.DT_INT32:
                return { values: ThreeDTileset._decodeDracoTypedAttribute( module, decoder, point_cloud, attribute, new module.DracoInt32Array(), Int32Array, "GetAttributeInt32ForAllPoints", components, name ) };
            case module.DT_FLOAT32:
                return { values: ThreeDTileset._decodeDracoTypedAttribute( module, decoder, point_cloud, attribute, new module.DracoFloat32Array(), Float32Array, "GetAttributeFloatForAllPoints", components, name ) };
            default:
                throw new Error( "Unsupported Draco data type for attribute: " + name );
            }
        }
        finally {
            module.destroy( attribute );
        }
    }


    private static _decodeDracoTypedAttribute<T extends ThreeDTileset.NumericArray>(
        module: any,
        decoder: any,
        point_cloud: any,
        attribute: any,
        draco_array: any,
        ctor: {
            new(length: number): T;
        },
        method_name: string,
        components: number,
        name: string
    ): T
    {
        try {
            const method = decoder[method_name];
            if ( typeof method !== "function" || !method.call( decoder, point_cloud, attribute, draco_array ) ) {
                throw new Error( "Failed to decode Draco attribute: " + name );
            }

            const expected_length = point_cloud.num_points() * components;
            if ( draco_array.size() !== expected_length ) {
                throw new Error( "Unexpected Draco attribute length: " + name );
            }

            const values = new ctor( expected_length );
            for ( let i = 0; i < expected_length; ++i ) {
                values[i] = draco_array.GetValue( i );
            }
            return values;
        }
        finally {
            module.destroy( draco_array );
        }
    }


    private static _getDracoAttribute(
        module: any,
        decoder: any,
        point_cloud: any,
        unique_id: number,
        components: number,
        name: string
    ): any
    {
        const attribute = decoder.GetAttributeByUniqueId( point_cloud, unique_id );
        if ( !attribute || attribute.ptr === 0 ) {
            throw new Error( "Draco attribute was not found: " + name );
        }
        if ( attribute.num_components() !== components ) {
            throw new Error( "Unexpected Draco attribute component count: " + name );
        }
        return attribute;
    }


    private static _decodePositions( feature_table_json: any, feature_table_binary: Uint8Array, count: number ): Float32Array
    {
        const positions = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "POSITION", Float32Array, 3, count );
        if ( positions ) {
            return new Float32Array( positions );
        }

        const quantized = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "POSITION_QUANTIZED", Uint16Array, 3, count );
        if ( !quantized ) {
            throw new Error( "Either POSITION or POSITION_QUANTIZED must be defined" );
        }

        const offset = ThreeDTileset._getGlobalVector3( feature_table_json, feature_table_binary, "QUANTIZED_VOLUME_OFFSET" );
        const scale = ThreeDTileset._getGlobalVector3( feature_table_json, feature_table_binary, "QUANTIZED_VOLUME_SCALE" );
        if ( !offset || !scale ) {
            throw new Error( "Quantized positions require QUANTIZED_VOLUME_OFFSET and QUANTIZED_VOLUME_SCALE" );
        }

        const decoded = new Float32Array( quantized.length );
        for ( let i = 0; i < count; ++i ) {
            decoded[3*i + 0] = (quantized[3*i + 0] / 65535) * scale[0] + offset[0];
            decoded[3*i + 1] = (quantized[3*i + 1] / 65535) * scale[1] + offset[1];
            decoded[3*i + 2] = (quantized[3*i + 2] / 65535) * scale[2] + offset[2];
        }
        return decoded;
    }


    private static _decodePntsColors(
        feature_table_json: any,
        feature_table_binary: Uint8Array,
        count: number
    ): { values: Float32Array; translucent: boolean }
    {
        const rgba = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "RGBA", Uint8Array, 4, count );
        if ( rgba ) {
            const values = new Float32Array( count * 4 );
            let translucent = false;

            for ( let i = 0; i < count; ++i ) {
                values[4*i + 0] = rgba[4*i + 0] / 255;
                values[4*i + 1] = rgba[4*i + 1] / 255;
                values[4*i + 2] = rgba[4*i + 2] / 255;
                values[4*i + 3] = rgba[4*i + 3] / 255;
                translucent = translucent || rgba[4*i + 3] < 255;
            }

            return { values, translucent };
        }

        const rgb = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "RGB", Uint8Array, 3, count );
        if ( rgb ) {
            const values = new Float32Array( count * 4 );
            for ( let i = 0; i < count; ++i ) {
                values[4*i + 0] = rgb[3*i + 0] / 255;
                values[4*i + 1] = rgb[3*i + 1] / 255;
                values[4*i + 2] = rgb[3*i + 2] / 255;
                values[4*i + 3] = 1.0;
            }
            return { values, translucent: false };
        }

        const rgb565 = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "RGB565", Uint16Array, 1, count );
        if ( rgb565 ) {
            const values = new Float32Array( count * 4 );
            for ( let i = 0; i < count; ++i ) {
                const color = rgb565[i];
                values[4*i + 0] = ((color >> 11) & 0x1f) / 31;
                values[4*i + 1] = ((color >> 5) & 0x3f) / 63;
                values[4*i + 2] = (color & 0x1f) / 31;
                values[4*i + 3] = 1.0;
            }
            return { values, translucent: false };
        }

        const constant_rgba = ThreeDTileset._getGlobalArray( feature_table_json, feature_table_binary, "CONSTANT_RGBA", Uint8Array, 4 );
        const color = constant_rgba ?? new Uint8Array( [255, 255, 255, 255] );
        const values = new Float32Array( count * 4 );
        for ( let i = 0; i < count; ++i ) {
            values[4*i + 0] = color[0] / 255;
            values[4*i + 1] = color[1] / 255;
            values[4*i + 2] = color[2] / 255;
            values[4*i + 3] = color[3] / 255;
        }
        return { values, translucent: color[3] < 255 };
    }


    private static _decodePntsNormals(
        feature_table_json: any,
        feature_table_binary: Uint8Array,
        count: number
    ): Float32Array | null
    {
        const normals = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "NORMAL", Float32Array, 3, count );
        if ( normals ) {
            return new Float32Array( normals );
        }

        const oct_normals = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "NORMAL_OCT16P", Uint8Array, 2, count );
        if ( oct_normals === null ) {
            return null;
        }

        const decoded = new Float32Array( count * 3 );
        const normal = GeoMath.createVector3();
        for ( let i = 0; i < count; ++i ) {
            ThreeDTileset._decodeOct( oct_normals[2*i + 0], oct_normals[2*i + 1], 255, normal );
            decoded[3*i + 0] = normal[0];
            decoded[3*i + 1] = normal[1];
            decoded[3*i + 2] = normal[2];
        }

        return decoded;
    }


    private static _decodePntsBatchIds(
        feature_table_json: any,
        feature_table_binary: Uint8Array,
        count: number
    ): Uint32Array | null
    {
        const property = feature_table_json.BATCH_ID;
        if ( !property || typeof property !== "object" || typeof property.byteOffset !== "number" ) {
            return null;
        }

        const component_type = typeof property.componentType === "string" ? property.componentType : "UNSIGNED_SHORT";
        let source: Uint8Array | Uint16Array | Uint32Array | null;
        switch ( component_type ) {
        case "UNSIGNED_BYTE":
            source = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "BATCH_ID", Uint8Array, 1, count );
            break;
        case "UNSIGNED_SHORT":
            source = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "BATCH_ID", Uint16Array, 1, count );
            break;
        case "UNSIGNED_INT":
            source = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "BATCH_ID", Uint32Array, 1, count );
            break;
        default:
            throw new Error( "Unsupported BATCH_ID componentType: " + component_type );
        }

        if ( source === null ) {
            return null;
        }

        const batch_ids = new Uint32Array( count );
        for ( let i = 0; i < count; ++i ) {
            batch_ids[i] = source[i];
        }

        return batch_ids;
    }


    private static _getPntsBatchLength( feature_table_json: any ): number
    {
        const batch_length = Number( feature_table_json.BATCH_LENGTH );
        if ( !Number.isFinite( batch_length ) || batch_length < 0 || !Number.isInteger( batch_length ) ) {
            throw new Error( "BATCH_LENGTH must be defined when BATCH_ID is present" );
        }
        return batch_length;
    }


    private static _createI3dmInstanceTransforms(
        tile: ThreeDTileset.Tile,
        feature_table_json: any,
        feature_table_binary: Uint8Array
    ): Matrix[]
    {
        const instances_length = Number( feature_table_json.INSTANCES_LENGTH ?? 0 );
        if ( !Number.isFinite( instances_length ) || instances_length < 0 ) {
            throw new Error( "Invalid INSTANCES_LENGTH" );
        }

        const positions = ThreeDTileset._decodePositions( feature_table_json, feature_table_binary, instances_length );
        const rtc_center = ThreeDTileset._getGlobalVector3( feature_table_json, feature_table_binary, "RTC_CENTER" ) ?? GeoMath.createVector3();
        const scale_uniform = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "SCALE", Float32Array, 1, instances_length );
        const scale_non_uniform = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "SCALE_NON_UNIFORM", Float32Array, 3, instances_length );
        const normals_up = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "NORMAL_UP", Float32Array, 3, instances_length );
        const normals_right = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "NORMAL_RIGHT", Float32Array, 3, instances_length );
        const normals_up_oct = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "NORMAL_UP_OCT32P", Uint16Array, 2, instances_length );
        const normals_right_oct = ThreeDTileset._getFeatureTableTypedArray( feature_table_json, feature_table_binary, "NORMAL_RIGHT_OCT32P", Uint16Array, 2, instances_length );
        const east_north_up = Boolean( feature_table_json.EAST_NORTH_UP );

        if ( (normals_up !== null) !== (normals_right !== null) ) {
            throw new Error( "i3dm custom orientation requires both NORMAL_UP and NORMAL_RIGHT" );
        }
        if ( (normals_up_oct !== null) !== (normals_right_oct !== null) ) {
            throw new Error( "i3dm oct-encoded orientation requires both NORMAL_UP_OCT32P and NORMAL_RIGHT_OCT32P" );
        }

        const transforms: Matrix[] = [];
        const inverse_tile_transform = GeoMath.inverse_A( tile.computed_transform, GeoMath.createMatrix() );
        const geo_point = new GeoPoint();
        const local_position = GeoMath.createVector3();
        const world_position = GeoMath.createVector3();
        const right = GeoMath.createVector3();
        const up = GeoMath.createVector3();
        const forward = GeoMath.createVector3();
        const world_basis = GeoMath.createMatrix();

        for ( let i = 0; i < instances_length; ++i ) {
            local_position[0] = positions[3*i + 0] + rtc_center[0];
            local_position[1] = positions[3*i + 1] + rtc_center[1];
            local_position[2] = positions[3*i + 2] + rtc_center[2];

            if ( normals_up && normals_right ) {
                right[0] = normals_right[3*i + 0];
                right[1] = normals_right[3*i + 1];
                right[2] = normals_right[3*i + 2];
                up[0] = normals_up[3*i + 0];
                up[1] = normals_up[3*i + 1];
                up[2] = normals_up[3*i + 2];
                GeoMath.normalize3( right, right );
                GeoMath.normalize3( up, up );
                GeoMath.cross3( right, up, forward );
                GeoMath.normalize3( forward, forward );
            }
            else if ( normals_up_oct && normals_right_oct ) {
                ThreeDTileset._decodeOct32P( normals_right_oct[2*i + 0], normals_right_oct[2*i + 1], right );
                ThreeDTileset._decodeOct32P( normals_up_oct[2*i + 0], normals_up_oct[2*i + 1], up );
                GeoMath.cross3( right, up, forward );
                GeoMath.normalize3( forward, forward );
            }
            else if ( east_north_up ) {
                GeoMath.transformPosition_A( tile.computed_transform, local_position, world_position );
                geo_point.setFromGocs( world_position );
                geo_point.getMlocsToGocsMatrix( world_basis );

                GeoMath.transformDirection_A( inverse_tile_transform, GeoMath.createVector3( [world_basis[0], world_basis[1], world_basis[2]] ), right );
                GeoMath.transformDirection_A( inverse_tile_transform, GeoMath.createVector3( [world_basis[4], world_basis[5], world_basis[6]] ), up );
                GeoMath.transformDirection_A( inverse_tile_transform, GeoMath.createVector3( [world_basis[8], world_basis[9], world_basis[10]] ), forward );
                GeoMath.normalize3( right, right );
                GeoMath.normalize3( up, up );
                GeoMath.normalize3( forward, forward );
            }
            else {
                right[0] = 1; right[1] = 0; right[2] = 0;
                up[0] = 0; up[1] = 1; up[2] = 0;
                forward[0] = 0; forward[1] = 0; forward[2] = 1;
            }

            const uniform_scale = scale_uniform ? scale_uniform[i] : 1.0;
            const sx = uniform_scale * (scale_non_uniform ? scale_non_uniform[3*i + 0] : 1.0);
            const sy = uniform_scale * (scale_non_uniform ? scale_non_uniform[3*i + 1] : 1.0);
            const sz = uniform_scale * (scale_non_uniform ? scale_non_uniform[3*i + 2] : 1.0);

            const local_transform = GeoMath.createMatrix();
            local_transform[0] = right[0] * sx;
            local_transform[1] = right[1] * sx;
            local_transform[2] = right[2] * sx;
            local_transform[3] = 0;
            local_transform[4] = up[0] * sy;
            local_transform[5] = up[1] * sy;
            local_transform[6] = up[2] * sy;
            local_transform[7] = 0;
            local_transform[8] = forward[0] * sz;
            local_transform[9] = forward[1] * sz;
            local_transform[10] = forward[2] * sz;
            local_transform[11] = 0;
            local_transform[12] = local_position[0];
            local_transform[13] = local_position[1];
            local_transform[14] = local_position[2];
            local_transform[15] = 1;

            transforms.push( GeoMath.mul_AA( tile.computed_transform, local_transform, GeoMath.createMatrix() ) );
        }

        return transforms;
    }


    private static _decodeOct32P( x: number, y: number, dst: Vector3 ): Vector3
    {
        return ThreeDTileset._decodeOct( x, y, 65535, dst );
    }


    private static _decodeOct( x: number, y: number, range: number, dst: Vector3 ): Vector3
    {
        let fx = x / range * 2 - 1;
        let fy = y / range * 2 - 1;
        let fz = 1 - Math.abs( fx ) - Math.abs( fy );

        if ( fz < 0 ) {
            const old_x = fx;
            fx = (1 - Math.abs( fy )) * ThreeDTileset._sign( old_x );
            fy = (1 - Math.abs( old_x )) * ThreeDTileset._sign( fy );
            fz = 1 - Math.abs( fx ) - Math.abs( fy );
        }

        dst[0] = fx;
        dst[1] = fy;
        dst[2] = fz;
        return GeoMath.normalize3( dst, dst );
    }


    private static _sign( value: number ): number
    {
        return value < 0 ? -1 : 1;
    }


    private static _getFeatureTableTypedArray<T extends Float32Array | Uint8Array | Uint16Array | Uint32Array>(
        feature_table_json: any,
        feature_table_binary: Uint8Array,
        name: string,
        ctor: {
            new(buffer: ArrayBufferLike, byteOffset: number, length: number): T;
            BYTES_PER_ELEMENT: number;
        },
        components: number,
        count: number
    ): T | null
    {
        const property = feature_table_json[name];
        if ( !property || typeof property !== "object" || typeof property.byteOffset !== "number" ) {
            return null;
        }

        const length = components * count;
        const byte_offset = feature_table_binary.byteOffset + property.byteOffset;
        const byte_length = length * ctor.BYTES_PER_ELEMENT;
        if ( property.byteOffset < 0 || property.byteOffset + byte_length > feature_table_binary.byteLength ) {
            throw new Error( "Invalid feature table property: " + name );
        }

        return new ctor( feature_table_binary.buffer, byte_offset, length );
    }


    private static _getGlobalArray<T extends Float32Array | Uint8Array>(
        feature_table_json: any,
        feature_table_binary: Uint8Array,
        name: string,
        ctor: {
            new(buffer: ArrayBufferLike, byteOffset: number, length: number): T;
            from(arrayLike: ArrayLike<number>): T;
            BYTES_PER_ELEMENT: number;
        },
        length: number
    ): T | null
    {
        const property = feature_table_json[name];
        if ( property === undefined ) {
            return null;
        }

        if ( Array.isArray( property ) ) {
            return ctor.from( property );
        }

        if ( typeof property === "object" && property !== null && typeof property.byteOffset === "number" ) {
            const byte_offset = feature_table_binary.byteOffset + property.byteOffset;
            const byte_length = length * ctor.BYTES_PER_ELEMENT;
            if ( property.byteOffset < 0 || property.byteOffset + byte_length > feature_table_binary.byteLength ) {
                throw new Error( "Invalid global feature table property: " + name );
            }
            return new ctor( feature_table_binary.buffer, byte_offset, length );
        }

        return null;
    }


    private static _getGlobalVector3( feature_table_json: any, feature_table_binary: Uint8Array, name: string ): Vector3 | null
    {
        const value = ThreeDTileset._getGlobalArray( feature_table_json, feature_table_binary, name, Float32Array, 3 );
        return value ? GeoMath.createVector3( [value[0], value[1], value[2]] ) : null;
    }


    private static _createPointPrimitive(
        viewer: Viewer,
        material: ThreeDTilesPointMaterial,
        tile: ThreeDTileset.Tile,
        parsed: ThreeDTileset.ParsedPnts
    ): Primitive
    {
        const count = parsed.positions.length / 3;
        const min = GeoMath.createVector3( [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] );
        const max = GeoMath.createVector3( [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY] );

        for ( let i = 0; i < count; ++i ) {
            min[0] = Math.min( min[0], parsed.positions[3*i + 0] );
            min[1] = Math.min( min[1], parsed.positions[3*i + 1] );
            min[2] = Math.min( min[2], parsed.positions[3*i + 2] );
            max[0] = Math.max( max[0], parsed.positions[3*i + 0] );
            max[1] = Math.max( max[1], parsed.positions[3*i + 1] );
            max[2] = Math.max( max[2], parsed.positions[3*i + 2] );
        }

        const local_center = GeoMath.createVector3( [
            0.5 * (min[0] + max[0]),
            0.5 * (min[1] + max[1]),
            0.5 * (min[2] + max[2]),
        ] );
        const anchor = GeoMath.add3( parsed.rtc_center, local_center, GeoMath.createVector3() );
        const anchor_ecef = GeoMath.transformPosition_A( tile.computed_transform, anchor, GeoMath.createVector3() );
        const anchor_geo_point = ThreeDTileset._convertEcefToGeoPoint( anchor_ecef );
        const mlocs_to_gocs = anchor_geo_point.getMlocsToGocsMatrix( GeoMath.createMatrix() );
        const gocs_to_mlocs = GeoMath.inverse_A( mlocs_to_gocs, GeoMath.createMatrix() );

        const positions = new Float32Array( count * 3 );
        const colors = new Uint8Array( count * 4 );
        const normals = parsed.normals ? new Int8Array( count * 4 ) : null;
        const transformed_min = GeoMath.createVector3( [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] );
        const transformed_max = GeoMath.createVector3( [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY] );
        const tile_position = GeoMath.createVector3();
        const world_position = GeoMath.createVector3();
        const mapray_world_position = GeoMath.createVector3();
        const transformed_position = GeoMath.createVector3();
        const local_normal = GeoMath.createVector3();
        const world_normal = GeoMath.createVector3();
        const transformed_normal = GeoMath.createVector3();

        for ( let i = 0; i < count; ++i ) {
            tile_position[0] = parsed.rtc_center[0] + parsed.positions[3*i + 0];
            tile_position[1] = parsed.rtc_center[1] + parsed.positions[3*i + 1];
            tile_position[2] = parsed.rtc_center[2] + parsed.positions[3*i + 2];
            GeoMath.transformPosition_A( tile.computed_transform, tile_position, world_position );
            ThreeDTileset._convertEcefToMaprayGocs( world_position, mapray_world_position );
            GeoMath.transformPosition_A( gocs_to_mlocs, mapray_world_position, transformed_position );

            positions[3*i + 0] = transformed_position[0];
            positions[3*i + 1] = transformed_position[1];
            positions[3*i + 2] = transformed_position[2];

            transformed_min[0] = Math.min( transformed_min[0], transformed_position[0] );
            transformed_min[1] = Math.min( transformed_min[1], transformed_position[1] );
            transformed_min[2] = Math.min( transformed_min[2], transformed_position[2] );
            transformed_max[0] = Math.max( transformed_max[0], transformed_position[0] );
            transformed_max[1] = Math.max( transformed_max[1], transformed_position[1] );
            transformed_max[2] = Math.max( transformed_max[2], transformed_position[2] );

            colors[4*i + 0] = ThreeDTileset._packPointColor( parsed.colors[4*i + 0] );
            colors[4*i + 1] = ThreeDTileset._packPointColor( parsed.colors[4*i + 1] );
            colors[4*i + 2] = ThreeDTileset._packPointColor( parsed.colors[4*i + 2] );
            colors[4*i + 3] = ThreeDTileset._packPointColor( parsed.colors[4*i + 3] );

            if ( normals ) {
                local_normal[0] = parsed.normals![3*i + 0];
                local_normal[1] = parsed.normals![3*i + 1];
                local_normal[2] = parsed.normals![3*i + 2];
                GeoMath.transformDirection_A( tile.computed_transform, local_normal, world_normal );
                ThreeDTileset._transformWorldDeltaToMlocs( mlocs_to_gocs, world_normal, transformed_normal );
                GeoMath.normalize3( transformed_normal, transformed_normal );

                normals[4*i + 0] = ThreeDTileset._packPointNormal( transformed_normal[0] );
                normals[4*i + 1] = ThreeDTileset._packPointNormal( transformed_normal[1] );
                normals[4*i + 2] = ThreeDTileset._packPointNormal( transformed_normal[2] );
                normals[4*i + 3] = 0;
            }
        }

        return ThreeDTileset._createPointPrimitiveFromTransformedData(
            viewer,
            material,
            {
                positions,
                colors,
                normals,
                bboxMin: transformed_min,
                bboxMax: transformed_max,
                anchorGeo: {
                    longitude: anchor_geo_point.longitude,
                    latitude: anchor_geo_point.latitude,
                    altitude: anchor_geo_point.altitude,
                },
            },
            parsed
        );
    }


    private static _createPointPrimitiveFromTransformedData(
        viewer: Viewer,
        material: ThreeDTilesPointMaterial,
        transformed: PntsTransformWorkerResult,
        parsed: ThreeDTileset.ParsedPnts
    ): Primitive
    {
        const count = transformed.positions.length / 3;
        const anchor_geo_point = new GeoPoint(
            transformed.anchorGeo.longitude,
            transformed.anchorGeo.latitude,
            transformed.anchorGeo.altitude
        );
        const mlocs_to_gocs = anchor_geo_point.getMlocsToGocsMatrix( GeoMath.createMatrix() );

        const init = new Mesh.Initializer( Mesh.DrawMode.POINTS, count );
        init.addAttribute( "a_position", new MeshBuffer( viewer.glenv, transformed.positions ), 3, Mesh.ComponentType.FLOAT );
        init.addAttribute( "a_color", new MeshBuffer( viewer.glenv, transformed.colors ), 4, Mesh.ComponentType.UNSIGNED_BYTE, { normalized: true } );
        if ( transformed.normals ) {
            init.addAttribute( "a_normal", new MeshBuffer( viewer.glenv, transformed.normals ), 3, Mesh.ComponentType.BYTE, { normalized: true, byte_stride: 4 } );
        }

        const mesh = new Mesh( viewer.glenv, init );

        const primitive = new Primitive(
            viewer.glenv,
            mesh,
            material,
            mlocs_to_gocs
        );

        primitive.pivot = GeoMath.createVector3();
        primitive.bbox = [
            GeoMath.createVector3( transformed.bboxMin ),
            GeoMath.createVector3( transformed.bboxMax ),
        ];
        primitive.properties = {
            point_size: parsed.point_size,
            translucent: parsed.translucent,
            has_normals: parsed.has_normals,
            batch_ids: parsed.batch_ids,
            batch_length: parsed.batch_length,
            anchor_geo_point,
        };

        return primitive;
    }


    private static _packPointColor( value: number ): number
    {
        return Math.max( 0, Math.min( 255, Math.round( value * 255 ) ) );
    }


    private static _packPointNormal( value: number ): number
    {
        return Math.max( -127, Math.min( 127, Math.round( value * 127 ) ) );
    }


    private _drawOpaquePrimitives( stage: RenderStage, primitives: Primitive[] ): void
    {
        primitives.sort( ( a, b ) => b.sort_z - a.sort_z );

        const gl = this._viewer.glenv.context;
        gl.disable( gl.BLEND );
        gl.depthMask( true );

        for ( const primitive of primitives ) {
            primitive.draw( stage );
        }
    }


    private _drawTranslucentPrimitives( stage: RenderStage, primitives: Primitive[] ): void
    {
        primitives.sort( ( a, b ) => a.sort_z - b.sort_z );

        const gl = this._viewer.glenv.context;
        gl.enable( gl.BLEND );
        gl.depthMask( false );

        for ( const primitive of primitives ) {
            primitive.draw( stage );
        }

        gl.disable( gl.BLEND );
        gl.depthMask( true );
    }


    private _endFrame(): void
    {
        this._flushRequestQueue();
        this._trimLoadedTiles();
        this._request_queue = [];
        ++this._frame_counter;
    }


    private _trimLoadedTiles(): void
    {
        if ( this._loaded_tiles.size <= this._max_cached_tiles ) {
            return;
        }

        const candidates = Array.from( this._loaded_tiles ).filter( tile => (
            tile.content_state === ThreeDTileset.ContentState.READY &&
            tile.last_touched_frame >= 0 &&
            tile.last_touched_frame + this._cache_hold_frames < this._frame_counter
        ) );

        candidates.sort( ( a, b ) => (
            a.last_touched_frame !== b.last_touched_frame ?
                a.last_touched_frame - b.last_touched_frame :
                a.last_screen_space_error - b.last_screen_space_error
        ) );

        for ( const tile of candidates ) {
            if ( this._loaded_tiles.size <= this._max_cached_tiles ) {
                break;
            }
            this._releaseTileContent( tile );
        }
    }


    private _releaseTileContent( tile: ThreeDTileset.Tile ): void
    {
        if ( tile.content_state !== ThreeDTileset.ContentState.READY ) {
            return;
        }

        for ( const external_tile of tile.external_tiles ) {
            this._releaseTileTree( external_tile );
        }

        if ( tile.primitives ) {
            this._releasePrimitiveMeshes( tile.primitives );
        }
        tile.primitives = null;
        tile.external_tiles = [];
        tile.content_state = tile.content_entries.length > 0 ? ThreeDTileset.ContentState.UNLOADED : ThreeDTileset.ContentState.READY;
        this._loaded_tiles.delete( tile );
        this._markFrameCacheDirty();
    }


    private _releaseTileTree( tile: ThreeDTileset.Tile ): void
    {
        for ( const child of tile.children ) {
            this._releaseTileTree( child );
        }

        for ( const external_tile of tile.external_tiles ) {
            this._releaseTileTree( external_tile );
        }

        if ( tile.primitives ) {
            this._releasePrimitiveMeshes( tile.primitives );
        }
        tile.primitives = null;
        tile.external_tiles = [];
        if ( tile.content_entries.length > 0 ) {
            tile.content_state = ThreeDTileset.ContentState.UNLOADED;
        }
        this._loaded_tiles.delete( tile );
        this._markFrameCacheDirty();
    }


    private _shouldReuseFrameCache( stage: RenderStage ): boolean
    {
        return (
            this._frame_cache_valid &&
            !this._frame_cache_dirty &&
            !this._frame_has_unresolved_tiles &&
            this._active_requests === 0 &&
            this._isStageEquivalent( stage )
        );
    }


    private _isStageEquivalent( stage: RenderStage ): boolean
    {
        if ( !Number.isFinite( this._cached_pixel_step ) || Math.abs( stage.pixel_step - this._cached_pixel_step ) > 1e-9 ) {
            return false;
        }

        return (
            ThreeDTileset._isMatrixEquivalent( stage.gocs_to_view, this._cached_gocs_to_view ) &&
            ThreeDTileset._isMatrixEquivalent( stage.gocs_to_clip, this._cached_gocs_to_clip )
        );
    }


    private static _isMatrixEquivalent( a: Matrix, b: Matrix ): boolean
    {
        for ( let i = 0; i < 16; ++i ) {
            if ( Math.abs( a[i] - b[i] ) > 1e-9 ) {
                return false;
            }
        }
        return true;
    }


    private _updateFrameCacheSnapshot( stage: RenderStage ): void
    {
        GeoMath.copyMatrix( stage.gocs_to_view, this._cached_gocs_to_view );
        GeoMath.copyMatrix( stage.gocs_to_clip, this._cached_gocs_to_clip );
        this._cached_pixel_step = stage.pixel_step;
        this._frame_cache_valid = true;
        this._frame_cache_dirty = false;
    }


    private _touchCachedTiles(): void
    {
        for ( const tile of this._cached_touched_tiles ) {
            tile.last_touched_frame = this._frame_counter;
        }
    }


    private _markFrameCacheDirty(): void
    {
        this._frame_cache_dirty = true;
    }


    private _dispose(): void
    {
        if ( this._destroyed ) {
            return;
        }

        this._destroyed = true;
        this._request_queue = [];
        for ( const tile of this._loaded_tiles ) {
            if ( tile.primitives ) {
                this._releasePrimitiveMeshes( tile.primitives );
            }
        }
        for ( const meshes of this._cache_retained_meshes.values() ) {
            this._releaseMeshes( meshes );
        }
        this._pnts_worker_pool?.destroy();
        this._draco_mesh_worker_pool?.destroy();
        this._cache_retained_meshes.clear();
        this._model_primitive_cache.clear();
        this._mesh_ref_counts.clear();
        this._loaded_tiles.clear();
        this._root_tile = null;
        this._frame_cache_valid = false;
        this._frame_cache_dirty = true;
        this._cached_touched_tiles.length = 0;
        this._opaque_primitives.length = 0;
        this._translucent_primitives.length = 0;
    }

}


namespace ThreeDTileset {


export interface BoundingVolume {
    center: Vector3;
    radius: number;
    corners: Vector3[] | null;
}


export interface Tile {
    parent?: Tile;
    refine: TileRefine;
    local_transform: Matrix;
    computed_transform: Matrix;
    geometric_error: number;
    bounding_volume: BoundingVolume;
    content_bounding_volume: BoundingVolume | null;
    children: Tile[];
    external_tiles: Tile[];
    content_entries: TileContentEntry[];
    content_state: ContentState;
    primitives: Primitive[] | null;
    last_distance_to_camera: number;
    last_screen_space_error: number;
    last_touched_frame: number;
    last_enqueued_frame: number;
}


export interface ParsedTileset {
    root: Tile;
}


export interface ParsedGlb {
    json: object;
    binary_chunk?: Uint8Array;
}


export interface TileContentEntry {
    uri: string;
    type: ContentType;
    resource: Resource | null;
    bounding_volume: BoundingVolume | null;
}


export type BinaryContentType = "glb" | "b3dm" | "i3dm" | "pnts" | "cmpt";


export interface ParsedCompositeEntry {
    type: BinaryContentType;
    payload: ArrayBuffer;
}


export interface ParsedI3dm {
    gltf_format: number;
    feature_table_json: any;
    feature_table_binary: Uint8Array;
    gltf: Uint8Array;
}


export interface GltfPayload {
    json: object;
    binary_chunk?: Uint8Array;
    base_resource: Resource;
    cache_key?: string;
}


export interface GltfBufferStorage {
    buffer_index: number;
    current_offset: number;
    use_binary_chunk: boolean;
    parts: Uint8Array[];
}


export interface DecodedDracoMeshAttribute {
    accessor_index: number;
    values: NumericArray;
    type: string;
    component_type: number;
    normalized: boolean;
    min: number[] | null;
    max: number[] | null;
}


export interface DecodedDracoMeshIndices {
    accessor_index: number | null;
    component_type: number;
    values: Uint8Array | Uint16Array | Uint32Array;
}


export interface DecodedDracoMeshPrimitive {
    vertex_count: number;
    attributes: DecodedDracoMeshAttribute[];
    indices: DecodedDracoMeshIndices | null;
}


export interface ComponentTypeInfo {
    bytes: number;
    draco_data_type: number;
    typed_array: any;
    min: number;
    max: number;
    is_float: boolean;
    is_unsigned: boolean;
}


export interface ParsedPnts {
    positions: Float32Array;
    colors: Float32Array;
    normals: Float32Array | null;
    has_normals: boolean;
    translucent: boolean;
    rtc_center: Vector3;
    batch_ids: Uint32Array | null;
    batch_length: number | null;
    point_size: number;
}


export interface LoadedContent {
    primitives: Primitive[] | null;
    external_tiles: Tile[];
}


export interface ResourceInfo {
    url: string;
}


export interface LoadRequest {
    tile: Tile;
    screen_space_error: number;
    distance: number;
}


export interface Option {
    visibility?: boolean;
    maximumScreenSpaceError?: number;
    maxConcurrentRequests?: number;
    maxCachedTiles?: number;
    cacheHoldFrames?: number;
    pointSize?: number;
    pointShape?: PointShape;
    dracoDecoderScriptUrl?: string;
    dracoDecoderWasmUrl?: string;
    dracoDecoderWorkerUrl?: string;
    dracoDecoderJsUrl?: string;
    model_matrix?: Matrix;
    transform?: Resource.TransformCallback;
}


export type PointShape =
    "rectangle" |
    "circle" |
    "circle_with_border" |
    "gradient_circle";


export type NumericArray =
    Float32Array |
    Int8Array |
    Uint8Array |
    Int16Array |
    Uint16Array |
    Int32Array |
    Uint32Array;


export interface DecodedDracoPnts {
    positions: Float32Array | null;
    colors: { values: Float32Array; translucent: boolean } | null;
    normals: Float32Array | null;
    batch_ids: Uint32Array | null;
}


export const enum ContentState {
    UNLOADED = "@@_ThreeDTileset.ContentState.UNLOADED",
    LOADING = "@@_ThreeDTileset.ContentState.LOADING",
    READY = "@@_ThreeDTileset.ContentState.READY",
    FAILED = "@@_ThreeDTileset.ContentState.FAILED",
}


}


class ThreeDTilesPointMaterial extends EntityMaterial {

    constructor( glenv: Viewer["glenv"], point_shape: ThreeDTileset.PointShape )
    {
        super( glenv, THREE_D_TILES_POINT_VS_CODE, THREE_D_TILES_POINT_FS_CODE );

        this.bindProgram();
        this.setFloat( "u_point_size", 3.0 );
        this.setFloat( "u_has_normals", 0.0 );
        this.setFloat( "u_point_shape", ThreeDTilesPointMaterial._getPointShapeCode( point_shape ) );
        this.setVector3( "u_light_dir", [0, 0, 1] );
    }


    private static _getPointShapeCode( point_shape: ThreeDTileset.PointShape ): number
    {
        switch ( point_shape ) {
            case "rectangle": return 0;
            case "circle": return 1;
            case "circle_with_border": return 2;
            case "gradient_circle":
            default:
                return 3;
        }
    }


    override isTranslucent( _stage: RenderStage, primitive: Primitive ): boolean
    {
        return Boolean( primitive.properties && (primitive.properties as any).translucent );
    }


    override setParameters( stage: RenderStage, primitive: Primitive ): void
    {
        this.setObjToClip( stage, primitive );
        this.setObjToView( stage, primitive );
        this.setFloat( "u_point_size", Number( primitive.properties && (primitive.properties as any).point_size || 3.0 ) );
        this.setFloat( "u_has_normals", primitive.properties && (primitive.properties as any).has_normals ? 1.0 : 0.0 );
        this.setVector3( "u_light_dir", [0, 0, 1] );
    }

}


const THREE_D_TILES_POINT_VS_CODE = `
attribute vec3 a_position;
attribute vec4 a_color;
attribute vec3 a_normal;

uniform mat4 u_obj_to_clip;
uniform mat4 u_obj_to_view;
uniform float u_point_size;
uniform float u_has_normals;
uniform float u_point_shape;
uniform vec3 u_light_dir;

varying vec4 v_color;
varying float v_point_shape;

void main( void )
{
    gl_Position = u_obj_to_clip * vec4( a_position, 1.0 );
    gl_PointSize = u_point_size;
    v_point_shape = u_point_shape;

    if ( u_has_normals > 0.5 ) {
        vec3 normal = normalize( (u_obj_to_view * vec4( a_normal, 0.0 )).xyz );
        float diffuse = max( dot( normal, normalize( u_light_dir ) ), 0.0 );
        float lit = 0.35 + 0.65 * diffuse;
        v_color = vec4( a_color.rgb * lit, a_color.a );
    }
    else {
        v_color = a_color;
    }
}
`;


const THREE_D_TILES_POINT_FS_CODE = `
precision highp float;

varying vec4 v_color;
varying float v_point_shape;

void main( void )
{
    if ( v_point_shape < 0.5 ) {
        gl_FragColor = v_color;
        return;
    }

    vec2 p = 2.0 * gl_PointCoord - 1.0;
    float distance_to_center = length( p );

    if ( distance_to_center > 1.0 ) {
        discard;
    }

    if ( v_point_shape < 1.5 ) {
        gl_FragColor = v_color;
        return;
    }

    if ( v_point_shape < 2.5 ) {
        if ( distance_to_center > 0.9 ) {
            gl_FragColor = vec4( 0.0, 0.0, 0.0, v_color.a );
        }
        else {
            gl_FragColor = v_color;
        }
        return;
    }

    float highlight = clamp( 1.0 - 0.3 * tan( (p.x + p.y) * 0.7853981633 ), 0.6, 1.35 );
    gl_FragColor = vec4( v_color.rgb * highlight, v_color.a );
}
`;


export default ThreeDTileset;
