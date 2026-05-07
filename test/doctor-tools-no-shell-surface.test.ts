/**
 * Canary: Dr. Claude must not expose shell-execution or file-modification
 * tools to the LLM.
 *
 * Context: audit finding P0-latent (docs/audit/findings.md:1535 `run_command`
 * substring blocklist → RCE; P1 `edit_file` self-modification; P1
 * `run_diagnostic_tests` shell-injects section). Production evidence from
 * 2026-02-05 → 2026-04-20 shows zero invocations of any of the three across
 * every character's tool-call log. Removed rather than neutered. This test
 * prevents silent re-addition.
 */
import { describe, it, expect } from 'vitest';
import { getDoctorToolDefinitions } from '../src/agent/doctor-tools.js';

const FORBIDDEN = ['run_command', 'run_diagnostic_tests', 'edit_file'] as const;

describe('doctor-tools — shell/edit surface removed', () => {
  for (const name of FORBIDDEN) {
    it(`does not expose ${name}`, () => {
      const names = getDoctorToolDefinitions().map((t) => t.name);
      expect(names).not.toContain(name);
    });
  }
});
