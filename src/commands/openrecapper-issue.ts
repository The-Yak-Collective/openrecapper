import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import { Config } from '../config';
import { GithubIssueClient } from '../services/github-issue-client';
import { IssueDraftService, IssueType } from '../services/issue-draft-service';
import { RelayClient } from '../services/relay-client';
import { hasRecordPermission } from '../services/record-permission-store';

// Simple in-memory per-user rate limit: at most MAX_PER_WINDOW issues per user
// within WINDOW_MS. Resets on process restart; good enough to blunt spam bursts.
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 5;
const recentByUser = new Map<string, number[]>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const hits = (recentByUser.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    recentByUser.set(userId, hits);
    return true;
  }
  hits.push(now);
  recentByUser.set(userId, hits);
  return false;
}

const TYPE_LABELS: Record<IssueType, string> = { bug: 'bug', feature: 'enhancement', task: 'task' };
const TYPE_COLORS: Record<IssueType, number> = { bug: 0xd7263d, feature: 0x2ecc71, task: 0x5865f2 };

function parseRecipients(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const openrecapperIssueCommand = {
  data: new SlashCommandBuilder()
    .setName('openrecapper-issue')
    .setDescription('Describe a bug, feature, or idea — it gets filed as a GitHub issue (posted publicly here)')
    .addStringOption((option) =>
      option
        .setName('text')
        .setDescription('Describe the feature, bug, or idea in your own words')
        .setRequired(true)
        .setMaxLength(4000),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }

    const canFile =
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
      hasRecordPermission(interaction.guild.id, interaction.user.id);
    if (!canFile) {
      await interaction.reply({
        content: '❌ You need Manage Server permission or explicit /record access from an admin to file issues.',
        ephemeral: true,
      });
      return;
    }

    if (!GithubIssueClient.isConfigured()) {
      await interaction.reply({ content: '⚠️ Issue filing isn\'t configured on this bot.', ephemeral: true });
      return;
    }

    if (rateLimited(interaction.user.id)) {
      await interaction.reply({
        content: `⚠️ You've filed several issues recently. Please wait a bit before filing another.`,
        ephemeral: true,
      });
      return;
    }

    const text = interaction.options.getString('text', true);

    // The issue and the confirmation are posted publicly in this channel.
    // Defer ephemerally so that if anything fails the error stays private. On
    // success we post the issue publicly via a follow-up message.
    await interaction.deferReply({ ephemeral: true });

    try {
      const draft = await IssueDraftService.draft(text);

      const footer =
        `\n\n---\n_Filed from Discord by <@${interaction.user.id}> in <#${interaction.channelId}>._`;

      const { url, number } = await GithubIssueClient.createIssue({
        title: draft.title,
        body: draft.body + footer,
        labels: [TYPE_LABELS[draft.type]],
      });

      // Best-effort email notification; never fails the command.
      const emailWarning = await this.notifyByEmail(interaction, draft.title, draft.body, url, number);

      const notes: string[] = [];
      if (draft.fallback) {
        notes.push('ℹ️ AI drafting was unavailable, so this used your text as-is — feel free to tidy it on GitHub.');
      }
      if (emailWarning) notes.push(emailWarning);

      // Embed descriptions cap at 4096 chars.
      const MAX_DESC = 4000;
      let description = draft.body;
      if (description.length > MAX_DESC) {
        description = description.slice(0, MAX_DESC) + `\n\n…(full text on GitHub)`;
      }

      const embed = new EmbedBuilder()
        .setColor(TYPE_COLORS[draft.type])
        .setTitle(`#${number} · ${draft.title}`.slice(0, 256))
        .setURL(url)
        .setDescription(description)
        .setFooter({
          text: `${draft.type} · filed by ${interaction.user.username}`,
        });

      const content =
        `📝 <@${interaction.user.id}> filed issue **#${number}** — ${url}\n` +
        `✏️ Not quite right? Edit it on GitHub via the link above.` +
        (notes.length ? `\n\n${notes.join('\n')}` : '');

      // Public post in the channel (the deferred reply is ephemeral).
      await interaction.followUp({ content, embeds: [embed] });
      // Close out the ephemeral "thinking" state privately.
      await interaction.editReply(`✅ Filed issue #${number} — posted in this channel.`);
    } catch (error) {
      console.error('[Command:/openrecapper-issue] Failed to create issue:', error);
      // Ephemeral: the deferred reply was ephemeral, so this stays private.
      await interaction.editReply('❌ Failed to file the issue. Check the bot logs for details.');
    }
  },

  /**
   * Email ISSUE_EMAIL_TO recipients about a new issue. Best-effort: returns a
   * warning string to surface in the reply on failure, or '' on success/skip.
   */
  async notifyByEmail(
    interaction: ChatInputCommandInteraction,
    title: string,
    body: string,
    url: string,
    number: number,
  ): Promise<string> {
    const recipients = parseRecipients(Config.ISSUE_EMAIL_TO);
    if (recipients.length === 0 || !RelayClient.isConfigured()) return '';

    const channelName =
      interaction.channel && 'name' in interaction.channel ? `#${(interaction.channel as any).name}` : 'a channel';
    const subject = `[${Config.BOT_NAME}] New issue #${number}: ${title}`;
    const emailBody = [
      `A new issue was filed from Discord.`,
      ``,
      `#${number} ${title}`,
      url,
      ``,
      `Filed by @${interaction.user.username} in ${channelName} (guild ${interaction.guildId}).`,
      ``,
      `---`,
      body,
    ].join('\n');

    let anyFailed = false;
    for (const to of recipients) {
      try {
        await RelayClient.email(to, subject, emailBody);
      } catch (err) {
        anyFailed = true;
        console.error(`[Command:/openrecapper-issue] Failed to email ${to}:`, err);
      }
    }
    return anyFailed ? '⚠️ Issue created, but at least one email notification failed.' : '';
  },
};
