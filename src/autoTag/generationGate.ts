interface PendingGeneration {
  chatId: string;
  type: string;
}

let pending: PendingGeneration | null = null;

/** Only a real, non-dry-run character generation may arm automatic tag creation. */
export function beginGeneration(chatId: string, type: unknown, dryRun: unknown): void {
  if (!chatId || dryRun || typeof type !== 'string' || type === 'quiet' || type === 'impersonate') return;
  pending = { chatId, type };
}

/** Consume the generation only when its final rendered message belongs to the same run and chat. */
export function consumeGeneration(chatId: string, type: unknown): boolean {
  if (!pending || pending.chatId !== chatId || pending.type !== type) return false;
  pending = null;
  return true;
}

export function clearGeneration(): void {
  pending = null;
}
