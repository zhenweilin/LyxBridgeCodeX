import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,utimes} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {NativeSession} from '../lib/native-session.mjs';
import {longDocument} from './fixtures/long-document.mjs';

test('long-document scrolling and forward/reverse selection retain exact endpoints and detect disk edits',
  {timeout:90000},async()=>{
    const directory=await mkdtemp(resolve('.native/long-document-integration-'));
    const path=join(directory,'long.lyx'),fixture=longDocument(await readFile('test/fixtures/demo.lyx','utf8'));
    await writeFile(path,fixture);
    const session=new NativeSession(),size={width:1100,height:750,serial:-1};
    const input=async params=>{await session.call('input',params);return session.call('state');};
    try{
      await session.start(path);await session.call('frame',size);
      const before=await session.call('selection');
      await session.call('command',{command:'buffer-end'});
      const beginning=await session.call('command',{command:'paragraph-up'});
      assert.ok(!beginning.error,beginning.message);
      const frame=await session.call('frame',size),surface=frame.surfaces.find(item=>item.main).id;
      const p=frame.inputMethod.rect,y=p.y+Math.floor(p.height/2),left=p.x+2,right=left+200;
      const click=async x=>{
        await input({type:'pointerdown',surface,x,y,button:0,buttons:1});
        return input({type:'pointerup',surface,x,y,button:0,buttons:0});
      };
      const a=await click(left),b=await click(right);
      assert.equal(a.cursor.at(-1).paragraph,2999);assert.equal(b.cursor.at(-1).paragraph,2999);
      assert.ok(b.cursor.at(-1).position>a.cursor.at(-1).position,
        JSON.stringify({p,left,right,y,a:a.cursor,b:b.cursor}));
      for(const [start,end] of [[left,right],[right,left]]){
        await input({type:'pointerdown',surface,x:start,y,button:0,buttons:1});
        for(let i=1;i<=25;i++)await input({type:'pointermove',surface,x:Math.round(start+(end-start)*i/25),y,button:0,buttons:1});
        const selected=await input({type:'pointerup',surface,x:end,y,button:0,buttons:0});
        assert.equal(selected.hasSelection,true);
        assert.deepEqual(selected.selectionStart,a.cursor);assert.deepEqual(selected.selectionEnd,b.cursor);
        assert.match(selected.selection,/Paragraph 3000/);
      }
      await input({type:'wheel',surface,x:300,y:300,deltaMode:0,dx:0,dy:80});
      const after=await session.call('selection');assert.equal(after.source,before.source);assert.equal(after.modified,false);
      // A same-length external rewrite with the original mtime must still be
      // detected by fallback checking (or LyX's native file watcher).
      const info=await stat(path),changed=fixture.replace('Paragraph 1.','Paragraph X.');
      assert.equal(changed.length,fixture.length);await writeFile(path,changed);await utimes(path,info.atime,info.mtime);
      let detected=false;
      for(let i=0;i<40;i++){
        if((await session.call('state')).externalModified){detected=true;break;}
        await new Promise(done=>setTimeout(done,50));
      }
      assert.equal(detected,true);
      assert.equal((await session.call('selection')).source,before.source,'Detection never reloads over the editor buffer');
      assert.equal(await readFile(path,'utf8'),changed);
    }finally{session.stop();}
  });
