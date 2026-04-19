import { create } from 'zustand';
import { OBDManager, OBDData, VehicleCfg, defaultOBDData } from './OBDManager';

interface OBDStore extends OBDData {
  start: (vehicle: VehicleCfg) => void;
  stop: () => void;
}

export const useOBDStore = create<OBDStore>((set) => {
  OBDManager.getInstance().setUpdateHandler((data) => set(data));

  return {
    ...defaultOBDData,
    start: (vehicle) => OBDManager.getInstance().start(vehicle),
    stop: () => OBDManager.getInstance().stop(),
  };
});
