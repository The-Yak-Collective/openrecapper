import fs from 'fs';
import path from 'path';
import {
  MessageReaction,
  PartialMessageReaction,
  User,
  PartialUser,
  Message,
} from 'discord.js';

export interface GrapevineRoute {
  /** Source guild ID (required) */
  sourceGuildId: string;
  /** Optional source channel ID. If omitted, matches all channels in the source guild. */
  sourceChannelId?: string;
  /** Emoji to react with. Unicode (e.g. "🍇") or custom emoji name (e.g. "grapevine"). */
  emoji: string;
  /** Destination webhook URL (in the target guild's channel). */
  destinationWebhookUrl: string;
  /** Human-readable label, used in logs and /grapevine list. */
  label?: string;
  /** Minimum number of reactions of this emoji required before forwarding. Default 1. */
  threshold?: number;
  /** Optional list of role IDs in the source guild allowed to trigger. If set, reactor must have one. */
  allowedRoleIds?: string[];
}

export interface GrapevineConfig {
  routes: GrapevineRoute[];
}

const DISCORD_WEBHOOK_RE = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;

let routes: GrapevineRoute[] = [];
let configPath = '';
// In-memory dedupe: key = `${messageId}::${routeIndex}` — prevents re-forwarding
// the same message via the same route within a process lifetime.
const forwarded = new Set<string>();

export function loadGrapevineConfig(): { routes: GrapevineRoute[]; path: string } {
  configPath =
    process.env.GRAPEVINE_ROUTES_FILE ||
    path.join(__dirname, '..', '..', 'grapevine-routes.json');

  if (!fs.existsSync(configPath)) {
    console.log(`[Grapevine] No routes file at ${configPath} — feature inactive.`);
    routes = [];
    return { routes, path: configPath };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as GrapevineConfig;
    routes = (Array.isArray(parsed.routes) ? parsed.routes : []).filter((route, index) => {
      if (DISCORD_WEBHOOK_RE.test(route.destinationWebhookUrl)) return true;
      console.error(`[Grapevine] Ignoring route ${index}: destinationWebhookUrl must be a Discord webhook URL`);
      return false;
    });
    console.log(`[Grapevine] Loaded ${routes.length} route(s) from ${configPath}`);
    for (const r of routes) {
      console.log(
        `[Grapevine]   • ${r.label || '(unlabeled)'} :: ${r.emoji} in guild ${r.sourceGuildId}${
          r.sourceChannelId ? `/${r.sourceChannelId}` : ''
        } → webhook ${r.destinationWebhookUrl.slice(0, 60)}…`,
      );
    }
  } catch (err) {
    console.error('[Grapevine] Failed to load routes file:', err);
    routes = [];
  }
  return { routes, path: configPath };
}

export function getRoutes(): GrapevineRoute[] {
  return routes;
}

export function getConfigPath(): string {
  return configPath;
}

function emojiMatches(reactionEmoji: { name: string | null; id: string | null }, target: string): boolean {
  if (!reactionEmoji.name && !reactionEmoji.id) return false;
  // Match by name (works for unicode and custom emoji by name)
  if (reactionEmoji.name && reactionEmoji.name === target) return true;
  // Match custom emoji by `<:name:id>` format
  if (reactionEmoji.id && target.includes(reactionEmoji.id)) return true;
  return false;
}

function findMatchingRoutes(message: Message, reactionEmoji: { name: string | null; id: string | null }): Array<{ route: GrapevineRoute; index: number }> {
  const matches: Array<{ route: GrapevineRoute; index: number }> = [];
  routes.forEach((route, index) => {
    if (message.guildId !== route.sourceGuildId) return;
    if (route.sourceChannelId && message.channelId !== route.sourceChannelId) return;
    if (!emojiMatches(reactionEmoji, route.emoji)) return;
    matches.push({ route, index });
  });
  return matches;
}

export async function handleReactionAdd(
  rawReaction: MessageReaction | PartialMessageReaction,
  rawUser: User | PartialUser,
): Promise<void> {
  if (routes.length === 0) return;

  let reaction: MessageReaction;
  try {
    reaction = rawReaction.partial ? await rawReaction.fetch() : (rawReaction as MessageReaction);
  } catch (err) {
    console.error('[Grapevine] Failed to fetch partial reaction:', err);
    return;
  }

  let user: User;
  try {
    user = rawUser.partial ? await rawUser.fetch() : (rawUser as User);
  } catch (err) {
    console.error('[Grapevine] Failed to fetch partial user:', err);
    return;
  }

  if (user.bot) return;

  let message: Message;
  try {
    message = reaction.message.partial ? await reaction.message.fetch() : (reaction.message as Message);
  } catch (err) {
    console.error('[Grapevine] Failed to fetch message:', err);
    return;
  }

  const matches = findMatchingRoutes(message, { name: reaction.emoji.name, id: reaction.emoji.id });
  if (matches.length === 0) return;

  for (const { route, index } of matches) {
    const dedupeKey = `${message.id}::${index}`;
    if (forwarded.has(dedupeKey)) continue;

    // Threshold check
    const threshold = route.threshold ?? 1;
    if ((reaction.count ?? 1) < threshold) continue;

    // Role gate
    if (route.allowedRoleIds && route.allowedRoleIds.length > 0) {
      try {
        const member = await message.guild!.members.fetch(user.id);
        const hasRole = route.allowedRoleIds.some((rid) => member.roles.cache.has(rid));
        if (!hasRole) {
          console.log(`[Grapevine] User ${user.tag} lacks required role for route "${route.label || index}"`);
          continue;
        }
      } catch (err) {
        console.error('[Grapevine] Failed role check:', err);
        continue;
      }
    }

    forwarded.add(dedupeKey);
    try {
      await forwardMessage(message, route, user);
      console.log(
        `[Grapevine] Forwarded message ${message.id} via route "${route.label || index}" (triggered by ${user.tag})`,
      );
    } catch (err) {
      console.error(`[Grapevine] Forward failed for route "${route.label || index}":`, err);
      forwarded.delete(dedupeKey); // allow retry on next reaction
    }
  }
}

async function forwardMessage(message: Message, route: GrapevineRoute, triggeredBy: User): Promise<void> {
  const author = message.author;
  const displayName =
    (message.member && message.member.displayName) || author.globalName || author.username;
  const avatarUrl = author.displayAvatarURL({ size: 128 });
  const sourceGuildName = message.guild?.name || 'unknown server';
  const sourceChannelName = (message.channel as any).name || message.channelId;

  const footer = `— forwarded from **#${sourceChannelName}** in *${sourceGuildName}* (reacted by ${triggeredBy.username}) · [jump](${message.url})`;

  let content = message.content || '';
  // Webhook content limit is 2000 chars; reserve room for footer.
  const FOOTER_OVERHEAD = footer.length + 4;
  const MAX = 2000;
  if (content.length + FOOTER_OVERHEAD > MAX) {
    content = content.slice(0, MAX - FOOTER_OVERHEAD - 1) + '…';
  }
  const body = content ? `${content}\n\n${footer}` : footer;

  // Collect attachment URLs (Discord CDN links work cross-server)
  const attachmentUrls = Array.from(message.attachments.values()).map((a) => a.url);
  const finalContent =
    attachmentUrls.length > 0 ? `${body}\n\n${attachmentUrls.join('\n')}` : body;

  const payload = {
    username: `${displayName} (via grapevine)`,
    avatar_url: avatarUrl,
    content: finalContent.slice(0, 2000),
    allowed_mentions: { parse: [] as string[] }, // never ping anyone on forward
  };

  const res = await fetch(route.destinationWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webhook ${res.status} ${res.statusText}: ${text}`);
  }
}
