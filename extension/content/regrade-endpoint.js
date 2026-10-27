// How to reply to / close a regrade request. Gradescope's endpoint for this is not known (the MCP
// server only reads requests), so this ships as `null` and the "Regrade response" fields stay
// hidden until it is filled in from a live recording. See README → Regrade requests → Reply & close.
//
// Shape once known:
// export const REGRADE_RESPONSE = {
//   method: "POST",                       // or "PATCH" / "PUT"
//   contentType: "json",                  // or "form" (application/x-www-form-urlencoded)
//   url: (ctx, req) => `${location.origin}/courses/${ctx.cid}/regrade_requests/${req.id}`,
//   body: (ctx, req, { message, close }) => ({ regrade_request: { staff_comment: message, closed: close } }),
// };
// ctx = the grade-page context (ctx.props, ctx.csrf, ctx.gradeUrl, ctx.cid, ctx.qid, ctx.sid);
// req = ctx.openRequest (props.open_request as the page delivered it).
export const REGRADE_RESPONSE = null;
