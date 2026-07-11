import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { WorkerManager, AlreadyRecordingError } from '../services/worker-manager';
import { RecorderPool, NoRecorderAvailableError } from '../services/recorder-pool';
import { adHocCallName } from '../services/call-naming';
import { hasRecordPermission } from '../services/record-permission-store';

export const recordCommand = {
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription('Start recording a voice channel')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to record')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Name for this ad hoc call (date is appended automatically)')
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }
    const canRecord =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      hasRecordPermission(interaction.guild.id, interaction.user.id);
    if (!canRecord) {
      await interaction.reply({
        content: '❌ You need Manage Server permission or explicit /record access from an admin.',
        ephemeral: true,
      });
      return;
    }

    const targetChannel = interaction.options.getChannel('channel');

    if (!targetChannel || (targetChannel.type !== ChannelType.GuildVoice && targetChannel.type !== ChannelType.GuildStageVoice)) {
      await interaction.reply({ content: '❌ Pick a voice or stage channel to record.', ephemeral: true });
      return;
    }
    if (!('guildId' in targetChannel) || targetChannel.guildId !== interaction.guild.id) {
      await interaction.reply({ content: '❌ That voice channel belongs to a different server.', ephemeral: true });
      return;
    }

    const manager = WorkerManager.getInstance();

    if (manager.isRecording(targetChannel.id)) {
      await interaction.reply({ content: `⚠️ Already recording <#${targetChannel.id}>.`, ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const nameOpt = interaction.options.getString('name');
      const callName = adHocCallName(nameOpt || 'Ad hoc');

      await manager.startRecording({
        guildId: interaction.guild.id,
        channelId: targetChannel.id,
        requesterId: interaction.user.id,
        textChannelId: interaction.channelId,
        callName,
      });

      await interaction.editReply(`🔴 Recording started for **${callName}** in <#${targetChannel.id}>. Use \`/stop\` to end.`);
    } catch (error) {
      if (error instanceof AlreadyRecordingError) {
        await interaction.editReply(`⚠️ Already recording <#${targetChannel.id}>.`);
        return;
      }
      if (error instanceof NoRecorderAvailableError) {
        const pool = RecorderPool.getInstance();
        const cap = pool.capacityForGuild(interaction.guild.id);
        await interaction.editReply(
          `⚠️ All ${cap} recorder bot(s) in this server are busy. Try again when a meeting ends.`
        );
        return;
      }
      console.error('[Command:/record] Failed to start recording:', error);
      await interaction.editReply('❌ Failed to start recording. Check the bot logs for details.');
    }
  },
};
