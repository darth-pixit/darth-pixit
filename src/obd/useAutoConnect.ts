import { useEffect, useState, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOBDStore } from './OBDStore';
import { VehicleCfg } from './OBDManager';
import { requestBlePermissions } from './blePermissions';

const SETUP_KEY = 'obd_auto_connect_enabled';

export type AutoConnectState =
  | { phase: 'loading' }         // still reading AsyncStorage
  | { phase: 'needs_setup' }     // first launch — show onboarding
  | { phase: 'ready' };          // setup done — connection managed automatically

/**
 * Manages the one-time setup gate and then auto-starts the OBD connection
 * whenever the hook mounts with setup already complete.
 *
 * Returns:
 *   phase === 'loading'      — AsyncStorage check in-flight; render nothing
 *   phase === 'needs_setup'  — render onboarding UI; call completeSetup() on CTA tap
 *   phase === 'ready'        — normal UI; connection started automatically
 *
 * completeSetup() requests Android BLE permissions, saves the flag, then starts
 * the connection. It returns false if the user denies permissions so the caller
 * can show an appropriate message.
 */
export function useAutoConnect(vehicle: VehicleCfg): {
  autoConnectState: AutoConnectState;
  completeSetup: () => Promise<boolean>;
} {
  const start = useOBDStore((s) => s.start);
  const [autoConnectState, setAutoConnectState] = useState<AutoConnectState>({ phase: 'loading' });

  // Track whether start() has been fired in this mount so we don't call it twice
  // if the effect re-runs (e.g. strict-mode double-invoke in dev).
  const startedRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(SETUP_KEY).then((val) => {
      if (val === 'true') {
        setAutoConnectState({ phase: 'ready' });
      } else {
        setAutoConnectState({ phase: 'needs_setup' });
      }
    });
  }, []);

  useEffect(() => {
    if (autoConnectState.phase === 'ready' && !startedRef.current) {
      startedRef.current = true;
      start(vehicle);
    }
  }, [autoConnectState.phase, start, vehicle]);

  const completeSetup = async (): Promise<boolean> => {
    const granted = await requestBlePermissions();
    if (!granted) return false;
    await AsyncStorage.setItem(SETUP_KEY, 'true');
    setAutoConnectState({ phase: 'ready' });
    return true;
  };

  return { autoConnectState, completeSetup };
}
