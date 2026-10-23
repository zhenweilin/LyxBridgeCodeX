import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {callNativeRpc} from '../../lib/native-broker-client.mjs';
const {createServer,serveLyxStdio}=await import(pathToFileURL(resolve(process.env.LYX_BENCHMARK_MODULE??'server/mcp.mjs')));
const broker=JSON.parse(process.env.LYX_TEST_BROKER);
delete process.env.LYX_TEST_BROKER;
serveLyxStdio(()=>createServer({rpc:(args,options)=>callNativeRpc(args,{...options,broker}),
  openNative:async()=>{throw new Error('The benchmark cannot open another document');}}));
