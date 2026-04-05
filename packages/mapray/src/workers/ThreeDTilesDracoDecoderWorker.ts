type NumericArray =
    Float32Array |
    Int8Array |
    Uint8Array |
    Int16Array |
    Uint16Array |
    Int32Array |
    Uint32Array;


interface WorkerAttributeSpec {
    semantic: string;
    uniqueId: number;
    accessorIndex: number;
    accessorType: string;
    componentType: number;
    normalized: boolean;
}


interface WorkerRequest {
    type: "decodePrimitive";
    taskId: number;
    payload: ArrayBuffer;
    bufferViewIndex: number;
    primitiveMode: number;
    attributes: WorkerAttributeSpec[];
    indexAccessorIndex: number | null;
    indexComponentType: number | null;
}


interface WorkerInitRequest {
    type: "init";
    scriptUrl: string;
    wasmUrl: string;
}


let dracoModulePromise: Promise<any> | null = null;
const workerScope = self as any;
let loadedDracoScriptUrl: string | null = null;
let loadedDracoWasmUrl: string | null = null;


async function getDracoModule( script_url?: string, wasm_url?: string ): Promise<any>
{
    if ( dracoModulePromise === null ) {
        if ( !script_url || !wasm_url ) {
            throw new Error( "Draco worker was not initialized" );
        }

        if ( typeof workerScope.importScripts !== "function" ) {
            throw new Error( "Worker importScripts is not available" );
        }

        if ( loadedDracoScriptUrl !== script_url ) {
            workerScope.importScripts( script_url );
            loadedDracoScriptUrl = script_url;
        }

        const factory = workerScope.createDracoDecoderModule || workerScope.DracoDecoderModule;
        if ( typeof factory !== "function" ) {
            throw new Error( "Draco decoder factory is not available in worker" );
        }

        loadedDracoWasmUrl = wasm_url;
        dracoModulePromise = new Promise( (resolve, reject) => {
            let settled = false;

            const settle = ( module: any ) => {
                if ( settled ) return;
                settled = true;
                resolve( module );
            };

            const fail = ( error: any ) => {
                if ( settled ) return;
                settled = true;
                reject( error );
            };

            const config = {
                locateFile: ( path: string ) => (
                    path && path.endsWith( ".wasm" ) ? loadedDracoWasmUrl : path
                ),
                onModuleLoaded: ( module: any ) => settle( module ),
            };

            try {
                const maybe_module = factory( config );
                if ( maybe_module && typeof maybe_module.then === "function" ) {
                    maybe_module.then( settle, fail );
                    return;
                }
                if ( maybe_module && maybe_module.ready && typeof maybe_module.ready.then === "function" ) {
                    maybe_module.ready.then( () => settle( maybe_module ), fail );
                    return;
                }
                if ( maybe_module && typeof maybe_module.Decoder === "function" ) {
                    settle( maybe_module );
                    return;
                }
                setTimeout( () => fail( new Error( "Timed out while initializing Draco decoder worker" ) ), 10000 );
            }
            catch ( error ) {
                fail( error );
            }
        } );
    }

    return await dracoModulePromise;
}


function getAccessorComponentCount( accessor_type: string ): number
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


function getComponentTypeInfo( module: any, component_type: number )
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


function convertNormalizedFloatToInteger( value: number, min: number, max: number, is_unsigned: boolean ): number
{
    if ( is_unsigned ) {
        return Math.round( Math.max( 0, Math.min( 1, value ) ) * max );
    }

    const clamped = Math.max( -1, Math.min( 1, value ) );
    const scale = clamped < 0 ? -min : max;
    return Math.round( clamped * scale );
}


function convertDracoAttributeValues(
    values: NumericArray,
    component_type: number,
    normalized: boolean,
    name: string
): NumericArray
{
    const info = getComponentTypeInfo( {
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

    const converted = new info.typed_array( values.length ) as NumericArray;
    for ( let i = 0; i < values.length; ++i ) {
        const value = Number( values[i] );
        if ( !Number.isFinite( value ) ) {
            throw new Error( "Invalid Draco value: " + name );
        }

        if ( info.is_float ) {
            converted[i] = value;
        }
        else if ( normalized && values instanceof Float32Array ) {
            converted[i] = convertNormalizedFloatToInteger( value, info.min, info.max, info.is_unsigned );
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


function calculateAccessorMinMax( values: NumericArray, count: number, components: number ): { min: number[]; max: number[] } | null
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


function getDracoAttribute( module: any, decoder: any, geometry: any, unique_id: number, components: number, name: string )
{
    const attribute = decoder.GetAttributeByUniqueId( geometry, unique_id );
    if ( !attribute || attribute.ptr === 0 ) {
        throw new Error( "Draco attribute was not found: " + name );
    }
    if ( attribute.num_components() !== components ) {
        throw new Error( "Unexpected Draco attribute component count: " + name );
    }
    return attribute;
}


function decodeDracoTypedAttribute<T extends NumericArray>(
    module: any,
    decoder: any,
    geometry: any,
    attribute: any,
    draco_array: any,
    ctor: { new(length: number): T },
    method_name: string,
    components: number,
    name: string
): T
{
    try {
        const method = decoder[method_name];
        if ( typeof method !== "function" || !method.call( decoder, geometry, attribute, draco_array ) ) {
            throw new Error( "Failed to decode Draco attribute: " + name );
        }

        const expected_length = geometry.num_points() * components;
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


function decodeDracoRawAttribute( module: any, decoder: any, geometry: any, unique_id: number, components: number, name: string )
{
    const attribute = getDracoAttribute( module, decoder, geometry, unique_id, components, name );
    try {
        switch ( attribute.data_type() ) {
        case module.DT_UINT8:
            return { values: decodeDracoTypedAttribute( module, decoder, geometry, attribute, new module.DracoUInt8Array(), Uint8Array, "GetAttributeUInt8ForAllPoints", components, name ) };
        case module.DT_UINT16:
            return { values: decodeDracoTypedAttribute( module, decoder, geometry, attribute, new module.DracoUInt16Array(), Uint16Array, "GetAttributeUInt16ForAllPoints", components, name ) };
        case module.DT_UINT32:
            return { values: decodeDracoTypedAttribute( module, decoder, geometry, attribute, new module.DracoUInt32Array(), Uint32Array, "GetAttributeUInt32ForAllPoints", components, name ) };
        case module.DT_INT8:
            return { values: decodeDracoTypedAttribute( module, decoder, geometry, attribute, new module.DracoInt8Array(), Int8Array, "GetAttributeInt8ForAllPoints", components, name ) };
        case module.DT_INT16:
            return { values: decodeDracoTypedAttribute( module, decoder, geometry, attribute, new module.DracoInt16Array(), Int16Array, "GetAttributeInt16ForAllPoints", components, name ) };
        case module.DT_INT32:
            return { values: decodeDracoTypedAttribute( module, decoder, geometry, attribute, new module.DracoInt32Array(), Int32Array, "GetAttributeInt32ForAllPoints", components, name ) };
        case module.DT_FLOAT32:
            return { values: decodeDracoTypedAttribute( module, decoder, geometry, attribute, new module.DracoFloat32Array(), Float32Array, "GetAttributeFloatForAllPoints", components, name ) };
        default:
            throw new Error( "Unsupported Draco data type for attribute: " + name );
        }
    }
    finally {
        module.destroy( attribute );
    }
}


function decodeDracoMeshAttribute( module: any, decoder: any, geometry: any, spec: WorkerAttributeSpec ): NumericArray
{
    const components = getAccessorComponentCount( spec.accessorType );
    const component_info = getComponentTypeInfo( module, spec.componentType );
    const count = geometry.num_points();

    if ( typeof decoder.GetAttributeDataArrayForAllPoints === "function" && typeof module._malloc === "function" ) {
        const attribute = getDracoAttribute( module, decoder, geometry, spec.uniqueId, components, spec.semantic );
        const byte_length = count * components * component_info.bytes;
        const pointer = module._malloc( byte_length );

        try {
            if ( !decoder.GetAttributeDataArrayForAllPoints( geometry, attribute, component_info.draco_data_type, byte_length, pointer ) ) {
                throw new Error( "Failed to decode Draco mesh attribute: " + spec.semantic );
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

    const decoded = decodeDracoRawAttribute( module, decoder, geometry, spec.uniqueId, components, spec.semantic );
    return convertDracoAttributeValues( decoded.values, spec.componentType, spec.normalized === true, spec.semantic );
}


function decodeDracoMeshIndices( module: any, decoder: any, geometry: any, accessor_index: number | null, requested_component_type: number | null )
{
    const face_count = geometry.num_faces();
    const index_count = face_count * 3;
    const values = new Uint32Array( index_count );

    const face = new module.DracoInt32Array();
    try {
        for ( let i = 0; i < face_count; ++i ) {
            if ( !decoder.GetFaceFromMesh( geometry, i, face ) ) {
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

    let max_index = 0;
    for ( let i = 0; i < values.length; ++i ) {
        if ( values[i] > max_index ) {
            max_index = values[i];
        }
    }

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
        accessorIndex: typeof accessor_index === "number" ? accessor_index : null,
        componentType: component_type,
        values: convertDracoAttributeValues( values, component_type, false, "indices" ) as Uint8Array | Uint16Array | Uint32Array,
    };
}


async function handleDecodePrimitive( data: WorkerRequest )
{
    const module = await getDracoModule();
    const decoder = new module.Decoder();
    const buffer = new module.DecoderBuffer();
    let status: any = null;
    let geometry: any = null;
    let geometry_type: number | null = null;
    let fatal_error = false;

    try {
        const payload_bytes = new Uint8Array( data.payload );
        buffer.Init( payload_bytes, payload_bytes.byteLength );

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
                `(bufferView=${data.bufferViewIndex}, primitiveMode=${data.primitiveMode}, geometryType=${geometry_label})`
            );
        }

        const vertex_count = geometry.num_points();
        const attributes = data.attributes.map( spec => {
            const values = decodeDracoMeshAttribute( module, decoder, geometry, spec );
            const min_max = spec.semantic === "POSITION" ?
                calculateAccessorMinMax( values, vertex_count, getAccessorComponentCount( spec.accessorType ) ) :
                null;
            return {
                accessorIndex: spec.accessorIndex,
                values,
                type: spec.accessorType,
                componentType: spec.componentType,
                normalized: spec.normalized,
                min: min_max?.min ?? null,
                max: min_max?.max ?? null,
            };
        } );

        const indices = geometry_type === module.TRIANGULAR_MESH ?
            decodeDracoMeshIndices( module, decoder, geometry, data.indexAccessorIndex, data.indexComponentType ) :
            null;

        const transferables: Transferable[] = attributes.map( attribute => attribute.values.buffer );
        if ( indices ) {
            transferables.push( indices.values.buffer );
        }

        workerScope.postMessage( {
            taskId: data.taskId,
            result: {
                vertexCount: vertex_count,
                attributes,
                indices,
            },
        }, transferables );
    }
    catch ( error ) {
        fatal_error = error instanceof WebAssembly.RuntimeError;
        workerScope.postMessage( {
            taskId: data.taskId,
            error: error instanceof Error ? error.message : String( error ),
            fatal: fatal_error,
        } );
    }
    finally {
        try {
            module.destroy( buffer );
        }
        catch { /* noop */ }
        if ( geometry && !fatal_error ) {
            try {
                module.destroy( geometry );
            }
            catch { /* noop */ }
        }
        if ( !fatal_error ) {
            try {
                module.destroy( decoder );
            }
            catch { /* noop */ }
        }
    }
}


workerScope.onmessage = async ( event: MessageEvent<WorkerInitRequest | WorkerRequest> ) => {
    const data = event.data;

    if ( data.type === "init" ) {
        try {
            await getDracoModule( data.scriptUrl, data.wasmUrl );
            workerScope.postMessage( { type: "initResult", ok: true } );
        }
        catch ( error ) {
            workerScope.postMessage( {
                type: "initResult",
                ok: false,
                error: error instanceof Error ? error.message : String( error ),
            } );
        }
        return;
    }

    await handleDecodePrimitive( data );
};
