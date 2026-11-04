import { HttpException } from '@nestjs/common';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  errors?: { field: string; message: string }[];
}

/** Error API berformat RFC 9457 (application/problem+json) dengan kode stabil (API_CONTRACTS §4). */
export class Problem extends HttpException {
  constructor(status: number, code: string, title: string, errors?: ProblemBody['errors']) {
    super({ type: 'about:blank', title, status, code, ...(errors ? { errors } : {}) } satisfies ProblemBody, status);
  }
}

export const problem = (status: number, code: string, title: string) => new Problem(status, code, title);
