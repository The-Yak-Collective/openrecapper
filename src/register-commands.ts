import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { Config, validateConfig } from './config';
import { recordCommand } from './commands/record';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { testScheduleCommand } from './commands/test-schedule';
import { grapevineCommand } from './commands/grapevine';
import { scheduleCommand } from './commands/schedule';
import { recordAccessCommand } from './commands/record-access';
import { setSummaryChannelCommand } from './commands/set-summary-channel';

validateConfig();

const commands = [
  recordCommand.data.toJSON(),
  stopCommand.data.toJSON(),
  statusCommand.data.toJSON(),
  testScheduleCommand.data.toJSON(),
  grapevineCommand.data.toJSON(),
  scheduleCommand.data.toJSON(),
  recordAccessCommand.data.toJSON(),
  setSummaryChannelCommand.data.toJSON(),
];

const rest = new REST({ version: '10' }).setToken(Config.DISCORD_TOKEN);

// Optional: a guild id whose stale per-guild commands should be cleared.
// Per-guild commands are shown ADDITIVELY with global ones in Discord, which
// causes every overlapping command to appear duplicated. We only ever register
// globally, so make sure no leftover guild-scoped copies linger.
const CLEAR_GUILD_ID = process.env.CLEAR_GUILD_COMMANDS_ID || process.env.SCHEDULED_GUILD_ID || '';

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands...`);
    await rest.put(
      Routes.applicationCommands(Config.DISCORD_CLIENT_ID),
      { body: commands },
    );
    console.log('✅ Slash commands registered globally.');

    if (CLEAR_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(Config.DISCORD_CLIENT_ID, CLEAR_GUILD_ID),
        { body: [] },
      );
      console.log(`🧹 Cleared stale guild-scoped commands for guild ${CLEAR_GUILD_ID}.`);
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();
