/**
 * Infrastructure test suite for Laintown
 *
 * Validates systemd service files, port assignments, LAIN_HOME isolation,
 * peer configs, interlink targets, and cross-file consistency.
 *
 * These tests would have caught:
 * - WatchdogSec killing Wired Lain during LLM calls (Mar 14 2026)
 * - EADDRINUSE on port 3001 from stale process (Mar 13 2026)
 * - Telegram 409 conflict from duplicate bot instance
 * - Voice service missing env vars
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────
// Helpers — parse systemd unit files and related configs
// ─────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..');
const SYSTEMD_DIR = join(ROOT, 'deploy', 'systemd');
const ENV_DIR = join(ROOT, 'deploy', 'env');
const WORKSPACE_DIR = join(ROOT, 'workspace');

interface ServiceFile {
  name: string; // e.g. "lain-wired"
  filename: string; // e.g. "lain-wired.service"
  raw: string;
  unit: Record<string, string>;
  service: Record<string, string[]>; // values can repeat (e.g. Environment=)
  install: Record<string, string>;
}

function parseServiceFile(filepath: string): ServiceFile {
  const raw = readFileSync(filepath, 'utf-8');
  const filename = filepath.split('/').pop()!;
  const name = filename.replace('.service', '');

  const unit: Record<string, string> = {};
  const service: Record<string, string[]> = {};
  const install: Record<string, string> = {};

  let section = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      section = trimmed.slice(1, -1).toLowerCase();
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);

    if (section === 'unit') {
      unit[key] = value;
    } else if (section === 'service') {
      if (!service[key]) service[key] = [];
      service[key].push(value);
    } else if (section === 'install') {
      install[key] = value;
    }
  }

  return { name, filename, raw, unit, service, install };
}

function getServiceEnv(svc: ServiceFile): Record<string, string> {
  const env: Record<string, string> = {};
  for (const val of svc.service['Environment'] ?? []) {
    // Handle Environment="KEY=value with spaces"
    const clean = val.replace(/^"(.*)"$/, '$1');
    const eqIdx = clean.indexOf('=');
    if (eqIdx !== -1) {
      env[clean.slice(0, eqIdx)] = clean.slice(eqIdx + 1);
    }
  }
  return env;
}

function getPort(svc: ServiceFile): number | null {
  const execStart = svc.service['ExecStart']?.[0] ?? '';
  const portMatch = execStart.match(/--port\s+(\d+)/);
  return portMatch ? parseInt(portMatch[1], 10) : null;
}

// Oneshot services (not long-running daemons — no restart policy, no target membership)
const ONESHOT_SERVICES = ['lain-healthcheck', 'lain-backup'];

// Known service → character ID mapping
const SERVICE_CHARACTER_MAP: Record<string, string> = {
  'lain-wired': 'wired-lain',
  'lain-main': 'lain',
  'lain-pkd': 'pkd',
  'lain-mckenna': 'mckenna',
  'lain-john': 'john',
  'lain-hiru': 'hiru',
};

// Load all service files
const allServiceFiles = readdirSync(SYSTEMD_DIR)
  .filter((f) => f.endsWith('.service'))
  .map((f) => parseServiceFile(join(SYSTEMD_DIR, f)));

// Long-running daemon services (excludes oneshot services like healthcheck, backup)
const serviceFiles = allServiceFiles.filter(
  (s) => !ONESHOT_SERVICES.includes(s.name),
);

// Whether character-specific services exist (only in wired-lain, not empty platform)
const hasCharacterServices = serviceFiles.some((s) => SERVICE_CHARACTER_MAP[s.name] !== undefined);

// Load lain.target
const targetRaw = readFileSync(join(SYSTEMD_DIR, 'lain.target'), 'utf-8');
const targetWants =
  targetRaw
    .match(/Wants=(.+)/)?.[1]
    .split(/\s+/)
    .filter(Boolean) ?? [];

// Load status.sh service definitions (only from the SERVICES array)
const statusRaw = readFileSync(join(ROOT, 'deploy', 'status.sh'), 'utf-8');
const statusServices: Array<{ svc: string; port: string; name: string }> = [];
const servicesArrayMatch = statusRaw.match(/SERVICES=\(([\s\S]*?)\)/);
if (servicesArrayMatch) {
  for (const match of servicesArrayMatch[1].matchAll(/"([^"]+):([^"]*):([^"]+)"/g)) {
    statusServices.push({ svc: match[1], port: match[2], name: match[3] });
  }
}

// Load start.sh for port/env cross-checking
const startRaw = readFileSync(join(ROOT, 'start.sh'), 'utf-8');

// Expected port assignments (single source of truth)
const EXPECTED_PORTS: Record<string, number> = {
  'lain-wired': 3000,
  'lain-main': 3001,
  'lain-dr-claude': 3002,
  'lain-pkd': 3003,
  'lain-mckenna': 3004,
  'lain-john': 3005,
  'lain-hiru': 3006,
  'lain-voice': 8765,
};

// Services that don't bind to a port via --port flag
const PORTLESS_SERVICES = ['lain-telegram', 'lain-gateway', 'lain-voice', 'lain-healthcheck'];

// ─────────────────────────────────────────────────────────
// 1. WATCHDOG SAFETY — Type=simple must not use WatchdogSec
//    without sd_notify implementation (caused Wired Lain crash)
// ─────────────────────────────────────────────────────────
describe('Watchdog Safety', () => {
  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: Type=simple must not have WatchdogSec (app has no sd_notify)',
    (_name, svc) => {
      const type = svc.service['Type']?.[0];
      const hasWatchdog = svc.service['WatchdogSec'] !== undefined;
      if (type === 'simple') {
        expect(hasWatchdog, `${svc.filename} has WatchdogSec with Type=simple — systemd will kill it during long LLM calls`).toBe(false);
      }
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: NotifyAccess should not be set without WatchdogSec',
    (_name, svc) => {
      const hasNotify = svc.service['NotifyAccess'] !== undefined;
      const hasWatchdog = svc.service['WatchdogSec'] !== undefined;
      if (!hasWatchdog) {
        expect(hasNotify, `${svc.filename} has NotifyAccess but no WatchdogSec — dead config`).toBe(false);
      }
    },
  );
});

// ─────────────────────────────────────────────────────────
// 2. PORT CONFLICTS — No two services share a port
//    (caused EADDRINUSE crash for Lain on port 3001)
// ─────────────────────────────────────────────────────────
describe('Port Conflicts', () => {
  it('no two services bind to the same port', () => {
    const portMap = new Map<number, string[]>();
    for (const svc of serviceFiles) {
      const port = getPort(svc);
      if (port === null) continue;
      if (!portMap.has(port)) portMap.set(port, []);
      portMap.get(port)!.push(svc.name);
    }
    for (const [port, services] of portMap) {
      expect(services, `Port ${port} claimed by multiple services: ${services.join(', ')}`).toHaveLength(1);
    }
  });

  it('all HTTP services have an assigned port', () => {
    const httpServices = serviceFiles.filter(
      (s) => !PORTLESS_SERVICES.includes(s.name),
    );
    for (const svc of httpServices) {
      const port = getPort(svc);
      expect(port, `${svc.name} has no --port in ExecStart`).not.toBeNull();
    }
  });

  it('port assignments match expected values', () => {
    for (const svc of serviceFiles) {
      const port = getPort(svc);
      if (port === null) continue;
      const expected = EXPECTED_PORTS[svc.name];
      expect(port, `${svc.name} port ${port} doesn't match expected ${expected}`).toBe(expected);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 3. RESTART POLICY — All services must auto-recover
// ─────────────────────────────────────────────────────────
describe('Restart Policy', () => {
  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has Restart=on-failure',
    (_name, svc) => {
      expect(svc.service['Restart']?.[0]).toBe('on-failure');
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has RestartSec to prevent restart spam',
    (_name, svc) => {
      const restartSec = svc.service['RestartSec']?.[0];
      expect(restartSec, `${svc.filename} missing RestartSec`).toBeDefined();
      expect(Number(restartSec)).toBeGreaterThan(0);
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has StartLimitBurst to cap restart attempts',
    (_name, svc) => {
      expect(svc.unit['StartLimitBurst'], `${svc.filename} missing StartLimitBurst`).toBeDefined();
      expect(Number(svc.unit['StartLimitBurst'])).toBeGreaterThanOrEqual(3);
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has StartLimitIntervalSec',
    (_name, svc) => {
      expect(svc.unit['StartLimitIntervalSec'], `${svc.filename} missing StartLimitIntervalSec`).toBeDefined();
    },
  );
});

// ─────────────────────────────────────────────────────────
// 4. LAIN_HOME ISOLATION — Each character has its own database
//    (shared DB is the #1 recurring production bug)
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('LAIN_HOME Isolation', () => {
  const characterServices = serviceFiles.filter(
    (s) => SERVICE_CHARACTER_MAP[s.name] !== undefined,
  );

  it('every character service has LAIN_HOME set', () => {
    for (const svc of characterServices) {
      const env = getServiceEnv(svc);
      expect(env['LAIN_HOME'], `${svc.name} missing LAIN_HOME — will default to ~/.lain and share Lain's database!`).toBeDefined();
    }
  });

  it('no two character services share the same LAIN_HOME', () => {
    const homeMap = new Map<string, string[]>();
    for (const svc of characterServices) {
      const env = getServiceEnv(svc);
      const home = env['LAIN_HOME'];
      if (!home) continue;
      if (!homeMap.has(home)) homeMap.set(home, []);
      homeMap.get(home)!.push(svc.name);
    }
    for (const [home, services] of homeMap) {
      expect(services, `LAIN_HOME=${home} shared by: ${services.join(', ')}`).toHaveLength(1);
    }
  });

  it('Lain and Wired Lain have different LAIN_HOME', () => {
    const lain = serviceFiles.find((s) => s.name === 'lain-main');
    const wired = serviceFiles.find((s) => s.name === 'lain-wired');
    expect(lain).toBeDefined();
    expect(wired).toBeDefined();
    const lainHome = getServiceEnv(lain!)['LAIN_HOME'];
    const wiredHome = getServiceEnv(wired!)['LAIN_HOME'];
    expect(lainHome).not.toBe(wiredHome);
  });

  it('Telegram bot uses Lain LAIN_HOME (not Wired Lain)', () => {
    const telegram = serviceFiles.find((s) => s.name === 'lain-telegram');
    const lain = serviceFiles.find((s) => s.name === 'lain-main');
    expect(telegram).toBeDefined();
    expect(lain).toBeDefined();
    const tgHome = getServiceEnv(telegram!)['LAIN_HOME'];
    const lainHome = getServiceEnv(lain!)['LAIN_HOME'];
    expect(tgHome).toBe(lainHome);
  });
});

// ─────────────────────────────────────────────────────────
// 5. INTERLINK TARGETS — Sisters must point at each other
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('Interlink Targets', () => {
  it('Wired Lain interlink target points to Lain port', () => {
    const wired = serviceFiles.find((s) => s.name === 'lain-wired');
    const env = getServiceEnv(wired!);
    const target = env['LAIN_INTERLINK_TARGET'];
    expect(target).toBeDefined();
    expect(target).toContain(`:${EXPECTED_PORTS['lain-main']}`);
    expect(target).toContain('/api/interlink/letter');
  });

  it('Lain interlink target points to Wired Lain port', () => {
    const lain = serviceFiles.find((s) => s.name === 'lain-main');
    const env = getServiceEnv(lain!);
    const target = env['LAIN_INTERLINK_TARGET'];
    expect(target).toBeDefined();
    expect(target).toContain(`:${EXPECTED_PORTS['lain-wired']}`);
    expect(target).toContain('/api/interlink/letter');
  });

  it('interlink targets are reciprocal (each points to the other)', () => {
    const wired = serviceFiles.find((s) => s.name === 'lain-wired');
    const lain = serviceFiles.find((s) => s.name === 'lain-main');
    const wiredTarget = getServiceEnv(wired!)['LAIN_INTERLINK_TARGET'];
    const lainTarget = getServiceEnv(lain!)['LAIN_INTERLINK_TARGET'];
    // Wired → Lain port, Lain → Wired port
    expect(wiredTarget).toContain(`:${EXPECTED_PORTS['lain-main']}/`);
    expect(lainTarget).toContain(`:${EXPECTED_PORTS['lain-wired']}/`);
  });
});

// ─────────────────────────────────────────────────────────
// 6. PEER CONFIG — Characters must not peer with themselves,
//    all peer URLs must point to valid services, and
//    PEER_CONFIG must be in EnvironmentFile (not inline)
// ─────────────────────────────────────────────────────────
describe('Peer Configuration', () => {
  const servicesWithPeers = serviceFiles.filter((s) => {
    const envFiles = s.service['EnvironmentFile'] ?? [];
    return envFiles.some((f) => f.includes('deploy/env/'));
  });

  it('PEER_CONFIG is never set as inline Environment= (systemd strips JSON quotes)', () => {
    for (const svc of serviceFiles) {
      const envLines = svc.service['Environment'] ?? [];
      for (const line of envLines) {
        expect(line, `${svc.name} has inline PEER_CONFIG — must use EnvironmentFile`).not.toMatch(/^PEER_CONFIG=/);
      }
    }
  });

  for (const svc of servicesWithPeers) {
    const characterId = SERVICE_CHARACTER_MAP[svc.name];
    const envFilePaths = (svc.service['EnvironmentFile'] ?? []).filter((f) =>
      f.includes('deploy/env/'),
    );

    // Map production paths to local paths for testing
    for (const envPath of envFilePaths) {
      const localPath = join(
        ENV_DIR,
        envPath.split('/').pop()!,
      );

      if (!existsSync(localPath)) continue;
      const envRaw = readFileSync(localPath, 'utf-8');
      const peerMatch = envRaw.match(/PEER_CONFIG=(.+)/);
      if (!peerMatch) continue;

      let peers: Array<{ id: string; url: string; name: string }>;
      try {
        peers = JSON.parse(peerMatch[1]);
      } catch {
        it(`${svc.name}: PEER_CONFIG is valid JSON`, () => {
          expect.unreachable(`${svc.name} peer config is not valid JSON: ${peerMatch[1]}`);
        });
        continue;
      }

      it(`${svc.name}: does not list itself as a peer`, () => {
        const selfPeer = peers.find((p) => p.id === characterId);
        expect(selfPeer, `${svc.name} (${characterId}) lists itself as a peer — would cause self-conversation loop`).toBeUndefined();
      });

      it(`${svc.name}: all peer URLs point to known service ports`, () => {
        for (const peer of peers) {
          const portMatch = peer.url.match(/:(\d+)$/);
          expect(portMatch, `${svc.name} peer ${peer.id} has no port in URL: ${peer.url}`).not.toBeNull();
          const port = parseInt(portMatch![1], 10);
          const knownPorts = Object.values(EXPECTED_PORTS);
          expect(knownPorts, `${svc.name} peer ${peer.id} URL port ${port} is not a known service port`).toContain(port);
        }
      });

      it(`${svc.name}: peer IDs match known character IDs`, () => {
        const knownCharIds = Object.values(SERVICE_CHARACTER_MAP);
        for (const peer of peers) {
          expect(knownCharIds, `${svc.name} peer ${peer.id} is not a known character`).toContain(peer.id);
        }
      });
    }
  }
});

// ─────────────────────────────────────────────────────────
// 7. lain.target COMPLETENESS — Every service must be in
//    the target, and every target entry must have a file
// ─────────────────────────────────────────────────────────
describe('lain.target Completeness', () => {
  it('every service file is listed in lain.target Wants=', () => {
    for (const svc of serviceFiles) {
      expect(
        targetWants,
        `${svc.filename} is not listed in lain.target Wants= — it won't start with the group`,
      ).toContain(svc.filename);
    }
  });

  it('every entry in lain.target Wants= has a service file', () => {
    const filenames = serviceFiles.map((s) => s.filename);
    for (const wanted of targetWants) {
      expect(filenames, `lain.target wants ${wanted} but no service file exists`).toContain(wanted);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 8. status.sh CONSISTENCY — Port numbers and service names
//    must match between status.sh and service files
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('status.sh Consistency', () => {
  it('every service in status.sh has a corresponding service file', () => {
    const svcNames = serviceFiles.map((s) => s.name);
    for (const entry of statusServices) {
      expect(svcNames, `status.sh references ${entry.svc} but no service file exists`).toContain(entry.svc);
    }
  });

  it('every service file appears in status.sh', () => {
    const statusNames = statusServices.map((s) => s.svc);
    for (const svc of serviceFiles) {
      expect(statusNames, `${svc.name} is missing from status.sh — downtime won't be visible`).toContain(svc.name);
    }
  });

  it('port assignments in status.sh match service files', () => {
    for (const entry of statusServices) {
      if (!entry.port) continue; // portless services (telegram, gateway)
      const svc = serviceFiles.find((s) => s.name === entry.svc);
      if (!svc) continue;
      const svcPort = getPort(svc);
      if (svcPort === null) continue;
      expect(
        parseInt(entry.port, 10),
        `status.sh says ${entry.svc} is on port ${entry.port} but service file says ${svcPort}`,
      ).toBe(svcPort);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 9. start.sh CONSISTENCY — Ports, LAIN_HOME, and character
//    IDs must match between start.sh and service files
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('start.sh Consistency', () => {
  it('default port assignments in start.sh match service files', () => {
    const portDefaults: Record<string, number> = {};
    for (const match of startRaw.matchAll(
      /(\w+_PORT)="\$\{\w+:-(\d+)\}"/g,
    )) {
      portDefaults[match[1]] = parseInt(match[2], 10);
    }
    // Verify known mappings
    expect(portDefaults['WIRED_PORT']).toBe(EXPECTED_PORTS['lain-wired']);
    expect(portDefaults['LAIN_PORT']).toBe(EXPECTED_PORTS['lain-main']);
    expect(portDefaults['DOCTOR_PORT']).toBe(EXPECTED_PORTS['lain-dr-claude']);
    expect(portDefaults['PKD_PORT']).toBe(EXPECTED_PORTS['lain-pkd']);
    expect(portDefaults['MCKENNA_PORT']).toBe(EXPECTED_PORTS['lain-mckenna']);
    expect(portDefaults['JOHN_PORT']).toBe(EXPECTED_PORTS['lain-john']);
    expect(portDefaults['HIRU_PORT']).toBe(EXPECTED_PORTS['lain-hiru']);
    expect(portDefaults['VOICE_PORT']).toBe(EXPECTED_PORTS['lain-voice']);
  });
});

// ─────────────────────────────────────────────────────────
// 10. STALE PORT CLEANUP — HTTP services must kill stale
//     processes on their port before starting (ExecStartPre)
//     (caused recurring EADDRINUSE crashes for Lain)
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('Stale Port Cleanup', () => {
  const httpServices = serviceFiles.filter(
    (s) => getPort(s) !== null,
  );

  it.each(httpServices.map((s) => [s.name, s]))(
    '%s: has ExecStartPre that kills stale process on its port',
    (_name, svc) => {
      const port = getPort(svc);
      const preCommands = svc.service['ExecStartPre'] ?? [];
      const hasPortKill = preCommands.some(
        (cmd) => cmd.includes('fuser') && cmd.includes(`${port}/tcp`),
      );
      expect(hasPortKill, `${svc.name} (port ${port}) needs ExecStartPre with 'fuser -k ${port}/tcp' to prevent EADDRINUSE on restart`).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────
// 11. SERVICE STRUCTURE — All services have required fields
// ─────────────────────────────────────────────────────────
describe('Service Structure', () => {
  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: is PartOf=lain.target',
    (_name, svc) => {
      expect(svc.unit['PartOf']).toBe('lain.target');
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has journal logging configured',
    (_name, svc) => {
      expect(svc.service['StandardOutput']?.[0]).toBe('journal');
      expect(svc.service['StandardError']?.[0]).toBe('journal');
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has SyslogIdentifier for journalctl filtering',
    (_name, svc) => {
      expect(svc.service['SyslogIdentifier']?.[0], `${svc.name} missing SyslogIdentifier — can't filter logs with journalctl -u`).toBeDefined();
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: WantedBy=lain.target in [Install]',
    (_name, svc) => {
      expect(svc.install['WantedBy']).toBe('lain.target');
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has After=network.target',
    (_name, svc) => {
      expect(svc.unit['After'], `${svc.name} missing After= — may start before network is ready`).toBeDefined();
      expect(svc.unit['After']).toContain('network.target');
    },
  );

  it.each(serviceFiles.map((s) => [s.name, s]))(
    '%s: has EnvironmentFile for shared .env',
    (_name, svc) => {
      const envFiles = svc.service['EnvironmentFile'] ?? [];
      const hasSharedEnv = envFiles.some((f) => f.endsWith('.env') && f.includes('local-lain'));
      expect(hasSharedEnv, `${svc.name} doesn't load shared .env file — API keys may be missing`).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────
// 11. DEPENDENCY ORDERING — Services that depend on others
//     must declare After= correctly
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('Dependency Ordering', () => {
  it('Lain starts after Wired Lain', () => {
    const lain = serviceFiles.find((s) => s.name === 'lain-main');
    expect(lain!.unit['After']).toContain('lain-wired.service');
  });

  it('Telegram starts after Lain (uses her database)', () => {
    const telegram = serviceFiles.find((s) => s.name === 'lain-telegram');
    expect(telegram!.unit['After']).toContain('lain-main.service');
  });

  it('Dr. Claude starts after Wired Lain', () => {
    const doctor = serviceFiles.find((s) => s.name === 'lain-dr-claude');
    expect(doctor!.unit['After']).toContain('lain-wired.service');
  });

  const characterServers = ['lain-pkd', 'lain-mckenna', 'lain-john', 'lain-hiru'];
  it.each(characterServers)(
    '%s starts after Wired Lain (research handler)',
    (svcName) => {
      const svc = serviceFiles.find((s) => s.name === svcName);
      expect(svc, `${svcName} service file not found`).toBeDefined();
      expect(svc!.unit['After']).toContain('lain-wired.service');
    },
  );
});

// ─────────────────────────────────────────────────────────
// 12. WORKSPACE CONFIGURATION — Characters with ExecStartPre
//     must have corresponding workspace directories
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('Workspace Configuration', () => {
  const servicesWithWorkspaceCopy = serviceFiles.filter((s) =>
    (s.service['ExecStartPre'] ?? []).some((cmd) => cmd.includes('workspace/characters/')),
  );

  for (const svc of servicesWithWorkspaceCopy) {
    const wsCmd = svc.service['ExecStartPre']!.find((cmd) => cmd.includes('workspace/characters/'));
    const charMatch = wsCmd?.match(/workspace\/characters\/([a-z-]+)/);
    if (!charMatch) continue;
    const charId = charMatch[1];

    it(`${svc.name}: workspace/characters/${charId}/ directory exists`, () => {
      const wsPath = join(WORKSPACE_DIR, 'characters', charId);
      expect(existsSync(wsPath), `${wsPath} does not exist — ExecStartPre will silently fail`).toBe(true);
    });

    it(`${svc.name}: workspace/characters/${charId}/SOUL.md exists`, () => {
      const soulPath = join(WORKSPACE_DIR, 'characters', charId, 'SOUL.md');
      expect(existsSync(soulPath), `${soulPath} missing — character has no personality`).toBe(true);
    });
  }
});

// ─────────────────────────────────────────────────────────
// 13. CHARACTER ID CONSISTENCY — LAIN_CHARACTER_ID env var
//     or CLI command must identify the character correctly.
//     Some services set LAIN_CHARACTER_ID explicitly, others
//     use the CLI command name (e.g. "pkd" → node dist/index.js pkd)
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('Character ID Consistency', () => {
  for (const [svcName, charId] of Object.entries(SERVICE_CHARACTER_MAP)) {
    it(`${svcName}: identifies as "${charId}" via env var or CLI command`, () => {
      const svc = serviceFiles.find((s) => s.name === svcName);
      expect(svc, `${svcName} service file not found`).toBeDefined();
      const env = getServiceEnv(svc!);
      const execStart = svc!.service['ExecStart']?.[0] ?? '';

      // Character ID can be set via env var OR inferred from CLI command
      const envCharId = env['LAIN_CHARACTER_ID'];
      // CLI command is the word after "dist/index.js" (e.g. "web", "pkd", "dr-claude")
      const cliCommand = execStart.match(/dist\/index\.js\s+(\S+)/)?.[1];

      if (envCharId) {
        expect(envCharId).toBe(charId);
      } else {
        // CLI command name should match the character ID
        expect(cliCommand, `${svcName} has no LAIN_CHARACTER_ID and CLI command doesn't match`).toBe(charId);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────
// 14. CHARACTER SERVERS — Must have provider config
//     (PKD, McKenna, John, Hiru)
// ─────────────────────────────────────────────────────────
describe.skipIf(!hasCharacterServices)('Character Server Provider Config', () => {
  const characters = ['lain-pkd', 'lain-mckenna', 'lain-john', 'lain-hiru'];

  it.each(characters)(
    '%s: has CHARACTER_PROVIDER set',
    (svcName) => {
      const svc = serviceFiles.find((s) => s.name === svcName);
      const env = getServiceEnv(svc!);
      expect(env['CHARACTER_PROVIDER']).toBeDefined();
    },
  );

  it.each(characters)(
    '%s: has CHARACTER_MODEL set',
    (svcName) => {
      const svc = serviceFiles.find((s) => s.name === svcName);
      const env = getServiceEnv(svc!);
      expect(env['CHARACTER_MODEL'], `${svcName} missing CHARACTER_MODEL`).toBeDefined();
    },
  );

  it.each(characters)(
    '%s: has CHARACTER_API_KEY_ENV set',
    (svcName) => {
      const svc = serviceFiles.find((s) => s.name === svcName);
      const env = getServiceEnv(svc!);
      expect(env['CHARACTER_API_KEY_ENV']).toBeDefined();
    },
  );

  it.each(characters)(
    '%s: has WIRED_LAIN_URL pointing to Wired Lain port',
    (svcName) => {
      const svc = serviceFiles.find((s) => s.name === svcName);
      const env = getServiceEnv(svc!);
      expect(env['WIRED_LAIN_URL']).toContain(`:${EXPECTED_PORTS['lain-wired']}`);
    },
  );
});

// ─────────────────────────────────────────────────────────
// 15. HEALTHCHECK SYSTEM — Auto-fix script and timer exist
// ─────────────────────────────────────────────────────────
describe('Healthcheck System', () => {
  it('healthcheck.sh exists and is a bash script', () => {
    const path = join(ROOT, 'deploy', 'healthcheck.sh');
    expect(existsSync(path), 'deploy/healthcheck.sh missing').toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toMatch(/^#!/);
    expect(content).toContain('--fix');
  });

  it('healthcheck.sh checks all daemon services', () => {
    const content = readFileSync(join(ROOT, 'deploy', 'healthcheck.sh'), 'utf-8');
    for (const svc of serviceFiles) {
      // healthcheck only monitors Node.js daemon services, not itself or external services
      if (ONESHOT_SERVICES.includes(svc.name) || svc.name === 'lain-voice') continue;
      expect(content, `healthcheck.sh doesn't check ${svc.name}`).toContain(svc.name);
    }
  });

  it('healthcheck timer unit file exists', () => {
    const path = join(SYSTEMD_DIR, 'lain-healthcheck.timer');
    expect(existsSync(path), 'lain-healthcheck.timer missing').toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('OnUnitActiveSec=');
  });

  it('healthcheck service unit file exists', () => {
    const path = join(SYSTEMD_DIR, 'lain-healthcheck.service');
    expect(existsSync(path), 'lain-healthcheck.service missing').toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('healthcheck.sh');
    expect(content).toContain('--fix');
  });

  it('setup-systemd.sh installs the healthcheck timer', () => {
    const content = readFileSync(join(ROOT, 'deploy', 'setup-systemd.sh'), 'utf-8');
    expect(content).toContain('lain-healthcheck.timer');
  });
});

// ─────────────────────────────────────────────────────────
// 16. PRODUCTION HEALTH — Live service checks
//     Only runs when LAINTOWN_HOST is set (e.g. in CI or
//     manual check: LAINTOWN_HOST=198.211.116.5 npm test)
// ─────────────────────────────────────────────────────────
describe('Production Health', () => {
  const host = process.env['LAINTOWN_HOST'];

  const httpServices = Object.entries(EXPECTED_PORTS).filter(
    ([name]) => name !== 'lain-voice', // voice is Python, separate concern
  );

  if (!host) {
    it.skip('skipped — set LAINTOWN_HOST=<ip> to enable live checks', () => {});
    return;
  }

  it.each(httpServices)(
    '%s (port %d): responds to HTTP',
    async (svcName, port) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`http://${host}:${port}/`, {
          signal: controller.signal,
        });
        expect(
          res.status,
          `${svcName} returned HTTP ${res.status}`,
        ).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(500);
      } finally {
        clearTimeout(timeout);
      }
    },
    10000,
  );
});
