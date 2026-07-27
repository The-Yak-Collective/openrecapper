import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { WorkerManager } from '../services/worker-manager';
import { RecorderPool } from '../services/recorder-pool';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show active recording sessions'),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }

    const manager = WorkerManager.getInstance();
    const sessions = manager.getActiveSessions().filter((s) => s.guildId === interaction.guildId);
    const pool = RecorderPool.getInstance();

    if (sessions.length === 0) {
      await interaction.reply({
        content: `📭 No active recording sessions (${pool.capacityForGuild(interaction.guildId)} recorder(s) available).`,
        ephemeral: true,
      });
      return;
    }

    const lines = sessions.map((s) => {
      const duration = Math.round((Date.now() - s.startedAt) / 1000);
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      return `🔴 <#${s.channelId}> — ${mins}m ${secs}s — ${s.speakerCount} speaker(s) — 🎙️ ${s.recorderLabel}`;
    });

    const header = `**Active Sessions** (${pool.inUseForGuild(interaction.guildId)}/${pool.capacityForGuild(interaction.guildId)} recorders in use):`;
    await interaction.reply({ content: `${header}\n${lines.join('\n')}`, ephemeral: true });
  },
};
