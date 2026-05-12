import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Trip, TripDetector } from './TripDetector';

const STORAGE_KEY = '@darth_pixit/trips_v1';
const MAX_TRIPS = 100;

interface TripState {
  trips: Trip[];
  currentTripStart: number | null;
  recentTrip: Trip | null;
  dismissRecentTrip: () => void;
  loadTrips: () => Promise<void>;
}

export const useTripStore = create<TripState>((set, get) => ({
  trips: [],
  currentTripStart: null,
  recentTrip: null,
  dismissRecentTrip: () => set({ recentTrip: null }),
  loadTrips: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) set({ trips: JSON.parse(raw) });
    } catch {}
  },
}));

// Wire up detector at module load time so handlers are ready before OBD data flows
const _det = TripDetector.getInstance();

_det.setActiveHandler((active, start) => {
  useTripStore.setState({ currentTripStart: active ? start : null });
});

_det.setTripEndedHandler(async (trip) => {
  const updated = [trip, ...useTripStore.getState().trips].slice(0, MAX_TRIPS);
  useTripStore.setState({ trips: updated, recentTrip: trip, currentTripStart: null });
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {}
});
