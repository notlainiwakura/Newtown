/**
 * Dr. Claude command — Start the diagnostic web interface
 */

import { startDoctorServer } from '../../web/doctor-server.js';
import { displayError } from '../utils/prompts.js';

export async function startDrClaude(port: number = 3002): Promise<void> {
  try {
    await startDoctorServer(port);
  } catch (error) {
    displayError(`Failed to start Dr. Claude server: ${error}`);
    process.exit(1);
  }
}
