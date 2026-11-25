export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** Resolves false on delivery failure; auth flows degrade gracefully then. */
  send(msg: EmailMessage): Promise<boolean>;
}

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Transactional email via Resend's plain REST API (no SDK needed). Without an
 * API key (dev / self-host) emails are logged to the console instead, so the
 * verification links stay reachable while developing.
 */
export function createMailer(apiKey: string | null, from: string): Mailer {
  if (!apiKey) {
    return {
      send(msg: EmailMessage): Promise<boolean> {
        console.log(`[email] RESEND_API_KEY not set; would send to ${msg.to}: ${msg.subject}\n${msg.text}`);
        return Promise.resolve(true);
      },
    };
  }
  return {
    async send(msg: EmailMessage): Promise<boolean> {
      try {
        const res = await fetch(RESEND_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from,
            to: [msg.to],
            subject: msg.subject,
            text: msg.text,
            html: msg.html,
          }),
        });
        if (!res.ok) {
          console.error(`[email] resend rejected (${res.status}): ${await res.text()}`);
          return false;
        }
        return true;
      } catch (err) {
        console.error('[email] resend unreachable', err);
        return false;
      }
    },
  };
}
