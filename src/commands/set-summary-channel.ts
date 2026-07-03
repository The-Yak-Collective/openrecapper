import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import {
  setSummaryChannel,
  clearSummaryChannel,
  getSummaryChannelForGuild,
} from '../services/summary-channel-store';

export const setSummaryChannelCommand = {
  data: new SlashCommandBuilder()
    .setName('set-summary-channel')
    .setDescription('Choose which text channel session summaries are posted in')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('set')
        .setDescription('Post all future summaries to a specific channel')
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Text channel to post summaries in')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('clear')
        .setDescription('Revert to default (post in the channel where /record ran)'),
    )
    .addSubcommand((sc) =>
      sc.setName('show').setDescription('Show the current summary channel setting'),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: '❌ You need Manage Server permission to change the summary channel.',
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      const { created } = setSummaryChannel(interaction.guildId, channel.id, interaction.user.id);
      await interaction.reply({
        content: created
          ? `✅ Summaries will now be posted in <#${channel.id}>.`
          : `✅ Updated: summaries will now be posted in <#${channel.id}>.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'clear') {
      const removed = clearSummaryChannel(interaction.guildId);
      await interaction.reply({
        content: removed
          ? '🗑️ Cleared. Summaries will post in the channel where /record is run (default).'
          : 'ℹ️ No summary channel was set; already using the default behaviour.',
        ephemeral: true,
      });
      return;
    }

    if (sub === 'show') {
      const channelId = getSummaryChannelForGuild(interaction.guildId);
      await interaction.reply({
        content: channelId
          ? `📌 Summaries are posted in <#${channelId}>.`
          : 'ℹ️ No override set — summaries post in the channel where /record is run (default).',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({ content: '❌ Unknown subcommand.', ephemeral: true });
  },
};
