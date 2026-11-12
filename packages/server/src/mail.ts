/**
 * The town's mail sender: Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email), called with fetch, no SDK.
 * Host secrets (docs/secrets.md): `RESEND_API_KEY` (a sending-only key) and `BLOG_MAIL_FROM` (e.g. "Muster Town <blog@mail.muster.town>",
 * on a domain verified in Resend). Without a key the sender is off (`enabled` false) and callers carry on as if there were no mail:
 * the blog signup stays single opt-in (mailing-list.ts). Only the blog's mailing list sends today.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** extra headers, e.g. List-Unsubscribe */
  headers?: Record<string, string>;
}

export interface MailSender {
  readonly enabled: boolean;
  /** Sends one email; throws when Resend refuses it or can't be reached. A no-op when the sender is off. */
  send(mail: Mail): Promise<void>;
}

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Muster Town <blog@muster.town>";

export function resendSender(opts: { apiKey?: string | null; from?: string | null; fetch?: typeof fetch } = {}): MailSender {
  const apiKey = opts.apiKey?.trim() || null;
  const from = opts.from?.trim() || DEFAULT_FROM;
  const doFetch = opts.fetch ?? fetch;
  return {
    enabled: apiKey !== null,
    async send(mail) {
      if (!apiKey) return;
      const res = await doFetch(RESEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, ...(mail.html ? { html: mail.html } : {}), ...(mail.headers ? { headers: mail.headers } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Resend answers {statusCode, name, message}; never log the key (it is only in the request)
        const body = await res.text().catch(() => "");
        throw new Error(`Resend refused the email (HTTP ${res.status}): ${body.slice(0, 300)}`);
      }
    },
  };
}

/** The sender from the host's env: off unless RESEND_API_KEY is set. */
export function mailFromEnv(env: NodeJS.ProcessEnv = process.env): MailSender {
  return resendSender({ apiKey: env.RESEND_API_KEY, from: env.BLOG_MAIL_FROM });
}
