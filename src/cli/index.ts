/**
 * CLI entry point using Commander
 */

import { Command } from 'commander';
import { onboard } from './commands/onboard.js';
import { startGateway, startDaemon, stopGateway } from './commands/gateway.js';
import { status } from './commands/status.js';
import { doctor } from './commands/doctor.js';
import { chat, sendMessage } from './commands/chat.js';
import { startWeb } from './commands/web.js';
import { startTelegram } from './commands/telegram.js';
import { startCharacter } from './commands/character.js';

const program = new Command();

program
  .name('newtown')
  .description('A local-first multi-resident town')
  .version('0.1.0');

// Onboard command
program
  .command('onboard')
  .description('Interactive setup wizard')
  .action(onboard);

// Gateway commands
const gatewayCmd = program
  .command('gateway')
  .description('Start the gateway server')
  .option('-d, --daemon', 'Run as daemon')
  .action(async (options) => {
    if (options.daemon) {
      await startDaemon();
    } else {
      await startGateway();
    }
  });

gatewayCmd
  .command('stop')
  .description('Stop the gateway daemon')
  .action(stopGateway);

// Status command
program
  .command('status')
  .description('Check gateway and system status')
  .action(status);

// Doctor command
program
  .command('doctor')
  .description('Diagnose issues')
  .action(doctor);

// Chat command
program
  .command('chat')
  .description('Interactive chat mode')
  .action(chat);

// Send command
program
  .command('send <message>')
  .description('Send a single message')
  .action(sendMessage);

// Configure command (alias for onboard)
program
  .command('configure')
  .description('Reconfigure Newtown')
  .action(onboard);

// Web command
program
  .command('web')
  .description('Start the web interface')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (options) => {
    await startWeb(parseInt(options.port, 10));
  });

// Telegram command
program
  .command('telegram')
  .description('Start the Telegram bot')
  .action(async () => {
    await startTelegram();
  });

// Character commands
program
  .command('neo')
  .description('Start the Neo character server')
  .option('-p, --port <port>', 'Port to listen on', '3003')
  .action(async (options) => {
    await startCharacter('neo', parseInt(options.port, 10));
  });

program
  .command('plato')
  .description('Start the Plato character server')
  .option('-p, --port <port>', 'Port to listen on', '3004')
  .action(async (options) => {
    await startCharacter('plato', parseInt(options.port, 10));
  });

program
  .command('joe')
  .description('Start the Joe character server (possessable)')
  .option('-p, --port <port>', 'Port to listen on', '3005')
  .action(async (options) => {
    await startCharacter('joe', parseInt(options.port, 10));
  });

export { program };

export async function run(): Promise<void> {
  await program.parseAsync(process.argv);
}
