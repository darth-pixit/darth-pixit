import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useOBDStore } from './OBDStore';

export function OBDStatusBanner() {
  const { state, adapterName, fuelCalcMethod, errorMsg } = useOBDStore();

  if (state === 'idle') return null;

  const configs = {
    scanning: { color: '#F5A623', label: 'Scanning for adapter…', showSpinner: true },
    connecting: { color: '#F5A623', label: 'Connecting…', showSpinner: true },
    ready: { color: '#7ED321', label: adapterName ?? 'OBD', showSpinner: false },
    reconnecting: { color: '#F5A623', label: 'Reconnecting…', showSpinner: true },
    error: { color: '#D0021B', label: errorMsg ?? 'OBD error', showSpinner: false },
  };

  const cfg = configs[state] ?? configs.error;

  return (
    <View style={[styles.banner, { borderLeftColor: cfg.color }]}>
      {cfg.showSpinner && (
        <ActivityIndicator size="small" color={cfg.color} style={styles.spinner} />
      )}
      {!cfg.showSpinner && <View style={[styles.dot, { backgroundColor: cfg.color }]} />}
      <Text style={styles.label} numberOfLines={1}>
        {cfg.label}
      </Text>
      {state === 'ready' && (
        <Text style={styles.method}>{fuelCalcMethod.toUpperCase()}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderLeftWidth: 3,
    backgroundColor: '#1A1A1A',
  },
  spinner: { marginRight: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  label: { flex: 1, color: '#FFF', fontSize: 13 },
  method: { color: '#888', fontSize: 11, marginLeft: 8 },
});
