(function () {
'use strict';

var __awaiter = (undefined && undefined.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
let dracoModulePromise = null;
const workerScope = self;
let loadedDracoScriptUrl = null;
let loadedDracoWasmUrl = null;
function getDracoModule(script_url, wasm_url) {
    return __awaiter(this, void 0, void 0, function* () {
        if (dracoModulePromise === null) {
            if (!script_url || !wasm_url) {
                throw new Error("Draco worker was not initialized");
            }
            if (typeof workerScope.importScripts !== "function") {
                throw new Error("Worker importScripts is not available");
            }
            if (loadedDracoScriptUrl !== script_url) {
                workerScope.importScripts(script_url);
                loadedDracoScriptUrl = script_url;
            }
            const factory = workerScope.createDracoDecoderModule || workerScope.DracoDecoderModule;
            if (typeof factory !== "function") {
                throw new Error("Draco decoder factory is not available in worker");
            }
            loadedDracoWasmUrl = wasm_url;
            dracoModulePromise = new Promise((resolve, reject) => {
                let settled = false;
                const settle = (module) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve(module);
                };
                const fail = (error) => {
                    if (settled)
                        return;
                    settled = true;
                    reject(error);
                };
                const config = {
                    locateFile: (path) => (path && path.endsWith(".wasm") ? loadedDracoWasmUrl : path),
                    onModuleLoaded: (module) => settle(module),
                };
                try {
                    const maybe_module = factory(config);
                    if (maybe_module && typeof maybe_module.then === "function") {
                        maybe_module.then(settle, fail);
                        return;
                    }
                    if (maybe_module && maybe_module.ready && typeof maybe_module.ready.then === "function") {
                        maybe_module.ready.then(() => settle(maybe_module), fail);
                        return;
                    }
                    if (maybe_module && typeof maybe_module.Decoder === "function") {
                        settle(maybe_module);
                        return;
                    }
                    setTimeout(() => fail(new Error("Timed out while initializing Draco decoder worker")), 10000);
                }
                catch (error) {
                    fail(error);
                }
            });
        }
        return yield dracoModulePromise;
    });
}
function getAccessorComponentCount(accessor_type) {
    switch (accessor_type) {
        case "SCALAR": return 1;
        case "VEC2": return 2;
        case "VEC3": return 3;
        case "VEC4": return 4;
        case "MAT2": return 4;
        case "MAT3": return 9;
        case "MAT4": return 16;
        default:
            throw new Error("Unsupported accessor type: " + accessor_type);
    }
}
function getComponentTypeInfo(module, component_type) {
    switch (component_type) {
        case 5120: return { bytes: 1, draco_data_type: module.DT_INT8, typed_array: Int8Array, min: -128, max: 127, is_float: false, is_unsigned: false };
        case 5121: return { bytes: 1, draco_data_type: module.DT_UINT8, typed_array: Uint8Array, min: 0, max: 255, is_float: false, is_unsigned: true };
        case 5122: return { bytes: 2, draco_data_type: module.DT_INT16, typed_array: Int16Array, min: -32768, max: 32767, is_float: false, is_unsigned: false };
        case 5123: return { bytes: 2, draco_data_type: module.DT_UINT16, typed_array: Uint16Array, min: 0, max: 65535, is_float: false, is_unsigned: true };
        case 5125: return { bytes: 4, draco_data_type: module.DT_UINT32, typed_array: Uint32Array, min: 0, max: 4294967295, is_float: false, is_unsigned: true };
        case 5126: return { bytes: 4, draco_data_type: module.DT_FLOAT32, typed_array: Float32Array, min: -Infinity, max: Infinity, is_float: true, is_unsigned: false };
        default:
            throw new Error("Unsupported glTF component type: " + component_type);
    }
}
function convertNormalizedFloatToInteger(value, min, max, is_unsigned) {
    if (is_unsigned) {
        return Math.round(Math.max(0, Math.min(1, value)) * max);
    }
    const clamped = Math.max(-1, Math.min(1, value));
    const scale = clamped < 0 ? -min : max;
    return Math.round(clamped * scale);
}
function convertDracoAttributeValues(values, component_type, normalized, name) {
    const info = getComponentTypeInfo({
        DT_INT8: 0,
        DT_UINT8: 0,
        DT_INT16: 0,
        DT_UINT16: 0,
        DT_UINT32: 0,
        DT_FLOAT32: 0,
    }, component_type);
    if (values instanceof info.typed_array) {
        return values;
    }
    const converted = new info.typed_array(values.length);
    for (let i = 0; i < values.length; ++i) {
        const value = Number(values[i]);
        if (!Number.isFinite(value)) {
            throw new Error("Invalid Draco value: " + name);
        }
        if (info.is_float) {
            converted[i] = value;
        }
        else if (normalized && values instanceof Float32Array) {
            converted[i] = convertNormalizedFloatToInteger(value, info.min, info.max, info.is_unsigned);
        }
        else {
            const rounded = Math.round(value);
            if (rounded < info.min || rounded > info.max) {
                throw new Error("Draco value is out of range for accessor: " + name);
            }
            converted[i] = rounded;
        }
    }
    return converted;
}
function calculateAccessorMinMax(values, count, components) {
    if (count <= 0 || components <= 0) {
        return null;
    }
    const min = new Array(components).fill(Number.POSITIVE_INFINITY);
    const max = new Array(components).fill(Number.NEGATIVE_INFINITY);
    for (let i = 0; i < count; ++i) {
        for (let c = 0; c < components; ++c) {
            const value = Number(values[components * i + c]);
            if (value < min[c])
                min[c] = value;
            if (value > max[c])
                max[c] = value;
        }
    }
    return { min, max };
}
function getDracoAttribute(module, decoder, geometry, unique_id, components, name) {
    const attribute = decoder.GetAttributeByUniqueId(geometry, unique_id);
    if (!attribute || attribute.ptr === 0) {
        throw new Error("Draco attribute was not found: " + name);
    }
    if (attribute.num_components() !== components) {
        throw new Error("Unexpected Draco attribute component count: " + name);
    }
    return attribute;
}
function decodeDracoTypedAttribute(module, decoder, geometry, attribute, draco_array, ctor, method_name, components, name) {
    try {
        const method = decoder[method_name];
        if (typeof method !== "function" || !method.call(decoder, geometry, attribute, draco_array)) {
            throw new Error("Failed to decode Draco attribute: " + name);
        }
        const expected_length = geometry.num_points() * components;
        if (draco_array.size() !== expected_length) {
            throw new Error("Unexpected Draco attribute length: " + name);
        }
        const values = new ctor(expected_length);
        for (let i = 0; i < expected_length; ++i) {
            values[i] = draco_array.GetValue(i);
        }
        return values;
    }
    finally {
        module.destroy(draco_array);
    }
}
function decodeDracoRawAttribute(module, decoder, geometry, unique_id, components, name) {
    const attribute = getDracoAttribute(module, decoder, geometry, unique_id, components, name);
    try {
        switch (attribute.data_type()) {
            case module.DT_UINT8:
                return { values: decodeDracoTypedAttribute(module, decoder, geometry, attribute, new module.DracoUInt8Array(), Uint8Array, "GetAttributeUInt8ForAllPoints", components, name) };
            case module.DT_UINT16:
                return { values: decodeDracoTypedAttribute(module, decoder, geometry, attribute, new module.DracoUInt16Array(), Uint16Array, "GetAttributeUInt16ForAllPoints", components, name) };
            case module.DT_UINT32:
                return { values: decodeDracoTypedAttribute(module, decoder, geometry, attribute, new module.DracoUInt32Array(), Uint32Array, "GetAttributeUInt32ForAllPoints", components, name) };
            case module.DT_INT8:
                return { values: decodeDracoTypedAttribute(module, decoder, geometry, attribute, new module.DracoInt8Array(), Int8Array, "GetAttributeInt8ForAllPoints", components, name) };
            case module.DT_INT16:
                return { values: decodeDracoTypedAttribute(module, decoder, geometry, attribute, new module.DracoInt16Array(), Int16Array, "GetAttributeInt16ForAllPoints", components, name) };
            case module.DT_INT32:
                return { values: decodeDracoTypedAttribute(module, decoder, geometry, attribute, new module.DracoInt32Array(), Int32Array, "GetAttributeInt32ForAllPoints", components, name) };
            case module.DT_FLOAT32:
                return { values: decodeDracoTypedAttribute(module, decoder, geometry, attribute, new module.DracoFloat32Array(), Float32Array, "GetAttributeFloatForAllPoints", components, name) };
            default:
                throw new Error("Unsupported Draco data type for attribute: " + name);
        }
    }
    finally {
        module.destroy(attribute);
    }
}
function decodeDracoMeshAttribute(module, decoder, geometry, spec) {
    const components = getAccessorComponentCount(spec.accessorType);
    const component_info = getComponentTypeInfo(module, spec.componentType);
    const count = geometry.num_points();
    if (typeof decoder.GetAttributeDataArrayForAllPoints === "function" && typeof module._malloc === "function") {
        const attribute = getDracoAttribute(module, decoder, geometry, spec.uniqueId, components, spec.semantic);
        const byte_length = count * components * component_info.bytes;
        const pointer = module._malloc(byte_length);
        try {
            if (!decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, component_info.draco_data_type, byte_length, pointer)) {
                throw new Error("Failed to decode Draco mesh attribute: " + spec.semantic);
            }
            const heap_view = new component_info.typed_array(module.HEAPU8.buffer, pointer, count * components);
            const values = new component_info.typed_array(count * components);
            values.set(heap_view);
            return values;
        }
        finally {
            module._free(pointer);
            module.destroy(attribute);
        }
    }
    const decoded = decodeDracoRawAttribute(module, decoder, geometry, spec.uniqueId, components, spec.semantic);
    return convertDracoAttributeValues(decoded.values, spec.componentType, spec.normalized === true, spec.semantic);
}
function decodeDracoMeshIndices(module, decoder, geometry, accessor_index, requested_component_type) {
    const face_count = geometry.num_faces();
    const index_count = face_count * 3;
    const values = new Uint32Array(index_count);
    const face = new module.DracoInt32Array();
    try {
        for (let i = 0; i < face_count; ++i) {
            if (!decoder.GetFaceFromMesh(geometry, i, face)) {
                throw new Error("Failed to decode Draco mesh indices");
            }
            values[3 * i + 0] = face.GetValue(0);
            values[3 * i + 1] = face.GetValue(1);
            values[3 * i + 2] = face.GetValue(2);
        }
    }
    finally {
        module.destroy(face);
    }
    let max_index = 0;
    for (let i = 0; i < values.length; ++i) {
        if (values[i] > max_index) {
            max_index = values[i];
        }
    }
    let component_type = Number.isFinite(Number(requested_component_type)) ? Number(requested_component_type) : 5125;
    if (component_type !== 5121 && component_type !== 5123 && component_type !== 5125) {
        component_type = 5125;
    }
    if (component_type === 5121 && max_index > 255) {
        component_type = max_index <= 65535 ? 5123 : 5125;
    }
    else if (component_type === 5123 && max_index > 65535) {
        component_type = 5125;
    }
    else if (component_type === 5125) {
        if (max_index <= 255)
            component_type = 5121;
        else if (max_index <= 65535)
            component_type = 5123;
    }
    return {
        accessorIndex: typeof accessor_index === "number" ? accessor_index : null,
        componentType: component_type,
        values: convertDracoAttributeValues(values, component_type, false, "indices"),
    };
}
function handleDecodePrimitive(data) {
    return __awaiter(this, void 0, void 0, function* () {
        const module = yield getDracoModule();
        const decoder = new module.Decoder();
        const buffer = new module.DecoderBuffer();
        let status = null;
        let geometry = null;
        let geometry_type = null;
        let fatal_error = false;
        try {
            const payload_bytes = new Uint8Array(data.payload);
            buffer.Init(payload_bytes, payload_bytes.byteLength);
            geometry_type = decoder.GetEncodedGeometryType(buffer);
            if (geometry_type === module.TRIANGULAR_MESH) {
                geometry = new module.Mesh();
                status = decoder.DecodeBufferToMesh(buffer, geometry);
            }
            else if (geometry_type === module.POINT_CLOUD) {
                geometry = new module.PointCloud();
                status = decoder.DecodeBufferToPointCloud(buffer, geometry);
            }
            else {
                throw new Error("Unsupported Draco glTF geometry type");
            }
            if (!status.ok() || geometry.ptr === 0) {
                const error_message = typeof status.error_msg === "function" ? status.error_msg() : "unknown error";
                const geometry_label = geometry_type === module.TRIANGULAR_MESH ? "TRIANGULAR_MESH" :
                    geometry_type === module.POINT_CLOUD ? "POINT_CLOUD" :
                        String(geometry_type);
                throw new Error(`Failed to decode Draco mesh payload: ${error_message} ` +
                    `(bufferView=${data.bufferViewIndex}, primitiveMode=${data.primitiveMode}, geometryType=${geometry_label})`);
            }
            const vertex_count = geometry.num_points();
            const attributes = data.attributes.map(spec => {
                var _a, _b;
                const values = decodeDracoMeshAttribute(module, decoder, geometry, spec);
                const min_max = spec.semantic === "POSITION" ?
                    calculateAccessorMinMax(values, vertex_count, getAccessorComponentCount(spec.accessorType)) :
                    null;
                return {
                    accessorIndex: spec.accessorIndex,
                    values,
                    type: spec.accessorType,
                    componentType: spec.componentType,
                    normalized: spec.normalized,
                    min: (_a = min_max === null || min_max === void 0 ? void 0 : min_max.min) !== null && _a !== void 0 ? _a : null,
                    max: (_b = min_max === null || min_max === void 0 ? void 0 : min_max.max) !== null && _b !== void 0 ? _b : null,
                };
            });
            const indices = geometry_type === module.TRIANGULAR_MESH ?
                decodeDracoMeshIndices(module, decoder, geometry, data.indexAccessorIndex, data.indexComponentType) :
                null;
            const transferables = attributes.map(attribute => attribute.values.buffer);
            if (indices) {
                transferables.push(indices.values.buffer);
            }
            workerScope.postMessage({
                taskId: data.taskId,
                result: {
                    vertexCount: vertex_count,
                    attributes,
                    indices,
                },
            }, transferables);
        }
        catch (error) {
            fatal_error = error instanceof WebAssembly.RuntimeError;
            workerScope.postMessage({
                taskId: data.taskId,
                error: error instanceof Error ? error.message : String(error),
                fatal: fatal_error,
            });
        }
        finally {
            try {
                module.destroy(buffer);
            }
            catch ( /* noop */_a) { /* noop */ }
            if (geometry && !fatal_error) {
                try {
                    module.destroy(geometry);
                }
                catch ( /* noop */_b) { /* noop */ }
            }
            if (!fatal_error) {
                try {
                    module.destroy(decoder);
                }
                catch ( /* noop */_c) { /* noop */ }
            }
        }
    });
}
workerScope.onmessage = (event) => __awaiter(void 0, void 0, void 0, function* () {
    const data = event.data;
    if (data.type === "init") {
        try {
            yield getDracoModule(data.scriptUrl, data.wasmUrl);
            workerScope.postMessage({ type: "initResult", ok: true });
        }
        catch (error) {
            workerScope.postMessage({
                type: "initResult",
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }
    yield handleDecodePrimitive(data);
});

})();
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiVGhyZWVEVGlsZXNEcmFjb0RlY29kZXJXb3JrZXIuanMiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy93b3JrZXJzL1RocmVlRFRpbGVzRHJhY29EZWNvZGVyV29ya2VyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbInR5cGUgTnVtZXJpY0FycmF5ID1cbiAgICBGbG9hdDMyQXJyYXkgfFxuICAgIEludDhBcnJheSB8XG4gICAgVWludDhBcnJheSB8XG4gICAgSW50MTZBcnJheSB8XG4gICAgVWludDE2QXJyYXkgfFxuICAgIEludDMyQXJyYXkgfFxuICAgIFVpbnQzMkFycmF5O1xuXG5cbmludGVyZmFjZSBXb3JrZXJBdHRyaWJ1dGVTcGVjIHtcbiAgICBzZW1hbnRpYzogc3RyaW5nO1xuICAgIHVuaXF1ZUlkOiBudW1iZXI7XG4gICAgYWNjZXNzb3JJbmRleDogbnVtYmVyO1xuICAgIGFjY2Vzc29yVHlwZTogc3RyaW5nO1xuICAgIGNvbXBvbmVudFR5cGU6IG51bWJlcjtcbiAgICBub3JtYWxpemVkOiBib29sZWFuO1xufVxuXG5cbmludGVyZmFjZSBXb3JrZXJSZXF1ZXN0IHtcbiAgICB0eXBlOiBcImRlY29kZVByaW1pdGl2ZVwiO1xuICAgIHRhc2tJZDogbnVtYmVyO1xuICAgIHBheWxvYWQ6IEFycmF5QnVmZmVyO1xuICAgIGJ1ZmZlclZpZXdJbmRleDogbnVtYmVyO1xuICAgIHByaW1pdGl2ZU1vZGU6IG51bWJlcjtcbiAgICBhdHRyaWJ1dGVzOiBXb3JrZXJBdHRyaWJ1dGVTcGVjW107XG4gICAgaW5kZXhBY2Nlc3NvckluZGV4OiBudW1iZXIgfCBudWxsO1xuICAgIGluZGV4Q29tcG9uZW50VHlwZTogbnVtYmVyIHwgbnVsbDtcbn1cblxuXG5pbnRlcmZhY2UgV29ya2VySW5pdFJlcXVlc3Qge1xuICAgIHR5cGU6IFwiaW5pdFwiO1xuICAgIHNjcmlwdFVybDogc3RyaW5nO1xuICAgIHdhc21Vcmw6IHN0cmluZztcbn1cblxuXG5sZXQgZHJhY29Nb2R1bGVQcm9taXNlOiBQcm9taXNlPGFueT4gfCBudWxsID0gbnVsbDtcbmNvbnN0IHdvcmtlclNjb3BlID0gc2VsZiBhcyBhbnk7XG5sZXQgbG9hZGVkRHJhY29TY3JpcHRVcmw6IHN0cmluZyB8IG51bGwgPSBudWxsO1xubGV0IGxvYWRlZERyYWNvV2FzbVVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RHJhY29Nb2R1bGUoIHNjcmlwdF91cmw/OiBzdHJpbmcsIHdhc21fdXJsPzogc3RyaW5nICk6IFByb21pc2U8YW55Plxue1xuICAgIGlmICggZHJhY29Nb2R1bGVQcm9taXNlID09PSBudWxsICkge1xuICAgICAgICBpZiAoICFzY3JpcHRfdXJsIHx8ICF3YXNtX3VybCApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvciggXCJEcmFjbyB3b3JrZXIgd2FzIG5vdCBpbml0aWFsaXplZFwiICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIHR5cGVvZiB3b3JrZXJTY29wZS5pbXBvcnRTY3JpcHRzICE9PSBcImZ1bmN0aW9uXCIgKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoIFwiV29ya2VyIGltcG9ydFNjcmlwdHMgaXMgbm90IGF2YWlsYWJsZVwiICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIGxvYWRlZERyYWNvU2NyaXB0VXJsICE9PSBzY3JpcHRfdXJsICkge1xuICAgICAgICAgICAgd29ya2VyU2NvcGUuaW1wb3J0U2NyaXB0cyggc2NyaXB0X3VybCApO1xuICAgICAgICAgICAgbG9hZGVkRHJhY29TY3JpcHRVcmwgPSBzY3JpcHRfdXJsO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZmFjdG9yeSA9IHdvcmtlclNjb3BlLmNyZWF0ZURyYWNvRGVjb2Rlck1vZHVsZSB8fCB3b3JrZXJTY29wZS5EcmFjb0RlY29kZXJNb2R1bGU7XG4gICAgICAgIGlmICggdHlwZW9mIGZhY3RvcnkgIT09IFwiZnVuY3Rpb25cIiApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvciggXCJEcmFjbyBkZWNvZGVyIGZhY3RvcnkgaXMgbm90IGF2YWlsYWJsZSBpbiB3b3JrZXJcIiApO1xuICAgICAgICB9XG5cbiAgICAgICAgbG9hZGVkRHJhY29XYXNtVXJsID0gd2FzbV91cmw7XG4gICAgICAgIGRyYWNvTW9kdWxlUHJvbWlzZSA9IG5ldyBQcm9taXNlKCAocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICBsZXQgc2V0dGxlZCA9IGZhbHNlO1xuXG4gICAgICAgICAgICBjb25zdCBzZXR0bGUgPSAoIG1vZHVsZTogYW55ICkgPT4ge1xuICAgICAgICAgICAgICAgIGlmICggc2V0dGxlZCApIHJldHVybjtcbiAgICAgICAgICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZXNvbHZlKCBtb2R1bGUgKTtcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGNvbnN0IGZhaWwgPSAoIGVycm9yOiBhbnkgKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKCBzZXR0bGVkICkgcmV0dXJuO1xuICAgICAgICAgICAgICAgIHNldHRsZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlamVjdCggZXJyb3IgKTtcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIGNvbnN0IGNvbmZpZyA9IHtcbiAgICAgICAgICAgICAgICBsb2NhdGVGaWxlOiAoIHBhdGg6IHN0cmluZyApID0+IChcbiAgICAgICAgICAgICAgICAgICAgcGF0aCAmJiBwYXRoLmVuZHNXaXRoKCBcIi53YXNtXCIgKSA/IGxvYWRlZERyYWNvV2FzbVVybCA6IHBhdGhcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIG9uTW9kdWxlTG9hZGVkOiAoIG1vZHVsZTogYW55ICkgPT4gc2V0dGxlKCBtb2R1bGUgKSxcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgbWF5YmVfbW9kdWxlID0gZmFjdG9yeSggY29uZmlnICk7XG4gICAgICAgICAgICAgICAgaWYgKCBtYXliZV9tb2R1bGUgJiYgdHlwZW9mIG1heWJlX21vZHVsZS50aGVuID09PSBcImZ1bmN0aW9uXCIgKSB7XG4gICAgICAgICAgICAgICAgICAgIG1heWJlX21vZHVsZS50aGVuKCBzZXR0bGUsIGZhaWwgKTtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoIG1heWJlX21vZHVsZSAmJiBtYXliZV9tb2R1bGUucmVhZHkgJiYgdHlwZW9mIG1heWJlX21vZHVsZS5yZWFkeS50aGVuID09PSBcImZ1bmN0aW9uXCIgKSB7XG4gICAgICAgICAgICAgICAgICAgIG1heWJlX21vZHVsZS5yZWFkeS50aGVuKCAoKSA9PiBzZXR0bGUoIG1heWJlX21vZHVsZSApLCBmYWlsICk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKCBtYXliZV9tb2R1bGUgJiYgdHlwZW9mIG1heWJlX21vZHVsZS5EZWNvZGVyID09PSBcImZ1bmN0aW9uXCIgKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldHRsZSggbWF5YmVfbW9kdWxlICk7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dCggKCkgPT4gZmFpbCggbmV3IEVycm9yKCBcIlRpbWVkIG91dCB3aGlsZSBpbml0aWFsaXppbmcgRHJhY28gZGVjb2RlciB3b3JrZXJcIiApICksIDEwMDAwICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXRjaCAoIGVycm9yICkge1xuICAgICAgICAgICAgICAgIGZhaWwoIGVycm9yICk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gYXdhaXQgZHJhY29Nb2R1bGVQcm9taXNlO1xufVxuXG5cbmZ1bmN0aW9uIGdldEFjY2Vzc29yQ29tcG9uZW50Q291bnQoIGFjY2Vzc29yX3R5cGU6IHN0cmluZyApOiBudW1iZXJcbntcbiAgICBzd2l0Y2ggKCBhY2Nlc3Nvcl90eXBlICkge1xuICAgIGNhc2UgXCJTQ0FMQVJcIjogcmV0dXJuIDE7XG4gICAgY2FzZSBcIlZFQzJcIjogcmV0dXJuIDI7XG4gICAgY2FzZSBcIlZFQzNcIjogcmV0dXJuIDM7XG4gICAgY2FzZSBcIlZFQzRcIjogcmV0dXJuIDQ7XG4gICAgY2FzZSBcIk1BVDJcIjogcmV0dXJuIDQ7XG4gICAgY2FzZSBcIk1BVDNcIjogcmV0dXJuIDk7XG4gICAgY2FzZSBcIk1BVDRcIjogcmV0dXJuIDE2O1xuICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvciggXCJVbnN1cHBvcnRlZCBhY2Nlc3NvciB0eXBlOiBcIiArIGFjY2Vzc29yX3R5cGUgKTtcbiAgICB9XG59XG5cblxuZnVuY3Rpb24gZ2V0Q29tcG9uZW50VHlwZUluZm8oIG1vZHVsZTogYW55LCBjb21wb25lbnRfdHlwZTogbnVtYmVyIClcbntcbiAgICBzd2l0Y2ggKCBjb21wb25lbnRfdHlwZSApIHtcbiAgICBjYXNlIDUxMjA6IHJldHVybiB7IGJ5dGVzOiAxLCBkcmFjb19kYXRhX3R5cGU6IG1vZHVsZS5EVF9JTlQ4LCB0eXBlZF9hcnJheTogSW50OEFycmF5LCBtaW46IC0xMjgsIG1heDogMTI3LCBpc19mbG9hdDogZmFsc2UsIGlzX3Vuc2lnbmVkOiBmYWxzZSB9O1xuICAgIGNhc2UgNTEyMTogcmV0dXJuIHsgYnl0ZXM6IDEsIGRyYWNvX2RhdGFfdHlwZTogbW9kdWxlLkRUX1VJTlQ4LCB0eXBlZF9hcnJheTogVWludDhBcnJheSwgbWluOiAwLCBtYXg6IDI1NSwgaXNfZmxvYXQ6IGZhbHNlLCBpc191bnNpZ25lZDogdHJ1ZSB9O1xuICAgIGNhc2UgNTEyMjogcmV0dXJuIHsgYnl0ZXM6IDIsIGRyYWNvX2RhdGFfdHlwZTogbW9kdWxlLkRUX0lOVDE2LCB0eXBlZF9hcnJheTogSW50MTZBcnJheSwgbWluOiAtMzI3NjgsIG1heDogMzI3NjcsIGlzX2Zsb2F0OiBmYWxzZSwgaXNfdW5zaWduZWQ6IGZhbHNlIH07XG4gICAgY2FzZSA1MTIzOiByZXR1cm4geyBieXRlczogMiwgZHJhY29fZGF0YV90eXBlOiBtb2R1bGUuRFRfVUlOVDE2LCB0eXBlZF9hcnJheTogVWludDE2QXJyYXksIG1pbjogMCwgbWF4OiA2NTUzNSwgaXNfZmxvYXQ6IGZhbHNlLCBpc191bnNpZ25lZDogdHJ1ZSB9O1xuICAgIGNhc2UgNTEyNTogcmV0dXJuIHsgYnl0ZXM6IDQsIGRyYWNvX2RhdGFfdHlwZTogbW9kdWxlLkRUX1VJTlQzMiwgdHlwZWRfYXJyYXk6IFVpbnQzMkFycmF5LCBtaW46IDAsIG1heDogNDI5NDk2NzI5NSwgaXNfZmxvYXQ6IGZhbHNlLCBpc191bnNpZ25lZDogdHJ1ZSB9O1xuICAgIGNhc2UgNTEyNjogcmV0dXJuIHsgYnl0ZXM6IDQsIGRyYWNvX2RhdGFfdHlwZTogbW9kdWxlLkRUX0ZMT0FUMzIsIHR5cGVkX2FycmF5OiBGbG9hdDMyQXJyYXksIG1pbjogLUluZmluaXR5LCBtYXg6IEluZmluaXR5LCBpc19mbG9hdDogdHJ1ZSwgaXNfdW5zaWduZWQ6IGZhbHNlIH07XG4gICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCBcIlVuc3VwcG9ydGVkIGdsVEYgY29tcG9uZW50IHR5cGU6IFwiICsgY29tcG9uZW50X3R5cGUgKTtcbiAgICB9XG59XG5cblxuZnVuY3Rpb24gY29udmVydE5vcm1hbGl6ZWRGbG9hdFRvSW50ZWdlciggdmFsdWU6IG51bWJlciwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyLCBpc191bnNpZ25lZDogYm9vbGVhbiApOiBudW1iZXJcbntcbiAgICBpZiAoIGlzX3Vuc2lnbmVkICkge1xuICAgICAgICByZXR1cm4gTWF0aC5yb3VuZCggTWF0aC5tYXgoIDAsIE1hdGgubWluKCAxLCB2YWx1ZSApICkgKiBtYXggKTtcbiAgICB9XG5cbiAgICBjb25zdCBjbGFtcGVkID0gTWF0aC5tYXgoIC0xLCBNYXRoLm1pbiggMSwgdmFsdWUgKSApO1xuICAgIGNvbnN0IHNjYWxlID0gY2xhbXBlZCA8IDAgPyAtbWluIDogbWF4O1xuICAgIHJldHVybiBNYXRoLnJvdW5kKCBjbGFtcGVkICogc2NhbGUgKTtcbn1cblxuXG5mdW5jdGlvbiBjb252ZXJ0RHJhY29BdHRyaWJ1dGVWYWx1ZXMoXG4gICAgdmFsdWVzOiBOdW1lcmljQXJyYXksXG4gICAgY29tcG9uZW50X3R5cGU6IG51bWJlcixcbiAgICBub3JtYWxpemVkOiBib29sZWFuLFxuICAgIG5hbWU6IHN0cmluZ1xuKTogTnVtZXJpY0FycmF5XG57XG4gICAgY29uc3QgaW5mbyA9IGdldENvbXBvbmVudFR5cGVJbmZvKCB7XG4gICAgICAgIERUX0lOVDg6IDAsXG4gICAgICAgIERUX1VJTlQ4OiAwLFxuICAgICAgICBEVF9JTlQxNjogMCxcbiAgICAgICAgRFRfVUlOVDE2OiAwLFxuICAgICAgICBEVF9VSU5UMzI6IDAsXG4gICAgICAgIERUX0ZMT0FUMzI6IDAsXG4gICAgfSwgY29tcG9uZW50X3R5cGUgKTtcblxuICAgIGlmICggdmFsdWVzIGluc3RhbmNlb2YgaW5mby50eXBlZF9hcnJheSApIHtcbiAgICAgICAgcmV0dXJuIHZhbHVlcztcbiAgICB9XG5cbiAgICBjb25zdCBjb252ZXJ0ZWQgPSBuZXcgaW5mby50eXBlZF9hcnJheSggdmFsdWVzLmxlbmd0aCApIGFzIE51bWVyaWNBcnJheTtcbiAgICBmb3IgKCBsZXQgaSA9IDA7IGkgPCB2YWx1ZXMubGVuZ3RoOyArK2kgKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gTnVtYmVyKCB2YWx1ZXNbaV0gKTtcbiAgICAgICAgaWYgKCAhTnVtYmVyLmlzRmluaXRlKCB2YWx1ZSApICkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCBcIkludmFsaWQgRHJhY28gdmFsdWU6IFwiICsgbmFtZSApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCBpbmZvLmlzX2Zsb2F0ICkge1xuICAgICAgICAgICAgY29udmVydGVkW2ldID0gdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoIG5vcm1hbGl6ZWQgJiYgdmFsdWVzIGluc3RhbmNlb2YgRmxvYXQzMkFycmF5ICkge1xuICAgICAgICAgICAgY29udmVydGVkW2ldID0gY29udmVydE5vcm1hbGl6ZWRGbG9hdFRvSW50ZWdlciggdmFsdWUsIGluZm8ubWluLCBpbmZvLm1heCwgaW5mby5pc191bnNpZ25lZCApO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgY29uc3Qgcm91bmRlZCA9IE1hdGgucm91bmQoIHZhbHVlICk7XG4gICAgICAgICAgICBpZiAoIHJvdW5kZWQgPCBpbmZvLm1pbiB8fCByb3VuZGVkID4gaW5mby5tYXggKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCBcIkRyYWNvIHZhbHVlIGlzIG91dCBvZiByYW5nZSBmb3IgYWNjZXNzb3I6IFwiICsgbmFtZSApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udmVydGVkW2ldID0gcm91bmRlZDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBjb252ZXJ0ZWQ7XG59XG5cblxuZnVuY3Rpb24gY2FsY3VsYXRlQWNjZXNzb3JNaW5NYXgoIHZhbHVlczogTnVtZXJpY0FycmF5LCBjb3VudDogbnVtYmVyLCBjb21wb25lbnRzOiBudW1iZXIgKTogeyBtaW46IG51bWJlcltdOyBtYXg6IG51bWJlcltdIH0gfCBudWxsXG57XG4gICAgaWYgKCBjb3VudCA8PSAwIHx8IGNvbXBvbmVudHMgPD0gMCApIHtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgY29uc3QgbWluID0gbmV3IEFycmF5PG51bWJlcj4oIGNvbXBvbmVudHMgKS5maWxsKCBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFkgKTtcbiAgICBjb25zdCBtYXggPSBuZXcgQXJyYXk8bnVtYmVyPiggY29tcG9uZW50cyApLmZpbGwoIE51bWJlci5ORUdBVElWRV9JTkZJTklUWSApO1xuXG4gICAgZm9yICggbGV0IGkgPSAwOyBpIDwgY291bnQ7ICsraSApIHtcbiAgICAgICAgZm9yICggbGV0IGMgPSAwOyBjIDwgY29tcG9uZW50czsgKytjICkge1xuICAgICAgICAgICAgY29uc3QgdmFsdWUgPSBOdW1iZXIoIHZhbHVlc1tjb21wb25lbnRzKmkgKyBjXSApO1xuICAgICAgICAgICAgaWYgKCB2YWx1ZSA8IG1pbltjXSApIG1pbltjXSA9IHZhbHVlO1xuICAgICAgICAgICAgaWYgKCB2YWx1ZSA+IG1heFtjXSApIG1heFtjXSA9IHZhbHVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIHsgbWluLCBtYXggfTtcbn1cblxuXG5mdW5jdGlvbiBnZXREcmFjb0F0dHJpYnV0ZSggbW9kdWxlOiBhbnksIGRlY29kZXI6IGFueSwgZ2VvbWV0cnk6IGFueSwgdW5pcXVlX2lkOiBudW1iZXIsIGNvbXBvbmVudHM6IG51bWJlciwgbmFtZTogc3RyaW5nIClcbntcbiAgICBjb25zdCBhdHRyaWJ1dGUgPSBkZWNvZGVyLkdldEF0dHJpYnV0ZUJ5VW5pcXVlSWQoIGdlb21ldHJ5LCB1bmlxdWVfaWQgKTtcbiAgICBpZiAoICFhdHRyaWJ1dGUgfHwgYXR0cmlidXRlLnB0ciA9PT0gMCApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCBcIkRyYWNvIGF0dHJpYnV0ZSB3YXMgbm90IGZvdW5kOiBcIiArIG5hbWUgKTtcbiAgICB9XG4gICAgaWYgKCBhdHRyaWJ1dGUubnVtX2NvbXBvbmVudHMoKSAhPT0gY29tcG9uZW50cyApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCBcIlVuZXhwZWN0ZWQgRHJhY28gYXR0cmlidXRlIGNvbXBvbmVudCBjb3VudDogXCIgKyBuYW1lICk7XG4gICAgfVxuICAgIHJldHVybiBhdHRyaWJ1dGU7XG59XG5cblxuZnVuY3Rpb24gZGVjb2RlRHJhY29UeXBlZEF0dHJpYnV0ZTxUIGV4dGVuZHMgTnVtZXJpY0FycmF5PihcbiAgICBtb2R1bGU6IGFueSxcbiAgICBkZWNvZGVyOiBhbnksXG4gICAgZ2VvbWV0cnk6IGFueSxcbiAgICBhdHRyaWJ1dGU6IGFueSxcbiAgICBkcmFjb19hcnJheTogYW55LFxuICAgIGN0b3I6IHsgbmV3KGxlbmd0aDogbnVtYmVyKTogVCB9LFxuICAgIG1ldGhvZF9uYW1lOiBzdHJpbmcsXG4gICAgY29tcG9uZW50czogbnVtYmVyLFxuICAgIG5hbWU6IHN0cmluZ1xuKTogVFxue1xuICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1ldGhvZCA9IGRlY29kZXJbbWV0aG9kX25hbWVdO1xuICAgICAgICBpZiAoIHR5cGVvZiBtZXRob2QgIT09IFwiZnVuY3Rpb25cIiB8fCAhbWV0aG9kLmNhbGwoIGRlY29kZXIsIGdlb21ldHJ5LCBhdHRyaWJ1dGUsIGRyYWNvX2FycmF5ICkgKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoIFwiRmFpbGVkIHRvIGRlY29kZSBEcmFjbyBhdHRyaWJ1dGU6IFwiICsgbmFtZSApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZXhwZWN0ZWRfbGVuZ3RoID0gZ2VvbWV0cnkubnVtX3BvaW50cygpICogY29tcG9uZW50cztcbiAgICAgICAgaWYgKCBkcmFjb19hcnJheS5zaXplKCkgIT09IGV4cGVjdGVkX2xlbmd0aCApIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvciggXCJVbmV4cGVjdGVkIERyYWNvIGF0dHJpYnV0ZSBsZW5ndGg6IFwiICsgbmFtZSApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdmFsdWVzID0gbmV3IGN0b3IoIGV4cGVjdGVkX2xlbmd0aCApO1xuICAgICAgICBmb3IgKCBsZXQgaSA9IDA7IGkgPCBleHBlY3RlZF9sZW5ndGg7ICsraSApIHtcbiAgICAgICAgICAgIHZhbHVlc1tpXSA9IGRyYWNvX2FycmF5LkdldFZhbHVlKCBpICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbHVlcztcbiAgICB9XG4gICAgZmluYWxseSB7XG4gICAgICAgIG1vZHVsZS5kZXN0cm95KCBkcmFjb19hcnJheSApO1xuICAgIH1cbn1cblxuXG5mdW5jdGlvbiBkZWNvZGVEcmFjb1Jhd0F0dHJpYnV0ZSggbW9kdWxlOiBhbnksIGRlY29kZXI6IGFueSwgZ2VvbWV0cnk6IGFueSwgdW5pcXVlX2lkOiBudW1iZXIsIGNvbXBvbmVudHM6IG51bWJlciwgbmFtZTogc3RyaW5nIClcbntcbiAgICBjb25zdCBhdHRyaWJ1dGUgPSBnZXREcmFjb0F0dHJpYnV0ZSggbW9kdWxlLCBkZWNvZGVyLCBnZW9tZXRyeSwgdW5pcXVlX2lkLCBjb21wb25lbnRzLCBuYW1lICk7XG4gICAgdHJ5IHtcbiAgICAgICAgc3dpdGNoICggYXR0cmlidXRlLmRhdGFfdHlwZSgpICkge1xuICAgICAgICBjYXNlIG1vZHVsZS5EVF9VSU5UODpcbiAgICAgICAgICAgIHJldHVybiB7IHZhbHVlczogZGVjb2RlRHJhY29UeXBlZEF0dHJpYnV0ZSggbW9kdWxlLCBkZWNvZGVyLCBnZW9tZXRyeSwgYXR0cmlidXRlLCBuZXcgbW9kdWxlLkRyYWNvVUludDhBcnJheSgpLCBVaW50OEFycmF5LCBcIkdldEF0dHJpYnV0ZVVJbnQ4Rm9yQWxsUG9pbnRzXCIsIGNvbXBvbmVudHMsIG5hbWUgKSB9O1xuICAgICAgICBjYXNlIG1vZHVsZS5EVF9VSU5UMTY6XG4gICAgICAgICAgICByZXR1cm4geyB2YWx1ZXM6IGRlY29kZURyYWNvVHlwZWRBdHRyaWJ1dGUoIG1vZHVsZSwgZGVjb2RlciwgZ2VvbWV0cnksIGF0dHJpYnV0ZSwgbmV3IG1vZHVsZS5EcmFjb1VJbnQxNkFycmF5KCksIFVpbnQxNkFycmF5LCBcIkdldEF0dHJpYnV0ZVVJbnQxNkZvckFsbFBvaW50c1wiLCBjb21wb25lbnRzLCBuYW1lICkgfTtcbiAgICAgICAgY2FzZSBtb2R1bGUuRFRfVUlOVDMyOlxuICAgICAgICAgICAgcmV0dXJuIHsgdmFsdWVzOiBkZWNvZGVEcmFjb1R5cGVkQXR0cmlidXRlKCBtb2R1bGUsIGRlY29kZXIsIGdlb21ldHJ5LCBhdHRyaWJ1dGUsIG5ldyBtb2R1bGUuRHJhY29VSW50MzJBcnJheSgpLCBVaW50MzJBcnJheSwgXCJHZXRBdHRyaWJ1dGVVSW50MzJGb3JBbGxQb2ludHNcIiwgY29tcG9uZW50cywgbmFtZSApIH07XG4gICAgICAgIGNhc2UgbW9kdWxlLkRUX0lOVDg6XG4gICAgICAgICAgICByZXR1cm4geyB2YWx1ZXM6IGRlY29kZURyYWNvVHlwZWRBdHRyaWJ1dGUoIG1vZHVsZSwgZGVjb2RlciwgZ2VvbWV0cnksIGF0dHJpYnV0ZSwgbmV3IG1vZHVsZS5EcmFjb0ludDhBcnJheSgpLCBJbnQ4QXJyYXksIFwiR2V0QXR0cmlidXRlSW50OEZvckFsbFBvaW50c1wiLCBjb21wb25lbnRzLCBuYW1lICkgfTtcbiAgICAgICAgY2FzZSBtb2R1bGUuRFRfSU5UMTY6XG4gICAgICAgICAgICByZXR1cm4geyB2YWx1ZXM6IGRlY29kZURyYWNvVHlwZWRBdHRyaWJ1dGUoIG1vZHVsZSwgZGVjb2RlciwgZ2VvbWV0cnksIGF0dHJpYnV0ZSwgbmV3IG1vZHVsZS5EcmFjb0ludDE2QXJyYXkoKSwgSW50MTZBcnJheSwgXCJHZXRBdHRyaWJ1dGVJbnQxNkZvckFsbFBvaW50c1wiLCBjb21wb25lbnRzLCBuYW1lICkgfTtcbiAgICAgICAgY2FzZSBtb2R1bGUuRFRfSU5UMzI6XG4gICAgICAgICAgICByZXR1cm4geyB2YWx1ZXM6IGRlY29kZURyYWNvVHlwZWRBdHRyaWJ1dGUoIG1vZHVsZSwgZGVjb2RlciwgZ2VvbWV0cnksIGF0dHJpYnV0ZSwgbmV3IG1vZHVsZS5EcmFjb0ludDMyQXJyYXkoKSwgSW50MzJBcnJheSwgXCJHZXRBdHRyaWJ1dGVJbnQzMkZvckFsbFBvaW50c1wiLCBjb21wb25lbnRzLCBuYW1lICkgfTtcbiAgICAgICAgY2FzZSBtb2R1bGUuRFRfRkxPQVQzMjpcbiAgICAgICAgICAgIHJldHVybiB7IHZhbHVlczogZGVjb2RlRHJhY29UeXBlZEF0dHJpYnV0ZSggbW9kdWxlLCBkZWNvZGVyLCBnZW9tZXRyeSwgYXR0cmlidXRlLCBuZXcgbW9kdWxlLkRyYWNvRmxvYXQzMkFycmF5KCksIEZsb2F0MzJBcnJheSwgXCJHZXRBdHRyaWJ1dGVGbG9hdEZvckFsbFBvaW50c1wiLCBjb21wb25lbnRzLCBuYW1lICkgfTtcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvciggXCJVbnN1cHBvcnRlZCBEcmFjbyBkYXRhIHR5cGUgZm9yIGF0dHJpYnV0ZTogXCIgKyBuYW1lICk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgZmluYWxseSB7XG4gICAgICAgIG1vZHVsZS5kZXN0cm95KCBhdHRyaWJ1dGUgKTtcbiAgICB9XG59XG5cblxuZnVuY3Rpb24gZGVjb2RlRHJhY29NZXNoQXR0cmlidXRlKCBtb2R1bGU6IGFueSwgZGVjb2RlcjogYW55LCBnZW9tZXRyeTogYW55LCBzcGVjOiBXb3JrZXJBdHRyaWJ1dGVTcGVjICk6IE51bWVyaWNBcnJheVxue1xuICAgIGNvbnN0IGNvbXBvbmVudHMgPSBnZXRBY2Nlc3NvckNvbXBvbmVudENvdW50KCBzcGVjLmFjY2Vzc29yVHlwZSApO1xuICAgIGNvbnN0IGNvbXBvbmVudF9pbmZvID0gZ2V0Q29tcG9uZW50VHlwZUluZm8oIG1vZHVsZSwgc3BlYy5jb21wb25lbnRUeXBlICk7XG4gICAgY29uc3QgY291bnQgPSBnZW9tZXRyeS5udW1fcG9pbnRzKCk7XG5cbiAgICBpZiAoIHR5cGVvZiBkZWNvZGVyLkdldEF0dHJpYnV0ZURhdGFBcnJheUZvckFsbFBvaW50cyA9PT0gXCJmdW5jdGlvblwiICYmIHR5cGVvZiBtb2R1bGUuX21hbGxvYyA9PT0gXCJmdW5jdGlvblwiICkge1xuICAgICAgICBjb25zdCBhdHRyaWJ1dGUgPSBnZXREcmFjb0F0dHJpYnV0ZSggbW9kdWxlLCBkZWNvZGVyLCBnZW9tZXRyeSwgc3BlYy51bmlxdWVJZCwgY29tcG9uZW50cywgc3BlYy5zZW1hbnRpYyApO1xuICAgICAgICBjb25zdCBieXRlX2xlbmd0aCA9IGNvdW50ICogY29tcG9uZW50cyAqIGNvbXBvbmVudF9pbmZvLmJ5dGVzO1xuICAgICAgICBjb25zdCBwb2ludGVyID0gbW9kdWxlLl9tYWxsb2MoIGJ5dGVfbGVuZ3RoICk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGlmICggIWRlY29kZXIuR2V0QXR0cmlidXRlRGF0YUFycmF5Rm9yQWxsUG9pbnRzKCBnZW9tZXRyeSwgYXR0cmlidXRlLCBjb21wb25lbnRfaW5mby5kcmFjb19kYXRhX3R5cGUsIGJ5dGVfbGVuZ3RoLCBwb2ludGVyICkgKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCBcIkZhaWxlZCB0byBkZWNvZGUgRHJhY28gbWVzaCBhdHRyaWJ1dGU6IFwiICsgc3BlYy5zZW1hbnRpYyApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBoZWFwX3ZpZXcgPSBuZXcgY29tcG9uZW50X2luZm8udHlwZWRfYXJyYXkoIG1vZHVsZS5IRUFQVTguYnVmZmVyLCBwb2ludGVyLCBjb3VudCAqIGNvbXBvbmVudHMgKTtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlcyA9IG5ldyBjb21wb25lbnRfaW5mby50eXBlZF9hcnJheSggY291bnQgKiBjb21wb25lbnRzICk7XG4gICAgICAgICAgICB2YWx1ZXMuc2V0KCBoZWFwX3ZpZXcgKTtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZXM7XG4gICAgICAgIH1cbiAgICAgICAgZmluYWxseSB7XG4gICAgICAgICAgICBtb2R1bGUuX2ZyZWUoIHBvaW50ZXIgKTtcbiAgICAgICAgICAgIG1vZHVsZS5kZXN0cm95KCBhdHRyaWJ1dGUgKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGRlY29kZWQgPSBkZWNvZGVEcmFjb1Jhd0F0dHJpYnV0ZSggbW9kdWxlLCBkZWNvZGVyLCBnZW9tZXRyeSwgc3BlYy51bmlxdWVJZCwgY29tcG9uZW50cywgc3BlYy5zZW1hbnRpYyApO1xuICAgIHJldHVybiBjb252ZXJ0RHJhY29BdHRyaWJ1dGVWYWx1ZXMoIGRlY29kZWQudmFsdWVzLCBzcGVjLmNvbXBvbmVudFR5cGUsIHNwZWMubm9ybWFsaXplZCA9PT0gdHJ1ZSwgc3BlYy5zZW1hbnRpYyApO1xufVxuXG5cbmZ1bmN0aW9uIGRlY29kZURyYWNvTWVzaEluZGljZXMoIG1vZHVsZTogYW55LCBkZWNvZGVyOiBhbnksIGdlb21ldHJ5OiBhbnksIGFjY2Vzc29yX2luZGV4OiBudW1iZXIgfCBudWxsLCByZXF1ZXN0ZWRfY29tcG9uZW50X3R5cGU6IG51bWJlciB8IG51bGwgKVxue1xuICAgIGNvbnN0IGZhY2VfY291bnQgPSBnZW9tZXRyeS5udW1fZmFjZXMoKTtcbiAgICBjb25zdCBpbmRleF9jb3VudCA9IGZhY2VfY291bnQgKiAzO1xuICAgIGNvbnN0IHZhbHVlcyA9IG5ldyBVaW50MzJBcnJheSggaW5kZXhfY291bnQgKTtcblxuICAgIGNvbnN0IGZhY2UgPSBuZXcgbW9kdWxlLkRyYWNvSW50MzJBcnJheSgpO1xuICAgIHRyeSB7XG4gICAgICAgIGZvciAoIGxldCBpID0gMDsgaSA8IGZhY2VfY291bnQ7ICsraSApIHtcbiAgICAgICAgICAgIGlmICggIWRlY29kZXIuR2V0RmFjZUZyb21NZXNoKCBnZW9tZXRyeSwgaSwgZmFjZSApICkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvciggXCJGYWlsZWQgdG8gZGVjb2RlIERyYWNvIG1lc2ggaW5kaWNlc1wiICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YWx1ZXNbMyppICsgMF0gPSBmYWNlLkdldFZhbHVlKCAwICk7XG4gICAgICAgICAgICB2YWx1ZXNbMyppICsgMV0gPSBmYWNlLkdldFZhbHVlKCAxICk7XG4gICAgICAgICAgICB2YWx1ZXNbMyppICsgMl0gPSBmYWNlLkdldFZhbHVlKCAyICk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgZmluYWxseSB7XG4gICAgICAgIG1vZHVsZS5kZXN0cm95KCBmYWNlICk7XG4gICAgfVxuXG4gICAgbGV0IG1heF9pbmRleCA9IDA7XG4gICAgZm9yICggbGV0IGkgPSAwOyBpIDwgdmFsdWVzLmxlbmd0aDsgKytpICkge1xuICAgICAgICBpZiAoIHZhbHVlc1tpXSA+IG1heF9pbmRleCApIHtcbiAgICAgICAgICAgIG1heF9pbmRleCA9IHZhbHVlc1tpXTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGxldCBjb21wb25lbnRfdHlwZSA9IE51bWJlci5pc0Zpbml0ZSggTnVtYmVyKCByZXF1ZXN0ZWRfY29tcG9uZW50X3R5cGUgKSApID8gTnVtYmVyKCByZXF1ZXN0ZWRfY29tcG9uZW50X3R5cGUgKSA6IDUxMjU7XG4gICAgaWYgKCBjb21wb25lbnRfdHlwZSAhPT0gNTEyMSAmJiBjb21wb25lbnRfdHlwZSAhPT0gNTEyMyAmJiBjb21wb25lbnRfdHlwZSAhPT0gNTEyNSApIHtcbiAgICAgICAgY29tcG9uZW50X3R5cGUgPSA1MTI1O1xuICAgIH1cblxuICAgIGlmICggY29tcG9uZW50X3R5cGUgPT09IDUxMjEgJiYgbWF4X2luZGV4ID4gMjU1ICkge1xuICAgICAgICBjb21wb25lbnRfdHlwZSA9IG1heF9pbmRleCA8PSA2NTUzNSA/IDUxMjMgOiA1MTI1O1xuICAgIH1cbiAgICBlbHNlIGlmICggY29tcG9uZW50X3R5cGUgPT09IDUxMjMgJiYgbWF4X2luZGV4ID4gNjU1MzUgKSB7XG4gICAgICAgIGNvbXBvbmVudF90eXBlID0gNTEyNTtcbiAgICB9XG4gICAgZWxzZSBpZiAoIGNvbXBvbmVudF90eXBlID09PSA1MTI1ICkge1xuICAgICAgICBpZiAoIG1heF9pbmRleCA8PSAyNTUgKSBjb21wb25lbnRfdHlwZSA9IDUxMjE7XG4gICAgICAgIGVsc2UgaWYgKCBtYXhfaW5kZXggPD0gNjU1MzUgKSBjb21wb25lbnRfdHlwZSA9IDUxMjM7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgYWNjZXNzb3JJbmRleDogdHlwZW9mIGFjY2Vzc29yX2luZGV4ID09PSBcIm51bWJlclwiID8gYWNjZXNzb3JfaW5kZXggOiBudWxsLFxuICAgICAgICBjb21wb25lbnRUeXBlOiBjb21wb25lbnRfdHlwZSxcbiAgICAgICAgdmFsdWVzOiBjb252ZXJ0RHJhY29BdHRyaWJ1dGVWYWx1ZXMoIHZhbHVlcywgY29tcG9uZW50X3R5cGUsIGZhbHNlLCBcImluZGljZXNcIiApIGFzIFVpbnQ4QXJyYXkgfCBVaW50MTZBcnJheSB8IFVpbnQzMkFycmF5LFxuICAgIH07XG59XG5cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlRGVjb2RlUHJpbWl0aXZlKCBkYXRhOiBXb3JrZXJSZXF1ZXN0IClcbntcbiAgICBjb25zdCBtb2R1bGUgPSBhd2FpdCBnZXREcmFjb01vZHVsZSgpO1xuICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgbW9kdWxlLkRlY29kZXIoKTtcbiAgICBjb25zdCBidWZmZXIgPSBuZXcgbW9kdWxlLkRlY29kZXJCdWZmZXIoKTtcbiAgICBsZXQgc3RhdHVzOiBhbnkgPSBudWxsO1xuICAgIGxldCBnZW9tZXRyeTogYW55ID0gbnVsbDtcbiAgICBsZXQgZ2VvbWV0cnlfdHlwZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gICAgbGV0IGZhdGFsX2Vycm9yID0gZmFsc2U7XG5cbiAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXlsb2FkX2J5dGVzID0gbmV3IFVpbnQ4QXJyYXkoIGRhdGEucGF5bG9hZCApO1xuICAgICAgICBidWZmZXIuSW5pdCggcGF5bG9hZF9ieXRlcywgcGF5bG9hZF9ieXRlcy5ieXRlTGVuZ3RoICk7XG5cbiAgICAgICAgZ2VvbWV0cnlfdHlwZSA9IGRlY29kZXIuR2V0RW5jb2RlZEdlb21ldHJ5VHlwZSggYnVmZmVyICk7XG4gICAgICAgIGlmICggZ2VvbWV0cnlfdHlwZSA9PT0gbW9kdWxlLlRSSUFOR1VMQVJfTUVTSCApIHtcbiAgICAgICAgICAgIGdlb21ldHJ5ID0gbmV3IG1vZHVsZS5NZXNoKCk7XG4gICAgICAgICAgICBzdGF0dXMgPSBkZWNvZGVyLkRlY29kZUJ1ZmZlclRvTWVzaCggYnVmZmVyLCBnZW9tZXRyeSApO1xuICAgICAgICB9XG4gICAgICAgIGVsc2UgaWYgKCBnZW9tZXRyeV90eXBlID09PSBtb2R1bGUuUE9JTlRfQ0xPVUQgKSB7XG4gICAgICAgICAgICBnZW9tZXRyeSA9IG5ldyBtb2R1bGUuUG9pbnRDbG91ZCgpO1xuICAgICAgICAgICAgc3RhdHVzID0gZGVjb2Rlci5EZWNvZGVCdWZmZXJUb1BvaW50Q2xvdWQoIGJ1ZmZlciwgZ2VvbWV0cnkgKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvciggXCJVbnN1cHBvcnRlZCBEcmFjbyBnbFRGIGdlb21ldHJ5IHR5cGVcIiApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCAhc3RhdHVzLm9rKCkgfHwgZ2VvbWV0cnkucHRyID09PSAwICkge1xuICAgICAgICAgICAgY29uc3QgZXJyb3JfbWVzc2FnZSA9IHR5cGVvZiBzdGF0dXMuZXJyb3JfbXNnID09PSBcImZ1bmN0aW9uXCIgPyBzdGF0dXMuZXJyb3JfbXNnKCkgOiBcInVua25vd24gZXJyb3JcIjtcbiAgICAgICAgICAgIGNvbnN0IGdlb21ldHJ5X2xhYmVsID1cbiAgICAgICAgICAgICAgICBnZW9tZXRyeV90eXBlID09PSBtb2R1bGUuVFJJQU5HVUxBUl9NRVNIID8gXCJUUklBTkdVTEFSX01FU0hcIiA6XG4gICAgICAgICAgICAgICAgZ2VvbWV0cnlfdHlwZSA9PT0gbW9kdWxlLlBPSU5UX0NMT1VEID8gXCJQT0lOVF9DTE9VRFwiIDpcbiAgICAgICAgICAgICAgICBTdHJpbmcoIGdlb21ldHJ5X3R5cGUgKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBgRmFpbGVkIHRvIGRlY29kZSBEcmFjbyBtZXNoIHBheWxvYWQ6ICR7ZXJyb3JfbWVzc2FnZX0gYCArXG4gICAgICAgICAgICAgICAgYChidWZmZXJWaWV3PSR7ZGF0YS5idWZmZXJWaWV3SW5kZXh9LCBwcmltaXRpdmVNb2RlPSR7ZGF0YS5wcmltaXRpdmVNb2RlfSwgZ2VvbWV0cnlUeXBlPSR7Z2VvbWV0cnlfbGFiZWx9KWBcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB2ZXJ0ZXhfY291bnQgPSBnZW9tZXRyeS5udW1fcG9pbnRzKCk7XG4gICAgICAgIGNvbnN0IGF0dHJpYnV0ZXMgPSBkYXRhLmF0dHJpYnV0ZXMubWFwKCBzcGVjID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHZhbHVlcyA9IGRlY29kZURyYWNvTWVzaEF0dHJpYnV0ZSggbW9kdWxlLCBkZWNvZGVyLCBnZW9tZXRyeSwgc3BlYyApO1xuICAgICAgICAgICAgY29uc3QgbWluX21heCA9IHNwZWMuc2VtYW50aWMgPT09IFwiUE9TSVRJT05cIiA/XG4gICAgICAgICAgICAgICAgY2FsY3VsYXRlQWNjZXNzb3JNaW5NYXgoIHZhbHVlcywgdmVydGV4X2NvdW50LCBnZXRBY2Nlc3NvckNvbXBvbmVudENvdW50KCBzcGVjLmFjY2Vzc29yVHlwZSApICkgOlxuICAgICAgICAgICAgICAgIG51bGw7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGFjY2Vzc29ySW5kZXg6IHNwZWMuYWNjZXNzb3JJbmRleCxcbiAgICAgICAgICAgICAgICB2YWx1ZXMsXG4gICAgICAgICAgICAgICAgdHlwZTogc3BlYy5hY2Nlc3NvclR5cGUsXG4gICAgICAgICAgICAgICAgY29tcG9uZW50VHlwZTogc3BlYy5jb21wb25lbnRUeXBlLFxuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWQ6IHNwZWMubm9ybWFsaXplZCxcbiAgICAgICAgICAgICAgICBtaW46IG1pbl9tYXg/Lm1pbiA/PyBudWxsLFxuICAgICAgICAgICAgICAgIG1heDogbWluX21heD8ubWF4ID8/IG51bGwsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9ICk7XG5cbiAgICAgICAgY29uc3QgaW5kaWNlcyA9IGdlb21ldHJ5X3R5cGUgPT09IG1vZHVsZS5UUklBTkdVTEFSX01FU0ggP1xuICAgICAgICAgICAgZGVjb2RlRHJhY29NZXNoSW5kaWNlcyggbW9kdWxlLCBkZWNvZGVyLCBnZW9tZXRyeSwgZGF0YS5pbmRleEFjY2Vzc29ySW5kZXgsIGRhdGEuaW5kZXhDb21wb25lbnRUeXBlICkgOlxuICAgICAgICAgICAgbnVsbDtcblxuICAgICAgICBjb25zdCB0cmFuc2ZlcmFibGVzOiBUcmFuc2ZlcmFibGVbXSA9IGF0dHJpYnV0ZXMubWFwKCBhdHRyaWJ1dGUgPT4gYXR0cmlidXRlLnZhbHVlcy5idWZmZXIgKTtcbiAgICAgICAgaWYgKCBpbmRpY2VzICkge1xuICAgICAgICAgICAgdHJhbnNmZXJhYmxlcy5wdXNoKCBpbmRpY2VzLnZhbHVlcy5idWZmZXIgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHdvcmtlclNjb3BlLnBvc3RNZXNzYWdlKCB7XG4gICAgICAgICAgICB0YXNrSWQ6IGRhdGEudGFza0lkLFxuICAgICAgICAgICAgcmVzdWx0OiB7XG4gICAgICAgICAgICAgICAgdmVydGV4Q291bnQ6IHZlcnRleF9jb3VudCxcbiAgICAgICAgICAgICAgICBhdHRyaWJ1dGVzLFxuICAgICAgICAgICAgICAgIGluZGljZXMsXG4gICAgICAgICAgICB9LFxuICAgICAgICB9LCB0cmFuc2ZlcmFibGVzICk7XG4gICAgfVxuICAgIGNhdGNoICggZXJyb3IgKSB7XG4gICAgICAgIGZhdGFsX2Vycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBXZWJBc3NlbWJseS5SdW50aW1lRXJyb3I7XG4gICAgICAgIHdvcmtlclNjb3BlLnBvc3RNZXNzYWdlKCB7XG4gICAgICAgICAgICB0YXNrSWQ6IGRhdGEudGFza0lkLFxuICAgICAgICAgICAgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKCBlcnJvciApLFxuICAgICAgICAgICAgZmF0YWw6IGZhdGFsX2Vycm9yLFxuICAgICAgICB9ICk7XG4gICAgfVxuICAgIGZpbmFsbHkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbW9kdWxlLmRlc3Ryb3koIGJ1ZmZlciApO1xuICAgICAgICB9XG4gICAgICAgIGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgICAgIGlmICggZ2VvbWV0cnkgJiYgIWZhdGFsX2Vycm9yICkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBtb2R1bGUuZGVzdHJveSggZ2VvbWV0cnkgKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhdGNoIHsgLyogbm9vcCAqLyB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCAhZmF0YWxfZXJyb3IgKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIG1vZHVsZS5kZXN0cm95KCBkZWNvZGVyICk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjYXRjaCB7IC8qIG5vb3AgKi8gfVxuICAgICAgICB9XG4gICAgfVxufVxuXG5cbndvcmtlclNjb3BlLm9ubWVzc2FnZSA9IGFzeW5jICggZXZlbnQ6IE1lc3NhZ2VFdmVudDxXb3JrZXJJbml0UmVxdWVzdCB8IFdvcmtlclJlcXVlc3Q+ICkgPT4ge1xuICAgIGNvbnN0IGRhdGEgPSBldmVudC5kYXRhO1xuXG4gICAgaWYgKCBkYXRhLnR5cGUgPT09IFwiaW5pdFwiICkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgZ2V0RHJhY29Nb2R1bGUoIGRhdGEuc2NyaXB0VXJsLCBkYXRhLndhc21VcmwgKTtcbiAgICAgICAgICAgIHdvcmtlclNjb3BlLnBvc3RNZXNzYWdlKCB7IHR5cGU6IFwiaW5pdFJlc3VsdFwiLCBvazogdHJ1ZSB9ICk7XG4gICAgICAgIH1cbiAgICAgICAgY2F0Y2ggKCBlcnJvciApIHtcbiAgICAgICAgICAgIHdvcmtlclNjb3BlLnBvc3RNZXNzYWdlKCB7XG4gICAgICAgICAgICAgICAgdHlwZTogXCJpbml0UmVzdWx0XCIsXG4gICAgICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyggZXJyb3IgKSxcbiAgICAgICAgICAgIH0gKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgYXdhaXQgaGFuZGxlRGVjb2RlUHJpbWl0aXZlKCBkYXRhICk7XG59O1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7OztBQXVDQSxJQUFJLGtCQUFrQixHQUF3QixJQUFJLENBQUM7QUFDbkQsTUFBTSxXQUFXLEdBQUcsSUFBVyxDQUFDO0FBQ2hDLElBQUksb0JBQW9CLEdBQWtCLElBQUksQ0FBQztBQUMvQyxJQUFJLGtCQUFrQixHQUFrQixJQUFJLENBQUM7QUFHN0MsU0FBZSxjQUFjLENBQUUsVUFBbUIsRUFBRSxRQUFpQixFQUFBOztRQUVqRSxJQUFLLGtCQUFrQixLQUFLLElBQUksRUFBRztBQUMvQixZQUFBLElBQUssQ0FBQyxVQUFVLElBQUksQ0FBQyxRQUFRLEVBQUc7QUFDNUIsZ0JBQUEsTUFBTSxJQUFJLEtBQUssQ0FBRSxrQ0FBa0MsQ0FBRSxDQUFDO0FBQ3pELGFBQUE7QUFFRCxZQUFBLElBQUssT0FBTyxXQUFXLENBQUMsYUFBYSxLQUFLLFVBQVUsRUFBRztBQUNuRCxnQkFBQSxNQUFNLElBQUksS0FBSyxDQUFFLHVDQUF1QyxDQUFFLENBQUM7QUFDOUQsYUFBQTtZQUVELElBQUssb0JBQW9CLEtBQUssVUFBVSxFQUFHO0FBQ3ZDLGdCQUFBLFdBQVcsQ0FBQyxhQUFhLENBQUUsVUFBVSxDQUFFLENBQUM7Z0JBQ3hDLG9CQUFvQixHQUFHLFVBQVUsQ0FBQztBQUNyQyxhQUFBO1lBRUQsTUFBTSxPQUFP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
