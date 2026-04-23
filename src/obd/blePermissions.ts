import { Platform, PermissionsAndroid } from 'react-native';

/**
 * Request BLE permissions on Android. iOS handles this automatically via
 * the system dialog when BleManager first touches the radio; nothing to do here.
 *
 * Returns true if permissions are granted (or if we're on iOS where the
 * runtime grant happens elsewhere).
 */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  if (Platform.Version >= 31) {
    // Android 12+ splits BLE into SCAN + CONNECT; location not required.
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return (
      results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
      results[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  // Android < 12: BLE scan requires location permission.
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
