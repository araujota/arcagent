import type { Response } from "express";

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable = false,
): void {
  res.status(status).json({
    error: {
      code,
      message,
      retryable,
    },
  } satisfies ErrorEnvelope);
}
