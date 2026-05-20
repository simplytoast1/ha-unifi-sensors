// Plugin entry point.
//
// Homebridge loads this module (resolved via package.json "main") and calls
// the default export with an API handle. We register a single dynamic
// platform; everything else lives in ./platform.

import type { API } from 'homebridge';
import { UnifiSensorsPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

// `export =` (not `export default`) because Homebridge uses
// CommonJS-style require() and expects the loader function to be the
// module's `module.exports`, not a `.default` property.
export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, UnifiSensorsPlatform);
};
