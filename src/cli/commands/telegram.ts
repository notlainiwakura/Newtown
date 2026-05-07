/**
 * Telegram bot command - starts two-way Telegram integration
 */

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { TelegramChannel, type TelegramConfig } from '../../channels/telegram.js';
import { initAgent, processMessage } from '../../agent/index.js';
import { initDatabase } from '../../storage/database.js';
import { getPaths } from '../../config/index.js';
import { getDefaultConfig } from '../../config/defaults.js';
import { getAllCharacters, getAgentConfigFor } from '../../config/characters.js';
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

  // findings.md P2:125 — hard-coded `'default'` used to match only the
  // default-config id; lain.json5 overrides silently misrouted messages.
  // findings.md P2:171 — after config.agents[] was removed, Telegram
  // resolves the character from characters.json:
  //   1. `LAIN_TELEGRAM_AGENT_ID` env var (explicit override)
  //   2. First character in the manifest
  const agentId = process.env['LAIN_TELEGRAM_AGENT_ID'] ?? getAllCharacters()[0]?.id;
  if (!agentId) {
    console.error(
      'Error: no characters configured (characters.json is empty and LAIN_TELEGRAM_AGENT_ID is unset)',
    );
    process.exit(1);
  }

  console.log('Initializing agent...');
  await initAgent(getAgentConfigFor(agentId));

  // Create Telegram channel config
  const telegramConfig: TelegramConfig = {
    id: 'telegram-main',
    type: 'telegram',
    enabled: true,
    agentId,
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
        // findings.md P2:307 — previously this used processMessageStream and
        // concatenated chunks into a string before sending. Telegram has no
        // incremental-send path wired up here, so the stream callback was
        // pure buffering: users saw nothing until generation finished, and
        // the agent's already-shaped OutgoingMessage list was thrown away
        // in favour of a single text concatenation. Switch to processMessage
        // and forward the agent's messages directly — same latency, simpler
        // code, preserves non-text messages if the agent ever produces them.
        const agentResponse = await processMessage({
          sessionKey,
          message,
        });

        let sentCount = 0;
        let textLength = 0;
        for (const out of agentResponse.messages) {
          // Rebind the outbound peerId/channel to this Telegram chat. The
          // agent populates these with its own defaults which don't know
          // which channel delivered the inbound message.
          const outgoing: OutgoingMessage = {
            ...out,
            id: out.id ?? nanoid(16),
            channel: 'telegram',
            peerId: message.peerId,
          };
          if (outgoing.content.type === 'text') {
            const text = (outgoing.content as TextContent).text;
            if (!text.trim()) continue;
            textLength += text.length;
          }
          await channel.send(outgoing);
          sentCount++;
        }

        if (sentCount > 0) {
          logger.info(
            { chatId: message.peerId, sentCount, textLength },
            'Response sent',
          );
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
