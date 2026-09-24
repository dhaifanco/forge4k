'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = async function smoke(window, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const errors = [];
  window.webContents.on('console-message', (_event, level, message) => { if (level === 3) errors.push(message); });
  const run = source => window.webContents.executeJavaScript(source);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = async label => { assert.equal(await run(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b || b.disabled)return false;b.click();return true})()`), true, label); await pause(650); };
  const navigate = async label => { await run(`[...document.querySelectorAll('nav a')].find(a=>a.textContent.includes(${JSON.stringify(label)})).click()`); await pause(650); };
  const capture = async name => { await pause(200); fs.writeFileSync(path.join(folder, name + '.png'), (await window.webContents.capturePage()).toPNG()); };
  const result = await run(`Promise.all(['/api/health','/api/presets','/api/queue','/api/updates'].map(p=>fetch(p).then(r=>r.json()))).then(([health,presets,queue,updates])=>({health,presets:presets.presets.length,queue:queue.items.length,updates}))`);
  assert.equal(result.health.ffmpegReady, true);
  assert.equal(result.updates.desktop, true);
  await pause(450); await capture('workspace-empty');
  result.pages = [];
  for (const [label, heading] of [['Video Analyzer', 'Video Analyzer'], ['History', 'History'], ['Settings', 'Settings'], ['Updates', 'Updates'], ['Optimizer', 'Video workspace']]) {
    await run(`[...document.querySelectorAll('nav a')].find(a=>a.textContent.includes(${JSON.stringify(label)})).click()`);
    await pause(600);
    const actual = await run(`document.querySelector('h1')?.textContent`);
    assert.equal(actual, heading); result.pages.push({ label, heading: actual });
    if (label === 'Settings' || label === 'Updates') await capture(label.toLowerCase());
  }
  if (process.env.FORGE_SMOKE_VIDEO) {
    const base64 = fs.readFileSync(process.env.FORGE_SMOKE_VIDEO).toString('base64');
    await run(`(()=>{ const bytes=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0)); const file=new File([bytes],'QA source.mp4',{type:'video/mp4'}); const dt=new DataTransfer(); dt.items.add(file); const input=document.querySelector('input[type=file]'); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    for (let i = 0; i < 50; i++) { if (await run(`!!document.querySelector('.plan-table')`)) break; await pause(200); }
    assert.equal(await run(`!!document.querySelector('.plan-table')`), true);
    assert.equal(await run(`document.querySelector('video')?.getAttribute('src')?.startsWith('blob:')`), true);
    await capture('workspace-loaded');
    if(process.env.FORGE_SMOKE_STUDIO){
      await click('Smart Auto');
      for(let i=0;i<50;i++){if(await run(`!!document.querySelector('.studio-notice')`))break;await pause(200);}
      assert.equal(await run(`!!document.querySelector('.studio-notice')`),true);
      await click('Dismiss notice').catch(async()=>{await run(`document.querySelector('[aria-label="Dismiss notice"]').click()`);});
      await click('Framing');
      for(const value of ['center','follow','manual','off']){
        await run(`(()=>{const s=document.querySelector('#crop-mode');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause(250);
        if(value==='manual')assert.equal(await run(`!!document.querySelector('#crop-x')&&!!document.querySelector('#crop-y')`),true);
      }
      for(const value of ['5','10','0']){await run(`(()=>{const s=document.querySelector('#stabilize');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause(250);}
      await click('Setup');
      await run(`(()=>{const s=document.querySelector('#recipe-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'Studio QA');s.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(250);
      await click('Save');assert.equal(await run(`document.querySelector('#saved-look').value`),'Studio QA');
      await click('Delete saved preset');
      await run(`document.querySelector('.enhancement-controls summary').click()`);
      await run(`document.querySelector('.enhancement-controls input').click()`);await pause(150);
      assert.equal(await run(`document.querySelector('.enhancement-controls input').checked`),true);
      await run(`document.querySelector('.enhancement-controls input').click()`);
      result.studioControls='Smart analysis, all framing modes, stabilization modes, preset save/delete and additional-destination toggle passed';
    }
    await run(`(()=>{ const s=document.querySelector('#export-preset'); s.value='master_4k120'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await pause(350);
    assert.equal(await run(`document.querySelector('#export-preset').value`), 'master_4k120');
    if (process.env.FORGE_SMOKE_AI) {
      await click('Detail');
      if(process.env.FORGE_SMOKE_STUDIO){
        for(const [id,values] of [['ai-scale',['4','1']],['ai-noise',['ai','off']],['motion-guard',['conservative','off','cuts']]])for(const value of values){await run(`(()=>{const s=document.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause(180);assert.equal(await run(`document.getElementById(${JSON.stringify(id)}).value`),value);}
        for(const value of ['0.3','0']){await run(`(()=>{const s=document.querySelector('#face-strength');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(200);assert.equal(await run(`document.querySelector('#face-strength').value`),value);}
      }
      for (const [id,value] of [['ai-scale','2'],['ai-fps','120'],['ai-noise','gentle']]) {
        await run(`(()=>{const s=document.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(400);
      }
      assert.equal(await run(`document.querySelector('#ai-fps').value`),'120');
      await capture('ai-controls');
      await click('Export 5-second sample');
      for(let i=0;i<480;i++){if(await run(`!!document.querySelector('.sample-preview video')`))break;await pause(250);}
      assert.equal(await run(`!!document.querySelector('.sample-preview video')`),true);
      await pause(600);
      assert.equal(await run(`document.querySelector('.sample-preview video').error`),null);
      assert.equal(await run(`document.querySelectorAll('.source-row').length`),1);
      await run(`document.querySelector('.sample-preview').scrollIntoView({block:'center'})`); await capture('ai-sample');
      if(process.env.FORGE_SMOKE_STUDIO){
        await click('Before / after');await pause(600);
        assert.equal(await run(`document.querySelectorAll('.comparison video').length`),2);
        await click('Play comparison');await pause(100);
        await run(`(()=>{const s=document.querySelector('[aria-label="Comparison zoom"]');s.value='2';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause(250);
        assert.equal(await run(`document.querySelector('[aria-label="Comparison zoom"]').value`),'2');
        await run(`document.querySelector('.monitor').scrollIntoView({block:'start'})`);await capture('comparison');
        await click('Compression preview');
        for(let i=0;i<80;i++){if(await run(`document.querySelector('.comparison')?.textContent.includes('Compressed simulation')`))break;await pause(250);}
        assert.equal(await run(`document.querySelector('.comparison')?.textContent.includes('Compressed simulation')`),true);
        await click('Original');
        result.comparison='Two synchronized videos, play, zoom, original toggle and real compression simulation passed';
      }
      for(const [id,value] of [['ai-scale','1'],['ai-fps','0'],['ai-noise','off']]){
        await run(`(()=>{const s=document.getElementById(${JSON.stringify(id)});s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause(300);
      }
      await click('Clear finished jobs');
      await click('Setup');
      result.ai='Real 2x detail + RIFE 120fps + gentle noise reduction; sample playback without errors; source retained for full export';
    }
    await run(`(()=>{ const s=document.querySelector('#export-preset'); s.value='tiktok_1080p60'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await pause(350);
    await run(`document.querySelector('.export-button').click()`);
    if(process.env.FORGE_SMOKE_STUDIO){
      for(let i=0;i<30;i++){if(await run(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Pause')`))break;await pause(50);}
      const pauseClicked=await run(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Pause');if(b){b.click();return true;}return false;})()`);
      if(pauseClicked){for(let i=0;i<80;i++){if(await run(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Resume')`))break;await pause(250);}await click('Resume');result.pauseResume='Pause at section boundary and Resume clicked successfully';}
    }
    for (let i = 0; i < 100; i++) { if (await run(`!!document.querySelector('.completed-specs')`)) break; await pause(250); }
    assert.equal(await run(`!!document.querySelector('.completed-specs')`), true);
    await capture('workspace-exported');
    await run(`document.querySelector('.logviewer summary')?.click()`);
    assert.equal(await run(`document.querySelector('.logviewer')?.open`), true);
    result.export = 'UI import, local preview, preset change, export, completion and log toggle passed';
    await click('Clear finished jobs');
    await navigate('History');
    await run(`document.querySelector('.history-record summary').click()`);
    assert.equal(await run(`document.querySelector('.history-record').open`), true);
    await click('Clear history'); await click('Keep history');
    await click('Remove record');
    if (process.env.FORGE_SMOKE_AI) { await click('Clear history'); await click('Clear records'); }
    assert.equal(await run(`!!document.querySelector('.empty-state')`), true);
  }
  await navigate('Settings');
  for (const label of ['Save preferences', 'Refresh hardware', 'Save engine paths', 'Re-detect engine']) {
    await click(label);
    for (let i=0;i<40;i++) { if(await run(`!!document.querySelector('.okbar')`)) break; await pause(250); }
    assert.equal(await run(`!!document.querySelector('.okbar')`), true, label);
  }
  // Exercise the update UI without publishing a fake release or launching an installer.
  await run(`(()=>{const real=window.fetch;window.qaUpdateCalls=[];let state={desktop:true,currentVersion:'1.1.0',phase:'idle',feedUrl:'https://github.com/dhaifanco/forge4k/releases/latest/download/forge-update.json',checkOnStart:true};window.fetch=async(input,options)=>{if(String(input).startsWith('/api/updates')){const action=String(input).split('/')[3];if(action){qaUpdateCalls.push(action);if(action==='check')state={...state,phase:'available',release:{version:'1.2.0',newer:true,size:1234,notes:'QA fixture'}};if(action==='download'||action==='importFile')state.phase='ready';if(action==='install')state.phase='installing';if(action==='save')state={...state,...JSON.parse(options.body),phase:'idle'};}return new Response(JSON.stringify(state),{headers:{'Content-Type':'application/json'}});}return real(input,options);};})()`);
  await navigate('Updates');
  await run(`document.querySelector('.check input').click()`);
  for (const label of ['Save update settings','Check for updates','Download update','Close Forge and install']) await click(label);
  await navigate('Optimizer');
  result.updateUI = await run(`window.qaUpdateCalls`);
  assert.deepEqual(result.updateUI, ['save','check','download','install']);
  await run(`document.querySelector('nav a').focus()`);
  assert.equal(await run(`document.activeElement.tagName`), 'A');
  result.preferences = 'Save preferences, refresh hardware, save paths, re-detect engine passed';
  window.setMinimumSize(360, 600); window.setSize(390, 844); await pause(250);
  result.mobileOverflow = await run(`document.documentElement.scrollWidth>innerWidth || document.querySelector('.main').scrollWidth>document.querySelector('.main').clientWidth`);
  assert.equal(result.mobileOverflow, false); await capture('workspace-narrow');
  window.setSize(1280, 860); await pause(200);
  result.errors = errors;
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(folder, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
  return result;
};
