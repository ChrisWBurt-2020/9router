// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
  getUsageRecordByExecutionId, getUsageRecordsByTraceId, getRecentExecutions,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
  flushRequestDetails, getReceiptsByTraceId,
} from "@/lib/db/index.js";
