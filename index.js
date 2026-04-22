import { Buffer } from 'buffer';
global.Buffer = Buffer;

// Sentry must be initialized before any other app module is loaded.
import { initAlerting } from './src/monitoring/AlertingService';
initAlerting();

import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('DarthPixit', () => App);
