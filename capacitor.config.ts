import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.tabtranscribe.app',
  appName: 'Tab Transcribe',
  webDir: 'dist',
  backgroundColor: '#16181d',
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
