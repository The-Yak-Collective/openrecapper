import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { WorkerManager } from '../services/worker-manager';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show active recording sessions'),

  async execute(interaction: ChatInputCommandInteraction) {
    const manager = WorkerManager.getInstance();
    const sessions = manager.getActiveSessions();

    if (sessions.length === 0) {
      await interaction.reply({ content: '📭 No active recording sessions.', ephemeral: true });
      return;
    }

    const lines = sessions.map((s) => {
      const duration = Math.round((Date.now() - s.startedAt) / 1000);
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      return `🔴 <#${s.channelId}> — ${mins}m ${secs}s — ${s.speakerCount} speaker(s)`;
    });

    await interaction.reply({ content: `**Active Sessions:**\n${lines.join('\n')}`, ephemeral: true });
  },
};
