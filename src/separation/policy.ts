/** When to separate instruments: the "Separate instruments first" setting. */
import { Capacitor } from '@capacitor/core';

export type SeparationSetting = 'auto' | 'on' | 'off';

export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === 'boolean' && uaData.mobile) return true;
  const ua = navigator.userAgent || '';
  // iPadOS reports a desktop Mac user agent.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * Auto separates in desktop browsers only: phones are slower and have less memory, so
 * there it is opt-in.
 */
export function shouldSeparate(setting: SeparationSetting): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return !Capacitor.isNativePlatform() && !isMobileDevice();
}

export function webGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as Navigator & { gpu?: unknown }).gpu;
}
