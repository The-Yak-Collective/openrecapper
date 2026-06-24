import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  User,
} from 'discord.js';
import {
  getRecordPermissionGrantsForGuild,
  grantRecordPermission,
  revokeRecordPermission,
} from '../services/record-permission-store';

export const recordAccessCommand = {
  data: new SlashCommandBuilder()
    .setName('record-access')
    .setDescription('Manage who can use /record without Manage Server permission')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) =>
      sc
        .setName('grant')
        .setDescription('Allow a user to start recordings with /record')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('User to grant /record access')
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('revoke')
        .setDescription('Remove a user\'s /record access')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('User to revoke /record access from')
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) => sc.setName('list').setDescription('List users who can use /record')),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: '❌ You need Manage Server permission to manage /record access.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'grant') {
      const user = interaction.options.getUser('user', true);
      if (user.bot) {
        await interaction.reply({ content: '❌ Bot users do not need /record access.', ephemeral: true });
        return;
      }

      const { created } = grantRecordPermission(interaction.guildId, user.id, interaction.user.id);
      await interaction.reply({
        content: created
          ? `✅ Granted /record access to ${user}.`
          : `ℹ️ ${user} already has /record access.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'revoke') {
      const user = interaction.options.getUser('user', true);
      const removed = revokeRecordPermission(interaction.guildId, user.id);
      await interaction.reply({
        content: removed
          ? `🗑️ Revoked /record access from ${user}.`
          : `ℹ️ ${user} did not have explicit /record access.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'list') {
      const list = getRecordPermissionGrantsForGuild(interaction.guildId);
      if (list.length === 0) {
        await interaction.reply({
          content: '🎙️ No extra /record users configured. Users with Manage Server can still record.',
          ephemeral: true,
        });
        return;
      }

      const usersById = new Map<string, User>();
      for (const user of interaction.options.resolved?.users?.values() ?? []) {
        usersById.set(user.id, user);
      }
      const lines = list.map((grant, i) => {
        const user = usersById.get(grant.userId);
        const who = user ? `${user}` : `<@${grant.userId}>`;
        return `**${i + 1}.** ${who} — granted <t:${Math.floor(Date.parse(grant.grantedAt) / 1000)}:R>`;
      });

      await interaction.reply({
        content: `🎙️ **/record access** (${list.length}):\n${lines.join('\n')}`,
        ephemeral: true,
      });
      return;
    }
  },
};
