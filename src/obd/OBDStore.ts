import { create } from 'zustand';
import { OBDManager, OBDData, VehicleCfg, defaultOBDData } from './OBDManager';
import { TripDetector } from '../trips/TripDetector';
// Ensure TripStore module initialises its detector handlers before OBD data flows
import '../trips/TripStore';

interface OBDStore extends OBDData {
  start: (vehicle: VehicleCfg) => void;
  stop: () => void;
}

export const useOBDStore = create<OBDStore>((set) => {
  OBDManager.getInstance().setUpdateHandler((data: OBDData) => {
    set(data);
    TripDetector.getInstance().feed(data);
  });

  return {
    ...defaultOBDData,
    start: (vehicle) => OBDManager.getInstance().start(vehicle),
    stop: () => OBDManager.getInstance().stop(),
  };
});
