import React, { useEffect, useRef, useMemo, useState } from 'react';
import {
  View,
  Text,
  Animated,
  Easing,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  StatusBar,
  SafeAreaView,
} from 'react-native';
import { useOBDStore } from '../obd/OBDStore';
import { OBDStatusBanner } from '../obd/OBDStatusBanner';
import { VehicleCfg } from '../obd/OBDManager';

const { width: SW } = Dimensions.get('window');
const PAD = 24;
const TRACK_W = SW - PAD * 2;
const TRACK_H = 72;
const THUMB_W = 6;
const CORNER = 14;

// Zone boundary thresholds (0–1)
const ECO_LIMIT = 0.40;
const MOD_LIMIT = 0.70;

interface Zone {
  id: 'eco' | 'moderate' | 'push';
  color: string;
  bgDim: string;
  label: string;
  nudge: string;
}

const ZONES: Zone[] = [
  {
    id: 'eco',
    color: '#22C55E',
    bgDim: '#052e16',
    label: 'Eco Zone',
    nudge: 'Smooth & efficient — great job!',
  },
  {
    id: 'moderate',
    color: '#F59E0B',
    bgDim: '#3d1f00',
    label: 'Moderate',
    nudge: 'Ease up a bit for better mileage.',
  },
  {
    id: 'push',
    color: '#EF4444',
    bgDim: '#3d0000',
    label: 'Push Zone',
    nudge: 'Ease off — heavy throttle burns fuel!',
  },
];

function getZone(v: number): Zone {
  if (v <= ECO_LIMIT) return ZONES[0];
  if (v <= MOD_LIMIT) return ZONES[1];
  return ZONES[2];
}

const DEFAULT_VEHICLE: VehicleCfg = {
  stoichAFR: 14.7,
  fuelDensityGPerL: 740,
  displacementL: 1.0,
  volEfficiency: 0.82,
};

export function ThrottleView() {
  const { engineLoadPct, rpm, state, fuelRateLPerH, speedKmH, start, stop } = useOBDStore();
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [demoThrottle, setDemoThrottle] = useState(0);

  // Demo mode: animated sine-wave throttle simulation
  useEffect(() => {
    if (!isDemoMode) return;
    let frame = 0;
    const id = setInterval(() => {
      frame++;
      const base = Math.sin(frame * 0.07) * 0.38 + 0.38;
      const jitter = (Math.random() - 0.5) * 0.06;
      setDemoThrottle(Math.max(0, Math.min(1, base + jitter)));
    }, 100);
    return () => clearInterval(id);
  }, [isDemoMode]);

  // Throttle value 0–1: prefer engineLoad, fall back to rpm, then demo
  const throttle = useMemo(() => {
    if (isDemoMode) return demoThrottle;
    if (engineLoadPct != null) return Math.max(0, Math.min(1, engineLoadPct / 100));
    if (rpm != null) return Math.max(0, Math.min(1, rpm / 6000));
    return 0;
  }, [isDemoMode, demoThrottle, engineLoadPct, rpm]);

  const hasLiveData = isDemoMode || state === 'ready';
  const zone = getZone(throttle);
  const pct = Math.round(throttle * 100);

  // Animated value drives fill width, thumb position, and color
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: throttle,
      duration: 140,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [throttle]);

  // Fill stretches left → right
  const fillWidth = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, TRACK_W],
    extrapolate: 'clamp',
  });

  // Thumb slides left → right
  const thumbLeft = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, TRACK_W - THUMB_W],
    extrapolate: 'clamp',
  });

  // Color transitions smoothly: green → yellow → red
  const fillColor = anim.interpolate({
    inputRange: [0, ECO_LIMIT, MOD_LIMIT, 1],
    outputRange: ['#22C55E', '#F59E0B', '#EF4444', '#EF4444'],
    extrapolate: 'clamp',
  });

  const obdConnected = state !== 'idle';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#0D0D0D" />
      <OBDStatusBanner />

      <View style={styles.body}>

        {/* Nudge message box */}
        <View style={[styles.nudgeBox, { borderColor: hasLiveData ? zone.color + '55' : '#2a2a2a' }]}>
          <Text style={[styles.nudgeText, { color: hasLiveData ? zone.color : '#555' }]}>
            {hasLiveData
              ? zone.nudge
              : 'Tap "Try Demo" to preview, or connect your OBD adapter.'}
          </Text>
        </View>

        {/* Zone label */}
        <Text style={[styles.zoneLabel, { color: hasLiveData ? zone.color + 'AA' : '#333' }]}>
          {hasLiveData ? zone.label.toUpperCase() : '— —'}
        </Text>

        {/* Big throttle percentage */}
        <Text style={[styles.pct, { color: hasLiveData ? zone.color : '#2a2a2a' }]}>
          {hasLiveData ? `${pct}%` : '--'}
        </Text>

        {/* Horizontal gauge */}
        <View style={styles.gaugeOuter}>
          {/* Dimmed zone backgrounds */}
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={{ flexDirection: 'row', flex: 1 }}>
              <View
                style={{
                  flex: 40,
                  backgroundColor: '#052e16',
                  borderTopLeftRadius: CORNER,
                  borderBottomLeftRadius: CORNER,
                }}
              />
              <View style={{ flex: 30, backgroundColor: '#3d1f00' }} />
              <View
                style={{
                  flex: 30,
                  backgroundColor: '#3d0000',
                  borderTopRightRadius: CORNER,
                  borderBottomRightRadius: CORNER,
                }}
              />
            </View>
          </View>

          {/* Animated color fill */}
          <Animated.View
            pointerEvents="none"
            style={[styles.fill, { width: fillWidth, backgroundColor: fillColor }]}
          />

          {/* Zone boundary dividers */}
          <View style={[styles.divider, { left: TRACK_W * ECO_LIMIT - 1 }]} />
          <View style={[styles.divider, { left: TRACK_W * MOD_LIMIT - 1 }]} />

          {/* Sliding thumb — bright white needle */}
          <Animated.View style={[styles.thumb, { left: thumbLeft }]} />
        </View>

        {/* Zone marker labels — centered over each zone segment */}
        <View style={styles.markerRow}>
          <View style={{ flex: 40, alignItems: 'center' }}>
            <Text style={[styles.markerLabel, { color: '#22C55E' }]}>ECO</Text>
          </View>
          <View style={{ flex: 30, alignItems: 'center' }}>
            <Text style={[styles.markerLabel, { color: '#F59E0B' }]}>MOD</Text>
          </View>
          <View style={{ flex: 30, alignItems: 'center' }}>
            <Text style={[styles.markerLabel, { color: '#EF4444' }]}>PUSH</Text>
          </View>
        </View>

        {/* Live stats row */}
        <View style={styles.statsRow}>
          {rpm != null ? (
            <View style={styles.statBlock}>
              <Text style={styles.statVal}>{Math.round(rpm).toLocaleString()}</Text>
              <Text style={styles.statLbl}>RPM</Text>
            </View>
          ) : null}
          {speedKmH != null ? (
            <View style={styles.statBlock}>
              <Text style={styles.statVal}>{Math.round(speedKmH)}</Text>
              <Text style={styles.statLbl}>km/h</Text>
            </View>
          ) : null}
          {fuelRateLPerH != null && state === 'ready' ? (
            <View style={styles.statBlock}>
              <Text style={styles.statVal}>{fuelRateLPerH.toFixed(1)}</Text>
              <Text style={styles.statLbl}>L/h</Text>
            </View>
          ) : null}
          {!hasLiveData ? (
            <Text style={styles.noDataHint}>Live RPM, speed &amp; fuel rate appear here</Text>
          ) : null}
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          {obdConnected ? (
            <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={() => stop()}>
              <Text style={styles.btnText}>Disconnect OBD</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={() => start(DEFAULT_VEHICLE)}
            >
              <Text style={styles.btnText}>Connect OBD Adapter</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={[styles.btn, isDemoMode ? styles.btnAccent : styles.btnOutline]}
            onPress={() => setIsDemoMode((d) => !d)}
          >
            <Text style={[styles.btnText, !isDemoMode && styles.btnTextMuted]}>
              {isDemoMode ? 'Stop Demo' : 'Try Demo'}
            </Text>
          </TouchableOpacity>
        </View>

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0D0D0D',
  },
  body: {
    flex: 1,
    paddingHorizontal: PAD,
    paddingTop: 28,
    paddingBottom: 16,
    gap: 16,
  },

  // Nudge box
  nudgeBox: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: 'center',
    backgroundColor: '#111',
    minHeight: 72,
    justifyContent: 'center',
  },
  nudgeText: {
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: 24,
  },

  // Zone + percentage
  zoneLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2.5,
    textAlign: 'center',
  },
  pct: {
    fontSize: 80,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 88,
    letterSpacing: -2,
  },

  // Gauge
  gaugeOuter: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: CORNER,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#1a1a1a',
  },
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: TRACK_H,
    opacity: 0.82,
  },
  divider: {
    position: 'absolute',
    top: 0,
    width: 2,
    height: TRACK_H,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  thumb: {
    position: 'absolute',
    top: 0,
    width: THUMB_W,
    height: TRACK_H,
    backgroundColor: '#FFFFFF',
    borderRadius: THUMB_W / 2,
    shadowColor: '#FFFFFF',
    shadowOpacity: 0.7,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },

  // Zone markers
  markerRow: {
    flexDirection: 'row',
    width: TRACK_W,
  },
  markerLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },

  // Stats
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
    flex: 1,
    alignItems: 'center',
  },
  statBlock: {
    alignItems: 'center',
  },
  statVal: {
    color: '#FFFFFF',
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  statLbl: {
    color: '#555',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.5,
    marginTop: 2,
  },
  noDataHint: {
    color: '#333',
    fontSize: 13,
    textAlign: 'center',
  },

  // Buttons
  actions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
  },
  btn: {
    paddingVertical: 13,
    paddingHorizontal: 22,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 140,
  },
  btnPrimary: { backgroundColor: '#22C55E' },
  btnDanger: { backgroundColor: '#EF4444' },
  btnAccent: { backgroundColor: '#3B82F6' },
  btnOutline: { borderWidth: 1, borderColor: '#2a2a2a' },
  btnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  btnTextMuted: { color: '#555' },
});
