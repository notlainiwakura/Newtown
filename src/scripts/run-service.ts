import 'dotenv/config';
import { startGateway } from '../cli/commands/gateway.js';
import { startWeb } from '../cli/commands/web.js';
import { startJoe, startNeo, startPlato } from '../cli/commands/character.js';

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const port = parseInt(raw, 10);
  return Number.isFinite(port) ? port : fallback;
}

async function main(): Promise<void> {
  const [service, portArg] = process.argv.slice(2);

  switch (service) {
    case 'web':
      await startWeb(parsePort(portArg, 3000));
      return;
    case 'gateway':
      await startGateway();
      return;
    case 'neo':
      await startNeo(parsePort(portArg, 3003));
      return;
    case 'plato':
      await startPlato(parsePort(portArg, 3004));
      return;
    case 'joe':
      await startJoe(parsePort(portArg, 3005));
      return;
    default:
      throw new Error(`Unknown service: ${service ?? '(missing)'}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
