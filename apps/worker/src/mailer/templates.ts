import { campus, eq, type Database } from '@pulse/db';
import type { NotifyEmailPayload } from '@pulse/jobs';
import { PermanentJobError } from '../rabbit/consume.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * The email for a job payload. Jobs carry ids only, so the content is loaded here, when the email
 * is sent: no name or address waits in a queue.
 */
export async function renderEmail(
  db: Database,
  payload: NotifyEmailPayload,
  opsMailTo: string,
): Promise<EmailMessage> {
  switch (payload.template) {
    case 'campus-created': {
      const [row] = await db
        .select({ id: campus.id, name: campus.name })
        .from(campus)
        .where(eq(campus.id, payload.campusId));
      // The campus commits before its event exists, so a retry cannot make it appear
      if (!row) throw new PermanentJobError('Campus for the campus-created email not found');
      const name = oneLine(row.name);
      return {
        to: opsMailTo,
        subject: `New campus on Pulse: ${name}`,
        text: `${name} was added to Pulse.\n\nCampus id: ${row.id}\n`,
      };
    }
  }
}

// A name with a line break (or any control character) must not be able to start a mail header
function oneLine(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, ' ').trim();
}
