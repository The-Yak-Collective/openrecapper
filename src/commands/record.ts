import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { WorkerManager } from '../services/worker-manager';
import { adHocCallName } from '../services/call-naming';

export const recordCommand = {
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription('Start recording the voice channel you are in')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to record (defaults to your current channel)')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false)
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
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '❌ You need Manage Server permission to start recordings.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    const targetChannel = interaction.options.getChannel('channel') ?? member.voice.channel;

    if (!targetChannel || (targetChannel.type !== ChannelType.GuildVoice && targetChannel.type !== ChannelType.GuildStageVoice)) {
      await interaction.reply({ content: '❌ Join a voice channel first, or specify one.', ephemeral: true });
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
      console.error('[Command:/record] Failed to start recording:', error);
      await interaction.editReply('❌ Failed to start recording. Check the bot logs for details.');
    }
  },
};
