import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { triggerScheduledRecording } from '../services/scheduler';

export const testScheduleCommand = {
  data: new SlashCommandBuilder()
    .setName('test-schedule')
    .setDescription('Manually trigger the scheduled recording (for testing)'),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await triggerScheduledRecording();
      await interaction.editReply(`✅ ${result}`);
    } catch (error: any) {
      await interaction.editReply(`❌ Failed to trigger scheduled recording: ${error.message}`);
    }
  },
};
