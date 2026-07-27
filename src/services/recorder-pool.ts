import { Client } from 'discord.js';

export class NoRecorderAvailableError extends Error {
  constructor(guildId: string, capacity: number) {
    super(`All ${capacity} recorder identit${capacity === 1 ? 'y is' : 'ies are'} busy in guild ${guildId}`);
    this.name = 'NoRecorderAvailableError';
  }
}

export interface RecorderLease {
  client: Client;
  guildId: string;
  // Bot user tag at allocation time, for /status display (e.g. "Recapper-2#1234").
  label: string;
}

/**
 * Owns every logged-in client (primary first) and hands out per-(client,guild)
 * leases for voice connections. Reservation granularity is per guild: one
 * client can simultaneously record in guild A and guild B, but never twice in
 * the same guild (Discord allows one voice connection per guild per identity).
 *
 * allocate() is fully synchronous — the slot is reserved before any await can
 * run, so two near-simultaneous /record calls cannot double-book an identity.
 */
export class RecorderPool {
  private static instance: RecorderPool;
  private clients: Client[] = [];
  // client -> set of guildIds currently reserved on that client
  private inUse: Map<Client, Set<string>> = new Map();

  static getInstance(): RecorderPool {
    if (!RecorderPool.instance) RecorderPool.instance = new RecorderPool();
    return RecorderPool.instance;
  }

  register(client: Client): void {
    this.clients.push(client);
    this.inUse.set(client, new Set());
  }

  allocate(guildId: string): RecorderLease | null {
    for (const client of this.clients) {
      if (!client.isReady()) continue;            // login failed or not yet ready
      if (!client.guilds.cache.has(guildId)) continue; // not invited to this guild
      const busy = this.inUse.get(client)!;
      if (busy.has(guildId)) continue;             // already recording in this guild
      busy.add(guildId);                           // reserve synchronously
      return { client, guildId, label: client.user?.tag ?? 'unknown' };
    }
    return null;
  }

  release(lease: RecorderLease): void {
    this.inUse.get(lease.client)?.delete(lease.guildId);
  }

  /** Recorders that are ready AND members of this guild. */
  capacityForGuild(guildId: string): number {
    return this.clients.filter((c) => c.isReady() && c.guilds.cache.has(guildId)).length;
  }

  inUseForGuild(guildId: string): number {
    let n = 0;
    for (const busy of this.inUse.values()) if (busy.has(guildId)) n++;
    return n;
  }
}
