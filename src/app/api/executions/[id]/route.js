import { NextResponse } from "next/server";
import { getExecutionById } from "@/lib/execution/receiptStore.js";

export const dynamic = "force-dynamic";

/** GET /api/executions/[id] — one execution receipt by execution_id. */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const execution = await getExecutionById(id);
    if (!execution) {
      return NextResponse.json({ error: "Execution not found" }, { status: 404 });
    }
    return NextResponse.json(execution);
  } catch (error) {
    console.error("[API] Failed to get execution:", error);
    return NextResponse.json({ error: "Failed to fetch execution" }, { status: 500 });
  }
}
