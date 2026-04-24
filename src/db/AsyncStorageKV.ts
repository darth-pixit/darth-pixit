import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KVStore } from '../safety/SafetyDatabase';

export class AsyncStorageKV implements KVStore {
  getItem    = (key: string) => AsyncStorage.getItem(key);
  setItem    = (key: string, value: string) => AsyncStorage.setItem(key, value);
  removeItem = (key: string) => AsyncStorage.removeItem(key);
  getAllKeys  = () => AsyncStorage.getAllKeys().then((keys) => [...keys]);
}
