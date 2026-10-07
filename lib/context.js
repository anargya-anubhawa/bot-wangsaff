/**
 * GX-ID — message context helpers
 *
 * `saluranCtx()` builds the "forwarded from channel" context used across the
 * bot. `interactiveContextInfo()` builds the `messageContextInfo` that
 * interactive (native-flow) messages require.
 */
import { randomBytes } from "crypto";
import config from "../config.js";

/**
 * Build the `messageContextInfo` required by interactive / native-flow
 * messages. WhatsApp silently drops interactive messages whose context is
 * missing a 32-byte `messageSecret`, so it MUST be injected inside the
 * `viewOnceMessage.message` wrapper (mirrors the reference architecture).
 */
export function interactiveContextInfo(extra = {}) {
  return {
    deviceListMetadata: {},
    deviceListMetadataVersion: 2,
    messageSecret: randomBytes(32),
    ...extra,
  };
}

export function saluranCtx() {
  const ctx = {
    forwardingScore: 9,
    isForwarded: false,
  };
  if (config.channel?.id) {
    ctx.forwardedNewsletterMessageInfo = {
      newsletterJid: config.channel.id,
      newsletterName: config.channel.name || config.bot?.name,
      serverMessageId: 127,
    };
  }
  return ctx;
}
