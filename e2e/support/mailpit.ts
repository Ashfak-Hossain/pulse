import { inject } from 'vitest';

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

/** Every email Mailpit holds with exactly this subject. */
export async function emailsWithSubject(subject: string): Promise<MailpitMessage[]> {
  const response = await fetch(`${inject('mailpitApi')}/messages?limit=1000`);
  if (!response.ok) throw new Error(`Mailpit answered ${response.status}`);
  const { messages } = (await response.json()) as { messages: MailpitMessage[] };
  return messages.filter((message) => message.Subject === subject);
}
