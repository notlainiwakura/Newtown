/**
 * Telegram bot command - starts two-way Telegram integration
 */

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { TelegramChannel, type TelegramConfig } from '../../channels/telegram.js';
import { initAgent, processMessageStream } from '../../agent/index.js';
import { initDatabase } from '../../storage/database.js';
import { getPaths } from '../../config/index.js';
import { getDefaultConfig } from '../../config/defaults.js';
import { getLogger } from '../../utils/logger.js';
import type { IncomingMessage, OutgoingMessage, TextContent } from '../../types/message.js';

export async function startTelegram(): Promise<void> {
  const logger = getLogger();
  const paths = getPaths();
  const config = getDefaultConfig();

  // Check for required environment variables
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  const allowedChatId = process.env['TELEGRAM_CHAT_ID'];

  if (!botToken) {
    console.error('Error: TELEGRAM_BOT_TOKEN not set in environment');
    console.error('Get a token from @BotFather on Telegram');
    process.exit(1);
  }

  if (!allowedChatId) {
    console.error('Error: TELEGRAM_CHAT_ID not set in environment');
    console.error('This is your Telegram user ID - get it from @userinfobot');
    process.exit(1);
  }

  console.log('Initializing database...');
  await initDatabase(paths.database, config.security.keyDerivation);

  console.log('Initializing agent...');
  for (const agentConfig of config.agents) {
    await initAgent(agentConfig);
  }

  // Create Telegram channel config
  const telegramConfig: TelegramConfig = {
    id: 'telegram-main',
    type: 'telegram',
    enabled: true,
    agentId: 'default',
    token: botToken,
    allowedUsers: [allowedChatId], // Only allow messages from the configured user
  };

  const channel = new TelegramChannel(telegramConfig);

  // Track sessions by chat ID
  const sessions = new Map<string, string>();

  // Set up event handlers
  channel.setEventHandlers({
    onMessage: async (message: IncomingMessage) => {
      logger.info({
        from: message.senderId,
        chatId: message.peerId,
        text: message.content.type === 'text' ? (message.content as TextContent).text : `[${message.content.type}]`
      }, 'Telegram message received');

      // Get or create session for this chat
      let sessionKey = sessions.get(message.peerId);
      if (!sessionKey) {
        sessionKey = `telegram:${message.peerId}:${nanoid(8)}`;
        sessions.set(message.peerId, sessionKey);
      }

      try {
        // Collect streamed response
        let fullResponse = '';

        await processMessageStream(
          {
            sessionKey,
            message,
          },
          (chunk: string) => {
            fullResponse += chunk;
          }
        );

        // Send the complete response
        if (fullResponse.trim()) {
          const outgoing: OutgoingMessage = {
            id: nanoid(16),
            channel: 'telegram',
            peerId: message.peerId,
            content: {
              type: 'text',
              text: fullResponse,
            },
          };

          await channel.send(outgoing);
          logger.info({ chatId: message.peerId, responseLength: fullResponse.length }, 'Response sent');
        }
      } catch (error) {
        logger.error({ error, chatId: message.peerId }, 'Error processing message');

        // Send error message
        const errorOutgoing: OutgoingMessage = {
          id: nanoid(16),
          channel: 'telegram',
          peerId: message.peerId,
          content: {
            type: 'text',
            text: '...something went wrong. try again.',
          },
        };
        await channel.send(errorOutgoing);
      }
    },

    onError: (error: Error) => {
      logger.error({ error }, 'Telegram channel error');
    },

    onConnect: () => {
      console.log('\n╔════════════════════════════════════════════════════════════╗');
      console.log('║                                                            ║');
      console.log('║   ██╗      █████╗ ██╗███╗   ██╗                           ║');
      console.log('║   ██║     ██╔══██╗██║████╗  ██║                           ║');
      console.log('║   ██║     ███████║██║██╔██╗ ██║                           ║');
      console.log('║   ██║     ██╔══██║██║██║╚██╗██║                           ║');
      console.log('║   ███████╗██║  ██║██║██║ ╚████║                           ║');
      console.log('║   ╚══════╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝                           ║');
      console.log('║                                                            ║');
      console.log('║   ...present day, present time                             ║');
      console.log('║                                                            ║');
      console.log('║   Telegram bot connected                                   ║');
      console.log('║   Waiting for messages...                                  ║');
      console.log('║                                                            ║');
      console.log('╚════════════════════════════════════════════════════════════╝\n');
    },

    onDisconnect: () => {
      logger.info('Telegram bot disconnected');
    },
  });

  // Connect the channel
  await channel.connect();

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await channel.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process running
  await new Promise(() => {});
}
