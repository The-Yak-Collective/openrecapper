import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import {
  Schedule,
  getSchedule,
  getSchedulesForGuild,
} from '../services/schedule-store';
import {
  createSchedule,
  editSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
} from '../services/scheduler';
import {
  buildCron,
  buildOneOffCron,
  describeCron,
  parseSimpleCron,
  parseInterval,
  parseDays,
  parseTime,
  nextFireDate,
  dayLabel,
  DescribeOpts,
} from '../services/cron-format';

const DEFAULT_TIMEZONE = 'America/New_York';

/** Validate an IANA timezone string via the Intl API. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Describe-options derived from a schedule's interval/one-off fields. */
function opts(s: Schedule): DescribeOpts {
  return { intervalWeeks: s.intervalWeeks, anchor: s.anchor, oneOff: s.oneOff };
}

/** One-line description of a schedule for `/schedule list`. */
function describeSchedule(s: Schedule): string {
  const when = describeCron(s.cron, s.timezone, opts(s));
  const status = s.paused ? ' ⏸ **paused**' : '';
  const text = s.textChannelId ? `<#${s.textChannelId}>` : '⚠️ missing — edit text_channel before it can fire';
  return (
    `**${s.name}** \`${s.id}\` — ${when}${status}\n` +
    `   • voice <#${s.voiceChannelId}> → text ${text}`
  );
}

/** Short choice label for autocomplete (Discord caps option name at 100 chars). */
function autocompleteLabel(s: Schedule): string {
  const label = `${s.name} — ${describeCron(s.cron, s.timezone, opts(s))}${s.paused ? ' (paused)' : ''} [${s.id}]`;
  return label.length > 100 ? label.slice(0, 99) + '…' : label;
}

/**
 * Shared autocomplete responder for the `schedule:` option (id-valued).
 * Lists this guild's schedules, filtered by the typed substring.
 */
export async function respondScheduleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }
  const focused = (interaction.options.getFocused() || '').toString().toLowerCase();
  const matches = getSchedulesForGuild(interaction.guildId).filter((s) => {
    if (!focused) return true;
    const hay = `${s.name} ${s.id} ${describeCron(s.cron, s.timezone, opts(s))}`.toLowerCase();
    return hay.includes(focused);
  });
  await interaction.respond(
    matches.slice(0, 25).map((s) => ({ name: autocompleteLabel(s), value: s.id })),
  );
}

/** Resolve the `schedule:` option to a schedule owned by this guild, or null. */
function resolveGuildSchedule(interaction: ChatInputCommandInteraction): Schedule | null {
  const id = interaction.options.getString('schedule', true);
  const schedule = getSchedule(id);
  if (!schedule || schedule.guildId !== interaction.guildId) return null;
  return schedule;
}

export const scheduleCommand = {
  data: new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Manage standing-call auto-record schedules')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sc) => sc.setName('list').setDescription('List this server\'s schedules'))
    .addSubcommand((sc) =>
      sc
        .setName('add')
        .setDescription('Add a new standing-call schedule')
        .addChannelOption((o) =>
          o
            .setName('voice_channel')
            .setDescription('Voice channel to auto-join and record')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('time').setDescription('24-hour time HH:MM, e.g. 11:15').setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName('days')
            .setDescription('Weekdays for a recurring call, e.g. mon,fri (also: weekdays, daily). Omit if using date.')
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('date')
            .setDescription('One-off calendar date YYYY-MM-DD (fires once, then auto-deletes). Use instead of days.')
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('every')
            .setDescription('Recurrence cadence: weekly (default) or biweekly / "2 weeks". Ignored for one-off dates.')
            .setRequired(false)
            .addChoices(
              { name: 'weekly (every week)', value: 'weekly' },
              { name: 'biweekly (every 2 weeks)', value: 'biweekly' },
              { name: 'every 3 weeks', value: '3 weeks' },
              { name: 'every 4 weeks', value: '4 weeks' },
            ),
        )
        .addStringOption((o) =>
          o
            .setName('timezone')
            .setDescription(`IANA timezone (default ${DEFAULT_TIMEZONE})`)
            .setRequired(false),
        )
        .addChannelOption((o) =>
          o
            .setName('text_channel')
            .setDescription('Where to post live transcript and results (default: this channel)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName('name')
            .setDescription('Schedule name; also the call-name prefix (e.g. CADS, GS)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('edit')
        .setDescription('Edit an existing schedule (only the fields you provide change)')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to edit').setRequired(true).setAutocomplete(true),
        )
        .addChannelOption((o) =>
          o
            .setName('voice_channel')
            .setDescription('New voice channel')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(false),
        )
        .addStringOption((o) => o.setName('days').setDescription('New days, e.g. mon,fri (switches a one-off back to recurring)').setRequired(false))
        .addStringOption((o) => o.setName('date').setDescription('New one-off date YYYY-MM-DD (converts to a one-off)').setRequired(false))
        .addStringOption((o) => o.setName('time').setDescription('New time HH:MM').setRequired(false))
        .addStringOption((o) =>
          o
            .setName('every')
            .setDescription('New cadence: weekly / biweekly / "N weeks"')
            .setRequired(false)
            .addChoices(
              { name: 'weekly (every week)', value: 'weekly' },
              { name: 'biweekly (every 2 weeks)', value: 'biweekly' },
              { name: 'every 3 weeks', value: '3 weeks' },
              { name: 'every 4 weeks', value: '4 weeks' },
            ),
        )
        .addStringOption((o) => o.setName('timezone').setDescription('New IANA timezone').setRequired(false))
        .addChannelOption((o) =>
          o
            .setName('text_channel')
            .setDescription('New results channel')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(false)),
    )
    .addSubcommand((sc) =>
      sc
        .setName('remove')
        .setDescription('Delete a schedule')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to remove').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('pause')
        .setDescription('Pause a schedule (kept but inactive)')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to pause').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName('resume')
        .setDescription('Resume a paused schedule')
        .addStringOption((o) =>
          o.setName('schedule').setDescription('Schedule to resume').setRequired(true).setAutocomplete(true),
        ),
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    await respondScheduleAutocomplete(interaction);
  },

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ This command only works in servers.', ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const list = getSchedulesForGuild(interaction.guildId);
      if (list.length === 0) {
        await interaction.reply({
          content: '🗓️ No schedules configured. Add one with `/schedule add`.',
          ephemeral: true,
        });
        return;
      }
      const body = list.map(describeSchedule).join('\n');
      await interaction.reply({
        content: `🗓️ **Schedules** (${list.length}):\n${body}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'add') {
      const voice = interaction.options.getChannel('voice_channel', true);
      const days = interaction.options.getString('days');
      const date = interaction.options.getString('date');
      const time = interaction.options.getString('time', true);
      const everyRaw = interaction.options.getString('every');
      const timezone = interaction.options.getString('timezone') || DEFAULT_TIMEZONE;
      const text = interaction.options.getChannel('text_channel');
      let name = interaction.options.getString('name')?.trim() || '';

      if (!isValidTimezone(timezone)) {
        await interaction.reply({ content: `❌ Unknown timezone \`${timezone}\`.`, ephemeral: true });
        return;
      }

      // Exactly one of days / date must be provided.
      if (days && date) {
        await interaction.reply({
          content: '❌ Provide either `days` (recurring) **or** `date` (one-off), not both.',
          ephemeral: true,
        });
        return;
      }
      if (!days && !date) {
        await interaction.reply({
          content: '❌ Provide `days` for a recurring call, or `date` for a one-off.',
          ephemeral: true,
        });
        return;
      }
      if (date && everyRaw) {
        await interaction.reply({
          content: '❌ `every` (cadence) does not apply to a one-off `date`.',
          ephemeral: true,
        });
        return;
      }

      let cron: string;
      let oneOff = false;
      let intervalWeeks: number | undefined;
      let anchor: string | undefined;

      try {
        if (date) {
          cron = buildOneOffCron(date, time);
          oneOff = true;
        } else {
          cron = buildCron(days!, time);
          const n = parseInterval(everyRaw);
          if (n > 1) {
            intervalWeeks = n;
            // Anchor the interval phase to the next matching occurrence so the
            // first real recording happens then (not N weeks out).
            const parsed = parseSimpleCron(cron)!;
            anchor = nextFireDate(parsed.days, parsed.hour, parsed.minute, timezone);
          }
        }
      } catch (err: any) {
        await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        return;
      }

      if (!name) {
        if (oneOff) {
          name = `One-off ${date}`;
        } else {
          const parsed = parseSimpleCron(cron)!; // buildCron always yields the simple shape
          name = `${parsed.days.map(dayLabel).join('/')} call`;
        }
      }

      const textChannelId = text?.id || interaction.channelId;
      const schedule = createSchedule({
        name,
        guildId: interaction.guildId,
        voiceChannelId: voice.id,
        textChannelId,
        cron,
        timezone,
        intervalWeeks,
        anchor,
        oneOff,
        paused: false,
        createdBy: interaction.user.id,
      });

      await interaction.reply({
        content:
          `✅ Added schedule **${schedule.name}** \`${schedule.id}\`\n` +
          `${describeSchedule(schedule)}`,
        ephemeral: true,
      });
      return;
    }

    // edit / remove / pause / resume all target a specific schedule.
    const schedule = resolveGuildSchedule(interaction);
    if (!schedule) {
      await interaction.reply({
        content: '❌ Schedule not found in this server. Pick one from the autocomplete list.',
        ephemeral: true,
      });
      return;
    }

    if (sub === 'remove') {
      deleteSchedule(schedule.id);
      await interaction.reply({
        content: `🗑️ Removed schedule **${schedule.name}** \`${schedule.id}\`.`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'pause') {
      if (schedule.paused) {
        await interaction.reply({ content: `⏸ **${schedule.name}** is already paused.`, ephemeral: true });
        return;
      }
      const updated = pauseSchedule(schedule.id)!;
      await interaction.reply({ content: `⏸ Paused **${updated.name}** \`${updated.id}\`.`, ephemeral: true });
      return;
    }

    if (sub === 'resume') {
      if (!schedule.paused) {
        await interaction.reply({ content: `▶️ **${schedule.name}** is already active.`, ephemeral: true });
        return;
      }
      const updated = resumeSchedule(schedule.id)!;
      await interaction.reply({
        content: `▶️ Resumed **${updated.name}** \`${updated.id}\`\n${describeSchedule(updated)}`,
        ephemeral: true,
      });
      return;
    }

    if (sub === 'edit') {
      const voice = interaction.options.getChannel('voice_channel');
      const days = interaction.options.getString('days');
      const date = interaction.options.getString('date');
      const time = interaction.options.getString('time');
      const everyRaw = interaction.options.getString('every');
      const timezone = interaction.options.getString('timezone');
      const text = interaction.options.getChannel('text_channel');
      const name = interaction.options.getString('name')?.trim();

      const patch: Partial<Omit<Schedule, 'id' | 'createdAt'>> = {};

      if (name) patch.name = name;
      if (voice) patch.voiceChannelId = voice.id;
      if (text) patch.textChannelId = text.id;

      if (days && date) {
        await interaction.reply({
          content: '❌ Provide either `days` (recurring) **or** `date` (one-off), not both.',
          ephemeral: true,
        });
        return;
      }

      // Effective timezone for any anchor recomputation below.
      const effectiveTz = timezone || schedule.timezone;
      if (timezone) {
        if (!isValidTimezone(timezone)) {
          await interaction.reply({ content: `❌ Unknown timezone \`${timezone}\`.`, ephemeral: true });
          return;
        }
        patch.timezone = timezone;
      }

      // Convert to a one-off if a date is supplied.
      if (date) {
        const timeStr =
          time ??
          (() => {
            const ex = parseSimpleCron(schedule.cron);
            return ex ? `${String(ex.hour).padStart(2, '0')}:${String(ex.minute).padStart(2, '0')}` : null;
          })();
        if (!timeStr) {
          await interaction.reply({
            content: '❌ Converting to a one-off needs a `time` (this schedule has no simple time to reuse).',
            ephemeral: true,
          });
          return;
        }
        try {
          patch.cron = buildOneOffCron(date, timeStr);
        } catch (err: any) {
          await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
          return;
        }
        patch.oneOff = true;
        patch.intervalWeeks = undefined;
        patch.anchor = undefined;
      } else if (days || time) {
        // Recurring days/time edit. Fill the unspecified side from existing cron.
        const existing = parseSimpleCron(schedule.cron);
        const daysStr = days ?? (existing ? existing.days.join(',') : null);
        const timeStr =
          time ??
          (existing
            ? `${String(existing.hour).padStart(2, '0')}:${String(existing.minute).padStart(2, '0')}`
            : null);
        if (!daysStr || !timeStr) {
          await interaction.reply({
            content:
              '❌ This schedule uses a custom cron, so editing days/time needs **both** `days` and `time`.',
            ephemeral: true,
          });
          return;
        }
        try {
          patch.cron = buildCron(daysStr, timeStr);
        } catch (err: any) {
          await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
          return;
        }
        // Editing days/time on a former one-off makes it recurring again.
        if (schedule.oneOff) patch.oneOff = false;
      }

      // Cadence change (only meaningful for recurring schedules).
      if (everyRaw !== null) {
        const willBeOneOff = patch.oneOff ?? schedule.oneOff;
        if (willBeOneOff) {
          await interaction.reply({
            content: '❌ `every` (cadence) does not apply to a one-off schedule.',
            ephemeral: true,
          });
          return;
        }
        let n: number;
        try {
          n = parseInterval(everyRaw);
        } catch (err: any) {
          await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
          return;
        }
        if (n > 1) {
          patch.intervalWeeks = n;
        } else {
          patch.intervalWeeks = undefined;
          patch.anchor = undefined;
        }
      }

      // If the schedule is (or becomes) an interval schedule and its cadence or
      // days/time changed, (re)anchor phase to the next matching occurrence.
      const finalInterval =
        'intervalWeeks' in patch ? patch.intervalWeeks : schedule.intervalWeeks;
      const finalCron = patch.cron ?? schedule.cron;
      const finalOneOff = patch.oneOff ?? schedule.oneOff;
      const needsAnchor =
        !finalOneOff &&
        (finalInterval ?? 1) > 1 &&
        (everyRaw !== null || patch.cron !== undefined || !schedule.anchor);
      if (needsAnchor) {
        const parsed = parseSimpleCron(finalCron);
        if (parsed) {
          patch.anchor = nextFireDate(parsed.days, parsed.hour, parsed.minute, effectiveTz);
        }
      }

      if (Object.keys(patch).length === 0) {
        await interaction.reply({
          content: 'ℹ️ Nothing to change — provide at least one field to edit.',
          ephemeral: true,
        });
        return;
      }

      const updated = editSchedule(schedule.id, patch)!;
      await interaction.reply({
        content: `✏️ Updated **${updated.name}** \`${updated.id}\`\n${describeSchedule(updated)}`,
        ephemeral: true,
      });
      return;
    }
  },
};
