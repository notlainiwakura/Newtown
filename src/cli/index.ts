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
  .description('A three-resident town template for self-hosted AI spaces')
  .version('0.1.0');

program
  .command('onboard')
  .description('Interactive setup wizard')
  .action(onboard);

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

program
  .command('status')
  .description('Check gateway and system status')
  .action(status);

program
  .command('doctor')
  .description('Diagnose local issues')
  .action(doctor);

program
  .command('chat')
  .description('Interactive chat mode')
  .action(chat);

program
  .command('send <message>')
  .description('Send a single message')
  .action(sendMessage);

program
  .command('configure')
  .description('Reconfigure Newtown')
  .action(onboard);

program
  .command('web')
  .description('Start the web interface')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (options) => {
    await startWeb(parseInt(options.port, 10));
  });

program
  .command('telegram')
  .description('Start the Telegram bot')
  .action(async () => {
    await startTelegram();
  });

program
  .command('neo')
  .description('Start the Neo resident server')
  .option('-p, --port <port>', 'Port to listen on', '3003')
  .action(async (options) => {
    await startCharacter('neo', parseInt(options.port, 10));
  });

program
  .command('plato')
  .description('Start the Plato resident server')
  .option('-p, --port <port>', 'Port to listen on', '3004')
  .action(async (options) => {
    await startCharacter('plato', parseInt(options.port, 10));
  });

program
  .command('joe')
  .description('Start the Joe resident server')
  .option('-p, --port <port>', 'Port to listen on', '3005')
  .action(async (options) => {
    await startCharacter('joe', parseInt(options.port, 10));
  });

export { program };

export async function run(): Promise<void> {
  await program.parseAsync(process.argv);
}
