import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  Platform,
} from 'react-native';
import { useOBDStore } from './OBDStore';

export function OBDStatusBanner() {
  const { state, adapterName, fuelCalcMethod, errorMsg, debugLog } = useOBDStore();
  const [showLog, setShowLog] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  if (state === 'idle') return null;

  const configs = {
    scanning:     { color: '#F5A623', label: 'Scanning for adapter…', showSpinner: true  },
    connecting:   { color: '#F5A623', label: 'Connecting…',           showSpinner: true  },
    ready:        { color: '#7ED321', label: adapterName ?? 'OBD',    showSpinner: false },
    reconnecting: { color: '#F5A623', label: 'Reconnecting…',         showSpinner: true  },
    error:        { color: '#D0021B', label: errorMsg ?? 'OBD error', showSpinner: false },
  };

  const cfg = configs[state] ?? configs.error;
  const canShowLog = debugLog.length > 0;

  return (
    <>
      <View style={[styles.banner, { borderLeftColor: cfg.color }]}>
        {cfg.showSpinner && (
          <ActivityIndicator size="small" color={cfg.color} style={styles.spinner} />
        )}
        {!cfg.showSpinner && <View style={[styles.dot, { backgroundColor: cfg.color }]} />}
        <Text style={styles.label} numberOfLines={2}>
          {cfg.label}
        </Text>
        {state === 'ready' && fuelCalcMethod !== 'none' && (
          <Text style={styles.method}>{fuelCalcMethod.toUpperCase()}</Text>
        )}
        {canShowLog && state === 'error' && (
          <TouchableOpacity onPress={() => setShowLog(true)} hitSlop={8}>
            <Text style={styles.logBtn}>LOG</Text>
          </TouchableOpacity>
        )}
      </View>

      <Modal visible={showLog} animationType="slide" onRequestClose={() => setShowLog(false)}>
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>OBD Debug Log</Text>
            <TouchableOpacity onPress={() => setShowLog(false)}>
              <Text style={styles.modalClose}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            ref={scrollRef}
            style={styles.logScroll}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          >
            {debugLog.map((line) => (
              <Text key={line} style={styles.logLine} selectable>
                {line}
              </Text>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </>
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
  logBtn: {
    color: '#F5A623',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginLeft: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: '#F5A623',
    borderRadius: 4,
  },
  modal: {
    flex: 1,
    backgroundColor: '#0D0D0D',
    paddingTop: 48,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  modalTitle: { color: '#FFF', fontSize: 17, fontWeight: '600' },
  modalClose: { color: '#3B82F6', fontSize: 15 },
  logScroll: { flex: 1, paddingHorizontal: 12, paddingTop: 8 },
  logLine: {
    color: '#CCC',
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace' }),
    marginBottom: 2,
  },
});
