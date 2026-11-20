import { Injectable } from '@nestjs/common';
import type { RequestParseResult } from '@pulse/contracts';
import { gazetteerFor, parseRequest } from '@pulse/request-parser';
import { type RateLimit, RateLimiter } from '../auth/rate-limiter.js';
import type { SignedInUser } from '../auth/session.service.js';
import { CampusService } from '../campus/campus.service.js';

// Parsing is cheap, but a client stuck in a loop should not be able to hammer it
const PARSE_LIMIT = { name: 'request-parse', max: 30, windowSec: 60 } as const satisfies RateLimit;

@Injectable()
export class RequestService {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly campuses: CampusService,
  ) {}

  /**
   * Reads a free-text ride request into fields with the rule parser. The text is never stored
   * or logged: storing samples needs the user's consent, which is a later slice.
   */
  async parse(user: SignedInUser, text: string): Promise<RequestParseResult> {
    // The user id is not personal on its own, so it is the subject as is
    await this.limiter.hit(PARSE_LIMIT, user.id);
    const slug = await this.campuses.slugById(user.campusId);
    // The routine slice (S38) will pass today's sections, so "ML class" becomes a course code
    const parsed = parseRequest(text, { courses: [], gazetteer: gazetteerFor(slug) });
    return { ...parsed, parser: 'rule@1' };
  }
}
