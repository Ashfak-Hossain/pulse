import { Logger } from '@nestjs/common';

/** Sends a sign-in code. A port, so real email replaces the log without touching sign-in. */
export type OtpMailer = {
  send(email: string, code: string): Promise<void>;
};

export const OTP_MAILER = Symbol('OTP_MAILER');

/** Development and tests only (production is refused at boot): writes the code to the log. */
export class LogOtpMailer implements OtpMailer {
  private readonly logger = new Logger('OtpMailer');

  send(email: string, code: string): Promise<void> {
    this.logger.log(`Sign-in code for ${email}: ${code}`);
    return Promise.resolve();
  }
}
