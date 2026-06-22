import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  GuildMember,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { WorkerManager } from '../services/worker-manager';

export const stopCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop recording a voice channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '❌ You need Manage Server permission to stop recordings.', ephemeral: true });
      return;
    }

    const member = interaction.member as GuildMember;
    const manager = WorkerManager.getInstance();

    // Resolve target channel: explicit option > user's voice channel > only active recording in guild
    let targetChannelId: string | null = null;

    const channelOption = interaction.options.getChannel('channel');
    if (channelOption) {
      if ('guildId' in channelOption && channelOption.guildId !== interaction.guild.id) {
        await interaction.reply({ content: '❌ That voice channel belongs to a different server.', ephemeral: true });
        return;
      }
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
      await interaction.editReply(
        `⏹️ Recording stopped in <#${targetChannelId}>. Transcribing ${result.fileCount} audio stream(s)... Results will be posted here.`
      );
    } catch (error) {
      console.error('[Command:/stop] Failed to stop recording:', error);
      await interaction.editReply('❌ Failed to stop recording. Check the bot logs for details.');
    }
  },
};
