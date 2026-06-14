import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { Config, validateConfig } from './config';
import { recordCommand } from './commands/record';
import { stopCommand } from './commands/stop';
import { statusCommand } from './commands/status';
import { testScheduleCommand } from './commands/test-schedule';
import { grapevineCommand } from './commands/grapevine';

validateConfig();

const commands = [
  recordCommand.data.toJSON(),
  stopCommand.data.toJSON(),
  statusCommand.data.toJSON(),
  testScheduleCommand.data.toJSON(),
  grapevineCommand.data.toJSON(),
];

const rest = new REST({ version: '10' }).setToken(Config.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} slash commands...`);
    await rest.put(
      Routes.applicationCommands(Config.DISCORD_CLIENT_ID),
      { body: commands },
    );
    console.log('✅ Slash commands registered globally.');
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
})();
