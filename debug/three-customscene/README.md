Three.js CustomScene Sample
================================================================================


Setup
--------------------------------------------------------------------------------
This sample uses `mapray` for the globe and `three.js` for an animated glTF
character drawn through `mapray.ThreeCustomScene`.

`MAPRAY_ACCESS_TOKEN` must be defined.

```bash
export MAPRAY_ACCESS_TOKEN=<mapray_access_token>
```

If the local packages have not been built yet, build them once from the repo root:

```bash
yarn build-devel
yarn css
```


Launch
--------------------------------------------------------------------------------
Install dependencies in this sample directory and start the watcher + server:

```bash
cd debug/three-customscene
yarn install
yarn start
```

Open [http://localhost:7776/](http://localhost:7776/).


Notes
--------------------------------------------------------------------------------
- The sample shares the existing `webgl2` canvas/context with mapray.
- `mapray.ThreeCustomScene` handles the normal scene pass only, so mapray picking is not disturbed.
- Arrow keys move the character over the Tokyo Station area.
- The character height follows `Viewer.getElevation()` so it stays on the terrain.
- By default the model is loaded from `https://threejs.org/examples/models/gltf/Soldier.glb`.
- You can override the model with `?model=<url>`.
