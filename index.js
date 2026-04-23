import { Buffer } from 'buffer';
global.Buffer = Buffer;

// Must be set before any Firebase auth call on iOS. APNs is unavailable in
// debug builds (empty entitlements), so Firebase would crash trying to register
// for remote notifications. This flag tells the native SDK to skip that path.
if (__DEV__) {
  const auth = require('@react-native-firebase/auth').default;
  auth().settings.appVerificationDisabledForTesting = true;
}

import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('DarthPixit', () => App);
