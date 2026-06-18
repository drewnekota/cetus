/**
 * Payload the cetus request_review pi extension returns in tool result `details`.
 * Mirror of the structure built in pi-install/cetus-extensions/request-review.ts.
 */
export interface ReviewRequestDetails {
  kind: "review_request";
  summary: string;
  questions: string[] | null;
}

export function isReviewRequestDetails(d: unknown): d is ReviewRequestDetails {
  return (
    !!d &&
    typeof d === "object" &&
    (d as { kind?: string }).kind === "review_request"
  );
}

/** The tool name the agent calls to hand a task off for review. */
export const REVIEW_TOOL_NAME = "request_review";
