import { NextResponse } from "next/server";
import {
  getExecutionById,
  getExecutionsByTraceId,
  listRecentExecutions,
} from "@/lib/execution/receiptStore.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/executions
 *   ?execution_id=<id>   → one execution receipt
 *   ?trace_id=<id>       → executions correlated by Heron trace (newest first)
 *   (no params)          → most recent executions that carry an execution_id
 *
 * Read-only observability surface; authentication is enforced by
 * dashboardGuard (dashboard session, CLI token, or API key).
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const executionId = searchParams.get("execution_id") || searchParams.get("executionId");
    const traceId = searchParams.get("trace_id") || searchParams.get("traceId");
    const limitRaw = parseInt(searchParams.get("limit"), 10);
    const limit = Number.isNaN(limitRaw) ? 20 : limitRaw;

    if (executionId) {
      const execution = await getExecutionById(executionId);
      if (!execution) {
        return NextResponse.json({ error: "Execution not found" }, { status: 404 });
      }
      return NextResponse.json(execution);
    }

    if (traceId) {
      const executions = await getExecutionsByTraceId(traceId, limit);
      return NextResponse.json({ trace_id: traceId, executions });
    }

    const executions = await listRecentExecutions(limit);
    return NextResponse.json({ executions });
  } catch (error) {
    console.error("[API] Failed to get executions:", error);
    return NextResponse.json({ error: "Failed to fetch executions" }, { status: 500 });
  }
}
