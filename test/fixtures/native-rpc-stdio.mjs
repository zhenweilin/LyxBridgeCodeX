// This fixture runs the production MCP handlers and authenticated HTTP client
// against a disposable broker, without replacing the user's live registry.
import {createServer,serveLyxStdio} from '../../server/mcp.mjs';
import {openNativeDocument,callNativeRpc} from '../../lib/native-broker-client.mjs';
const broker=JSON.parse(process.env.LYX_TEST_BROKER);
delete process.env.LYX_TEST_BROKER;
serveLyxStdio(()=>createServer({
  openNative:path=>openNativeDocument(path,{broker}),
  rpc:(args,options)=>callNativeRpc(args,{...options,broker}),
}));
