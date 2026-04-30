export class ApiError extends Error {
  statusCode: number;
  details?: string;

  constructor(statusCode: number, message: string, details?: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const toErrorResponse = (error: unknown): Response => {
  if (error instanceof ApiError) {
    return Response.json(
      {
        error: error.message,
        details: error.details ?? ""
      },
      { status: error.statusCode }
    );
  }

  return Response.json(
    {
      error: "Internal server error",
      details: error instanceof Error ? error.message : "Unknown failure"
    },
    { status: 500 }
  );
};
