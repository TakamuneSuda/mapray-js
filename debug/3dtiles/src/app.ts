import ThreeDTilesViewer from './ThreeDTilesViewer';


class App {

    constructor( container ) {
        this._container = container;
        this._current = new ThreeDTilesViewer( this._container );
    }

    destroy() {
        this._current.destroyViewer();
    }
}

export default App;
