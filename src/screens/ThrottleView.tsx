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
  Alert,
} from 'react-native';
import { useOBDStore } from '../obd/OBDStore';
import { OBDStatusBanner } from '../obd/OBDStatusBanner';
import { VehicleCfg } from '../obd/OBDManager';
import { useAuth } from '../auth/AuthContext';

const { width: SW } = Dimensions.get('window');
const PAD = 24;
const TRACK_W = SW - PAD * 2;
const TRACK_H = 72;
const THUMB_W = 6;
const CORNER = 14;

const ECO_LIMIT = 0.40;
const MOD_LIMIT = 0.70;

interface Zone {
  id: 'eco' | 'moderate' | 'push';
  color: string;
  label: string;
  nudge: string;
  coaching: string;
}

const ZONES: Zone[] = [
  {
    id: 'eco',
    color: '#22C55E',
    label: 'Eco Zone',
    nudge: 'Smooth & efficient — great job!',
    coaching: 'Perfect — keep this pace.',
  },
  {
    id: 'moderate',
    color: '#F59E0B',
    label: 'Moderate',
    nudge: 'Ease up a bit for better mileage.',
    coaching: 'Ease off a little to save fuel.',
  },
  {
    id: 'push',
    color: '#EF4444',
    label: 'Push Zone',
    nudge: 'Ease off — heavy throttle burns fuel!',
    coaching: 'Back off — you\'re burning extra fuel.',
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
  redlineRPM: 6500,
};

export function ThrottleView() {
  const { engineLoadPct, rpm, state, fuelRateLPerH, speedKmH, start, stop } = useOBDStore();
  const { signOut } = useAuth();
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [demoThrottle, setDemoThrottle] = useState(0);
  const [tripAvgKmL, setTripAvgKmL] = useState<number | null>(null);

  // Refs so the accumulation interval always reads fresh values
  const demoThrottleRef = useRef(demoThrottle);
  const fuelRateRef = useRef(fuelRateLPerH);
  const speedRef = useRef(speedKmH);
  useEffect(() => { demoThrottleRef.current = demoThrottle; }, [demoThrottle]);
  useEffect(() => { fuelRateRef.current = fuelRateLPerH; }, [fuelRateLPerH]);
  useEffect(() => { speedRef.current = speedKmH; }, [speedKmH]);

  const tripFuelRef = useRef(0);
  const tripDistRef = useRef(0);

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

  const hasLiveData = isDemoMode || state === 'ready';

  // Reset trip accumulators when the session ends OR when demo mode is toggled.
  // Without the isDemoMode reset, switching modes while OBD is live pollutes
  // the trip average by mixing real and simulated fuel/distance figures.
  useEffect(() => {
    if (!hasLiveData) {
      tripFuelRef.current = 0;
      tripDistRef.current = 0;
      setTripAvgKmL(null);
    }
  }, [hasLiveData]);

  useEffect(() => {
    tripFuelRef.current = 0;
    tripDistRef.current = 0;
    setTripAvgKmL(null);
  }, [isDemoMode]);

  // Accumulate fuel & distance every 500ms to compute trip average
  useEffect(() => {
    if (!hasLiveData) return;
    const id = setInterval(() => {
      const dt = 0.5 / 3600; // 500ms expressed in hours
      let fr: number;
      let sp: number;
      if (isDemoMode) {
        const t = demoThrottleRef.current;
        fr = 0.8 + t * 9;   // simulated L/h
        sp = 20 + t * 60;   // simulated km/h
      } else {
        fr = fuelRateRef.current ?? 0;
        sp = speedRef.current ?? 0;
      }
      if (fr > 0.1 && sp > 0.5) {
        tripFuelRef.current += fr * dt;
        tripDistRef.current += sp * dt;
        if (tripFuelRef.current > 0.005) {
          setTripAvgKmL(tripDistRef.current / tripFuelRef.current);
        }
      }
    }, 500);
    return () => clearInterval(id);
  }, [hasLiveData, isDemoMode]);

  const throttle = useMemo(() => {
    if (isDemoMode) return demoThrottle;
    if (engineLoadPct != null) return Math.max(0, Math.min(1, engineLoadPct / 100));
    if (rpm != null) return Math.max(0, Math.min(1, rpm / 6000));
    return 0;
  }, [isDemoMode, demoThrottle, engineLoadPct, rpm]);

  const zone = getZone(throttle);

  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: throttle,
      duration: 140,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [throttle]);

  const fillWidth = anim.interpolate({ inputRange: [0, 1], outputRange: [0, TRACK_W], extrapolate: 'clamp' });
  const thumbLeft = anim.interpolate({ inputRange: [0, 1], outputRange: [0, TRACK_W - THUMB_W], extrapolate: 'clamp' });
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

        {/* Coaching copy */}
        {hasLiveData ? (
          <Text style={[styles.coaching, { color: zone.color }]}>
            {zone.coaching}
          </Text>
        ) : null}

        {/* Horizontal gauge */}
        <View style={styles.gaugeOuter}>
          <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
            <View style={{ flexDirection: 'row', flex: 1 }}>
              <View style={{ flex: 40, backgroundColor: '#052e16', borderTopLeftRadius: CORNER, borderBottomLeftRadius: CORNER }} />
              <View style={{ flex: 30, backgroundColor: '#3d1f00' }} />
              <View style={{ flex: 30, backgroundColor: '#3d0000', borderTopRightRadius: CORNER, borderBottomRightRadius: CORNER }} />
            </View>
          </View>
          <Animated.View style={[styles.fill, { width: fillWidth, backgroundColor: fillColor, pointerEvents: 'none' }]} />
          <View style={[styles.divider, { left: TRACK_W * ECO_LIMIT - 1 }]} />
          <View style={[styles.divider, { left: TRACK_W * MOD_LIMIT - 1 }]} />
          <Animated.View style={[styles.thumb, { left: thumbLeft }]} />
        </View>

        {/* Zone marker labels */}
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

        {/* Trip average mileage */}
        {tripAvgKmL != null ? (
          <View style={styles.tripRow}>
            <Text style={styles.tripLabel}>TRIP AVG</Text>
            <Text style={styles.tripVal}>{tripAvgKmL.toFixed(1)}</Text>
            <Text style={styles.tripUnit}>km/L</Text>
          </View>
        ) : null}

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
            <Text style={styles.noDataHint}>Live RPM, speed & fuel rate appear here</Text>
          ) : null}
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          {obdConnected ? (
            <TouchableOpacity style={[styles.btn, styles.btnDanger]} onPress={() => stop()}>
              <Text style={styles.btnText}>Disconnect OBD</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.btn, styles.btnPrimary]} onPress={() => start(DEFAULT_VEHICLE)}>
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

        {/* Sign out */}
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={() => {
            Alert.alert('Sign out', 'Are you sure you want to sign out?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign out', style: 'destructive', onPress: signOut },
            ]);
          }}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>

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
  zoneLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2.5,
    textAlign: 'center',
  },
  coaching: {
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
    opacity: 0.85,
  },
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
  markerRow: {
    flexDirection: 'row',
    width: TRACK_W,
  },
  markerLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  tripRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 6,
  },
  tripLabel: {
    color: '#444',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  tripVal: {
    color: '#FFFFFF',
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  tripUnit: {
    color: '#555',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
  },
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
  signOutBtn: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  signOutText: {
    color: '#333',
    fontSize: 13,
    fontWeight: '500',
  },
});
