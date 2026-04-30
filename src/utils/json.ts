import { ApiError } from "./errors";

export const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "Invalid request body", "Malformed JSON payload");
  }
};
