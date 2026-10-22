import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const config={mcpServers:{lyx_preview:{command:process.execPath,args:[fileURLToPath(new URL('../server/mcp.mjs',import.meta.url))]}}};
await writeFile(new URL('../plugins/lyx-preview/.mcp.json',import.meta.url),JSON.stringify(config,null,2)+'\n');
console.log('Configured development plugin for this checkout.');
