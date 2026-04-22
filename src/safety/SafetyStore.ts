/**
 * SafetyStore — Zustand store exposing the live safety state to the UI.
 */

import { create } from 'zustand';
import {
  SafetyEvent,
  SafetyScore,
  TripStatus,
  TripRecord,
  CrashReport,
  WearSignal,
  DrowsinessSignal,
  WeatherSnapshot,
  RouteContext,
  SafetyConfig,
  DEFAULT_SAFETY_CONFIG,
} from './types';

export interface SafetyState {
  // Live trip state
  status: TripStatus;
  tripId: string | null;
  startedAt: number | null;
  distanceM: number;
  currentSpeedKmH: number;
  events: SafetyEvent[];
  liveScore: SafetyScore | null;
  crashSuspected: boolean;
  lastCrashReport: CrashReport | null;
  wearSignals: WearSignal[];
  drowsinessEvents: DrowsinessSignal[];
  weather: WeatherSnapshot | null;
  routeContext: RouteContext | null;
  drowsinessCalibrated: boolean;

  // History
  recentTrips: TripRecord[];
  lifetimeScore: number | null;

  // Config
  config: SafetyConfig;

  // Actions (called by integration layer, not UI directly)
  _applyTripSnapshot: (s: {
    status: TripStatus;
    tripId: string | null;
    startedAt: number | null;
    distanceM: number;
    events: SafetyEvent[];
    liveScore: SafetyScore | null;
    currentSpeedKmH: number;
    crashSuspected: boolean;
    wearSignals: WearSignal[];
    drowsinessEvents: DrowsinessSignal[];
    weather: WeatherSnapshot | null;
    routeContext: RouteContext | null;
    drowsinessDetectorCalibrated: boolean;
  }) => void;
  _onTripEnded: (trip: TripRecord) => void;
  _setCrashReport: (r: CrashReport | null) => void;
  _setRecentTrips: (trips: TripRecord[]) => void;
  _setLifetimeScore: (s: number | null) => void;
  _setConfig: (c: SafetyConfig) => void;
}

export const useSafetyStore = create<SafetyState>((set) => ({
  status: 'idle',
  tripId: null,
  startedAt: null,
  distanceM: 0,
  currentSpeedKmH: 0,
  events: [],
  liveScore: null,
  crashSuspected: false,
  lastCrashReport: null,
  wearSignals: [],
  drowsinessEvents: [],
  weather: null,
  routeContext: null,
  drowsinessCalibrated: false,

  recentTrips: [],
  lifetimeScore: null,

  config: { ...DEFAULT_SAFETY_CONFIG },

  _applyTripSnapshot: (s) => set({
    status: s.status,
    tripId: s.tripId,
    startedAt: s.startedAt,
    distanceM: s.distanceM,
    events: s.events,
    liveScore: s.liveScore,
    currentSpeedKmH: s.currentSpeedKmH,
    crashSuspected: s.crashSuspected,
    wearSignals: s.wearSignals,
    drowsinessEvents: s.drowsinessEvents,
    weather: s.weather,
    routeContext: s.routeContext,
    drowsinessCalibrated: s.drowsinessDetectorCalibrated,
  }),
  _onTripEnded: (trip) => set((prev) => ({
    recentTrips: [trip, ...prev.recentTrips].slice(0, 50),
  })),
  _setCrashReport: (r) => set({ lastCrashReport: r }),
  _setRecentTrips: (trips) => set({ recentTrips: trips }),
  _setLifetimeScore: (s) => set({ lifetimeScore: s }),
  _setConfig: (c) => set({ config: c }),
}));
