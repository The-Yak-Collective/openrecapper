import { Client } from 'discord.js';

let clientRef: Client | null = null;

export function setClient(client: Client): void {
  clientRef = client;
}

export function getClient(): Client {
  if (!clientRef) throw new Error('Client not initialized');
  return clientRef;
}
