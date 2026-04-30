import { parseJsonBody } from "../utils/json";
import { validateStartRunRequest } from "../utils/validation";
import { ApiError } from "../utils/errors";
import { RunService } from "../services/run.service";

export const handleRunRoutes = async (request: Request, runService: RunService): Promise<Response | null> => {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (method === "POST" && url.pathname === "/run") {
    const payload = await parseJsonBody(request);
    const validated = validateStartRunRequest(payload);
    const result = await runService.startRun(validated);

    return Response.json(
      {
        run_id: result.runId,
        reused: result.reused
      },
      { status: result.reused ? 200 : 201 }
    );
  }

  const runMatch = url.pathname.match(/^\/run\/([^/]+)$/);
  if (method === "GET" && runMatch) {
    const runId = runMatch[1];
    return Response.json(await runService.getRunSummary(runId));
  }

  const detailsMatch = url.pathname.match(/^\/run\/([^/]+)\/details$/);
  if (method === "GET" && detailsMatch) {
    const runId = detailsMatch[1];
    const run = await runService.getRun(runId);

    return Response.json({
      run_id: run.id,
      status: run.status,
      totalCases: run.totalCases,
      completedCases: run.completedCases,
      totalCostUsd: run.totalCostUsd,
      ...(run.status === "failed" && run.failedReason !== undefined
        ? { failedReason: run.failedReason }
        : {}),
      cases: Object.values(run.results)
    });
  }

  return null;
};

export const notFoundResponse = (): Response => {
  throw new ApiError(404, "Not found", "Route does not exist");
};
