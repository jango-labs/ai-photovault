import { describe, expect, it } from 'vitest';
import { geocoderConfigFromEnv } from './geocoder.js';

describe('place-name lookup is private by default', () => {
  it('is off unless you switch it on, so no place name ever leaves this computer by default', () => {
    expect(geocoderConfigFromEnv({}).enabled).toBe(false);
    expect(geocoderConfigFromEnv({ PHOTOVAULT_GEOCODER: 'off' }).enabled).toBe(false);
    expect(geocoderConfigFromEnv({ PHOTOVAULT_GEOCODER: 'on' }).enabled).toBe(true);
  });
});
