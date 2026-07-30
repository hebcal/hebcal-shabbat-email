import {appendIsraelAndTracking} from '@hebcal/rest-api';

/**
 * Appends Israel and UTM tracking query params to a hebcal.com URL and
 * escapes the ampersands for safe inclusion in HTML attributes.
 */
export function urlEncodeAndTrack(url: string, il = false): string {
  url = appendIsraelAndTracking(url, il, 'newsletter', 'email', 'shabbat-weekly');
  return url.replaceAll('&', '&amp;');
}
