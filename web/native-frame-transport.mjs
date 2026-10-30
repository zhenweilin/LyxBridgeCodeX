// The desktop host's MCP Apps adapter logs entire postMessage responses,
// retaining PNGs in the renderer console. Its documented compatibility bridge
// reaches the same server without that adapter. Use it only for frame reads;
// edits keep their existing ordered MCP route and are never replayed here.
export async function readNativeFrame({sessionId,params},{app,openai}) {
  const request={name:'native_lyx_rpc',arguments:{sessionId,method:'frame',params}};
  if(typeof openai?.callTool!=='function')return app.callServerTool(request);
  const reply=await openai.callTool(request.name,request.arguments);
  const candidates=[reply,reply?.call_tool_result,reply?.mcp_tool_result,
    reply?.meta?.call_tool_result,reply?.meta?.mcp_tool_result];
  const result=candidates.find(value=>value?._meta?.['lyx/rpc'])
    ?? candidates.find(value=>value?.isError===true);
  if(result)return result;
  if(reply?.meta?.['lyx/rpc'])return {...reply,_meta:reply.meta};
  // Do not silently fall back to the leaking route or hide native failures.
  throw new Error('The host frame bridge did not return native LyX state');
}
