/**
 * AsyncStorage backend for SafetyDatabase's KVStore interface.
 *
 * Kept in its own file so SafetyDatabase.ts stays free of any
 * react-native-specific imports.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from './SafetyDatabase';

export class AsyncStorageKV implements KVStore {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  }
  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  }
  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  }
  async getAllKeys(): Promise<string[]> {
    const keys = await AsyncStorage.getAllKeys();
    return Array.from(keys);
  }
}
