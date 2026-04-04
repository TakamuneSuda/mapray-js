import '../../../packages/ui/dist/mapray.css';
import App from './app';

var appInstance;

function startApp( container )
{
    if ( appInstance ) {
        appInstance.destroy();
        appInstance = undefined;
    }

    appInstance = new App( container );
}

// @ts-ignore
window.startApp = startApp;
