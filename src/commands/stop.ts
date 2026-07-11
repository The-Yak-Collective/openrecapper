import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { WorkerManager } from '../services/worker-manager';
import { hasRecordPermission } from '../services/record-permission-store';
import { getSummaryChannelForGuild } from '../services/summary-channel-store';

export const stopCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop recording a voice channel')
    // No setDefaultMemberPermissions: Discord gates command *visibility* on this
    // static flag and cannot consult our per-user record grants. Mirror /record
    // (visible to all, enforced at runtime) so granted users can stop the
    // recordings they are allowed to start.
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to stop recording')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }
    const canStop =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      hasRecordPermission(interaction.guild.id, interaction.user.id);
    if (!canStop) {
      await interaction.reply({
        content: '❌ You need Manage Server permission or explicit /record access from an admin.',
        ephemeral: true,
      });
      return;
    }

    const manager = WorkerManager.getInstance();

    const channelOption = interaction.options.getChannel('channel', true);
    if ('guildId' in channelOption && channelOption.guildId !== interaction.guild.id) {
      await interaction.reply({ content: '❌ That voice channel belongs to a different server.', ephemeral: true });
      return;
    }
    const targetChannelId = channelOption.id;

    const session = manager.getSession(targetChannelId);
    if (!session) {
      await interaction.reply({ content: `⚠️ Not recording <#${targetChannelId}>.`, ephemeral: true });
      return;
    }
    if (session.guildId !== interaction.guild.id) {
      await interaction.reply({ content: '❌ That recording belongs to a different server.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await manager.stopRecording(targetChannelId);
      const summaryChannelId = getSummaryChannelForGuild(interaction.guild.id);
      const destination = summaryChannelId ? `in <#${summaryChannelId}>` : 'here';
      await interaction.editReply(
        `⏹️ Recording stopped in <#${targetChannelId}>. Transcribing ${result.fileCount} audio stream(s)... Results will be posted ${destination}.`
      );
    } catch (error) {
      console.error('[Command:/stop] Failed to stop recording:', error);
      await interaction.editReply('❌ Failed to stop recording. Check the bot logs for details.');
    }
  },
};
