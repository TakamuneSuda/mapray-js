Babylon.js CustomScene Sample
================================================================================


Setup
--------------------------------------------------------------------------------
This sample uses `mapray` for the globe and `Babylon.js` for a custom-rendered
box drawn through `Viewer.custom_scene_collection`.

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
cd debug/babylon-customscene
yarn install
yarn start
```

Open [http://localhost:7776/](http://localhost:7776/).


Notes
--------------------------------------------------------------------------------
- The sample shares the existing `webgl2` canvas with mapray.
- Babylon.js rendering runs only for the normal scene pass, so mapray picking is not disturbed.
- The box is placed above Tokyo Station using GOCS/Mapray local coordinates.
