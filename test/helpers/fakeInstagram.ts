import { vi, type Mock } from 'vitest';
import type { InstagramClient } from '../../src/instagram/client.js';

export type FakeInstagram = { [K in keyof InstagramClient]: Mock<InstagramClient[K]> };

/** Cliente falso: todos os métodos são mocks tipados; `overrides` define implementações específicas. */
export function createFakeInstagram(overrides: Partial<InstagramClient> = {}): FakeInstagram {
  const client: FakeInstagram = {
    getProfile: vi.fn<InstagramClient['getProfile']>(),
    listMedia: vi.fn<InstagramClient['listMedia']>(async () => []),
    getMedia: vi.fn<InstagramClient['getMedia']>(),
    listComments: vi.fn<InstagramClient['listComments']>(async () => ({ comments: [] })),
    replyToComment: vi.fn<InstagramClient['replyToComment']>(async () => ({ id: 'REPLY1' })),
    sendPrivateReply: vi.fn<InstagramClient['sendPrivateReply']>(async () => ({ messageId: 'MSG1' })),
    subscribeToComments: vi.fn<InstagramClient['subscribeToComments']>(async () => undefined),
  };
  for (const [key, implementation] of Object.entries(overrides)) {
    (client[key as keyof FakeInstagram] as Mock).mockImplementation(implementation as (...args: unknown[]) => unknown);
  }
  return client;
}

export const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
