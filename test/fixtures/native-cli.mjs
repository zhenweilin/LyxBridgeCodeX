// Isolated test transport. Production CLI never accepts broker credentials.
import {createCli,executeLines} from '../../lib/native-cli.mjs';
import {createNativeEditor} from '../../lib/native-editor.mjs';
import {callNativeRpc} from '../../lib/native-broker-client.mjs';
const broker=JSON.parse(process.env.LYX_TEST_BROKER);
delete process.env.LYX_TEST_BROKER;
const execute=createCli({editor:createNativeEditor({rpc:(args,options)=>callNativeRpc(args,{...options,broker})}),
  openNative:async()=>{throw new Error('The fixture cannot open documents');}});
for await(const result of executeLines(process.stdin,execute))process.stdout.write(JSON.stringify(result)+'\n');
