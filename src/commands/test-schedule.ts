import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { triggerScheduledRecording } from '../services/scheduler';
import { getSchedule, getSchedulesForGuild } from '../services/schedule-store';
import { respondScheduleAutocomplete } from './schedule';

export const testScheduleCommand = {
  data: new SlashCommandBuilder()
    .setName('test-schedule')
    .setDescription('Manually trigger a scheduled recording (for testing)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName('schedule')
        .setDescription('Which schedule to fire (default: the only one in this server)')
        .setRequired(false)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    await respondScheduleAutocomplete(interaction);
  },

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '❌ You need Manage Server permission to trigger schedules.', ephemeral: true });
      return;
    }

    // Resolve the target schedule: explicit option > the guild's only schedule.
    let scheduleId = interaction.options.getString('schedule') || '';
    if (scheduleId) {
      const s = getSchedule(scheduleId);
      if (!s || s.guildId !== interaction.guildId) {
        await interaction.reply({ content: '❌ Schedule not found in this server.', ephemeral: true });
        return;
      }
    } else {
      const guildSchedules = getSchedulesForGuild(interaction.guildId);
      if (guildSchedules.length === 0) {
        await interaction.reply({
          content: '❌ No schedules configured. Add one with `/schedule add`.',
          ephemeral: true,
        });
        return;
      }
      if (guildSchedules.length > 1) {
        await interaction.reply({
          content: '❌ Multiple schedules exist — pick one with the `schedule:` option.',
          ephemeral: true,
        });
        return;
      }
      scheduleId = guildSchedules[0].id;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await triggerScheduledRecording(scheduleId);
      await interaction.editReply(`✅ ${result}`);
    } catch (error) {
      console.error('[Command:/test-schedule] Failed to trigger scheduled recording:', error);
      await interaction.editReply('❌ Failed to trigger scheduled recording. Check the bot logs for details.');
    }
  },
};
