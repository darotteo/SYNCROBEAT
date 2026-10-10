import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.darotteo.syncrobeat.beta',
  appName: 'SyncroBeat Beta',
  webDir: 'dist',
  backgroundColor: '#0b0b0b',
  server: { androidScheme: 'https', iosScheme: 'capacitor', cleartext: false },
  ios: { contentInset: 'automatic' },
};

export default config;
