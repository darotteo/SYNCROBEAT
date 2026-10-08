import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Packaging for the app stores. The web build in dist/ ships inside the app, so the metronome and
 * local practice work with no network at all; rooms still need the server, whose address is fixed
 * at build time through VITE_SERVER_URL (see src/utils/serverUrl.ts).
 *
 * appId is permanent: once an app is published under it, Google and Apple will not let it change.
 */
const config: CapacitorConfig = {
  appId: 'com.syncrobeat.app',
  appName: 'SyncroBeat',
  webDir: 'dist',
  android: {
    // The click is scheduled far more precisely than the screen can repaint; letting the web view
    // mix audio at its own pace is what matters, so no custom audio flags are set here.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
