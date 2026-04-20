import { Buffer } from 'buffer';
global.Buffer = Buffer;

import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('DarthPixit', () => App);
