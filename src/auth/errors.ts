import type { FirebaseAuthTypes } from '@react-native-firebase/auth';

export const AUTH_MISSING_CLIENT_ID = 'auth/missing-client-identifier';

const MISSING_SHA_DEV =
  'This build is not registered with Firebase yet.\n\n' +
  'Run scripts/print-firebase-shas.sh, add the SHA-1 and SHA-256 to ' +
  'Firebase Console > Project Settings > Android app > "Add fingerprint", ' +
  'then re-download google-services.json and reinstall the APK.';

const MISSING_SHA_USER =
  'This app build can\'t verify your phone right now. Please contact support.';

export function authErrorToMessage(e: unknown, fallback: string): string {
  const code = (e as FirebaseAuthTypes.NativeFirebaseAuthError | undefined)?.code;
  if (code === AUTH_MISSING_CLIENT_ID) {
    return __DEV__ ? MISSING_SHA_DEV : MISSING_SHA_USER;
  }
  if (typeof e === 'string') return e;
  return (e as { message?: string } | undefined)?.message ?? fallback;
}
