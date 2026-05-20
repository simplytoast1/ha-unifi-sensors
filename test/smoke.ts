// Live-API smoke test for the UniFi Protect Integration API.
//
// Runs the same client the plugin uses, against a real console, without
// any Homebridge dependency. The goal is to confirm in seconds that:
//   - the API key is valid
//   - the host is reachable
//   - the sensors response matches the schema we expect
//
// Usage:
//   echo "<your-api-key>" > .credentials
//   UNIFI_HOST=https://nvr.example.com npm run dev:smoke
//
// The script prints one line per sensor with the fields the plugin maps
// onto HomeKit (mac, id, state, mount, battery, capabilities, latest
// readings) so you can see exactly what the Homebridge platform will
// receive.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IntegrationApiClient, IntegrationApiError } from '../src/unifi/client';

/** Read the API key from .credentials in the repo root. Refuses to use
 *  the placeholder string so a forgotten paste doesn't masquerade as a
 *  failed connection. */
function readCredentials(): string {
  const file = path.resolve(__dirname, '..', '.credentials');
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing .credentials file at ${file}. Paste your UniFi Protect Integration API key there.`,
    );
  }
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw || raw.startsWith('PASTE_')) {
    throw new Error(`Edit .credentials and replace the placeholder with your API key.`);
  }
  return raw;
}

async function main() {
  // Host can be overridden per run for testing against multiple consoles.
  // The default is the user's own console so an unattended `npm run`
  // works without arguments.
  const host = process.env.UNIFI_HOST || 'https://nvr.dortoahankins.com';
  const apiKey = readCredentials();
  const client = new IntegrationApiClient({ host, apiKey, rejectUnauthorized: false });

  // Step 1: ping /meta/info. Identical to what the plugin does at
  // startup; surfaces auth + connectivity issues with the clearest error.
  console.log(`-> GET ${host}/proxy/protect/integration/v1/meta/info`);
  try {
    const meta = await client.getMetaInfo();
    console.log(`   Protect application version: ${meta.applicationVersion}`);
  } catch (err) {
    const e = err as IntegrationApiError;
    console.error(`meta/info failed: ${e.message}`);
    if (e.body) console.error(`  body: ${e.body.slice(0, 500)}`);
    process.exit(1);
  }

  // Step 2: list every sensor. The output below uses the same field
  // paths the platform uses, so any discrepancy here predicts a real
  // bug at runtime.
  console.log(`-> GET ${host}/proxy/protect/integration/v1/sensors`);
  let sensors;
  try {
    sensors = await client.listSensors();
  } catch (err) {
    const e = err as IntegrationApiError;
    console.error(`sensors list failed: ${e.message}`);
    if (e.body) console.error(`  body: ${e.body.slice(0, 500)}`);
    process.exit(1);
  }

  console.log(`   Discovered ${sensors.length} sensor(s):`);
  for (const s of sensors) {
    // Compute which HomeKit services the plugin would expose. Mirrors
    // the gating logic in platformAccessory.ts so the smoke test acts
    // as a visual cross-check.
    const caps: string[] = [];
    if (s.motionSettings?.isEnabled) caps.push('motion');
    if (s.mountType && s.mountType !== 'none' && s.mountType !== 'leak') {
      caps.push(`contact:${s.mountType}`);
    }
    if (
      s.mountType === 'leak'
      || s.leakSettings?.isInternalEnabled
      || s.leakSettings?.isExternalEnabled
    ) {
      caps.push('leak');
    }
    if (s.temperatureSettings?.isEnabled) caps.push('temperature');
    if (s.humiditySettings?.isEnabled) caps.push('humidity');
    if (s.lightSettings?.isEnabled) caps.push('light');
    if (s.alarmSettings?.isEnabled) caps.push('alarm');

    // Battery lives under wirelessConnectionState in the v7.1 schema; the
    // legacy top-level batteryStatus is still emitted on some firmware
    // for backwards compatibility.
    const battery = s.wirelessConnectionState?.batteryStatus ?? s.batteryStatus;
    const pct = battery?.percentage;

    console.log(
      `   - ${s.name ?? '(unnamed)'}  mac=${s.mac}  id=${s.id}  state=${s.state}  ` +
      `mount=${s.mountType}  battery=${pct ?? '?'}%${battery?.isLow ? ' (LOW)' : ''}  ` +
      `caps=[${caps.join(', ')}]`,
    );

    // Print the live readings on a second line when present.
    if (s.stats) {
      const t = s.stats.temperature?.value;
      const h = s.stats.humidity?.value;
      const l = s.stats.light?.value;
      const parts: string[] = [];
      if (typeof t === 'number') parts.push(`${t.toFixed(1)}°C`);
      if (typeof h === 'number') parts.push(`${h.toFixed(0)}%RH`);
      if (typeof l === 'number') parts.push(`${l.toFixed(0)}lux`);
      if (parts.length) console.log(`     readings: ${parts.join(', ')}`);
    }
  }

  // Step 3: list every fob. Same shape as the sensor block; surfaces
  // which buttons each fob advertises so the user can verify the
  // StatelessProgrammableSwitch services match.
  console.log(`-> GET ${host}/proxy/protect/integration/v1/fobs`);
  try {
    const fobs = await client.listFobs();
    console.log(`   Discovered ${fobs.length} fob(s):`);
    for (const f of fobs) {
      const battery = f.wirelessConnectionState?.batteryStatus;
      const pct = battery?.percentage;
      console.log(
        `   - ${f.name ?? '(unnamed)'}  mac=${f.mac}  id=${f.id}  state=${f.state}  ` +
        `awayState=${f.awayState}  battery=${pct ?? '?'}%${battery?.isLow ? ' (LOW)' : ''}  ` +
        `buttons=[${(f.featureFlags?.buttons ?? []).join(', ')}]`,
      );
    }
  } catch (err) {
    const e = err as IntegrationApiError;
    console.error(`fobs list failed: ${e.message}`);
    if (e.body) console.error(`  body: ${e.body.slice(0, 500)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
