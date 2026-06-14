import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { getRoutes, loadGrapevineConfig, getConfigPath } from '../services/grapevine-service';

export const grapevineCommand = {
  data: new SlashCommandBuilder()
    .setName('grapevine')
    .setDescription('Manage cross-server reaction forwarding (grapevine) routes')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => sc.setName('list').setDescription('List configured grapevine routes'))
    .addSubcommand((sc) => sc.setName('reload').setDescription('Reload grapevine-routes.json from disk')),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'reload') {
      const { routes, path } = loadGrapevineConfig();
      await interaction.reply({
        content: `🔄 Reloaded \`${path}\` — ${routes.length} route(s) active.`,
        ephemeral: true,
      });
      return;
    }

    const routes = getRoutes();
    if (routes.length === 0) {
      await interaction.reply({
        content:
          `🍇 No grapevine routes configured.\n` +
          `Create \`${getConfigPath() || 'grapevine-routes.json'}\` with a \`{ "routes": [...] }\` block, then run \`/grapevine reload\`.`,
        ephemeral: true,
      });
      return;
    }

    const lines = routes.map((r, i) => {
      const where = r.sourceChannelId ? `<#${r.sourceChannelId}>` : `(any channel in guild \`${r.sourceGuildId}\`)`;
      let hookHost = 'webhook';
      try { hookHost = new URL(r.destinationWebhookUrl).host; } catch {}
      const extras: string[] = [];
      if (r.threshold && r.threshold > 1) extras.push(`threshold ${r.threshold}`);
      if (r.allowedRoleIds?.length) extras.push('role-gated');
      const suffix = extras.length ? ` _(${extras.join(', ')})_` : '';
      return `**${i + 1}.** ${r.label || '(unlabeled)'}\n   • React ${r.emoji} on ${where} → ${hookHost}${suffix}`;
    });

    await interaction.reply({
      content: `🍇 **Grapevine routes** (${routes.length}):\n${lines.join('\n')}`,
      ephemeral: true,
    });
  },
};
