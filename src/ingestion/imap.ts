/**
 * ImapSource (FR1, production path). Owned by the Ingestion module.
 * Polls a real mailbox over IMAP (imapflow), parses each UNSEEN message with
 * mailparser, and yields a RawInvoice for every PDF attachment. Marks processed
 * messages \Seen so they aren't re-ingested. Implements InvoiceSource
 * (kind = "email"), the same shape EmlFolderSource produces, so downstream
 * persistRaw()/orchestrator wiring is identical regardless of source.
 *
 * Connection config comes from env (IMAP_HOST, IMAP_PORT, IMAP_USER,
 * IMAP_PASSWORD, IMAP_TLS, IMAP_MAILBOX) with a constructor override. If host/
 * user/password aren't configured, poll() logs a warning and returns [] — the
 * source is a no-op rather than a crash, so the demo runs without a live server.
 */

import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { InvoiceSource, RawInvoice } from "@/contracts";
import { logger } from "@/lib/logger";

const PDF_MIME = "application/pdf";

export interface ImapSourceOptions {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  tls?: boolean;
  mailbox?: string;
  /** Cap on how many recent messages list() fetches. */
  listLimit?: number;
}

interface ResolvedImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
  mailbox: string;
  listLimit: number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function isPdfAttachment(att: { contentType?: string; filename?: string }): boolean {
  if (att.contentType?.toLowerCase() === PDF_MIME) return true;
  return (att.filename ?? "").toLowerCase().endsWith(".pdf");
}

function addressText(addr: ParsedMail["from"]): string | undefined {
  return (addr as AddressObject | undefined)?.text;
}

export class ImapSource implements InvoiceSource {
  readonly kind = "email";

  private readonly cfg: ResolvedImapConfig;

  constructor(opts: ImapSourceOptions = {}) {
    this.cfg = {
      host: opts.host ?? process.env.IMAP_HOST ?? "",
      port: opts.port ?? Number(process.env.IMAP_PORT ?? 993),
      user: opts.user ?? process.env.IMAP_USER ?? "",
      password: opts.password ?? process.env.IMAP_PASSWORD ?? "",
      tls: opts.tls ?? parseBool(process.env.IMAP_TLS, true),
      mailbox: opts.mailbox ?? process.env.IMAP_MAILBOX ?? "INBOX",
      listLimit: opts.listLimit ?? 20,
    };
  }

  private isConfigured(): boolean {
    return Boolean(this.cfg.host && this.cfg.user && this.cfg.password);
  }

  private newClient(): ImapFlow {
    return new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.tls,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      logger: false,
    });
  }

  /** Parse one downloaded message body into zero-or-more RawInvoices. */
  private async toRawInvoices(source: Buffer, uid: number): Promise<RawInvoice[]> {
    let parsed: ParsedMail;
    try {
      parsed = await simpleParser(source);
    } catch (err) {
      logger.warn(
        { uid, err: err instanceof Error ? err.message : String(err) },
        "ImapSource: failed to parse message, skipping",
      );
      return [];
    }
    return parsed.attachments.filter(isPdfAttachment).map((att) => ({
      fileName: att.filename ?? `message-${uid}.pdf`,
      source: "email" as const,
      bytes: att.content,
      mimeType: PDF_MIME,
      meta: {
        from: addressText(parsed.from),
        subject: parsed.subject,
        messageId: parsed.messageId,
        date: parsed.date?.toISOString(),
        uid,
      },
    }));
  }

  /**
   * Fetch + parse messages matching `criteria`, optionally marking them \Seen.
   * Centralizes connect/lock/finally so poll() and list() share one code path.
   */
  private async fetchMessages(
    criteria: Record<string, unknown>,
    opts: { markSeen: boolean; limit?: number },
  ): Promise<RawInvoice[]> {
    const client = this.newClient();
    const out: RawInvoice[] = [];
    let lock: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | undefined;
    try {
      await client.connect();
      lock = await client.getMailboxLock(this.cfg.mailbox);

      let uids = await client.search(criteria, { uid: true });
      if (!uids) uids = [];
      if (opts.limit !== undefined && uids.length > opts.limit) {
        // Keep the most recent `limit` messages (UIDs increase with arrival).
        uids = uids.slice(-opts.limit);
      }

      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const raws = await this.toRawInvoices(msg.source, uid);
        out.push(...raws);
        if (opts.markSeen) {
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        }
      }
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), mailbox: this.cfg.mailbox },
        "ImapSource: IMAP fetch failed",
      );
      throw err;
    } finally {
      if (lock) lock.release();
      try {
        await client.logout();
      } catch {
        // Best-effort logout; connection may already be torn down.
      }
    }
    return out;
  }

  async poll(): Promise<RawInvoice[]> {
    if (!this.isConfigured()) {
      logger.warn(
        { host: this.cfg.host || "(unset)" },
        "ImapSource: IMAP_HOST/IMAP_USER/IMAP_PASSWORD not configured; skipping poll",
      );
      return [];
    }
    return this.fetchMessages({ seen: false }, { markSeen: true });
  }

  async list(): Promise<RawInvoice[]> {
    if (!this.isConfigured()) {
      logger.warn(
        { host: this.cfg.host || "(unset)" },
        "ImapSource: IMAP_HOST/IMAP_USER/IMAP_PASSWORD not configured; skipping list",
      );
      return [];
    }
    // Enumerate recent messages without consuming them (no \Seen mutation).
    return this.fetchMessages({ all: true }, { markSeen: false, limit: this.cfg.listLimit });
  }
}

export default ImapSource;
