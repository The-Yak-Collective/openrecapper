import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ChannelType,
} from 'discord.js';
import { WorkerManager } from '../services/worker-manager';

export const stopCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop recording a voice channel')
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Voice channel to stop recording (defaults to your current channel)')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    const manager = WorkerManager.getInstance();

    // Resolve target channel: explicit option > user's voice channel > only active recording in guild
    let targetChannelId: string | null = null;

    const channelOption = interaction.options.getChannel('channel');
    if (channelOption) {
      targetChannelId = channelOption.id;
    } else if (member.voice.channel) {
      targetChannelId = member.voice.channel.id;
    } else {
      // Fall back: if there's exactly one active recording in this guild, use that
      const guildSessions = manager.getActiveSessions().filter(
        (s) => s.guildId === interaction.guild!.id
      );
      if (guildSessions.length === 1) {
        targetChannelId = guildSessions[0].channelId;
      } else if (guildSessions.length > 1) {
        const channelList = guildSessions.map((s) => `<#${s.channelId}>`).join(', ');
        await interaction.reply({
          content: `❌ Multiple active recordings in this server (${channelList}). Specify which channel to stop with \`/stop channel:\`.`,
          ephemeral: true,
        });
        return;
      }
    }

    if (!targetChannelId) {
      await interaction.reply({ content: '❌ No active recordings in this server. Specify a channel or join one.', ephemeral: true });
      return;
    }

    if (!manager.isRecording(targetChannelId)) {
      await interaction.reply({ content: `⚠️ Not recording <#${targetChannelId}>.`, ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await manager.stopRecording(targetChannelId);
      await interaction.editReply(
        `⏹️ Recording stopped in <#${targetChannelId}>. Transcribing ${result.fileCount} audio stream(s)... Results will be posted here.`
      );
    } catch (error: any) {
      await interaction.editReply(`❌ Failed to stop recording: ${error.message}`);
    }
  },
};
