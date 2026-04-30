import { FileStore } from "./storage/fileStore";
import { RunService } from "./services/run.service";
import { handleRunRoutes, notFoundResponse } from "./routes/run.routes";
import { toErrorResponse } from "./utils/errors";

interface AppOptions {
  storagePath?: string;
}

export const createApp = (options?: AppOptions) => {
  const storagePath = options?.storagePath ?? "storage-data/runs.json";
  const runService = new RunService(new FileStore(storagePath));

  runService.resumeIncompleteRuns().catch((error) => {
    console.error("Failed to resume runs", error);
  });

  const fetch = async (request: Request): Promise<Response> => {
    try {
      const response = await handleRunRoutes(request, runService);
      return response ?? notFoundResponse();
    } catch (error) {
      return toErrorResponse(error);
    }
  };

  return {
    fetch,
    runService
  };
};
